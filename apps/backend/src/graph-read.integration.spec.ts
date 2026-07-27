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
  ApiSpec,
  ApiSpecStatus,
  ApprovedMapping,
  RegisteredApp,
  RegisteredAppStatus,
  SyncRule,
} from "@mediator/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { GraphProjection, GraphService } from "./modules/graph/index.js";

/**
 * Live-Postgres integration test for the **GR-5 `getGraph` read**. Requires the compose
 * `postgres` service + a resolvable `DATABASE_URL`; excluded from `pnpm verify`, run via
 * `pnpm --filter @mediator/backend test:integration`.
 *
 * It proves — against the **real** `active`-spec node predicate + the materialized
 * `GraphEdge` set — the load-bearing GR-5.4 node-membership rule: a **disabled** (AL-1) app
 * is still a node with its edge rendering **paused**, while a **deregistered** (AL-2) app —
 * its every spec archived and its edges gone — is **absent from nodes and edges entirely**;
 * a **consumer-only** app is an ordinary node. It also checks the app/status/type filters
 * against the real projection.
 */
let databaseUrl: string | undefined;
try {
  databaseUrl = resolveDatabaseUrl(process.env);
} catch {
  databaseUrl = undefined;
}
const suite = databaseUrl === undefined ? describe.skip : describe;

const CREATED_AT = new Date("2026-07-21T00:00:00.000Z");

// A disabled (AL-1) app A synced to its still-active peer B; A keeps its active spec.
const DISABLED_APP = randomUUID();
const PEER_APP = randomUUID();
const SPEC_DISABLED = randomUUID();
const SPEC_PEER = randomUUID();
const PEER_MAPPING = randomUUID();
const RULE = randomUUID();
// A consumer-only app (ordinary node, no edges).
const CONSUMER_ONLY = randomUUID();
const SPEC_CONSUMER = randomUUID();
// A deregistered (AL-2) app: row retained as `disabled`, EVERY spec archived, no edges.
const DEREGISTERED_APP = randomUUID();
const SPEC_DEREGISTERED = randomUUID();

function appOf(id: string, name: string, status: RegisteredAppStatus): RegisteredApp {
  return {
    id,
    name,
    status,
    capabilities: {
      supportsPolling: true,
      supportsDeltaQuery: false,
      supportsChangeTimestamps: false,
      defaultPollInterval: 60000,
    },
    createdAt: CREATED_AT,
  };
}
function specOf(id: string, appId: string, role: ApiSpec["role"], status: ApiSpecStatus): ApiSpec {
  return {
    id,
    appId,
    role,
    rawDocument: { openapi: "3.1.0" },
    parsedIR: [],
    analysisExclusions: [],
    version: 1,
    contentHash: `sha256:${id}`,
    status,
    createdAt: CREATED_AT,
  };
}
function ruleOf(id: string): SyncRule {
  return {
    id,
    approvedMappingId: PEER_MAPPING,
    resourcePairRef: "a:issues|b:tasks",
    status: "enabled",
  };
}

suite("GR-5 getGraph read integration (requires Postgres)", () => {
  let db: Database;
  let graph: GraphService;

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

    graph = new GraphService({ db });
    const projection = new GraphProjection({ db, newId: randomUUID });

    await tx(db, async (txn) => {
      const apps = new RegisteredAppRepository(txn);
      // A is DISABLED (AL-1) — stays a node, its edge renders paused.
      await apps.create(appOf(DISABLED_APP, "prov-a", "disabled"));
      await apps.create(appOf(PEER_APP, "prov-b", "active"));
      await apps.create(appOf(CONSUMER_ONLY, "consumer", "active"));
      // D was DEREGISTERED (AL-2): its row is retained as `disabled`.
      await apps.create(appOf(DEREGISTERED_APP, "gone", "disabled"));

      const specs = new ApiSpecRepository(txn);
      await specs.create(specOf(SPEC_DISABLED, DISABLED_APP, "PROVIDER", "active"));
      await specs.create(specOf(SPEC_PEER, PEER_APP, "PROVIDER", "active"));
      await specs.create(specOf(SPEC_CONSUMER, CONSUMER_ONLY, "CONSUMER", "active"));
      // AL-2 archived EVERY spec of the deregistered app → it has zero active specs.
      await specs.create(specOf(SPEC_DEREGISTERED, DEREGISTERED_APP, "PROVIDER", "archived"));

      const mappings = new ApprovedMappingRepository(txn);
      await mappings.insert({
        id: PEER_MAPPING,
        sourceSpecId: SPEC_DISABLED,
        targetSpecId: SPEC_PEER,
        sourceAppId: DISABLED_APP,
        targetAppId: PEER_APP,
        variant: "peer-peer",
        approvedBy: "operator",
        approvedAt: CREATED_AT,
        status: "active",
      } satisfies ApprovedMapping);

      await new DownstreamArtifactRepository(txn).insertSyncRuleIfAbsent(ruleOf(RULE));
    });

    // Materialize the sync edge; A is disabled → the edge renders paused (AL-1.5).
    await projection.recomputeSyncEdge(DISABLED_APP, PEER_APP);
  });

  afterAll(async () => {
    await cleanTables();
    await closeDb(db);
  });

  it("GR-5.1/GR-5.4: nodes are the active-spec members — disabled + consumer-only present, deregistered absent", async () => {
    const { nodes } = await graph.getGraph();
    const nodeIds = nodes.map((n) => n.id);

    expect(nodeIds).toContain(DISABLED_APP); // AL-1 disabled app: still a node
    expect(nodeIds).toContain(PEER_APP);
    expect(nodeIds).toContain(CONSUMER_ONLY); // consumer-only: ordinary node
    expect(nodeIds).not.toContain(DEREGISTERED_APP); // AL-2 deregistered: gone from nodes
    // The disabled node keeps its RegisteredApp.status; membership is by active-spec, not status.
    expect(nodes.find((n) => n.id === DISABLED_APP)?.status).toBe("disabled");
  });

  it("GR-5.4: the disabled app's sync edge is present and rendered paused (disable does not remove it)", async () => {
    const { edges } = await graph.getGraph();
    const edge = edges.find(
      (e) => e.sourceNodeId === DISABLED_APP && e.targetNodeId === PEER_APP && e.type === "sync",
    );
    expect(edge).toBeDefined();
    expect(edge?.status).toBe("paused");
    // The deregistered app is in no edge either.
    expect(
      edges.some((e) => e.sourceNodeId === DEREGISTERED_APP || e.targetNodeId === DEREGISTERED_APP),
    ).toBe(false);
  });

  it("GR-5.2: a type filter returns only matching edges; a status filter narrows accordingly", async () => {
    expect((await graph.getGraph({ type: "adapter-dependency" })).edges).toHaveLength(0);
    expect((await graph.getGraph({ type: "sync" })).edges).toHaveLength(1);
    expect((await graph.getGraph({ status: "paused" })).edges).toHaveLength(1);
    expect((await graph.getGraph({ status: "active" })).edges).toHaveLength(0);
  });

  it("GR-5.2: an app filter focuses on the app's neighbourhood", async () => {
    const focused = await graph.getGraph({ appId: DISABLED_APP });
    expect(focused.nodes.map((n) => n.id).sort()).toStrictEqual([DISABLED_APP, PEER_APP].sort());
    expect(focused.edges).toHaveLength(1);
    // Filtering on the deregistered app yields an empty subgraph (not a member, no edges).
    const gone = await graph.getGraph({ appId: DEREGISTERED_APP });
    expect(gone.nodes).toHaveLength(0);
    expect(gone.edges).toHaveLength(0);
  });
});
