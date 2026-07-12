import { randomUUID } from "node:crypto";

import type {
  AdapterBinding,
  AdapterEndpoint,
  ApiSpec,
  ApprovedMapping,
  GraphEdge,
  RegisteredApp,
  SyncRule,
} from "@mediator/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closeDb, createDb, tx, type Database } from "./client.js";
import { resolveDatabaseUrl } from "./env.js";
import { runMigrations } from "./migrate.js";
import {
  ApiSpecRepository,
  ApprovedMappingRepository,
  DownstreamArtifactRepository,
  MappingArtifactsRepository,
  RegisteredAppRepository,
} from "./repositories/index.js";
import {
  adapterBinding,
  adapterEndpoint,
  apiSpec,
  approvedMapping,
  graphEdge,
  registeredApp,
  syncRule,
} from "./schema.js";

/**
 * Live-database integration test for the Phase-3 downstream-artifact persistence
 * (AI-1..AI-3). Requires the compose `postgres` service + a resolvable
 * `DATABASE_URL`; excluded from `pnpm verify`, run via
 * `pnpm --filter @mediator/db test:integration`.
 *
 * Proves the real Drizzle repo's insert-if-absent / ensure-exists / upsert
 * semantics against a freshly migrated schema (chain 0000→0009): the
 * idempotent `SyncRule`/`AdapterBinding`/`GraphEdge` writes, the endpoint
 * ensure-exists (reuse, never duplicate), the incremental upsert (existing rows
 * untouched), and the reconciliation query. It is the live counterpart to the
 * fake-backed unit tests (the fakes mirror exactly these semantics).
 */
let databaseUrl: string | undefined;
try {
  databaseUrl = resolveDatabaseUrl(process.env);
} catch {
  databaseUrl = undefined;
}
const suite = databaseUrl === undefined ? describe.skip : describe;

const APP_A = randomUUID(); // provider (peer source)
const APP_B = randomUUID(); // provider (peer target)
const APP_C = randomUUID(); // consumer
const SPEC_A = randomUUID();
const SPEC_B = randomUUID();
const SPEC_C = randomUUID();
const PEER_MAPPING = randomUUID();
const CP_MAPPING = randomUUID();
const EMPTY_MAPPING = randomUUID(); // active, has a child, no artifacts → the one to reconcile
const CREATED_AT = new Date("2026-07-12T00:00:00.000Z");

// Fixed artifact ids (real UUIDs — the id columns are `uuid`). The `_DUP` ids are
// the "second write, same natural key, different id" that ON CONFLICT DO NOTHING
// must ignore (keeping the original id).
const RULE_1 = randomUUID();
const RULE_1_DUP = randomUUID();
const RULE_2 = randomUUID();
const ENDPOINT_1 = randomUUID();
const ENDPOINT_1_DUP = randomUUID();
const BINDING_1 = randomUUID();
const BINDING_1_DUP = randomUUID();
const EDGE_1 = randomUUID();
const EDGE_1_DUP = randomUUID();

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
  return {
    ...input,
    approvedBy: "operator",
    approvedAt: CREATED_AT,
    status: "active",
  };
}

function syncRuleOf(id: string, resourcePairRef: string): SyncRule {
  return { id, approvedMappingId: PEER_MAPPING, resourcePairRef, status: "disabled" };
}
function endpointCandidate(id: string, consumerOperationId: string): AdapterEndpoint {
  return { id, consumerAppId: APP_C, consumerOperationId, status: "composition-required" };
}
function bindingOf(id: string, endpointId: string, backendOperationId: string): AdapterBinding {
  return {
    id,
    adapterEndpointId: endpointId,
    backendAppId: APP_A,
    backendOperationId,
    approvedMappingId: CP_MAPPING,
    role: "primary",
    status: "proposed",
  };
}
function syncEdgeOf(id: string): GraphEdge {
  return {
    id,
    sourceNodeId: APP_A,
    targetNodeId: APP_B,
    type: "sync",
    status: "disabled",
    metadata: { direction: { sourceSpecId: SPEC_A, targetSpecId: SPEC_B }, lastActivityAt: null },
  };
}

