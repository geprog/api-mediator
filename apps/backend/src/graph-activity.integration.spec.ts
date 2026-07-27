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
  eventOutbox,
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
  AuditLogEntry,
  GraphEdge,
  RegisteredApp,
  SyncRule,
} from "@mediator/domain";
import { DbSyncEventStore } from "@mediator/outbound";
import { PostgresEventBus } from "@mediator/event-bus";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { GraphActivity, GraphProjection } from "./modules/graph/index.js";

/**
 * Live-Postgres integration test for **GR-4 activity metadata**. Requires the compose
 * `postgres` service + a resolvable `DATABASE_URL`; excluded from `pnpm verify`, run via
 * `pnpm --filter @mediator/backend test:integration`.
 *
 * It proves — through the **real** {@link DownstreamArtifactRepository} monotonic
 * `jsonb_set(metadata,'{lastActivityAt}')` write and the real edge resolution joins — that:
 * - recording a real `sync-execution` `SyncEvent` through the **wired** {@link DbSyncEventStore}
 *   path advances the sync edge's `metadata.lastActivityAt` (and touches nothing else);
 * - a **stale redelivery** (older timestamp) never moves it backwards (monotonic);
 * - the disjoint adapter path advances an adapter-dependency edge from an `adapter-request`.
 */
let databaseUrl: string | undefined;
try {
  databaseUrl = resolveDatabaseUrl(process.env);
} catch {
  databaseUrl = undefined;
}
const suite = databaseUrl === undefined ? describe.skip : describe;

const CREATED_AT = new Date("2026-07-21T00:00:00.000Z");
const T1 = new Date("2026-07-21T09:00:00.000Z");
const T2 = new Date("2026-07-21T10:00:00.000Z");
const T3 = new Date("2026-07-21T11:00:00.000Z");

const APP_A = randomUUID();
const APP_B = randomUUID();
const SPEC_A = randomUUID();
const SPEC_B = randomUUID();
const PEER_MAPPING = randomUUID();
const RULE = randomUUID();

const CONSUMER = randomUUID();
const BACKEND = randomUUID();
const SPEC_CONSUMER = randomUUID();
const SPEC_BACKEND = randomUUID();
const CP_MAPPING = randomUUID();
const ENDPOINT = randomUUID();
const BINDING = randomUUID();

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
function ruleOf(id: string): SyncRule {
  return {
    id,
    approvedMappingId: PEER_MAPPING,
    resourcePairRef: "app-a:issues|app-b:tasks",
    status: "enabled",
  };
}
function endpointOf(id: string): AdapterEndpoint {
  return {
    id,
    consumerAppId: CONSUMER,
    consumerOperationId: "search/searchIssues",
    status: "active",
  };
}
function bindingOf(id: string): AdapterBinding {
  return {
    id,
    adapterEndpointId: ENDPOINT,
    backendAppId: BACKEND,
    backendOperationId: "issues/listIssues",
    approvedMappingId: CP_MAPPING,
    role: "primary",
    status: "active",
  };
}

function syncExecution(timestamp: Date): AuditLogEntry {
  return {
    id: randomUUID(),
    type: "sync-execution",
    actor: "sync-engine",
    status: "success",
    timestamp,
    relatedRuleId: RULE,
    originAppId: APP_B,
  };
}
function adapterRequest(timestamp: Date): AuditLogEntry {
  return {
    id: randomUUID(),
    type: "adapter-request",
    actor: `consumer-app:${CONSUMER}`,
    status: "success",
    timestamp,
    relatedBindingId: BINDING,
    relatedEndpointId: ENDPOINT,
  };
}

