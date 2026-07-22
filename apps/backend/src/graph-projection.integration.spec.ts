import { randomUUID } from "node:crypto";

import {
  ApiSpecRepository,
  ApprovedMappingRepository,
  DownstreamArtifactRepository,
  RegisteredAppRepository,
  adapterBinding,
  adapterEndpoint,
  apiSpec,
  approvedMapping,
  auditLog,
  closeDb,
  createDb,
  graphEdge,
  registeredApp,
  resolveDatabaseUrl,
  runMigrations,
  syncRule,
  tx,
  type Database,
} from "@mediator/db";
import type {
  AdapterBinding,
  AdapterEndpoint,
  ApiSpec,
  ApprovedMapping,
  GraphEdge,
  RegisteredApp,
  SyncRule,
} from "@mediator/domain";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AdapterCompositionService } from "./modules/adapter-composition/index.js";
import { GraphProjection } from "./modules/graph/index.js";

/**
 * Live-Postgres integration test for the **GR-2 + GR-3 incremental graph projection**.
 * Requires the compose `postgres` service + a resolvable `DATABASE_URL`; excluded from
 * `pnpm verify`, run via `pnpm --filter @mediator/backend test:integration`.
 *
 * It proves the full **create → recompute → remove** lifecycle for one sync edge and
 * one adapter-dependency edge through the **real** {@link GraphProjection} +
 * {@link DownstreamArtifactRepository} ops (the real aggregate joins, the GR-1
 * update-in-place / remove-by-key), that a status recompute preserves
 * `metadata.lastActivityAt` and writes **no audit row**, and — end to end through the
 * **real** {@link AdapterCompositionService} — that resolving the CO-6 marker actually
 * moves the edge (a disabled endpoint pauses its adapter-dependency edge, re-enabling
 * restores it).
 */
let databaseUrl: string | undefined;
try {
  databaseUrl = resolveDatabaseUrl(process.env);
} catch {
  databaseUrl = undefined;
}
const suite = databaseUrl === undefined ? describe.skip : describe;

const CREATED_AT = new Date("2026-07-21T00:00:00.000Z");

// Sync concern: a peer-peer direction APP_A → APP_B.
const APP_A = randomUUID();
const APP_B = randomUUID();
const SPEC_A = randomUUID();
const SPEC_B = randomUUID();
const PEER_MAPPING = randomUUID();
const RULE_1 = randomUUID();
const RULE_2 = randomUUID();

// Adapter lifecycle concern: consumer CONSUMER → backend BACKEND.
const CONSUMER = randomUUID();
const BACKEND = randomUUID();
const SPEC_CONSUMER = randomUUID();
const SPEC_BACKEND = randomUUID();
const CP_MAPPING = randomUUID();
const ENDPOINT_1 = randomUUID();
const BINDING_1 = randomUUID();
const BINDING_2 = randomUUID();

// CO-6 wiring concern (isolated on a second backend so it does not share an edge with
// the adapter-lifecycle concern): consumer CONSUMER → backend BACKEND_2.
const BACKEND_2 = randomUUID();
const SPEC_BACKEND_2 = randomUUID();
const WIRING_MAPPING = randomUUID();
const ENDPOINT_2 = randomUUID();
const WIRING_BINDING = randomUUID();

function appOf(id: string, name: string): RegisteredApp {
  return {
    id,
    name,
    status: "active",
    baseUrl: `https://${name}.example.test`,
    capabilities: {
      supportsPolling: true,
      supportsDeltaQuery: false,
      supportsChangeTimestamps: false,
      defaultPollInterval: 60000,
    },
    createdAt: CREATED_AT,
  };
}
function specOf(id: string, appId: string, role: ApiSpec["role"]): ApiSpec {
  return {
    id,
    appId,
    role,
    rawDocument: { openapi: "3.1.0" },
    parsedIR: [],
    analysisExclusions: [],
    version: 1,
    contentHash: `sha256:${id}`,
    status: "active",
    createdAt: CREATED_AT,
  };
}
function mappingOf(input: {
  readonly id: string;
  readonly sourceSpecId: string;
  readonly targetSpecId: string;
  readonly sourceAppId: string;
  readonly targetAppId: string;
  readonly variant: ApprovedMapping["variant"];
}): ApprovedMapping {
  return { ...input, approvedBy: "operator", approvedAt: CREATED_AT, status: "active" };
}
function syncRuleOf(id: string, resourcePairRef: string): SyncRule {
  return { id, approvedMappingId: PEER_MAPPING, resourcePairRef, status: "disabled" };
}
function endpointOf(id: string, consumerOperationId: string): AdapterEndpoint {
  return { id, consumerAppId: CONSUMER, consumerOperationId, status: "active" };
}
function bindingOf(input: {
  readonly id: string;
  readonly endpointId: string;
  readonly backendAppId: string;
  readonly backendOperationId: string;
  readonly approvedMappingId: string;
  readonly status: AdapterBinding["status"];
}): AdapterBinding {
  return {
    id: input.id,
    adapterEndpointId: input.endpointId,
    backendAppId: input.backendAppId,
    backendOperationId: input.backendOperationId,
    approvedMappingId: input.approvedMappingId,
    role: "primary",
    status: input.status,
  };
}

