import { randomUUID } from "node:crypto";

import type { WithCredentialResult } from "@mediator/credentials";
import {
  ApiSpecRepository,
  RecordLinkRepository,
  RegisteredAppRepository,
  ResourceBindingRepository,
  ScopeLinkRepository,
  apiSpec,
  closeDb,
  createDb,
  recordLink,
  registeredApp,
  resolveDatabaseUrl,
  resourceBinding,
  resourceBindingRef,
  runMigrations,
  tx,
  type Database,
} from "@mediator/db";
import type { ApiSpec, Ir, RecordLink, RegisteredApp, ResourceBinding } from "@mediator/domain";
import { resolveRecordAddressing } from "@mediator/domain";
import {
  AppLoadGovernor,
  RecordAddressUnresolvedError,
  type CredentialAccess,
  type OutboundRequest,
  type OutboundResponse,
  type ProtocolClient,
} from "@mediator/outbound";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { canonicalResourcePairRef } from "./modules/artifact-instantiation/derive.js";
import { RecordAddressRepairService } from "./modules/sync/record-address-repair.js";
import { parseResourcePairRef } from "./modules/sync/resolution.js";
import {
  RepoTargetCollectionReadResolver,
  RestTargetIdentityLookup,
} from "./modules/sync/target-identity-lookup.js";

/**
 * **SS-19 — live-Postgres integration for the `recordAddressRef` address-repair sweep.**
 * Drives the FULL real stack — real `RecordLinkRepository` (candidate query + the new
 * `setRecordAddress` stamp), real `RepoTargetCollectionReadResolver` + real
 * `RestTargetIdentityLookup` (container enumeration, native-id match, abort-on-partial),
 * over a real ingested IR + confirmed `ResourceBinding` — with only the outbound wire
 * (`ProtocolClient`) and the credential scope stubbed.
 *
 * It proves what a fake cannot:
 *  - a link whose record is **present** in the enumerated container is stamped with its
 *    container-relative address per side (the correct `app_{a,b}_record_address` column);
 *  - a link whose record is **gone** stays unstamped (fail-safe), while its siblings stamp;
 *  - the stamp is **idempotent** — a re-run stamps nothing new;
 *  - a **subsequently composed write** then resolves `stored-address` for the stamped link
 *    (addressing the record inside its container) and **parks**
 *    (`RecordAddressUnresolvedError`) for the unstamped one — the exact disposition
 *    `SyncPipelineHandler.#resolveRecordAddress` reaches.
 *
 * Requires the compose `postgres` service + a resolvable `DATABASE_URL`; excluded from
 * `pnpm verify`, run via `pnpm --filter @mediator/backend test:integration`. Self-skips
 * when `DATABASE_URL` is unresolvable.
 */
let databaseUrl: string | undefined;
try {
  databaseUrl = resolveDatabaseUrl(process.env);
} catch {
  databaseUrl = undefined;
}
const suite = databaseUrl === undefined ? describe.skip : describe;

const DATE = new Date("2026-07-21T00:00:00.000Z");
const CONFIRMED = { confirmedBy: "operator@test", confirmedAt: DATE };

const GITEA = randomUUID();
const VIKUNJA = randomUUID();
const SPEC_ID = randomUUID();
const BINDING_ID = randomUUID();
// The canonical pair + which side the Gitea `issues` resource lands on (so the seeded
// links assign `app_{a,b}_*` exactly as Identity Resolution would).
const PAIR = canonicalResourcePairRef(
  { appId: GITEA, resourceRef: "issues" },
  { appId: VIKUNJA, resourceRef: "tasks" },
);
const GITEA_IS_A = parseResourcePairRef(PAIR)?.a.appId === GITEA;

/** The Gitea IR: a single-repo `issues` collection read whose items carry `id` + `number`. */
const IR: Ir = [
  {
    resourceRef: "issues",
    name: "issues",
    operations: [
      {
        operationId: "issueListIssues",
        method: "get",
        path: "/repos/{owner}/{repo}/issues",
        parameters: [
          { name: "owner", location: "path", required: true },
          { name: "repo", location: "path", required: true },
        ],
        responseSchema: {
          name: "Issue",
          fields: [
            { name: "id", type: "integer", required: true },
            { name: "number", type: "integer", required: true },
            { name: "title", type: "string", required: false },
          ],
        },
      },
    ],
    schemas: [
      {
        name: "Issue",
        fields: [
          { name: "id", type: "integer", required: true },
          { name: "number", type: "integer", required: true },
        ],
      },
    ],
    crossResourceRefs: [],
  },
];

