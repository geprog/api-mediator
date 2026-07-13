import { randomUUID } from "node:crypto";

import type { AppConfig } from "@mediator/config";
import { CredentialStore, DbCredentialPersistence, EnvKeyProvider } from "@mediator/credentials";
import {
  ApiSpecRepository,
  ApprovedMappingRepository,
  AuditLogRepository,
  DownstreamArtifactRepository,
  MappingArtifactsRepository,
  RecordLinkRepository,
  RegisteredAppRepository,
  ResourceBindingRepository,
  SyncRuleRepository,
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
  AuditLogEntry,
  ConfirmableRef,
  FieldMapping,
  IrOperation,
  IrResourceGroup,
  OperationMapping,
  RegisteredApp,
  ResourceBinding,
  SyncRule,
} from "@mediator/domain";
import type {
  AmbiguousMatchListResponse,
  CreateRecordLinkResponse,
  EnableSyncRuleResponse,
  SyncEventListResponse,
  SyncRuleListResponse,
  SyncRuleStatusDto,
} from "@mediator/contracts";
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
 * Live-Postgres backend integration for the **Sync HTTP API (SA-1..SA-3)**: it drives
 * the real operator API (real auth via the testkit, real routes, the real
 * {@link SyncOperatorService} over the real {@link buildSyncBackground} + repos) through
 * Fastify `inject`, with only the external HTTP faked by a {@link FakeLandscape}. It
 * proves the operator/viewer gating (OA-2), the enablement-gate delegation
 * (accepted/blocked), state-retaining disable, manual link/unlink (RL-5), the sync
 * audit-log query, the ambiguous-match queue, identity attribution (OA-3), and the
 * no-credential/no-payload response invariant.
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
const MAPPING_NOKEY = randomUUID();
const BINDING_A = randomUUID();
const BINDING_B = randomUUID();
const RULE_AB = randomUUID();
const RULE_BA = randomUUID();
const RULE_NOKEY = randomUUID();
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

// ── Fixture builders (mirrors sync.integration.spec.ts) ────────────────────────
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
  status: ApprovedMapping["status"] = "active",
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
    status,
  };
}

