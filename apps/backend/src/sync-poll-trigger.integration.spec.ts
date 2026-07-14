import { randomUUID } from "node:crypto";

import type { AppConfig } from "@mediator/config";
import { CredentialStore, DbCredentialPersistence, EnvKeyProvider } from "@mediator/credentials";
import {
  ApiSpecRepository,
  ApprovedMappingRepository,
  DownstreamArtifactRepository,
  MappingArtifactsRepository,
  OrderingQueueRepository,
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
import type { SyncRuleListResponse, TriggerPollResponse } from "@mediator/contracts";
import type { OutboundRequest, OutboundResponse, ProtocolClient } from "@mediator/outbound";
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
 * Live-Postgres backend integration for the **TEST/DEV-ONLY deterministic poll-trigger
 * endpoint** (`POST /api/sync-rules/:id/poll`, the SP-5 hook the SU-6 e2e drives). It
 * drives the real operator API (real auth, real routes, the real `SyncOperatorService`
 * over the real `buildSyncBackground` + repos) through Fastify `inject`, with only the
 * external HTTP faked by a {@link FakeLandscape}. It proves:
 *
 *  - **flag ON** — an operator `POST .../poll` on an enabled rule returns the
 *    `PollRunOutcome` (a completed cycle with an `enqueuedCount`), and the enqueued
 *    change then drives a full pipeline step (the target records the write);
 *  - **operator-only** — a `viewer` is 403 (OA-2);
 *  - **flag OFF** — the route is **absent** (a request 404s) even though the other sync
 *    routes are present, proving the production-safety gate: the poll trigger exists only
 *    when `sync.testPollTrigger` is set.
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
const MAPPING_BA = randomUUID();
const BINDING_A = randomUUID();
const BINDING_B = randomUUID();
const RULE_AB = randomUUID();
const RULE_BA = randomUUID();
const CREATED_AT = new Date("2026-07-13T00:00:00.000Z");
const CONFIRMED_AT = new Date("2026-07-13T01:00:00.000Z");
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

// ── Fixture builders (mirror sync-api.integration.spec.ts) ─────────────────────
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
  const parameters: IrOperation["parameters"] =
    method === "patch" ? [{ name: "id", location: "path", required: true, type: "string" }] : [];
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
    op("createWidget", "post", "/widgets"),
    op("updateWidget", "patch", "/widgets/{id}"),
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

function mappingOf(
  id: string,
  sourceSpec: string,
  targetSpec: string,
  sourceApp: string,
  targetApp: string,
): ApprovedMapping {
  return {
    id,
    sourceSpecId: sourceSpec,
    targetSpecId: targetSpec,
    sourceAppId: sourceApp,
    targetAppId: targetApp,
    variant: "peer-peer",
    approvedBy: "operator",
    approvedAt: CREATED_AT,
    status: "active",
  };
}

function fieldsOf(mappingId: string): FieldMapping[] {
  return [
    {
      id: randomUUID(),
      mappingId,
      sourcePath: "code",
      targetPath: "code",
      transform: "rename",
      isIdentityKey: true,
    },
    { id: randomUUID(), mappingId, sourcePath: "name", targetPath: "name", transform: "rename" },
    {
      id: randomUUID(),
      mappingId,
      sourcePath: "status",
      targetPath: "status",
      transform: "rename",
    },
  ];
}

function operationsOf(mappingId: string): OperationMapping[] {
  return [
    {
      id: randomUUID(),
      mappingId,
      sourceOperationRef: `${RESOURCE}/createWidget`,
      targetOperationRef: `${RESOURCE}/createWidget`,
      action: "create",
    },
    {
      id: randomUUID(),
      mappingId,
      sourceOperationRef: `${RESOURCE}/updateWidget`,
      targetOperationRef: `${RESOURCE}/updateWidget`,
      action: "update",
      targetIdParamRef: `${RESOURCE}/updateWidget#id`,
    },
  ];
}

function ruleOf(id: string, mappingId: string): SyncRule {
  return {
    id,
    approvedMappingId: mappingId,
    resourcePairRef: RESOURCE_PAIR_REF,
    status: "disabled",
    backfillStatus: "pending",
    backfillMode: "link-only",
    pollOperationRef: `${RESOURCE}/listWidgets`,
  };
}

// ── Fake landscape (the ONLY thing faked: the external HTTP) ────────────────────
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

function testConfig(url: string, testPollTrigger: boolean): AppConfig {
  return {
    http: { port: 0 },
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
    sync: { testPollTrigger },
  };
}

async function clearRuntimeState(db: Database): Promise<void> {
  await db.delete(orderingQueue);
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

suite("Phase-4 deterministic poll-trigger endpoint (SP-5, config-gated) — live Postgres", () => {
  let db: Database;
  let sync: SyncBackground;
  // Flag ON: the poll-trigger route is registered. Flag OFF: same sync runtime, route absent.
  let serverOn: RunningServer;
  let serverOff: RunningServer;
  let appOn: FastifyInstance;
  let appOff: FastifyInstance;
  const configOn = testConfig(databaseUrl ?? "", true);
  const configOff = testConfig(databaseUrl ?? "", false);
  const logger: FastifyBaseLogger = pino({ level: "silent" });
  const landscape = new FakeLandscape();

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
      await mappings.insert(mappingOf(MAPPING_AB, SPEC_A, SPEC_B, APP_A, APP_B));
      await mappings.insert(mappingOf(MAPPING_BA, SPEC_B, SPEC_A, APP_B, APP_A));
      await mappings.setCounterpart(MAPPING_AB, MAPPING_BA);
      await mappings.setCounterpart(MAPPING_BA, MAPPING_AB);
      const artifacts = new MappingArtifactsRepository(txn);
      await artifacts.replaceChildren(MAPPING_AB, {
        fieldMappings: fieldsOf(MAPPING_AB),
        operationMappings: operationsOf(MAPPING_AB),
        parameterMappings: [],
      });
      await artifacts.replaceChildren(MAPPING_BA, {
        fieldMappings: fieldsOf(MAPPING_BA),
        operationMappings: operationsOf(MAPPING_BA),
        parameterMappings: [],
      });
    });

    const credentialStore = new CredentialStore(
      new DbCredentialPersistence(db),
      new EnvKeyProvider(configOn.credentials.masterKey),
    );
    await credentialStore.store(APP_A, { secret: { type: "apiKey", apiKey: SOURCE_SECRET } });
    await credentialStore.store(APP_B, { secret: { type: "apiKey", apiKey: TARGET_SECRET } });

    // One shared sync runtime, mounted behind two servers that differ ONLY in the flag.
    sync = buildSyncBackground({ db, config: configOn, logger, protocolClient: landscape });
    serverOn = buildServer({ config: configOn, db, logger, sync });
    serverOff = buildServer({ config: configOff, db, logger, sync });
    appOn = serverOn.app;
    appOff = serverOff.app;
    await appOn.ready();
    await appOff.ready();
  });

  beforeEach(async () => {
    await clearRuntimeState(db);
    const downstream = new DownstreamArtifactRepository(db);
    await downstream.insertSyncRuleIfAbsent(ruleOf(RULE_AB, MAPPING_AB));
    await downstream.insertSyncRuleIfAbsent(ruleOf(RULE_BA, MAPPING_BA));
    landscape.appA.clear();
    landscape.appB.clear();
  });

  afterAll(async () => {
    await sync.stop();
    await appOn.close();
    await appOff.close();
    await clearAll(db);
    await closeDb(db);
  });

  it("flag ON: operator POST .../poll runs one cycle → completed outcome that drives a pipeline step", async () => {
    // Both apps hold the same identity-keyed record so link-only backfill links a1↔b1.
    landscape.appA.set("a1", { id: "a1", code: "W-100", name: "Alpha", status: "open" });
    landscape.appB.set("b1", { id: "b1", code: "W-100", name: "Alpha", status: "open" });

    // Bring RULE_AB live (link-only backfill seeds baselines + the go-live snapshot).
    const enabled = await sync.enableRule(RULE_AB);
    expect(enabled.kind).toBe("accepted");
    if (enabled.kind !== "accepted") {
      throw new Error("expected the rule to enable");
    }
    expect((await enabled.backfill).kind).toBe("enabled");

    // The source changes AFTER go-live; the poll must detect exactly this one change.
    landscape.appA.set("a1", { id: "a1", code: "W-100", name: "Alpha v2", status: "open" });

    const response = await injectAs(appOn, TEST_OPERATOR, {
      method: "POST",
      url: `/api/sync-rules/${RULE_AB}/poll`,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<TriggerPollResponse>();
    expect(body.ruleId).toBe(RULE_AB);
    expect(body.outcome.kind).toBe("completed");
    if (body.outcome.kind === "completed") {
      expect(body.outcome.mode).toBe("full-fetch");
      expect(body.outcome.enqueuedCount).toBe(1);
    }
    // The response is a COUNT-only projection — no live value / credential material.
    expect(response.body).not.toContain("Alpha v2");
    expect(response.body).not.toContain(SOURCE_SECRET);
    expect(response.body).not.toContain(TARGET_SECRET);

    // The trigger durably enqueued the change...
    const queue = new OrderingQueueRepository(db);
    expect(await queue.listByStatus("pending")).toHaveLength(1);
    // ...and running the ordering-queue worker drives the full pipeline step: the target
    // records the write (a single deterministic sync step from one trigger).
    const tick = await sync.queueDispatcher.runOnce();
    expect(tick.outcome).toBe("done");
    expect(landscape.appB.get("b1")).toMatchObject({ name: "Alpha v2" });
  });

  it("flag ON: viewer POST .../poll → 403 (operator-only, OA-2)", async () => {
    const response = await injectAs(appOn, TEST_VIEWER, {
      method: "POST",
      url: `/api/sync-rules/${RULE_AB}/poll`,
    });
    expect(response.statusCode).toBe(403);
  });

  it("flag OFF: the poll route is ABSENT (404) even though the other sync routes are present", async () => {
    // The sync routes ARE mounted on the flag-off server (sync runtime is present)...
    const listResponse = await injectAs(appOff, TEST_VIEWER, {
      method: "GET",
      url: "/api/sync-rules",
    });
    expect(listResponse.statusCode).toBe(200);
    const list = listResponse.json<SyncRuleListResponse>();
    expect(list.rules.some((r) => r.id === RULE_AB)).toBe(true);

    // ...but the poll-trigger route is not registered, so an operator's POST 404s. This
    // is the production-safety gate: the endpoint is absent unless the flag is set.
    const pollResponse = await injectAs(appOff, TEST_OPERATOR, {
      method: "POST",
      url: `/api/sync-rules/${RULE_AB}/poll`,
    });
    expect(pollResponse.statusCode).toBe(404);

    // The very same request IS handled on the flag-on server (route present → not a 404).
    const pollOn = await injectAs(appOn, TEST_OPERATOR, {
      method: "POST",
      url: `/api/sync-rules/${RULE_AB}/poll`,
    });
    expect(pollOn.statusCode).not.toBe(404);
  });
});
