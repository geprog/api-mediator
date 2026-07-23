import { randomUUID } from "node:crypto";

import {
  ApiSpecRepository,
  ApprovedMappingRepository,
  AuditLogRepository,
  DownstreamArtifactRepository,
  RegisteredAppRepository,
  ResourceBindingRepository,
  ScopeCorrespondenceRepository,
  ScopeLinkRepository,
  SyncRuleRepository,
  apiSpec,
  closeDb,
  createDb,
  registeredApp,
  resolveDatabaseUrl,
  tx,
  type Database,
  type DbHandle,
} from "@mediator/db";
import type { ApiSpec, RegisteredApp } from "@mediator/domain";
import { buildIr, computeContentHash } from "@mediator/ir";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { CredentialTxStore, TxStores } from "./modules/persistence.js";
import { SpecRegistry } from "./modules/spec-registry.js";
import { ScopeLifecycleService } from "./modules/sync/scope-lifecycle.js";
import { providerSpecDocument } from "./testing/sample-specs.testkit.js";

/**
 * SL-1 — live-Postgres backend integration for {@link SpecRegistry.ingestNewVersion}:
 * the persistence-touching behaviours the in-memory unit tests cannot fully prove
 * against a real database:
 *
 *  - **SL-1.1** ingesting a v2 for a lineage that already has an `active` v1 stores v2
 *    (`version = 2`, `status = active`) and marks v1 `superseded` — the lineage's
 *    single active version advances;
 *  - **SL-1.5** an identical-`contentHash` re-submit of the active version is a no-op:
 *    no new row, the active version untouched.
 *
 * Requires the compose `postgres` service + a resolvable `DATABASE_URL`; excluded from
 * `pnpm verify`, run via `pnpm --filter @mediator/backend test:integration`.
 * Self-skips when `DATABASE_URL` is unresolvable.
 */
let databaseUrl: string | undefined;
try {
  databaseUrl = resolveDatabaseUrl(process.env);
} catch {
  databaseUrl = undefined;
}
const suite = databaseUrl === undefined ? describe.skip : describe;

/**
 * Storing credentials is never part of a version advance (SL-1/SL-2), so the credential
 * port rejects — the test fails loudly if that ever changes. (Bindings/mappings/audit
 * *are* touched by the SL-2 additive reaction and use real repositories below; these SL-1
 * fixtures seed no mappings and no v1 bindings, so that reaction is a no-op here.)
 */
const unusedCredentials: CredentialTxStore = {
  store: () => Promise.reject(new Error("unused")),
};

