import { randomUUID } from "node:crypto";

import type { AppConfig } from "@mediator/config";
import { CredentialStore, DbCredentialPersistence, EnvKeyProvider } from "@mediator/credentials";
import {
  ApiSpecRepository,
  ApprovedMappingRepository,
  AuditLogRepository,
  DownstreamArtifactRepository,
  MappingArtifactsRepository,
  ParkedConflictRepository,
  RecordLinkRepository,
  RegisteredAppRepository,
  ResourceBindingRepository,
  SyncFieldStateRepository,
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
import type {
  ParkedConflictListResponse,
  ResolveParkedConflictResponse,
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
 * Live-Postgres backend integration for **SA-4 — resolve a parked conflict**. It drives a
 * real conflict through the real `buildSyncBackground` pipeline to PARK it (a structured
 * `parked_conflict` row), then resolves it through the real operator API (real auth, real
 * routes, real {@link SyncOperatorService}) via Fastify `inject`, and asserts the
 * resolution **flows back through the normal pipeline** — CF re-checks drift, the write /
 * delete goes through the standard path, and target-wins forges **no** baseline. Only the
 * external HTTP is faked ({@link FakeLandscape}).
 *
 * A single **one-way** rule A→B with `targetDriftCheck = read-before-write` is used so a
 * conflict is deterministic without a counterpart poll: a hand-edit on the target drifts
 * it, CF reads it live at write time and parks the `manual-resolve` field / the drifted
 * delete.
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

// ── Fixture builders ─────────────────────────────────────────────────────────
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
    {
      id: randomUUID(),
      mappingId: MAPPING_AB,
      sourceOperationRef: `${RESOURCE}/deleteWidget`,
      targetOperationRef: `${RESOURCE}/deleteWidget`,
      action: "delete",
      targetIdParamRef: `${RESOURCE}/deleteWidget#id`,
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
    if (method === "DELETE" && bare.startsWith("/widgets/")) {
      const id = decodeURIComponent(bare.slice("/widgets/".length));
      const removed = store.get(id);
      store.delete(id);
      return resp(200, removed ?? {});
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

suite("SA-4 resolve a parked conflict — live Postgres", () => {
  let db: Database;
  let sync: SyncBackground;
  let server: RunningServer;
  let app: FastifyInstance;
  let landscape: FakeLandscape;
  const config = testConfig(databaseUrl ?? "");
  const logger: FastifyBaseLogger = pino({ level: "silent" });

  const rules = (): SyncRuleRepository => new SyncRuleRepository(db);
  const links = (): RecordLinkRepository => new RecordLinkRepository(db);
  const fieldState = (): SyncFieldStateRepository => new SyncFieldStateRepository(db);
  const audits = (): AuditLogRepository => new AuditLogRepository(db);
  const parked = (): ParkedConflictRepository => new ParkedConflictRepository(db);

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
   * Configure the rule (read-before-write so a hand-edit on the target drifts it) + set
   * the `name` field to `manual-resolve`, enable link-only (seed baselines + link a1↔b1),
   * seed both apps with an agreeing record.
   */
  async function enableWithManualResolveName(deletePropagation: "ignore" | "propagate"): Promise<{
    linkId: string;
    nameFieldId: string;
  }> {
    landscape.appA.set("a1", { id: "a1", code: "W-100", name: "Alpha", status: "open" });
    landscape.appB.set("b1", { id: "b1", code: "W-100", name: "Alpha", status: "open" });

    const artifacts = new MappingArtifactsRepository(db);
    const fields = await artifacts.listFieldMappings(MAPPING_AB);
    const nameField = fields.find((field) => field.sourcePath === "name");
    if (nameField === undefined) {
      throw new Error("name field mapping missing");
    }
    await artifacts.setFieldMappingConflictPolicy(nameField.id, "manual-resolve");
    await rules().updateConfig(RULE_AB, {
      targetDriftCheck: "read-before-write",
      deletePropagation,
    });

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
    return { linkId: link.id, nameFieldId: nameField.id };
  }

  it("SA-4.1/4.2 park a manual-resolve field, read the queue, resolve source-wins → write + resolved + attributed", async () => {
    const { linkId } = await enableWithManualResolveName("ignore");

    // A hand-edit drifts the TARGET, and a source change makes A→B a genuine change.
    landscape.appB.set("b1", { id: "b1", code: "W-100", name: "TargetHandEdit", status: "open" });
    landscape.appA.set("a1", { id: "a1", code: "W-100", name: "SourceEdit", status: "open" });

    await sync.pollOnce(RULE_AB);
    await sync.runQueueOnce();

    // The manual-resolve `name` field parked (a structured row); `status` still synced.
    const openRows = await parked().listOpen(50);
    const nameConflict = openRows.find((row) => row.fieldPath === "name");
    expect(nameConflict).toBeDefined();
    expect(nameConflict?.kind).toBe("manual-resolve");
    expect(nameConflict?.recordLinkId).toBe(linkId);
    expect(landscape.appB.get("b1")?.name).toBe("TargetHandEdit"); // withheld, not overwritten

    // SA-4.1 — the queue read carries the row, no raw value / credential.
    const queueRes = await injectAs(app, TEST_VIEWER, {
      method: "GET",
      url: "/api/parked-conflicts",
    });
    expect(queueRes.statusCode).toBe(200);
    const queue = queueRes.json<ParkedConflictListResponse>();
    const dto = queue.conflicts.find((c) => c.id === nameConflict?.id);
    expect(dto?.kind).toBe("manual-resolve");
    expect(dto?.fieldPath).toBe("name");
    expect(queueRes.body).not.toContain("TargetHandEdit");
    expect(queueRes.body).not.toContain("SourceEdit");
    expect(queueRes.body).not.toContain(SOURCE_SECRET);
    expect(queueRes.body).not.toContain(TARGET_SECRET);

    // SA-4.2 — operator resolves source-wins → re-run flows through the pipeline.
    const resolveRes = await injectAs(app, TEST_OPERATOR, {
      method: "POST",
      url: `/api/parked-conflicts/${nameConflict?.id ?? ""}/resolve`,
      payload: { resolution: "source-wins" },
    });
    expect(resolveRes.statusCode).toBe(200);
    const body = resolveRes.json<ResolveParkedConflictResponse>();
    expect(body.outcome).toBe("enqueued");
    expect(resolveRes.body).not.toContain("SourceEdit");

    // Drive the enqueued re-run.
    await sync.runQueueOnce();

    // The source value propagated through the normal write path; the row is resolved.
    expect(landscape.appB.get("b1")?.name).toBe("SourceEdit");
    const resolved = await parked().getById(nameConflict?.id ?? "");
    expect(resolved?.status).toBe("resolved");
    expect(resolved?.resolutionChoice).toBe("source-wins");
    expect(resolved?.resolvedBy).toBe(TEST_OPERATOR.username);

    // OA-3 — the resolution is attributed to the authenticated identity.
    const attributed = (
      await audits().querySyncEvents({ relatedRuleId: RULE_AB, limit: 100 })
    ).some(
      (event) =>
        event.actor === TEST_OPERATOR.username && (event.details ?? "").includes("source-wins"),
    );
    expect(attributed).toBe(true);
  });

  it("SA-4.2 resolve target-wins → withheld, NO write, NO forged baseline", async () => {
    const { linkId } = await enableWithManualResolveName("ignore");
    landscape.appB.set("b1", { id: "b1", code: "W-100", name: "TargetKept", status: "open" });
    landscape.appA.set("a1", { id: "a1", code: "W-100", name: "SourceLoses", status: "open" });

    await sync.pollOnce(RULE_AB);
    await sync.runQueueOnce();
    const nameConflict = (await parked().listOpen(50)).find((row) => row.fieldPath === "name");
    expect(nameConflict).toBeDefined();

    // Capture the B-side name baseline BEFORE resolving (to prove it is never forged).
    const baselineBefore = (await fieldState().findByLink(linkId))
      .filter((row) => row.fieldPath === "name")
      .map((row) => row.lastSyncedHash);

    const resolveRes = await injectAs(app, TEST_OPERATOR, {
      method: "POST",
      url: `/api/parked-conflicts/${nameConflict?.id ?? ""}/resolve`,
      payload: { resolution: "target-wins" },
    });
    expect(resolveRes.statusCode).toBe(200);
    await sync.runQueueOnce();

    // The target value was kept — no write to B; the row is resolved.
    expect(landscape.appB.get("b1")?.name).toBe("TargetKept");
    expect((await parked().getById(nameConflict?.id ?? ""))?.status).toBe("resolved");

    // The baselines are UNTOUCHED — target-wins never sneaks a value into reconciled state.
    const baselineAfter = (await fieldState().findByLink(linkId))
      .filter((row) => row.fieldPath === "name")
      .map((row) => row.lastSyncedHash);
    expect(baselineAfter).toEqual(baselineBefore);
  });

  it("SA-4.3 park a drifted delete, resolve propagate → delete + tombstone propagated-delete", async () => {
    const { linkId } = await enableWithManualResolveName("propagate");
    // Drift the target, then delete the source record.
    landscape.appB.set("b1", { id: "b1", code: "W-100", name: "TargetDrift", status: "open" });
    landscape.appA.delete("a1");

    await sync.pollOnce(RULE_AB);
    await sync.runQueueOnce();

    // Parked as a drifted-delete; the link is left active, nothing deleted.
    const deletePark = (await parked().listOpen(50)).find((row) => row.kind === "drifted-delete");
    expect(deletePark).toBeDefined();
    expect((await links().getById(linkId))?.status).toBe("active");
    expect(landscape.appB.has("b1")).toBe(true);

    const resolveRes = await injectAs(app, TEST_OPERATOR, {
      method: "POST",
      url: `/api/parked-conflicts/${deletePark?.id ?? ""}/resolve`,
      payload: { resolution: "propagate" },
    });
    expect(resolveRes.statusCode).toBe(200);
    expect(resolveRes.json<ResolveParkedConflictResponse>().outcome).toBe("enqueued");
    await sync.runQueueOnce();

    // The delete propagated through the pipeline; link tombstoned propagated-delete.
    expect(landscape.appB.has("b1")).toBe(false);
    const link = await links().getById(linkId);
    expect(link?.status).toBe("tombstoned");
    expect(link?.tombstoneReason).toBe("propagated-delete");
    expect((await parked().getById(deletePark?.id ?? ""))?.status).toBe("resolved");
  });

  it("SA-4.3 park a drifted delete, resolve sever → tombstone observed-delete, NOTHING deleted", async () => {
    const { linkId } = await enableWithManualResolveName("propagate");
    landscape.appB.set("b1", { id: "b1", code: "W-100", name: "TargetSurvivor", status: "open" });
    landscape.appA.delete("a1");

    await sync.pollOnce(RULE_AB);
    await sync.runQueueOnce();
    const deletePark = (await parked().listOpen(50)).find((row) => row.kind === "drifted-delete");
    expect(deletePark).toBeDefined();

    const resolveRes = await injectAs(app, TEST_OPERATOR, {
      method: "POST",
      url: `/api/parked-conflicts/${deletePark?.id ?? ""}/resolve`,
      payload: { resolution: "sever" },
    });
    expect(resolveRes.statusCode).toBe(200);
    expect(resolveRes.json<ResolveParkedConflictResponse>().outcome).toBe("applied");

    // The survivor is kept; the pair is severed with an observed-delete tombstone.
    expect(landscape.appB.get("b1")?.name).toBe("TargetSurvivor");
    const link = await links().getById(linkId);
    expect(link?.status).toBe("tombstoned");
    expect(link?.tombstoneReason).toBe("observed-delete");
    expect((await parked().getById(deletePark?.id ?? ""))?.status).toBe("resolved");
  });

  it("SA-4.5 viewer → 403 on resolve (nothing changes)", async () => {
    await enableWithManualResolveName("ignore");
    landscape.appB.set("b1", { id: "b1", code: "W-100", name: "TargetHandEdit", status: "open" });
    landscape.appA.set("a1", { id: "a1", code: "W-100", name: "SourceEdit", status: "open" });
    await sync.pollOnce(RULE_AB);
    await sync.runQueueOnce();
    const nameConflict = (await parked().listOpen(50)).find((row) => row.fieldPath === "name");
    expect(nameConflict).toBeDefined();

    const res = await injectAs(app, TEST_VIEWER, {
      method: "POST",
      url: `/api/parked-conflicts/${nameConflict?.id ?? ""}/resolve`,
      payload: { resolution: "source-wins" },
    });
    expect(res.statusCode).toBe(403);
    // Untouched — still open, no write.
    expect((await parked().getById(nameConflict?.id ?? ""))?.status).toBe("open");
    expect(landscape.appB.get("b1")?.name).toBe("TargetHandEdit");
  });

  it("viewer may READ the parked-conflict queue (SA-4.1)", async () => {
    await enableWithManualResolveName("ignore");
    const res = await injectAs(app, TEST_VIEWER, { method: "GET", url: "/api/parked-conflicts" });
    expect(res.statusCode).toBe(200);
  });
});