const app: RegisteredApp = {
  id: GITEA,
  name: "Gitea",
  status: "active",
  baseUrl: "https://gitea.example.test",
  capabilities: {
    supportsPolling: true,
    supportsDeltaQuery: false,
    supportsChangeTimestamps: false,
    defaultPollInterval: 60_000,
  },
  createdAt: DATE,
};

const spec: ApiSpec = {
  id: SPEC_ID,
  appId: GITEA,
  role: "PROVIDER",
  rawDocument: { openapi: "3.1.0", info: { title: "Gitea", version: "1" } },
  parsedIR: IR,
  analysisExclusions: [],
  version: 1,
  contentHash: "sha256:ss19-address-repair",
  status: "active",
  createdAt: DATE,
};

/** The confirmed, container-scoped `issues` binding — address ref just confirmed. */
const binding: ResourceBinding = {
  id: BINDING_ID,
  apiSpecId: SPEC_ID,
  resourceRef: "issues",
  nativeIdRef: { value: { kind: "field", path: "id" }, ...CONFIRMED },
  recordAddressRef: { value: { kind: "field", path: "number" }, ...CONFIRMED },
  collectionReadRef: { value: { kind: "operation", operationId: "issueListIssues" }, ...CONFIRMED },
  scopePathBindings: [
    { kind: "constant", parameterName: "owner", value: "alice", ...CONFIRMED },
    { kind: "constant", parameterName: "repo", value: "phoenix", ...CONFIRMED },
  ],
};

/** Seed a link the way Identity Resolution would: Gitea on its canonical side, no address. */
function seedLink(giteaNativeId: string, vikunjaNativeId: string): RecordLink {
  return {
    id: randomUUID(),
    appAId: GITEA_IS_A ? GITEA : VIKUNJA,
    appANativeId: GITEA_IS_A ? giteaNativeId : vikunjaNativeId,
    appBId: GITEA_IS_A ? VIKUNJA : GITEA,
    appBNativeId: GITEA_IS_A ? vikunjaNativeId : giteaNativeId,
    resourcePairRef: PAIR,
    establishedBy: "identity-match",
    status: "active",
    establishingQueueKey: { kind: "identity-value", value: giteaNativeId },
    createdAt: DATE,
    tombstonedAt: null,
  };
}

/** The Gitea-side stored address of a link (the side the sweep stamps). */
function giteaAddressOf(link: RecordLink | undefined): string | undefined {
  return GITEA_IS_A ? link?.appARecordAddress : link?.appBRecordAddress;
}

const NO_CREDENTIAL: CredentialAccess = {
  withCredential: <T>(): Promise<WithCredentialResult<T>> =>
    Promise.resolve({ outcome: "no-credential" }),
};

/** The Gitea repo's live issues on the wire (native `id` + container-relative `number`). */
class GiteaWire implements ProtocolClient {
  public readonly urls: string[] = [];
  public send(request: OutboundRequest): Promise<OutboundResponse> {
    this.urls.push(request.url);
    return Promise.resolve({
      status: 200,
      headers: {},
      body: [
        { id: 4242, number: 7, title: "Ship it" },
        { id: 4243, number: 8, title: "Fix it" },
      ],
    });
  }
}

/**
 * Mirror `SyncPipelineHandler.#resolveRecordAddress` for a scoped write, built only from
 * production primitives: `stored-address` addressing (a container-scoped binding) reads the
 * link's frozen per-side address, and throws `RecordAddressUnresolvedError` when it is
 * absent (the park) rather than falling back to the native id.
 */
function composeScopedWriteAddress(b: ResourceBinding, link: RecordLink): string {
  const addressing = resolveRecordAddressing(b, (b.scopePathBindings ?? []).length > 0);
  if (addressing.kind !== "stored-address") {
    throw new Error(`expected stored-address, got ${addressing.kind}`);
  }
  const address = giteaAddressOf(link);
  if (address === undefined) {
    throw new RecordAddressUnresolvedError("no container-relative address stored for the side");
  }
  return address;
}

