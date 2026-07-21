import { randomUUID } from "node:crypto";

import type { AppConfig } from "@mediator/config";
import { CredentialStore, DbCredentialPersistence, EnvKeyProvider } from "@mediator/credentials";
import type { DeadLetterQueueResponse, ReplayParkedWriteResponse } from "@mediator/contracts";
import {
  ApiSpecRepository,
  ApprovedMappingRepository,
  AuditLogRepository,
  DownstreamArtifactRepository,
  MappingArtifactsRepository,
  OrderingQueueRepository,
  RecordLinkRepository,
  RegisteredAppRepository,
  ResourceBindingRepository,
  apiSpec,
  approvedMapping,
  auditLog,
  closeDb,
  createDb,
  credential,
  fieldMapping,
  operationMapping,
  orderingQueue,
  parkedConflict,
  pollSnapshot,
  recordLink,
  registeredApp,
  resolveDatabaseUrl,
  resourceBinding,
  resourceBindingRef,
  runMigrations,
  syncFieldState,
  syncRule,
  tx,
  type Database,
} from "@mediator/db";
import type {
  ApiSpec,
  ApprovedMapping,
  ConfirmableRef,
  FieldMapping,
  IrOperation,
  IrResourceGroup,
  OperationMapping,
  RegisteredApp,
  ResourceBinding,
  SyncRule,
} from "@mediator/domain";
import type { OutboundRequest, OutboundResponse, ProtocolClient } from "@mediator/outbound";
import { buildChangePayload, type DetectedChange } from "@mediator/sync-engine";
import type { JsonRecord, JsonValue } from "@mediator/transform";
import { pino } from "pino";
import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { buildServer, type RunningServer } from "./composition-root.js";
import { buildSyncBackground, type SyncBackground } from "./modules/sync/background.js";
import {
  TEST_OPERATOR,
  TEST_OPERATOR_ACCOUNTS,
  TEST_VIEWER,
  injectAs,
} from "./testing/auth.testkit.js";

/**
 * Live-Postgres backend integration for **SA-5 — replay a parked (dead-letter) write**.
 * It stands up the real `buildSyncBackground` pipeline (only external HTTP is faked —
 * {@link FakeLandscape}), enables a rule so a record is linked with seeded baselines,
 * then **seeds a parked `ordering_queue` write** (the OC-4 dead-letter — enqueue → claim →
 * park through the real repo) carrying a real `DetectedChange`. It then drives the real
 * operator API (real auth, routes, {@link SyncOperatorService}) via Fastify `inject` and
 * asserts:
 *
 *  - SA-5.1 the dead-letter GET lists the parked write with record/rule context, its
 *    `superseded` flag, and **no raw payload value / credential** (data boundary);
 *  - SA-5.2 an operator replay **reactivates** the write, and driving the dispatcher
 *    (`runQueueOnce`) **re-runs the full pipeline** (the value lands in app B) — not a
 *    blind re-issue; the reactivation is attributed to the identity (OA-3);
 *  - SA-5.3 a **superseded** entry's replay is a no-op (nothing reactivated, nothing
 *    written);
 *  - the single-active-per-key guard blocks a replay while a same-key change is queued;
 *  - SA-5.4 a viewer is 403 on replay, but may read the queue.
 *
 * Requires the compose `postgres` service + a resolvable `DATABASE_URL`; excluded from
 * `pnpm verify`, run via `pnpm --filter @mediator/backend test:integration`.
 */
let databaseUrl: string | undefined;
try {
  databaseUrl = resolveDatabaseUrl(process.env);
} catch {
  databaseUrl = undefined;
}
const suite = databaseUrl === undefined ? describe.skip : describe;

// ── Fixture ids ──────────────────────────────────────────────────────────────
const APP_A = randomUUID();
const APP_B = randomUUID();
const SPEC_A = randomUUID();
const SPEC_B = randomUUID();
const MAPPING_AB = randomUUID();
const BINDING_A = randomUUID();
const BINDING_B = randomUUID();
const RULE_AB = randomUUID();
const CREATED_AT = new Date("2026-07-14T00:00:00.000Z");
const CONFIRMED_AT = new Date("2026-07-14T01:00:00.000Z");
const BASE_A = "https://app-a.test";
const BASE_B = "https://app-b.test";
const RESOURCE = "widgets";
const SOURCE_SECRET = "source-secret";
const TARGET_SECRET = "target-secret";

