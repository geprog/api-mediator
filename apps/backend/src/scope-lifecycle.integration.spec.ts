import { randomUUID } from "node:crypto";

import {
  ApiSpecRepository,
  RecordLinkRepository,
  RegisteredAppRepository,
  ResourceBindingRepository,
  ScopeCorrespondenceRepository,
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
  scopeCorrespondence,
  scopeLink,
  tx,
  type Database,
} from "@mediator/db";
import type {
  ApiSpec,
  Ir,
  RecordLink,
  RegisteredApp,
  ResourceBinding,
  ScopeCorrespondence,
  ScopeLink,
} from "@mediator/domain";
import type { ScopeCorrespondenceSide } from "@mediator/ir";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ScopeLifecycleService } from "./modules/sync/scope-lifecycle.js";

/**
 * SS-16 — live-Postgres backend integration for the {@link ScopeLifecycleService}: the
 * seam that persists the `@mediator/ir` re-validation policy's output. Proves, against a
 * real database, the three persistence-touching behaviours the pure policy cannot:
 *
 *  - **SS-16.2 (+ SS-19)** a binding's confirmed ref is written back **unconfirmed** — the
 *    stored state the runtime backstop reads as "paused" (an unconfirmed ref is used
 *    nowhere);
 *  - **SS-16.5** a container that disappeared returns the `ScopeCorrespondence` to
 *    unconfirmed and **archives** (never deletes) its `ScopeLink`s, so a
 *    `RecordLink.scopeRef` pointing at one still resolves its frozen key for a final
 *    delete/audit;
 *  - **SS-16.4** a scope-identity-key break archives only the `identity-match` links,
 *    leaving an operator-pinned `constant`/`manual` link active.
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

const CONFIRMED = { confirmedBy: "op@example.test", confirmedAt: new Date("2026-07-19T00:00:00Z") };

suite("SS-16 ScopeLifecycleService (requires Postgres)", () => {
  let db: Database;

  beforeAll(async () => {
    db = createDb(resolveDatabaseUrl(process.env));
    await runMigrations(db);
  });

  afterAll(async () => {
    await closeDb(db);
  });

  function deps(): ScopeLifecycleService {
    return new ScopeLifecycleService({
      resourceBindings: new ResourceBindingRepository(db),
      scopeCorrespondences: new ScopeCorrespondenceRepository(db),
      scopeLinks: new ScopeLinkRepository(db),
    });
  }

  // ── SS-16.2 (+ SS-19) — revalidateSpecBindings persists a ref unconfirmed ──────

  describe("revalidateSpecBindings", () => {
    const appId = randomUUID();
    const specId = randomUUID();
    const bindingId = randomUUID();
    const at = new Date("2026-07-19T00:00:00.000Z");

    const app: RegisteredApp = {
      id: appId,
      name: "Gitea",
      status: "active",
      baseUrl: "https://gitea.example.test",
      capabilities: {
        supportsPolling: true,
        supportsDeltaQuery: false,
        supportsChangeTimestamps: false,
        defaultPollInterval: 60000,
      },
      createdAt: at,
    };
    const spec: ApiSpec = {
      id: specId,
      appId,
      role: "PROVIDER",
      rawDocument: { openapi: "3.1.0", info: { title: "Gitea", version: "1" } },
      parsedIR: [],
      analysisExclusions: [],
      version: 1,
      contentHash: "sha256:ss16-lifecycle-bindings",
      status: "active",
      createdAt: at,
    };
    // A confirmed scoped `issues` binding: native id `id`, address `number`, scope owner/repo.
    const binding: ResourceBinding = {
      id: bindingId,
      apiSpecId: specId,
      resourceRef: "issues",
      nativeIdRef: { value: { kind: "field", path: "id" }, ...CONFIRMED },
      recordAddressRef: { value: { kind: "field", path: "number" }, ...CONFIRMED },
      collectionReadRef: { value: { kind: "operation", operationId: "issueList" }, ...CONFIRMED },
      scopePathBindings: [
        { kind: "constant", parameterName: "owner", value: "alice", ...CONFIRMED },
        { kind: "constant", parameterName: "repo", value: "phoenix", ...CONFIRMED },
      ],
    };

    beforeAll(async () => {
      await tx(db, async (txn) => {
        await new RegisteredAppRepository(txn).create(app);
        await new ApiSpecRepository(txn).create(spec);
        await new ResourceBindingRepository(txn).createMany([binding]);
      });
    });

    afterAll(async () => {
      await db
        .delete(resourceBindingRef)
        .where(eq(resourceBindingRef.resourceBindingId, bindingId));
      await db.delete(resourceBinding).where(eq(resourceBinding.apiSpecId, specId));
      await db.delete(apiSpec).where(eq(apiSpec.id, specId));
      await db.delete(registeredApp).where(eq(registeredApp.id, appId));
    });

    it("returns recordAddressRef to unconfirmed (persisted) when its address field breaks", async () => {
      // The re-ingested IR drops the `number` (address) field and the `issueList` op keeps
      // owner/repo scope, so recordAddressRef + collectionReadRef both break.
      const newIr: Ir = [
        {
          resourceRef: "issues",
          name: "issues",
          operations: [
            {
              operationId: "issuesIndex", // renamed from issueList
              method: "get",
              path: "/repos/{owner}/{repo}/issues",
              parameters: [
                { name: "owner", location: "path", required: true },
                { name: "repo", location: "path", required: true },
              ],
            },
          ],
          schemas: [{ name: "Issue", fields: [{ name: "id", type: "integer", required: true }] }],
          crossResourceRefs: [],
        },
      ];

      const result = await deps().revalidateSpecBindings(specId, newIr);

      // Findings name the broken refs (SS-16.2 + SS-19).
      const refs = result.findings
        .filter((f) => f.kind === "binding-ref-invalidated")
        .map((f) => f.ref);
      expect(refs).toContain("recordAddressRef");
      expect(refs).toContain("collectionReadRef");

      // Reload independently: the confirmed address ref is now UNCONFIRMED but retained —
      // the stored state the runtime reads as "paused", and NOT dropped (SS-19 guard).
      const reloaded = await new ResourceBindingRepository(db).getById(bindingId);
      expect(reloaded?.recordAddressRef?.value).toStrictEqual({ kind: "field", path: "number" });
      expect(reloaded?.recordAddressRef?.confirmedBy).toBeNull();
      // nativeIdRef `id` survived → carried forward confirmed (additive re-pin, SS-16.1).
      expect(reloaded?.nativeIdRef?.confirmedBy).toBe("op@example.test");
      // collectionReadRef re-pointed at the surviving list op, unconfirmed.
      expect(reloaded?.collectionReadRef?.value).toStrictEqual({
        kind: "operation",
        operationId: "issuesIndex",
      });
      expect(reloaded?.collectionReadRef?.confirmedBy).toBeNull();
    });
  });

  // ── SS-16.4/16.5 — revalidateCorrespondence archives links + RecordLink resolves ──

  describe("revalidateCorrespondence", () => {
    // `app_a_id`/`app_b_id` are `uuid` columns on both scope_link and record_link, so the
    // apps need real UUIDs; the direction-agnostic `resourcePairRef` is a text token and is
    // made unique per test so a row leaked by a mid-test throw cannot collide across tests.
    const APP_GITEA = randomUUID();
    const APP_VIKUNJA = randomUUID();

    function makeCorrespondence(id: string, pair: string): ScopeCorrespondence {
      return {
        id,
        resourcePairRef: pair,
        scopeIdentityKey: [{ sourceScopeKey: "owner", targetFieldPath: "title" }],
        targetContainerRef: { appId: APP_VIKUNJA, resourceRef: "projects" },
        sourceContainerRef: { appId: APP_GITEA, resourceRef: "repos" },
        ...CONFIRMED,
      };
    }
    function makeLink(corrId: string, pair: string, overrides: Partial<ScopeLink>): ScopeLink {
      return {
        id: randomUUID(),
        scopeCorrespondenceId: corrId,
        appAId: APP_GITEA,
        appAScopeKey: { owner: "alice", name: "phoenix" },
        appBId: APP_VIKUNJA,
        appBScopeKey: { id: "42" },
        resourcePairRef: pair,
        establishedBy: "identity-match",
        status: "active",
        createdAt: new Date("2026-07-19T00:00:00.000Z"),
        ...overrides,
      };
    }
    function makeRecordLink(scopeLinkId: string, pair: string): RecordLink {
      return {
        id: randomUUID(),
        appAId: APP_GITEA,
        appANativeId: "a-1",
        appBId: APP_VIKUNJA,
        appBNativeId: "b-1",
        resourcePairRef: pair,
        establishedBy: "identity-match",
        status: "active",
        establishingQueueKey: { kind: "identity-value", value: "issue-1" },
        scopeRef: { kind: "scope-link", scopeLinkId },
        createdAt: new Date("2026-07-19T00:00:00.000Z"),
        tombstonedAt: null,
      };
    }

    // The re-ingested sides: source keeps its container + capture; target IR drops `projects`.
    function sourceSide(): ScopeCorrespondenceSide {
      const issues: ResourceBinding = {
        id: randomUUID(),
        apiSpecId: "spec-gitea",
        resourceRef: "issues",
        sourceScopeRef: {
          components: [{ key: "owner", fieldPath: "repository.owner" }],
          ...CONFIRMED,
        },
        scopePathBindings: [],
      };
      return {
        appId: APP_GITEA,
        ir: [
          {
            resourceRef: "issues",
            name: "issues",
            operations: [],
            schemas: [
              {
                name: "Issue",
                fields: [{ name: "repository", type: "RepositoryMeta", required: true }],
              },
              {
                name: "RepositoryMeta",
                fields: [{ name: "owner", type: "string", required: true }],
              },
            ],
            crossResourceRefs: [],
          },
          {
            resourceRef: "repos",
            name: "repos",
            operations: [],
            schemas: [
              { name: "Repository", fields: [{ name: "id", type: "integer", required: true }] },
            ],
            crossResourceRefs: [],
          },
        ],
        bindings: [issues],
        resourceRef: "issues",
      };
    }
    const targetSideNoProjects: ScopeCorrespondenceSide = {
      appId: APP_VIKUNJA,
      ir: [], // `projects` container resource is GONE
      bindings: [],
      resourceRef: "tasks",
    };
    function targetSideNoTitle(): ScopeCorrespondenceSide {
      return {
        appId: APP_VIKUNJA,
        ir: [
          {
            resourceRef: "projects",
            name: "projects",
            operations: [],
            // `title` (the identity field) removed; only `id` remains.
            schemas: [
              { name: "Project", fields: [{ name: "id", type: "integer", required: true }] },
            ],
            crossResourceRefs: [],
          },
        ],
        bindings: [],
        resourceRef: "tasks",
      };
    }

    it("SS-16.5: a gone container → unconfirmed + ALL links archived; RecordLink.scopeRef still resolves", async () => {
      const corrId = randomUUID();
      const pair = `ss16-gone-${corrId}:issues|ss16-gone-${corrId}:tasks`;
      const corrRepo = new ScopeCorrespondenceRepository(db);
      const linkRepo = new ScopeLinkRepository(db);
      const recordRepo = new RecordLinkRepository(db);
      let record: RecordLink | undefined;

      try {
        await corrRepo.create(makeCorrespondence(corrId, pair));
        const idm = makeLink(corrId, pair, {
          establishedBy: "identity-match",
          appBScopeKey: { id: "42" },
        });
        const manual = makeLink(corrId, pair, {
          establishedBy: "manual",
          appBScopeKey: { id: "43" },
        });
        await linkRepo.create(idm);
        await linkRepo.create(manual);
        record = makeRecordLink(idm.id, pair);
        await recordRepo.insert(record);

        const result = await deps().revalidateCorrespondence(
          makeCorrespondence(corrId, pair),
          sourceSide(),
          targetSideNoProjects,
        );

        expect(result.findings.some((f) => f.kind === "container-resource-removed")).toBe(true);
        expect(result.archivedScopeLinks).toBe(2);

        // Correspondence returned to unconfirmed. The TARGET container vanished, so the
        // (still-present) source container ref is retained — dropping the source ref is the
        // separate source-gone case (unit-covered); either way the row is unconfirmed.
        const persisted = await corrRepo.getByResourcePair(pair);
        expect(persisted?.confirmedBy).toBeNull();
        expect(persisted?.sourceContainerRef).toBeDefined();

        // Both links ARCHIVED, never deleted.
        const links = await linkRepo.listByCorrespondence(corrId);
        expect(links).toHaveLength(2);
        expect(links.every((l) => l.status === "archived")).toBe(true);

        // SS-16.5 — the RecordLink.scopeRef still resolves its frozen container for a final delete/audit.
        const storedRecord = await recordRepo.getById(record.id);
        expect(storedRecord?.scopeRef).toStrictEqual({ kind: "scope-link", scopeLinkId: idm.id });
        const resolved = await linkRepo.getById(idm.id);
        expect(resolved?.status).toBe("archived");
        expect(resolved?.appBScopeKey).toStrictEqual({ id: "42" });
      } finally {
        if (record !== undefined) {
          await db.delete(recordLink).where(eq(recordLink.id, record.id));
        }
        await db.delete(scopeLink).where(eq(scopeLink.scopeCorrespondenceId, corrId));
        await db.delete(scopeCorrespondence).where(eq(scopeCorrespondence.id, corrId));
      }
    });

    it("SS-16.4: a scope-identity-key break archives ONLY identity-match links", async () => {
      const corrId = randomUUID();
      const pair = `ss16-idkey-${corrId}:issues|ss16-idkey-${corrId}:tasks`;
      const corrRepo = new ScopeCorrespondenceRepository(db);
      const linkRepo = new ScopeLinkRepository(db);

      try {
        await corrRepo.create(makeCorrespondence(corrId, pair));
        const idm = makeLink(corrId, pair, {
          establishedBy: "identity-match",
          appBScopeKey: { id: "42" },
        });
        const constant = makeLink(corrId, pair, {
          establishedBy: "constant",
          appBScopeKey: { id: "43" },
        });
        const manual = makeLink(corrId, pair, {
          establishedBy: "manual",
          appBScopeKey: { id: "44" },
        });
        await linkRepo.create(idm);
        await linkRepo.create(constant);
        await linkRepo.create(manual);

        const result = await deps().revalidateCorrespondence(
          makeCorrespondence(corrId, pair),
          sourceSide(),
          targetSideNoTitle(),
        );

        expect(
          result.findings.some(
            (f) =>
              f.kind === "scope-identity-key-invalidated" && f.issue === "target-field-removed",
          ),
        ).toBe(true);
        expect(result.archivedScopeLinks).toBe(1);

        const persisted = await corrRepo.getByResourcePair(pair);
        expect(persisted?.confirmedBy).toBeNull();

        const links = await linkRepo.listByCorrespondence(corrId);
        const byId = new Map(links.map((l) => [l.id, l.status]));
        expect(byId.get(idm.id)).toBe("archived");
        expect(byId.get(constant.id)).toBe("active");
        expect(byId.get(manual.id)).toBe("active");
      } finally {
        await db.delete(scopeLink).where(eq(scopeLink.scopeCorrespondenceId, corrId));
        await db.delete(scopeCorrespondence).where(eq(scopeCorrespondence.id, corrId));
      }
    });
  });
});