suite("Phase-3 downstream-artifact persistence integration (requires Postgres)", () => {
  let db: Database;

  beforeAll(async () => {
    db = createDb(databaseUrl ?? "");
    await runMigrations(db);

    // Clean slate for the tables this suite touches (children first, FK order).
    await db.delete(syncRule);
    await db.delete(adapterBinding);
    await db.delete(adapterEndpoint);
    await db.delete(graphEdge);
    await db.delete(approvedMapping);
    await db.delete(apiSpec);
    await db.delete(registeredApp);

    await tx(db, async (txn) => {
      const apps = new RegisteredAppRepository(txn);
      await apps.create(appOf(APP_A, "prov-a"));
      await apps.create(appOf(APP_B, "prov-b"));
      await apps.create(appOf(APP_C, "consumer-c"));
      const specs = new ApiSpecRepository(txn);
      await specs.create(specOf(SPEC_A, APP_A, "PROVIDER"));
      await specs.create(specOf(SPEC_B, APP_B, "PROVIDER"));
      await specs.create(specOf(SPEC_C, APP_C, "CONSUMER"));
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
          sourceSpecId: SPEC_C,
          targetSpecId: SPEC_A,
          sourceAppId: APP_C,
          targetAppId: APP_A,
          variant: "consumer-provider",
        }),
      );
      // An active peer mapping with children (a field pair) but no artifacts yet.
      // Uses the REVERSE directional spec pair (B→A) so it does not collide with
      // PEER_MAPPING (A→B) on the active-direction unique index.
      await mappings.insert(
        mappingOf({
          id: EMPTY_MAPPING,
          sourceSpecId: SPEC_B,
          targetSpecId: SPEC_A,
          sourceAppId: APP_B,
          targetAppId: APP_A,
          variant: "peer-peer",
        }),
      );
      await new MappingArtifactsRepository(txn).replaceChildren(EMPTY_MAPPING, {
        fieldMappings: [
          {
            id: randomUUID(),
            mappingId: EMPTY_MAPPING,
            sourcePath: "issues/title",
            targetPath: "tasks/title",
            transform: "rename",
          },
        ],
        operationMappings: [],
        parameterMappings: [],
      });
    });
  });

  afterAll(async () => {
    await db.delete(syncRule);
    await db.delete(adapterBinding);
    await db.delete(adapterEndpoint);
    await db.delete(graphEdge);
    await db.delete(approvedMapping);
    await db.delete(apiSpec);
    await db.delete(registeredApp);
    await closeDb(db);
  });

  it("insertSyncRuleIfAbsent persists a disabled rule and is idempotent by (mapping, resourcePairRef)", async () => {
    const repo = new DownstreamArtifactRepository(db);
    const ref = "app-a:issues|app-b:tasks";
    await repo.insertSyncRuleIfAbsent(syncRuleOf(RULE_1, ref));
    // Redelivery: same natural key, different id → DO NOTHING keeps the original.
    await repo.insertSyncRuleIfAbsent(syncRuleOf(RULE_1_DUP, ref));

    const rules = await repo.listSyncRulesByMapping(PEER_MAPPING);
    expect(rules).toHaveLength(1);
    expect(rules[0]?.id).toBe(RULE_1);
    expect(rules[0]?.status).toBe("disabled");
    expect(rules[0]?.resourcePairRef).toBe(ref);
  });

  it("upserts on an incremental approval: adds a new resource pair, leaves the existing rule untouched", async () => {
    const repo = new DownstreamArtifactRepository(db);
    await repo.insertSyncRuleIfAbsent(syncRuleOf(RULE_2, "app-a:users|app-b:members"));

    const rules = await repo.listSyncRulesByMapping(PEER_MAPPING);
    expect(rules).toHaveLength(2);
    const byRef = new Map(rules.map((rule) => [rule.resourcePairRef, rule]));
    expect(byRef.get("app-a:issues|app-b:tasks")?.id).toBe(RULE_1); // untouched
    expect(byRef.get("app-a:users|app-b:members")?.id).toBe(RULE_2);
  });

  it("ensureAdapterEndpoint creates once, then reuses (never duplicates) the same consumer operation", async () => {
    const repo = new DownstreamArtifactRepository(db);
    const created = await repo.ensureAdapterEndpoint(
      endpointCandidate(ENDPOINT_1, "search/searchIssues"),
    );
    expect(created.id).toBe(ENDPOINT_1);

    // A later mapping ensures the same consumer operation with a DIFFERENT candidate
    // id → returns the existing endpoint, no duplicate row.
    const reused = await repo.ensureAdapterEndpoint(
      endpointCandidate(ENDPOINT_1_DUP, "search/searchIssues"),
    );
    expect(reused.id).toBe(ENDPOINT_1);

    const endpoints = await repo.listAdapterEndpointsByConsumerApp(APP_C);
    expect(endpoints).toHaveLength(1);
    expect(endpoints[0]?.status).toBe("composition-required");
  });

  it("insertAdapterBindingIfAbsent attaches a proposed binding and is idempotent", async () => {
    const repo = new DownstreamArtifactRepository(db);
    await repo.insertAdapterBindingIfAbsent(bindingOf(BINDING_1, ENDPOINT_1, "issues/listIssues"));
    await repo.insertAdapterBindingIfAbsent(
      bindingOf(BINDING_1_DUP, ENDPOINT_1, "issues/listIssues"),
    );

    const bindings = await repo.listAdapterBindingsByMapping(CP_MAPPING);
    expect(bindings).toHaveLength(1);
    expect(bindings[0]?.id).toBe(BINDING_1);
    expect(bindings[0]?.status).toBe("proposed");
    expect(bindings[0]?.role).toBe("primary");
    expect(bindings[0]?.adapterEndpointId).toBe(ENDPOINT_1);
  });

  it("upsertGraphEdge is ensure-exists: a repeat upsert keeps the original edge (no clobber)", async () => {
    const repo = new DownstreamArtifactRepository(db);
    await repo.upsertGraphEdge(syncEdgeOf(EDGE_1));
    await repo.upsertGraphEdge(syncEdgeOf(EDGE_1_DUP));

    const edge = await repo.getGraphEdge(APP_A, APP_B, "sync");
    expect(edge?.id).toBe(EDGE_1);
    expect(edge?.status).toBe("disabled");
    expect(edge?.metadata).toStrictEqual({
      direction: { sourceSpecId: SPEC_A, targetSpecId: SPEC_B },
      lastActivityAt: null,
    });
  });

  it("listActiveMappingIdsWithoutArtifacts finds only mappings with children and no artifacts", async () => {
    const repo = new DownstreamArtifactRepository(db);
    // PEER_MAPPING has sync rules; CP_MAPPING has a binding; both are instantiated.
    // EMPTY_MAPPING is active, has a field child, but no artifacts → the one to reconcile.
    const missing = await repo.listActiveMappingIdsWithoutArtifacts();
    expect(missing).toStrictEqual([EMPTY_MAPPING]);

    // Instantiate its rule → it drops out of the missing set (no infinite re-trigger).
    await repo.insertSyncRuleIfAbsent({
      id: randomUUID(),
      approvedMappingId: EMPTY_MAPPING,
      resourcePairRef: "app-a:issues|app-b:tasks",
      status: "disabled",
    });
    expect(await repo.listActiveMappingIdsWithoutArtifacts()).toStrictEqual([]);
  });
});