const RESOURCE_PAIR_REF = ((): string => {
  const tokenA = `${APP_A}:${RESOURCE}`;
  const tokenB = `${APP_B}:${RESOURCE}`;
  return tokenA <= tokenB ? `${tokenA}|${tokenB}` : `${tokenB}|${tokenA}`;
})();

// ── Fixture builders (mirror the SA-4 integration fixture) ─────────────────────
function appOf(id: string, name: string, baseUrl: string): RegisteredApp {
  return {
    id,
    name,
    status: "active",
    baseUrl,
    capabilities: {
      supportsPolling: true,
      supportsDeltaQuery: false,
      supportsChangeTimestamps: false,
      defaultPollInterval: 60_000,
    },
    createdAt: CREATED_AT,
  };
}

function op(operationId: string, method: IrOperation["method"], path: string): IrOperation {
  const parameters: IrOperation["parameters"] = path.includes("{id}")
    ? [{ name: "id", location: "path", required: true, type: "string" }]
    : [];
  return {
    operationId,
    method,
    path,
    parameters,
    responseSchema: {
      name: "Widget",
      fields: [
        { name: "id", type: "string", required: true },
        { name: "code", type: "string", required: true },
        { name: "name", type: "string", required: false },
        { name: "status", type: "string", required: false },
      ],
    },
  };
}

const WIDGET_GROUP: IrResourceGroup = {
  resourceRef: RESOURCE,
  name: "Widgets",
  operations: [
    op("listWidgets", "get", "/widgets"),
    op("getWidget", "get", "/widgets/{id}"),
    op("createWidget", "post", "/widgets"),
    op("updateWidget", "patch", "/widgets/{id}"),
    op("deleteWidget", "delete", "/widgets/{id}"),
  ],
  schemas: [],
  crossResourceRefs: [],
};

function specOf(id: string, appId: string): ApiSpec {
  return {
    id,
    appId,
    role: "PROVIDER",
    rawDocument: { openapi: "3.1.0" },
    parsedIR: [WIDGET_GROUP],
    analysisExclusions: [],
    version: 1,
    contentHash: `sha256:${id}`,
    status: "active",
    createdAt: CREATED_AT,
  };
}

function confirmedRef(value: ConfirmableRef["value"]): ConfirmableRef {
  return { value, confirmedBy: "operator", confirmedAt: CONFIRMED_AT };
}

function bindingOf(id: string, apiSpecId: string): ResourceBinding {
  return {
    id,
    apiSpecId,
    resourceRef: RESOURCE,
    nativeIdRef: confirmedRef({ kind: "field", path: "id" }),
    collectionReadRef: confirmedRef({ kind: "operation", operationId: "listWidgets" }),
  };
}

function mappingOf(): ApprovedMapping {
  return {
    id: MAPPING_AB,
    sourceSpecId: SPEC_A,
    targetSpecId: SPEC_B,
    sourceAppId: APP_A,
    targetAppId: APP_B,
    variant: "peer-peer",
    approvedBy: "operator",
    approvedAt: CREATED_AT,
    status: "active",
  };
}

function fieldsOf(): FieldMapping[] {
  return [
    {
      id: randomUUID(),
      mappingId: MAPPING_AB,
      sourcePath: "code",
      targetPath: "code",
      transform: "rename",
      isIdentityKey: true,
    },
    {
      id: randomUUID(),
      mappingId: MAPPING_AB,
      sourcePath: "name",
      targetPath: "name",
      transform: "rename",
    },
    {
      id: randomUUID(),
      mappingId: MAPPING_AB,
      sourcePath: "status",
      targetPath: "status",
      transform: "rename",
    },
  ];
}

function operationsOf(): OperationMapping[] {
  return [
    {
      id: randomUUID(),
      mappingId: MAPPING_AB,
      sourceOperationRef: `${RESOURCE}/createWidget`,
      targetOperationRef: `${RESOURCE}/createWidget`,
      action: "create",
    },
    {
      id: randomUUID(),
      mappingId: MAPPING_AB,
      sourceOperationRef: `${RESOURCE}/updateWidget`,
      targetOperationRef: `${RESOURCE}/updateWidget`,
      action: "update",
      targetIdParamRef: `${RESOURCE}/updateWidget#id`,
    },
  ];
}