suite("SL-1 SpecRegistry.ingestNewVersion (requires Postgres)", () => {
  let db: Database;
  const registry = new SpecRegistry();
  const createdAppIds: string[] = [];

  beforeAll(() => {
    db = createDb(resolveDatabaseUrl(process.env));
  });

  afterAll(async () => {
    if (createdAppIds.length > 0) {
      await db.delete(apiSpec).where(inArray(apiSpec.appId, createdAppIds));
      await db.delete(registeredApp).where(inArray(registeredApp.id, createdAppIds));
    }
    await closeDb(db);
  });

  /** Seed a provider app + its `active` v1 `ApiSpec` directly (no bindings, no event). */
  async function seedAppWithV1(): Promise<{ app: RegisteredApp; v1: ApiSpec }> {
    const app: RegisteredApp = {
      id: randomUUID(),
      name: `SL-1 advance ${randomUUID()}`,
      status: "active",
      baseUrl: "https://sl1.example.test",
      capabilities: {
        supportsPolling: true,
        supportsDeltaQuery: false,
        supportsChangeTimestamps: true,
        defaultPollInterval: 60000,
      },
      createdAt: new Date(),
    };
    createdAppIds.push(app.id);
    await new RegisteredAppRepository(db).create(app);

    const document = providerSpecDocument();
    const v1: ApiSpec = {
      id: randomUUID(),
      appId: app.id,
      role: "PROVIDER",
      rawDocument: document,
      parsedIR: await buildIr(document),
      analysisExclusions: [],
      version: 1,
      contentHash: computeContentHash(document),
      status: "active",
      createdAt: new Date(),
    };
    await new ApiSpecRepository(db).create(v1);
    return { app, v1 };
  }

  /** The version-advance `TxStores` over one transaction handle (real repositories). */
  function txStoresOn(handle: DbHandle): TxStores {
    return {
      registeredApps: new RegisteredAppRepository(handle),
      apiSpecs: new ApiSpecRepository(handle),
      resourceBindings: new ResourceBindingRepository(handle),
      credentialStore: unusedCredentials,
      approvedMappings: new ApprovedMappingRepository(handle),
      audit: new AuditLogRepository(handle),
      // SL-1 isolates the version-advance + diff classification; the SL-3 scoped-delta
      // trigger has its own spec, so record no job here.
      detectionJobs: { enqueueScoped: (): Promise<void> => Promise.resolve() },
      // SL-4 breaking-reaction ports — these SL-1 fixtures seed no mappings, so the
      // breaking branch finds nothing to stale even when the diff classifies breaking.
      mappingArtifacts: {
        listFieldMappings: (): Promise<never[]> => Promise.resolve([]),
        listOperationMappings: (): Promise<never[]> => Promise.resolve([]),
      },
      downstreamArtifacts: new DownstreamArtifactRepository(handle),
      graph: {
        recomputeSyncEdge: (): Promise<void> => Promise.resolve(),
        recomputeAdapterEdge: (): Promise<void> => Promise.resolve(),
      },
      cacheInvalidator: { invalidateEndpoint: (): void => {} },
      // SL-5 operational-ref re-validation ports (real repos); these SL-1 fixtures seed no
      // bindings/rules/correspondences, so a breaking advance finds nothing to re-validate.
      syncRules: new SyncRuleRepository(handle),
      scopeCorrespondences: new ScopeCorrespondenceRepository(handle),
      scopeLifecycle: new ScopeLifecycleService({
        resourceBindings: new ResourceBindingRepository(handle),
        scopeCorrespondences: new ScopeCorrespondenceRepository(handle),
        scopeLinks: new ScopeLinkRepository(handle),
      }),
      emit: () =>
        Promise.reject(new Error("ingestNewVersion must not emit SpecIngested on advance")),
    };
  }

  it("stores v2 active and supersedes v1 on a changed re-ingest", async () => {
    const { app, v1 } = await seedAppWithV1();

    // v2 adds an optional `priority` field → an additive diff.
    const v2doc = providerSpecDocument() as {
      components: { schemas: { Issue: { properties: Record<string, unknown> } } };
    };
    v2doc.components.schemas.Issue.properties["priority"] = { type: "string" };

    const outcome = await tx(db, (handle) =>
      registry.ingestNewVersion(app.id, v2doc, "PROVIDER", txStoresOn(handle)),
    );

    expect(outcome.kind).toBe("advanced");
    if (outcome.kind !== "advanced") throw new Error("expected advanced");
    expect(outcome.diff.classification).toBe("additive");

    // Re-read straight from Postgres: v1 superseded, v2 the single active version 2.
    const rows = await db.select().from(apiSpec).where(eq(apiSpec.appId, app.id));
    const byId = new Map(rows.map((row) => [row.id, row]));
    expect(byId.get(v1.id)?.status).toBe("superseded");
    const v2row = byId.get(outcome.newSpec.id);
    expect(v2row?.version).toBe(2);
    expect(v2row?.status).toBe("active");
    expect(v2row?.contentHash).toBe(computeContentHash(v2doc));

    const active = await new ApiSpecRepository(db).findActiveByAppAndRole(app.id, "PROVIDER");
    expect(active?.id).toBe(outcome.newSpec.id);
  });

  it("is a no-op on an identical-contentHash re-submit of the active version (SL-1.5)", async () => {
    const { app, v1 } = await seedAppWithV1();

    const outcome = await tx(db, (handle) =>
      registry.ingestNewVersion(app.id, providerSpecDocument(), "PROVIDER", txStoresOn(handle)),
    );

    expect(outcome.kind).toBe("unchanged");
    if (outcome.kind !== "unchanged") throw new Error("expected unchanged");
    expect(outcome.activeSpec.id).toBe(v1.id);

    // No new version row; v1 stays active version 1.
    const rows = await db.select().from(apiSpec).where(eq(apiSpec.appId, app.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("active");
    expect(rows[0]?.version).toBe(1);
  });
});