suite("GR-4 activity metadata integration (requires Postgres)", () => {
  let db: Database;
  let projection: GraphProjection;
  let activity: GraphActivity;

  async function cleanTables(): Promise<void> {
    await db.delete(syncRule);
    await db.delete(adapterBinding);
    await db.delete(adapterEndpoint);
    await db.delete(graphEdge);
    await db.delete(eventOutbox);
    await db.delete(auditLog);
    await db.delete(approvedMapping);
    await db.delete(apiSpec);
    await db.delete(registeredApp);
  }

  function readEdge(
    source: string,
    target: string,
    type: GraphEdge["type"],
  ): Promise<GraphEdge | undefined> {
    return new DownstreamArtifactRepository(db).getGraphEdge(source, target, type);
  }

  beforeAll(async () => {
    db = createDb(databaseUrl ?? "");
    await runMigrations(db);
    await cleanTables();

    projection = new GraphProjection({ db, newId: randomUUID });
    activity = new GraphActivity({ db });

    await tx(db, async (txn) => {
      const apps = new RegisteredAppRepository(txn);
      await apps.create(appOf(APP_A, "prov-a"));
      await apps.create(appOf(APP_B, "prov-b"));
      await apps.create(appOf(CONSUMER, "consumer"));
      await apps.create(appOf(BACKEND, "backend"));
      const specs = new ApiSpecRepository(txn);
      await specs.create(specOf(SPEC_A, APP_A, "PROVIDER"));
      await specs.create(specOf(SPEC_B, APP_B, "PROVIDER"));
      await specs.create(specOf(SPEC_CONSUMER, CONSUMER, "CONSUMER"));
      await specs.create(specOf(SPEC_BACKEND, BACKEND, "PROVIDER"));
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
      const artifacts = new DownstreamArtifactRepository(txn);
      await artifacts.insertSyncRuleIfAbsent(ruleOf(RULE));
      await artifacts.ensureAdapterEndpoint(endpointOf(ENDPOINT));
      await artifacts.insertAdapterBindingIfAbsent(bindingOf(BINDING));
    });
  });

  beforeEach(async () => {
    // Re-establish both edges (with lastActivityAt = null) before each case.
    await db.delete(graphEdge);
    await db.delete(eventOutbox);
    await db.delete(auditLog);
    await projection.recomputeSyncEdge(APP_A, APP_B);
    await projection.recomputeAdapterEdge(CONSUMER, BACKEND);
  });

  afterAll(async () => {
    await cleanTables();
    await closeDb(db);
  });

  it("GR-4.3: a freshly-projected edge has no last-activity until an event is recorded", async () => {
    expect((await readEdge(APP_A, APP_B, "sync"))?.metadata.lastActivityAt).toBeNull();
  });

  it("GR-4.1: recording a real sync-execution through DbSyncEventStore advances the sync edge, touching nothing else", async () => {
    const store = new DbSyncEventStore(db, new PostgresEventBus(), {
      onRecorded: (entry, handle) => activity.recordFromAuditEntryWithin(handle, entry),
    });

    const before = await readEdge(APP_A, APP_B, "sync");
    await store.record(syncExecution(T2));

    const after = await readEdge(APP_A, APP_B, "sync");
    expect(after?.metadata.lastActivityAt).toStrictEqual(T2);
    // Disjoint: the durable audit row exists, and status/direction/id are byte-preserved.
    expect(await db.select().from(auditLog)).toHaveLength(1);
    expect(after?.id).toBe(before?.id);
    expect(after?.status).toBe(before?.status);
    expect(after?.metadata.direction).toStrictEqual(before?.metadata.direction);
  });

  it("GR-4.2: a stale redelivery (older timestamp) never moves lastActivityAt backwards", async () => {
    const store = new DbSyncEventStore(db, new PostgresEventBus(), {
      onRecorded: (entry, handle) => activity.recordFromAuditEntryWithin(handle, entry),
    });

    await store.record(syncExecution(T2));
    await store.record(syncExecution(T1)); // slow redelivery, older
    expect((await readEdge(APP_A, APP_B, "sync"))?.metadata.lastActivityAt).toStrictEqual(T2);

    await store.record(syncExecution(T3)); // a genuinely newer event still advances
    expect((await readEdge(APP_A, APP_B, "sync"))?.metadata.lastActivityAt).toStrictEqual(T3);
  });

  it("advances an adapter-dependency edge from an adapter-request, monotonically", async () => {
    await activity.recordFromAuditEntry(adapterRequest(T2));
    expect(
      (await readEdge(CONSUMER, BACKEND, "adapter-dependency"))?.metadata.lastActivityAt,
    ).toStrictEqual(T2);

    await activity.recordFromAuditEntry(adapterRequest(T1)); // stale
    expect(
      (await readEdge(CONSUMER, BACKEND, "adapter-dependency"))?.metadata.lastActivityAt,
    ).toStrictEqual(T2);
    // The sync edge is untouched by an adapter-request (disjoint edges).
    expect((await readEdge(APP_A, APP_B, "sync"))?.metadata.lastActivityAt).toBeNull();
  });
});