function ruleOf(): SyncRule {
  return {
    id: RULE_AB,
    approvedMappingId: MAPPING_AB,
    resourcePairRef: RESOURCE_PAIR_REF,
    status: "disabled",
    backfillStatus: "pending",
    backfillMode: "link-only",
    pollOperationRef: `${RESOURCE}/listWidgets`,
  };
}

// ── Fake landscape (the ONLY thing faked: external HTTP) ────────────────────────
function resp(status: number, body: JsonValue | undefined): Promise<OutboundResponse> {
  return Promise.resolve({ status, headers: {}, body });
}
function asRecord(body: JsonValue | undefined): JsonRecord {
  return body !== null && typeof body === "object" && !Array.isArray(body) ? body : {};
}
class FakeLandscape implements ProtocolClient {
  public readonly appA = new Map<string, JsonRecord>();
  public readonly appB = new Map<string, JsonRecord>();
  public send(request: OutboundRequest): Promise<OutboundResponse> {
    const { method, url } = request;
    const isA = url.startsWith(BASE_A);
    const store = isA ? this.appA : this.appB;
    const path = url.slice((isA ? BASE_A : BASE_B).length);
    const bare = path.split("?")[0] ?? path;
    if (method === "GET" && bare === "/widgets") {
      return resp(200, [...store.values()]);
    }
    if (method === "GET" && bare.startsWith("/widgets/")) {
      const id = decodeURIComponent(bare.slice("/widgets/".length));
      const record = store.get(id);
      return record === undefined ? resp(404, undefined) : resp(200, record);
    }
    if (method === "POST" && bare === "/widgets") {
      const id = `gen-${String(this.appA.size + this.appB.size + 1)}`;
      const record: JsonRecord = { ...asRecord(request.body), id };
      store.set(id, record);
      return resp(200, record);
    }
    if (method === "PATCH" && bare.startsWith("/widgets/")) {
      const id = decodeURIComponent(bare.slice("/widgets/".length));
      const merged: JsonRecord = { ...(store.get(id) ?? {}), ...asRecord(request.body), id };
      store.set(id, merged);
      return resp(200, merged);
    }
    return resp(404, undefined);
  }
}

function testConfig(url: string): AppConfig {
  return {
    http: { port: 0 },
    adapterHttp: { port: 0 },
    database: { url },
    telemetry: { enabled: false },
    mappingLlm: {
      provider: "ollama",
      ollamaBaseUrl: "http://localhost:11434",
      model: "test",
      temperature: 0,
      thinking: false,
      requestTimeoutMs: 1_000,
      maxRetries: 0,
      reviewThreshold: 0.7,
    },
    credentials: { masterKey: Buffer.alloc(32, 7) },
    registration: { defaultPollInterval: 60_000 },
    auth: { accounts: [...TEST_OPERATOR_ACCOUNTS] },
    sync: { testPollTrigger: false },
  };
}

async function clearRuntimeState(db: Database): Promise<void> {
  await db.delete(orderingQueue);
  await db.delete(parkedConflict);
  await db.delete(syncFieldState);
  await db.delete(pollSnapshot);
  await db.delete(recordLink);
  await db.delete(auditLog);
  await db.delete(syncRule);
}
async function clearAll(db: Database): Promise<void> {
  await clearRuntimeState(db);
  await db.delete(credential);
  await db.delete(operationMapping);
  await db.delete(fieldMapping);
  await db.delete(resourceBindingRef);
  await db.delete(resourceBinding);
  await db.delete(approvedMapping);
  await db.delete(apiSpec);
  await db.delete(registeredApp);
}

const PARK_ERROR = "target write failed: 503";
const SEEDED_VALUE = "SENSITIVE-REPLAY-VALUE";