suite("GR-2/GR-3 incremental graph projection integration (requires Postgres)", () => {
  let db: Database;
  let projection: GraphProjection;

  async function cleanTables(): Promise<void> {
    await db.delete(syncRule);
    await db.delete(adapterBinding);
    await db.delete(adapterEndpoint);
    await db.delete(graphEdge);
    await db.delete(auditLog);
    await db.delete(approvedMapping);
    await db.delete(apiSpec);
    await db.delete(registeredApp);
  }

  beforeAll(async () => {
    db = createDb(databaseUrl ?? "");
    await runMigrations(db);
    await cleanTables();

    projection = new GraphProjection({ db, newId: randomUUID });

    await tx(db, async (txn) => {
      const apps = new RegisteredAppRepository(txn);
      await apps.create(appOf(APP_A, "prov-a"));
      await apps.create(appOf(APP_B, "prov-b"));
      await apps.create(appOf(CONSUMER, "consumer"));
      await apps.create(appOf(BACKEND, "backend"));
      await apps.create(appOf(BACKEND_2, "backend-2"));
      const specs = new ApiSpecRepository(txn);
      await specs.create(specOf(SPEC_A, APP_A, "PROVIDER"));
      await specs.create(specOf(SPEC_B, APP_B, "PROVIDER"));
      await specs.create(specOf(SPEC_CONSUMER, CONSUMER, "CONSUMER"));
      await specs.create(specOf(SPEC_BACKEND, BACKEND, "PROVIDER"));
      await specs.create(specOf(SPEC_BACKEND_2, BACKEND_2, "PROVIDER"));
      const mappings = new ApprovedMappingRepository(txn);
      await mappings.insert(
        mappingOf({
          id: PEER_MAPPING,
          sourceSpecId: SPEC_A,
          targetSpecId: SPEC_B,
          sourceAppId: APP_A,
          targetAppId: APP_B,
          variant: "peer-peer",
        }),
      );
      await mappings.insert(
        mappingOf({
          id: CP_MAPPING,
          sourceSpecId: SPEC_CONSUMER,
          targetSpecId: SPEC_BACKEND,
          sourceAppId: CONSUMER,
          targetAppId: BACKEND,
          variant: "consumer-provider",
        }),
      );
      await mappings.insert(
        mappingOf({
          id: WIRING_MAPPING,
          sourceSpecId: SPEC_CONSUMER,
          targetSpecId: SPEC_BACKEND_2,
          sourceAppId: CONSUMER,
          targetAppId: BACKEND_2,
          variant: "consumer-provider",
        }),
      );

      const artifacts = new DownstreamArtifactRepository(txn);
      // Sync: two disabled rules for the A → B direction.
      await artifacts.insertSyncRuleIfAbsent(syncRuleOf(RULE_1, "app-a:issues|app-b:tasks"));
      await artifacts.insertSyncRuleIfAbsent(syncRuleOf(RULE_2, "app-a:users|app-b:members"));
      // Adapter lifecycle: one active endpoint with one active binding to BACKEND.
      await artifacts.ensureAdapterEndpoint(endpointOf(ENDPOINT_1, "search/searchIssues"));
      await artifacts.insertAdapterBindingIfAbsent(
        bindingOf({
          id: BINDING_1,
          endpointId: ENDPOINT_1,
          backendAppId: BACKEND,
          backendOperationId: "issues/listIssues",
          approvedMappingId: CP_MAPPING,
          status: "active",
        }),
      );
      // CO-6 wiring: a second active endpoint with one active binding to BACKEND_2.
      await artifacts.ensureAdapterEndpoint(endpointOf(ENDPOINT_2, "detail/getIssue"));
      await artifacts.insertAdapterBindingIfAbsent(
        bindingOf({
          id: WIRING_BINDING,
          endpointId: ENDPOINT_2,
          backendAppId: BACKEND_2,
          backendOperationId: "issues/getIssue",
          approvedMappingId: WIRING_MAPPING,
          status: "active",
        }),
      );
    });
  });

  afterAll(async () => {
    await cleanTables();
    await closeDb(db);
  });

  function readEdge(
    source: string,
    target: string,
    type: GraphEdge["type"],
  ): Promise<GraphEdge | undefined> {
    return new DownstreamArtifactRepository(db).getGraphEdge(source, target, type);
  }

  it("sync edge lifecycle: create → enable → degrade → (activity preserved) → remove, with no audit row", async () => {
    // Create-if-absent: no edge exists yet; the first recompute creates it. All rules
    // disabled → the whole aggregate is paused (GR-2.1).
    await projection.recomputeSyncEdge(APP_A, APP_B);
    let edge = await readEdge(APP_A, APP_B, "sync");
    expect(edge?.status).toBe("paused");
    expect(edge?.metadata.direction).toStrictEqual({ sourceSpecId: SPEC_A, targetSpecId: SPEC_B });
    expect(edge?.metadata.lastActivityAt).toBeNull();
    const createdId = edge?.id;

    // Simulate GR-4 having stamped activity, so the recompute below can prove it is preserved.
    const activityAt = new Date("2026-07-20T09:30:00.000Z");
    await db
      .update(graphEdge)
      .set({
        metadata: {
          direction: { sourceSpecId: SPEC_A, targetSpecId: SPEC_B },
          lastActivityAt: activityAt,
        },
      })
      .where(eq(graphEdge.id, createdId ?? ""));

    // Enable both rules → recompute → active (GR-2.2), on the SAME row, activity preserved (GR-2.4).
    await db
      .update(syncRule)
      .set({ status: "enabled" })
      .where(eq(syncRule.approvedMappingId, PEER_MAPPING));
    await projection.recomputeSyncEdge(APP_A, APP_B);
    edge = await readEdge(APP_A, APP_B, "sync");
    expect(edge?.id).toBe(createdId);
    expect(edge?.status).toBe("active");
    expect(edge?.metadata.lastActivityAt).toStrictEqual(activityAt);

    // Disable one rule → mixed aggregate → degraded (GR-2.3).
    await db.update(syncRule).set({ status: "disabled" }).where(eq(syncRule.id, RULE_2));
    await projection.recomputeSyncEdge(APP_A, APP_B);
    expect((await readEdge(APP_A, APP_B, "sync"))?.status).toBe("degraded");

    // GR-3.6/GR-2.6 — the projection wrote NO audit row across all of the above.
    expect(await db.select().from(auditLog)).toHaveLength(0);

    // Last rule of the direction gone → empty aggregate → the edge is removed (GR-2.5).
    await db.delete(syncRule).where(eq(syncRule.approvedMappingId, PEER_MAPPING));
    await projection.recomputeSyncEdge(APP_A, APP_B);
    expect(await readEdge(APP_A, APP_B, "sync")).toBeUndefined();
  });

  it("adapter-dependency edge lifecycle: create → degrade → remove through the real ops", async () => {
    const auditBefore = (await db.select().from(auditLog)).length;

    // One active binding under an active endpoint → active (GR-3.1).
    await projection.recomputeAdapterEdge(CONSUMER, BACKEND);
    let edge = await readEdge(CONSUMER, BACKEND, "adapter-dependency");
    expect(edge?.status).toBe("active");
    expect(edge?.metadata.direction).toStrictEqual({
      sourceSpecId: SPEC_CONSUMER,
      targetSpecId: SPEC_BACKEND,
    });

    // Attach a second, proposed binding (same endpoint, same backend app) → degraded.
    await new DownstreamArtifactRepository(db).insertAdapterBindingIfAbsent(
      bindingOf({
        id: BINDING_2,
        endpointId: ENDPOINT_1,
        backendAppId: BACKEND,
        backendOperationId: "issues/searchIssues",
        approvedMappingId: CP_MAPPING,
        status: "proposed",
      }),
    );
    await projection.recomputeAdapterEdge(CONSUMER, BACKEND);
    expect((await readEdge(CONSUMER, BACKEND, "adapter-dependency"))?.status).toBe("degraded");

    // Remove every binding of the pair → empty aggregate → the edge is removed (GR-3.5).
    await db.delete(adapterBinding).where(eq(adapterBinding.adapterEndpointId, ENDPOINT_1));
    await projection.recomputeAdapterEdge(CONSUMER, BACKEND);
    edge = await readEdge(CONSUMER, BACKEND, "adapter-dependency");
    expect(edge).toBeUndefined();

    // The direct recompute path wrote no audit row.
    expect((await db.select().from(auditLog)).length).toBe(auditBefore);
  });

  it("CO-6 marker resolved end to end: disabling the endpoint pauses its edge via the real AdapterCompositionService (GR-3.2)", async () => {
    const service = new AdapterCompositionService({
      db,
      newId: randomUUID,
      graphProjection: projection,
    });

    // Establish the edge for the wiring endpoint (active binding, active endpoint).
    await projection.recomputeAdapterEdge(CONSUMER, BACKEND_2);
    expect((await readEdge(CONSUMER, BACKEND_2, "adapter-dependency"))?.status).toBe("active");

    // Disable the endpoint through the real service → the CO-6 status-mutation marker
    // now recomputes the edge → paused (previously it could only leave a stale edge).
    await service.setEndpointEnabled(ENDPOINT_2, false, "operator");
    expect((await readEdge(CONSUMER, BACKEND_2, "adapter-dependency"))?.status).toBe("paused");

    // Re-enable → the edge is restored to active.
    await service.setEndpointEnabled(ENDPOINT_2, true, "operator");
    expect((await readEdge(CONSUMER, BACKEND_2, "adapter-dependency"))?.status).toBe("active");
  });
});