suite("SS-19 record-address repair sweep (requires Postgres)", () => {
  let db: Database;

  beforeAll(async () => {
    db = createDb(resolveDatabaseUrl(process.env));
    await runMigrations(db);
    await tx(db, async (txn) => {
      await new RegisteredAppRepository(txn).create(app);
      await new ApiSpecRepository(txn).create(spec);
      await new ResourceBindingRepository(txn).createMany([binding]);
    });
  });

  beforeEach(async () => {
    await db.delete(recordLink).where(eq(recordLink.resourcePairRef, PAIR));
  });

  afterAll(async () => {
    await db.delete(recordLink).where(eq(recordLink.resourcePairRef, PAIR));
    await db.delete(resourceBindingRef).where(eq(resourceBindingRef.resourceBindingId, BINDING_ID));
    await db.delete(resourceBinding).where(eq(resourceBinding.apiSpecId, SPEC_ID));
    await db.delete(apiSpec).where(eq(apiSpec.id, SPEC_ID));
    await db.delete(registeredApp).where(eq(registeredApp.id, GITEA));
    await closeDb(db);
  });

  function serviceOf(wire: ProtocolClient): RecordAddressRepairService {
    const resolver = new RepoTargetCollectionReadResolver({
      apiSpecs: new ApiSpecRepository(db),
      resourceBindings: new ResourceBindingRepository(db),
      registeredApps: new RegisteredAppRepository(db),
    });
    const lookup = new RestTargetIdentityLookup(
      resolver,
      wire,
      NO_CREDENTIAL,
      new AppLoadGovernor(),
      { applyCredential: (headers) => ({ ...headers }) },
    );
    return new RecordAddressRepairService({
      recordLinks: new RecordLinkRepository(db),
      lookup,
      scopeLinks: new ScopeLinkRepository(db),
    });
  }

  it("stamps the container-relative address of present records, leaves a gone record unstamped, and is idempotent", async () => {
    const links = new RecordLinkRepository(db);
    const present1 = seedLink("4242", "task-1");
    const present2 = seedLink("4243", "task-2");
    const gone = seedLink("9999", "task-3"); // no issue #9999 in the repo
    await links.insert(present1);
    await links.insert(present2);
    await links.insert(gone);

    const wire = new GiteaWire();
    const result = await serviceOf(wire).repairConfirmedBinding(binding, GITEA);

    // Present records → stamped with the container-relative `number`.
    expect(result.outcomes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "stamped", linkId: present1.id, address: "7" }),
        expect.objectContaining({ kind: "stamped", linkId: present2.id, address: "8" }),
        expect.objectContaining({ kind: "record-not-found", linkId: gone.id }),
      ]),
    );
    expect(giteaAddressOf(await links.getById(present1.id))).toBe("7");
    expect(giteaAddressOf(await links.getById(present2.id))).toBe("8");
    // Fail-safe: the gone record is untouched — never guessed.
    expect(giteaAddressOf(await links.getById(gone.id))).toBeUndefined();

    // The container was enumerated ONCE for all three links (OC-3 load discipline).
    expect(wire.urls).toEqual(["https://gitea.example.test/repos/alice/phoenix/issues"]);

    // Idempotent: a second sweep stamps nothing new (the two are no longer candidates).
    const rerun = await serviceOf(new GiteaWire()).repairConfirmedBinding(binding, GITEA);
    expect(rerun.outcomes.filter((o) => o.kind === "stamped")).toEqual([]);
    expect(giteaAddressOf(await links.getById(present1.id))).toBe("7");
  });

  it("a subsequently-composed scoped write resolves stored-address for a stamped link and parks for an unstamped one", async () => {
    const links = new RecordLinkRepository(db);
    const stampedSeed = seedLink("4242", "task-1");
    const parkedSeed = seedLink("9999", "task-2"); // record gone → stays unstamped
    await links.insert(stampedSeed);
    await links.insert(parkedSeed);

    await serviceOf(new GiteaWire()).repairConfirmedBinding(binding, GITEA);

    const stamped = await links.getById(stampedSeed.id);
    const parked = await links.getById(parkedSeed.id);
    if (stamped === undefined || parked === undefined) {
      throw new Error("links vanished mid-test");
    }

    // The stamped link addresses the record inside its container on its next write.
    expect(composeScopedWriteAddress(binding, stamped)).toBe("7");
    // The unstamped link parks — never falls back to the native id (which would 404 or clobber).
    expect(() => composeScopedWriteAddress(binding, parked)).toThrow(RecordAddressUnresolvedError);
    // Both still address by `stored-address` (the ref is confirmed) — the difference is only
    // whether the sweep could freeze an address.
    expect(resolveRecordAddressing(binding, true)).toEqual({ kind: "stored-address" });
    // Identity is untouched throughout: the links still correlate by their global native ids.
    expect(GITEA_IS_A ? stamped.appANativeId : stamped.appBNativeId).toBe("4242");
  });
});