suite("SA-5 replay a parked (dead-letter) write — live Postgres", () => {
  let db: Database;
  let sync: SyncBackground;
  let server: RunningServer;
  let app: FastifyInstance;
  let landscape: FakeLandscape;
  const config = testConfig(databaseUrl ?? "");
  const logger: FastifyBaseLogger = pino({ level: "silent" });

  const links = (): RecordLinkRepository => new RecordLinkRepository(db);
  const audits = (): AuditLogRepository => new AuditLogRepository(db);
  const queue = (): OrderingQueueRepository => new OrderingQueueRepository(db);

  beforeAll(async () => {
    db = createDb(databaseUrl ?? "");
    await runMigrations(db);
    await clearAll(db);

    await tx(db, async (txn) => {
      const apps = new RegisteredAppRepository(txn);
      await apps.create(appOf(APP_A, "app-a", BASE_A));
      await apps.create(appOf(APP_B, "app-b", BASE_B));
      const specs = new ApiSpecRepository(txn);
      await specs.create(specOf(SPEC_A, APP_A));
      await specs.create(specOf(SPEC_B, APP_B));
      await new ResourceBindingRepository(txn).createMany([
        bindingOf(BINDING_A, SPEC_A),
        bindingOf(BINDING_B, SPEC_B),
      ]);
      const mappings = new ApprovedMappingRepository(txn);
      await mappings.insert(mappingOf());
      await new MappingArtifactsRepository(txn).replaceChildren(MAPPING_AB, {
        fieldMappings: fieldsOf(),
        operationMappings: operationsOf(),
        parameterMappings: [],
      });
    });

    const credentialStore = new CredentialStore(
      new DbCredentialPersistence(db),
      new EnvKeyProvider(config.credentials.masterKey),
    );
    await credentialStore.store(APP_A, { secret: { type: "apiKey", apiKey: SOURCE_SECRET } });
    await credentialStore.store(APP_B, { secret: { type: "apiKey", apiKey: TARGET_SECRET } });

    landscape = new FakeLandscape();
    sync = buildSyncBackground({ db, config, logger, protocolClient: landscape });
    server = buildServer({ config, db, logger, sync });
    app = server.app;
    await app.ready();
  });

  beforeEach(async () => {
    await clearRuntimeState(db);
    landscape.appA.clear();
    landscape.appB.clear();
    await new DownstreamArtifactRepository(db).insertSyncRuleIfAbsent(ruleOf());
  });

  afterAll(async () => {
    await sync.stop();
    await app.close();
    await clearAll(db);
    await closeDb(db);
  });

  /**
   * Enable link-only (links a1↔b1, seeds agreeing baselines), then **seed a parked
   * `ordering_queue` write** — enqueue → claim → park through the real repo — carrying a
   * real `DetectedChange` update of a1 whose `name` differs (a change with no later
   * change). Returns the link id + the parked entry id.
   */
  async function seedParkedUpdate(): Promise<{ linkId: string; parkedId: string }> {
    landscape.appA.set("a1", { id: "a1", code: "W-100", name: "Alpha", status: "open" });
    landscape.appB.set("b1", { id: "b1", code: "W-100", name: "Alpha", status: "open" });

    const enabled = await sync.enableRule(RULE_AB);
    if (enabled.kind !== "accepted") {
      throw new Error(`enable not accepted: ${enabled.kind}`);
    }
    await enabled.backfill;

    const link = await links().findActiveByRecord(RESOURCE_PAIR_REF, {
      appId: APP_A,
      nativeId: "a1",
    });
    if (link === undefined) {
      throw new Error("backfill did not link a1↔b1");
    }

    // The source record changed to a value with no later change — the exact case replay
    // exists for. The parked write carries it as the DetectedChange's observedRecord.
    landscape.appA.set("a1", { id: "a1", code: "W-100", name: SEEDED_VALUE, status: "open" });
    const change: DetectedChange = {
      ruleId: RULE_AB,
      mappingId: MAPPING_AB,
      sourceAppId: APP_A,
      targetAppId: APP_B,
      resourcePairRef: RESOURCE_PAIR_REF,
      sourceNativeId: "a1",
      changeKind: "update",
      observedRecord: { id: "a1", code: "W-100", name: SEEDED_VALUE, status: "open" },
    };

    // Seed the parked row exactly as the OC-4 dead-letter would: enqueue → claim → park.
    const repo = queue();
    const parkedId = await repo.enqueue(link.id, buildChangePayload(change));
    const claimed = await repo.claimNext({
      now: CREATED_AT,
      leaseExpiresAt: new Date(CREATED_AT.getTime() + 30_000),
      owner: "seed",
    });
    if (claimed?.id !== parkedId) {
      throw new Error("seed claim did not return the seeded entry");
    }
    await repo.park(parkedId, PARK_ERROR, "seed", new Date(CREATED_AT.getTime() + 1_000));
    return { linkId: link.id, parkedId };
  }

  it("SA-5.1/5.2 read the dead-letter queue, replay → reactivated + pipeline re-run + attributed; no payload value", async () => {
    const { parkedId } = await seedParkedUpdate();

    // SA-5.1 — the dead-letter GET carries record/rule context + the superseded flag,
    // and no raw payload value / credential (data boundary). Viewer may read.
    const queueRes = await injectAs(app, TEST_VIEWER, {
      method: "GET",
      url: "/api/dead-letter-writes",
    });
    expect(queueRes.statusCode).toBe(200);
    const body = queueRes.json<DeadLetterQueueResponse>();
    const dto = body.writes.find((w) => w.id === parkedId);
    expect(dto).toBeDefined();
    expect(dto?.ruleId).toBe(RULE_AB);
    expect(dto?.sourceNativeId).toBe("a1");
    expect(dto?.changeKind).toBe("update");
    expect(dto?.lastError).toBe(PARK_ERROR);
    expect(dto?.attempts).toBe(1);
    expect(dto?.superseded).toBe(false);
    // Data boundary — the seeded field value and credentials never appear.
    expect(queueRes.body).not.toContain(SEEDED_VALUE);
    expect(queueRes.body).not.toContain(SOURCE_SECRET);
    expect(queueRes.body).not.toContain(TARGET_SECRET);

    // SA-5.2 — operator replay reactivates the parked write.
    const replayRes = await injectAs(app, TEST_OPERATOR, {
      method: "POST",
      url: `/api/dead-letter-writes/${parkedId}/replay`,
    });
    expect(replayRes.statusCode).toBe(200);
    expect(replayRes.json<ReplayParkedWriteResponse>().outcome).toBe("reactivated");
    expect((await queue().getById(parkedId))?.status).toBe("pending");
    // Not yet written — reactivation only re-queues; the dispatcher re-runs the pipeline.
    expect(landscape.appB.get("b1")?.name).toBe("Alpha");

    // Driving the dispatcher re-runs the FULL pipeline against current state → app B written.
    await sync.runQueueOnce();
    expect(landscape.appB.get("b1")?.name).toBe(SEEDED_VALUE);
    expect((await queue().getById(parkedId))?.status).toBe("done");

    // OA-3 — the replay is attributed to the authenticated identity; the re-run recorded
    // its own success SyncEvent through the pipeline.
    const events = await audits().querySyncEvents({ relatedRuleId: RULE_AB, limit: 100 });
    expect(
      events.some(
        (e) => e.actor === TEST_OPERATOR.username && (e.details ?? "").includes("replay"),
      ),
    ).toBe(true);
    expect(events.some((e) => e.status === "success")).toBe(true);
  });

  it("SA-5.3 a superseded parked write is flagged and its replay is a no-op", async () => {
    const { linkId, parkedId } = await seedParkedUpdate();

    // A later same-key change runs to completion → supersedes the parked write.
    const repo = queue();
    const laterId = await repo.enqueue(
      linkId,
      buildChangePayload({
        ruleId: RULE_AB,
        mappingId: MAPPING_AB,
        sourceAppId: APP_A,
        targetAppId: APP_B,
        resourcePairRef: RESOURCE_PAIR_REF,
        sourceNativeId: "a1",
        changeKind: "update",
        observedRecord: { id: "a1", code: "W-100", name: "LaterValue", status: "open" },
      }),
    );
    const claimed = await repo.claimNext({
      now: new Date(CREATED_AT.getTime() + 2_000),
      leaseExpiresAt: new Date(CREATED_AT.getTime() + 32_000),
      owner: "later",
    });
    expect(claimed?.id).toBe(laterId);
    await repo.markDone(laterId, "later", new Date(CREATED_AT.getTime() + 3_000));

    // SA-5.3 — the dead-letter read flags it superseded.
    const queueRes = await injectAs(app, TEST_VIEWER, {
      method: "GET",
      url: "/api/dead-letter-writes",
    });
    expect(
      queueRes.json<DeadLetterQueueResponse>().writes.find((w) => w.id === parkedId)?.superseded,
    ).toBe(true);

    // Replay is a no-op (409 conflict) — nothing reactivated, nothing written. The
    // superseded verdict comes from the ATOMIC reactivate guard, not a separate read.
    const replayRes = await injectAs(app, TEST_OPERATOR, {
      method: "POST",
      url: `/api/dead-letter-writes/${parkedId}/replay`,
    });
    expect(replayRes.statusCode).toBe(409);
    expect((await queue().getById(parkedId))?.status).toBe("parked");
    await sync.runQueueOnce();
    expect(landscape.appB.get("b1")?.name).toBe("Alpha");
  });

  it("replay is blocked while another change for the same record is still queued (single-active-per-key)", async () => {
    const { linkId, parkedId } = await seedParkedUpdate();
    // A later same-key change is still queued (pending, non-terminal).
    await queue().enqueue(
      linkId,
      buildChangePayload({
        ruleId: RULE_AB,
        mappingId: MAPPING_AB,
        sourceAppId: APP_A,
        targetAppId: APP_B,
        resourcePairRef: RESOURCE_PAIR_REF,
        sourceNativeId: "a1",
        changeKind: "update",
        observedRecord: { id: "a1", code: "W-100", name: "Queued", status: "open" },
      }),
    );

    const replayRes = await injectAs(app, TEST_OPERATOR, {
      method: "POST",
      url: `/api/dead-letter-writes/${parkedId}/replay`,
    });
    expect(replayRes.statusCode).toBe(409);
    expect((await queue().getById(parkedId))?.status).toBe("parked");
  });

  it("SA-5.4 a viewer is 403 on replay (nothing changes)", async () => {
    const { parkedId } = await seedParkedUpdate();
    const res = await injectAs(app, TEST_VIEWER, {
      method: "POST",
      url: `/api/dead-letter-writes/${parkedId}/replay`,
    });
    expect(res.statusCode).toBe(403);
    expect((await queue().getById(parkedId))?.status).toBe("parked");
  });

  it("data boundary: a parked CREATE never leaks its identity-key value (the queue key) or field values", async () => {
    // A parked create has no link yet, so its ordering-queue key IS the identity-key
    // VALUE (a synced business key). The dead-letter read must never surface it.
    const IDENTITY_VALUE = "SECRET-SKU-9999";
    const change: DetectedChange = {
      ruleId: RULE_AB,
      mappingId: MAPPING_AB,
      sourceAppId: APP_A,
      targetAppId: APP_B,
      resourcePairRef: RESOURCE_PAIR_REF,
      sourceNativeId: "a-new",
      changeKind: "create",
      observedRecord: { id: "a-new", code: IDENTITY_VALUE, name: "SecretName", status: "open" },
    };
    const repo = queue();
    const parkedId = await repo.enqueue(IDENTITY_VALUE, buildChangePayload(change));
    const claimed = await repo.claimNext({
      now: CREATED_AT,
      leaseExpiresAt: new Date(CREATED_AT.getTime() + 30_000),
      owner: "seed",
    });
    expect(claimed?.id).toBe(parkedId);
    await repo.park(parkedId, PARK_ERROR, "seed", new Date(CREATED_AT.getTime() + 1_000));

    const res = await injectAs(app, TEST_VIEWER, { method: "GET", url: "/api/dead-letter-writes" });
    expect(res.statusCode).toBe(200);
    const dto = res.json<DeadLetterQueueResponse>().writes.find((w) => w.id === parkedId);
    expect(dto).toBeDefined();
    expect(dto?.changeKind).toBe("create");
    expect(dto?.sourceNativeId).toBe("a-new");
    // Neither the identity value (which is the queue key) nor any field value appears.
    expect(res.body).not.toContain(IDENTITY_VALUE);
    expect(res.body).not.toContain("SecretName");
  });

  it("replay of an absent entry → 404", async () => {
    const res = await injectAs(app, TEST_OPERATOR, {
      method: "POST",
      url: `/api/dead-letter-writes/${randomUUID()}/replay`,
    });
    expect(res.statusCode).toBe(404);
  });
});