function fieldsOf(mappingId: string, withIdentityKey: boolean): FieldMapping[] {
  return [
    {
      id: randomUUID(),
      mappingId,
      sourcePath: "code",
      targetPath: "code",
      transform: "rename",
      ...(withIdentityKey ? { isIdentityKey: true } : {}),
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

function testConfig(url: string): AppConfig {
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

suite("Phase-4 Sync HTTP API (SA-1..SA-3) — live Postgres", () => {
  let db: Database;
  let sync: SyncBackground;
  let server: RunningServer;
  let app: FastifyInstance;
  const config = testConfig(databaseUrl ?? "");
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
      // The gate-blocked fixture reuses the A→B spec pair, so it is `suspended` to
      // avoid the active-direction unique index (the enablement gate ignores mapping
      // status — it blocks purely on the missing identity key, which is what SA-1.3
      // exercises).
      await mappings.insert(mappingOf(MAPPING_NOKEY, SPEC_A, SPEC_B, APP_A, APP_B, "suspended"));
      await mappings.setCounterpart(MAPPING_AB, MAPPING_BA);
      await mappings.setCounterpart(MAPPING_BA, MAPPING_AB);
      const artifacts = new MappingArtifactsRepository(txn);
      await artifacts.replaceChildren(MAPPING_AB, {
        fieldMappings: fieldsOf(MAPPING_AB, true),
        operationMappings: operationsOf(MAPPING_AB),
        parameterMappings: [],
      });
      await artifacts.replaceChildren(MAPPING_BA, {
        fieldMappings: fieldsOf(MAPPING_BA, true),
        operationMappings: operationsOf(MAPPING_BA),
        parameterMappings: [],
      });
      await artifacts.replaceChildren(MAPPING_NOKEY, {
        fieldMappings: fieldsOf(MAPPING_NOKEY, false),
        operationMappings: operationsOf(MAPPING_NOKEY),
        parameterMappings: [],
      });
    });

    const credentialStore = new CredentialStore(
      new DbCredentialPersistence(db),
      new EnvKeyProvider(config.credentials.masterKey),
    );
    await credentialStore.store(APP_A, { secret: { type: "apiKey", apiKey: SOURCE_SECRET } });
    await credentialStore.store(APP_B, { secret: { type: "apiKey", apiKey: TARGET_SECRET } });

    sync = buildSyncBackground({ db, config, logger, protocolClient: landscape });
    server = buildServer({ config, db, logger, sync });
    app = server.app;
    await app.ready();
  });

  beforeEach(async () => {
    // Reset all live runtime state; re-seed the three disabled rules.
    await clearRuntimeState(db);
    const downstream = new DownstreamArtifactRepository(db);
    await downstream.insertSyncRuleIfAbsent(ruleOf(RULE_AB, MAPPING_AB));
    await downstream.insertSyncRuleIfAbsent(ruleOf(RULE_BA, MAPPING_BA));
    await downstream.insertSyncRuleIfAbsent(ruleOf(RULE_NOKEY, MAPPING_NOKEY));
  });

  afterAll(async () => {
    await sync.stop();
    await app.close();
    await clearAll(db);
    await closeDb(db);
  });

  const rules = (): SyncRuleRepository => new SyncRuleRepository(db);
  const audits = (): AuditLogRepository => new AuditLogRepository(db);

  // ── SA-1: configure ─────────────────────────────────────────────────────────

  it("SA-1.1 operator configures a disabled rule's options → persisted + attributed", async () => {
    const fields = await new MappingArtifactsRepository(db).listFieldMappings(MAPPING_AB);
    const statusField = fields.find((f) => f.sourcePath === "status");
    expect(statusField).toBeDefined();

    const response = await injectAs(app, TEST_OPERATOR, {
      method: "PATCH",
      url: `/api/sync-rules/${RULE_AB}/config`,
      payload: {
        pollIntervalOverride: 30_000,
        deletePropagation: "propagate",
        targetDriftCheck: "read-before-write",
        fieldConflictPolicies: [
          { fieldMappingId: statusField?.id ?? "", conflictPolicy: "manual-resolve" },
        ],
      },
    });
    expect(response.statusCode).toBe(200);
    const dto = response.json<SyncRuleStatusDto>();
    expect(dto.pollIntervalOverride).toBe(30_000);
    expect(dto.deletePropagation).toBe("propagate");
    expect(dto.targetDriftCheck).toBe("read-before-write");

    const persisted = await rules().getById(RULE_AB);
    expect(persisted?.pollIntervalOverride).toBe(30_000);
    expect(persisted?.deletePropagation).toBe("propagate");
    const reloadedFields = await new MappingArtifactsRepository(db).listFieldMappings(MAPPING_AB);
    expect(reloadedFields.find((f) => f.sourcePath === "status")?.conflictPolicy).toBe(
      "manual-resolve",
    );

    // OA-3 — attributed to the authenticated identity.
    const events = await audits().querySyncEvents({ relatedRuleId: RULE_AB, limit: 50 });
    expect(events.some((e) => e.actor === TEST_OPERATOR.username)).toBe(true);
    // No credential material in the response.
    expect(response.body).not.toContain(SOURCE_SECRET);
    expect(response.body).not.toContain(BASE_A);
  });

  it("SA-1.1 configuring an enabled rule is rejected (disabled-only)", async () => {
    await rules().applyEnableTransition(RULE_AB, {
      status: "enabled",
      backfillStatus: "completed",
    });
    const response = await injectAs(app, TEST_OPERATOR, {
      method: "PATCH",
      url: `/api/sync-rules/${RULE_AB}/config`,
      payload: { deletePropagation: "propagate" },
    });
    expect(response.statusCode).toBe(400);
  });

  // ── SA-1: enable / disable ────────────────────────────────────────────────────

  it("SA-1.2 operator enables a gate-satisfied rule → 202 accepted + backfill triggered", async () => {
    const response = await injectAs(app, TEST_OPERATOR, {
      method: "POST",
      url: `/api/sync-rules/${RULE_AB}/enable`,
      payload: { action: "backfill", backfillMode: "link-only" },
    });
    expect(response.statusCode).toBe(202);
    const body = response.json<EnableSyncRuleResponse>();
    expect(body.outcome).toBe("accepted");

    await sync.awaitBackfills();
    const rule = await rules().getById(RULE_AB);
    expect(rule?.status).toBe("enabled");
    expect(rule?.backfillStatus).toBe("completed");

    // OA-3 attribution.
    const events = await audits().querySyncEvents({ relatedRuleId: RULE_AB, limit: 50 });
    expect(
      events.some((e) => e.actor === TEST_OPERATOR.username && e.details?.includes("enabled")),
    ).toBe(true);
  });

  it("SA-1.3 enabling a gate-UNsatisfied rule → 422 with the exact stillNeeds + nothing enabled", async () => {
    const response = await injectAs(app, TEST_OPERATOR, {
      method: "POST",
      url: `/api/sync-rules/${RULE_NOKEY}/enable`,
      payload: { action: "backfill", backfillMode: "link-only" },
    });
    expect(response.statusCode).toBe(422);
    const body = response.json<EnableSyncRuleResponse>();
    expect(body.outcome).toBe("blocked");
    if (body.outcome === "blocked") {
      expect(body.stillNeeds).toContainEqual({
        kind: "identity-key",
        issue: "missing",
        confirmedCount: 0,
      });
    }
    // Nothing enabled.
    expect((await rules().getById(RULE_NOKEY))?.status).toBe("disabled");
  });

  it("SA-1.4 disable stops polling and retains state (cursor/snapshot untouched)", async () => {
    // Bring the rule live with a backfill first, then disable it.
    await injectAs(app, TEST_OPERATOR, {
      method: "POST",
      url: `/api/sync-rules/${RULE_AB}/enable`,
      payload: { action: "skip-backfill" },
    });
    await sync.awaitBackfills();
    const beforeDisable = await rules().getById(RULE_AB);
    expect(beforeDisable?.status).toBe("enabled");

    const response = await injectAs(app, TEST_OPERATOR, {
      method: "POST",
      url: `/api/sync-rules/${RULE_AB}/disable`,
    });
    expect(response.statusCode).toBe(200);
    const after = await rules().getById(RULE_AB);
    expect(after?.status).toBe("disabled");
    // Live state retained, never reset.
    expect(after?.lastSnapshotRef ?? null).toEqual(beforeDisable?.lastSnapshotRef ?? null);
    expect(after?.cursor ?? null).toEqual(beforeDisable?.cursor ?? null);
  });

  it("SA-1.5 viewer → 403 on configure / enable / disable (nothing changes)", async () => {
    const configResp = await injectAs(app, TEST_VIEWER, {
      method: "PATCH",
      url: `/api/sync-rules/${RULE_AB}/config`,
      payload: { deletePropagation: "propagate" },
    });
    const enableResp = await injectAs(app, TEST_VIEWER, {
      method: "POST",
      url: `/api/sync-rules/${RULE_AB}/enable`,
      payload: { action: "skip-backfill" },
    });
    const disableResp = await injectAs(app, TEST_VIEWER, {
      method: "POST",
      url: `/api/sync-rules/${RULE_AB}/disable`,
    });
    expect(configResp.statusCode).toBe(403);
    expect(enableResp.statusCode).toBe(403);
    expect(disableResp.statusCode).toBe(403);
    // Untouched.
    const rule = await rules().getById(RULE_AB);
    expect(rule?.status).toBe("disabled");
    expect(rule?.deletePropagation ?? null).toBeNull();
  });

  // ── SA-2: read ────────────────────────────────────────────────────────────────

  it("SA-2.1/2.2 rule list carries status/backfill/lastRun/lastEvent/pair/stillNeeds/lag; no credential material", async () => {
    for (const account of [TEST_VIEWER, TEST_OPERATOR]) {
      const response = await injectAs(app, account, { method: "GET", url: "/api/sync-rules" });
      expect(response.statusCode).toBe(200);
      const body = response.json<SyncRuleListResponse>();
      const ab = body.rules.find((r) => r.id === RULE_AB);
      const nokey = body.rules.find((r) => r.id === RULE_NOKEY);
      expect(ab).toBeDefined();
      expect(ab?.status).toBe("disabled");
      expect(ab?.backfillStatus).toBe("pending");
      expect(ab?.resourcePair?.source.appId).toBe(APP_A);
      expect(ab?.resourcePair?.source.resourceRef).toBe(RESOURCE);
      expect(ab?.pollerLag).toBeDefined();
      expect(ab?.stillNeeds).toEqual([]); // gate-satisfied → nothing outstanding
      // The unsatisfied rule surfaces its stillNeeds.
      expect(nokey?.stillNeeds).toContainEqual({
        kind: "identity-key",
        issue: "missing",
        confirmedCount: 0,
      });
      // No credential material / base URL anywhere in the list.
      expect(response.body).not.toContain(SOURCE_SECRET);
      expect(response.body).not.toContain(TARGET_SECRET);
      expect(response.body).not.toContain(BASE_A);
      expect(response.body).not.toContain(BASE_B);
    }
  });

  it("SA-2.3 event query filters by rule/record/status and returns NO payload values; both roles read", async () => {
    const linkId = randomUUID();
    const rows: AuditLogEntry[] = [
      {
        id: randomUUID(),
        type: "sync-execution",
        actor: "system",
        status: "success",
        relatedRuleId: RULE_AB,
        recordLinkId: linkId,
        sourceNativeId: "a1",
        payloadHash: "sha256:deadbeef",
        timestamp: new Date("2026-07-13T10:00:00.000Z"),
      },
      {
        id: randomUUID(),
        type: "sync-execution",
        actor: "system",
        status: "failure",
        relatedRuleId: RULE_AB,
        sourceNativeId: "a2",
        details: "write failed",
        timestamp: new Date("2026-07-13T10:01:00.000Z"),
      },
    ];
    for (const row of rows) {
      await audits().insert(row);
    }

    for (const account of [TEST_VIEWER, TEST_OPERATOR]) {
      const byRule = await injectAs(app, account, {
        method: "GET",
        url: `/api/sync-events?ruleId=${RULE_AB}`,
      });
      expect(byRule.statusCode).toBe(200);
      const list = byRule.json<SyncEventListResponse>();
      expect(list.events.length).toBeGreaterThanOrEqual(2);
      // A payload value ("Alpha") never appears — only ids/hashes/status/details.
      expect(byRule.body).not.toContain("Alpha");
      expect(byRule.body).not.toContain(SOURCE_SECRET);
    }

    const byStatus = await injectAs(app, TEST_VIEWER, {
      method: "GET",
      url: `/api/sync-events?ruleId=${RULE_AB}&status=failure`,
    });
    const failures = byStatus.json<SyncEventListResponse>();
    expect(failures.events.every((e) => e.status === "failure")).toBe(true);

    const byRecord = await injectAs(app, TEST_VIEWER, {
      method: "GET",
      url: `/api/sync-events?recordLinkId=${linkId}`,
    });
    const forLink = byRecord.json<SyncEventListResponse>();
    expect(forLink.events).toHaveLength(1);
    expect(forLink.events[0]?.sourceNativeId).toBe("a1");
  });

  // ── SA-3: manual link / unlink + ambiguous queue ──────────────────────────────

  it("SA-3.1/3.2 operator links + unlinks records (RL-5) with attribution", async () => {
    const linkResponse = await injectAs(app, TEST_OPERATOR, {
      method: "POST",
      url: "/api/record-links",
      payload: { ruleId: RULE_AB, sourceNativeId: "a1", targetNativeId: "b1" },
    });
    expect(linkResponse.statusCode).toBe(201);
    const { link } = linkResponse.json<CreateRecordLinkResponse>();
    expect(link.establishedBy).toBe("manual");
    // Source (APP_A) → a1, target (APP_B) → b1, whichever canonical side each is.
    const appASideNativeId = link.appAId === APP_A ? link.appANativeId : link.appBNativeId;
    const appBSideNativeId = link.appAId === APP_A ? link.appBNativeId : link.appANativeId;
    expect(appASideNativeId).toBe("a1");
    expect(appBSideNativeId).toBe("b1");

    const persisted = await new RecordLinkRepository(db).getById(link.id);
    expect(persisted?.status).toBe("active");

    // OA-3 attribution for the link.
    const linkEvents = await audits().querySyncEvents({ recordLinkId: link.id, limit: 50 });
    expect(linkEvents.some((e) => e.actor === TEST_OPERATOR.username)).toBe(true);

    // Unlink severs it.
    const unlinkResponse = await injectAs(app, TEST_OPERATOR, {
      method: "DELETE",
      url: `/api/record-links/${link.id}`,
    });
    expect(unlinkResponse.statusCode).toBe(200);
    expect(await new RecordLinkRepository(db).getById(link.id)).toBeUndefined();
  });

  it("SA-3.4 viewer → 403 on link / unlink", async () => {
    const linkResp = await injectAs(app, TEST_VIEWER, {
      method: "POST",
      url: "/api/record-links",
      payload: { ruleId: RULE_AB, sourceNativeId: "a1", targetNativeId: "b1" },
    });
    const unlinkResp = await injectAs(app, TEST_VIEWER, {
      method: "DELETE",
      url: `/api/record-links/${randomUUID()}`,
    });
    expect(linkResp.statusCode).toBe(403);
    expect(unlinkResp.statusCode).toBe(403);
  });

  it("SA-3.3 ambiguous-match queue lists candidate target ids from the failure details", async () => {
    await audits().insert({
      id: randomUUID(),
      type: "sync-execution",
      actor: "system",
      status: "failure",
      relatedRuleId: RULE_AB,
      originAppId: APP_A,
      sourceNativeId: "a9",
      details: "ambiguous identity match: 2 candidates [t1, t2]",
      timestamp: new Date("2026-07-13T11:00:00.000Z"),
    });

    const response = await injectAs(app, TEST_VIEWER, {
      method: "GET",
      url: "/api/record-links/ambiguous-matches",
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<AmbiguousMatchListResponse>();
    const entry = body.matches.find((m) => m.sourceNativeId === "a9");
    expect(entry).toBeDefined();
    expect(entry?.candidateTargetNativeIds).toStrictEqual(["t1", "t2"]);
    expect(entry?.ruleId).toBe(RULE_AB);
    expect(entry?.sourceAppId).toBe(APP_A);
  });
});
