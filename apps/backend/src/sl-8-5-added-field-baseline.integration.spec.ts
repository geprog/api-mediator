import { randomUUID } from "node:crypto";

import type { AppConfig } from "@mediator/config";
import { CredentialStore, DbCredentialPersistence, EnvKeyProvider } from "@mediator/credentials";
import {
  ApiSpecRepository,
  ApprovedMappingRepository,
  DownstreamArtifactRepository,
  MappingArtifactsRepository,
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
  graphEdge,
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
import {
  MAPPING_APPROVED_EVENT_TYPE,
  type ApiSpec,
  type ConfirmableRef,
  type FieldMapping,
  type IrOperation,
  type IrResourceGroup,
  type OperationMapping,
  type RecordLink,
  type RegisteredApp,
  type ResourceBinding,
  type SyncFieldState,
  type SyncRule,
} from "@mediator/domain";
import type { DeliveredEvent } from "@mediator/event-bus";
import type { OutboundRequest, OutboundResponse, ProtocolClient } from "@mediator/outbound";
import { hashFieldValue } from "@mediator/sync-engine";
import type { JsonRecord, JsonValue } from "@mediator/transform";
import { inArray } from "drizzle-orm";
import { pino } from "pino";
import type { FastifyBaseLogger } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { canonicalResourcePairRef } from "./modules/artifact-instantiation/derive.js";
import { buildArtifactInstantiation } from "./modules/artifact-instantiation/index.js";
import { GraphProjection } from "./modules/graph/index.js";
import { buildSyncBackground, type SyncBackground } from "./modules/sync/background.js";

/**
 * **SL-8.5 — live-Postgres integration for the added-field-baseline fix.** When successor
 * adoption re-points a rule whose **successor** mapping ADDS a field pair the stale predecessor
 * lacked, that added field pair has no `SyncFieldState` baseline over the pre-existing
 * `RecordLink`s — so Conflict Detection would read the absent baseline as `drifted` →
 * target-wins-withhold, and the added field would never propagate. This drives the REAL
 * `MappingApproved` consumer's adoption over live Postgres, wired to the REAL
 * `SyncBackground.seedAddedFieldBaselines` (the async link-only seeding backfill), with only the
 * external HTTP faked by a {@link FakeLandscape} `ProtocolClient`, and proves:
 *
 *  1. adoption enqueues a link-only seeding backfill **only** for the re-pointed rule whose pair
 *     gained a field (the unchanged pair's rule enqueues nothing);
 *  2. after that backfill runs, the added field pair (`widgets/status`) has a **reconciled**
 *     `SyncFieldState` baseline over the EXISTING link, and a pre-existing field's baseline is
 *     **unchanged** (`SyncFieldStateStore.seed` never erases);
 *  3. Conflict Detection is now well-defined: a subsequent source change to the added field
 *     **propagates** to the target instead of spuriously conflicting/withholding.
 *
 * Requires the compose `postgres` service + a resolvable `DATABASE_URL`; excluded from
 * `pnpm verify`. Self-skips when unresolvable. Run in isolation (the shared-DB integration suite
 * is flaky across files); its teardown deletes everything it writes, FK-safe.
 */
let databaseUrl: string | undefined;
try {
  databaseUrl = resolveDatabaseUrl(process.env);
} catch {
  databaseUrl = undefined;
}
const suite = databaseUrl === undefined ? describe.skip : describe;

const CREATED_AT = new Date("2026-07-23T00:00:00.000Z");
const OBSERVED_AT = new Date("2026-07-23T01:00:00.000Z");

const APP_A = randomUUID();
const APP_B = randomUUID();
const SPEC_A_OLD = randomUUID();
const SPEC_A_NEW = randomUUID();
const SPEC_B = randomUUID();
const BINDING_A_NEW = randomUUID();
const BINDING_B = randomUUID();
const M_PRED = randomUUID();
const M_SUCC = randomUUID();
const RULE_WIDGETS = randomUUID();
const RULE_GADGETS = randomUUID();
const LINK_ID = randomUUID();
const NAME_STATE_A = randomUUID();
const NAME_STATE_B = randomUUID();

const BASE_A = "https://sl85-a.test";
const BASE_B = "https://sl85-b.test";

const ALL_APP_IDS = [APP_A, APP_B];
const ALL_SPEC_IDS = [SPEC_A_OLD, SPEC_A_NEW, SPEC_B];
const ALL_MAPPING_IDS = [M_PRED, M_SUCC];
const ALL_RULE_IDS = [RULE_WIDGETS, RULE_GADGETS];

// The canonical, direction-agnostic pair refs the rules share (derive.ts).
const WIDGETS_PAIR = canonicalResourcePairRef(
  { appId: APP_A, resourceRef: "widgets" },
  { appId: APP_B, resourceRef: "widgets" },
);
const GADGETS_PAIR = canonicalResourcePairRef(
  { appId: APP_A, resourceRef: "gadgets" },
  { appId: APP_B, resourceRef: "gadgets" },
);

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

function widgetOp(operationId: string, method: IrOperation["method"], path: string): IrOperation {
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
  resourceRef: "widgets",
  name: "Widgets",
  operations: [
    widgetOp("listWidgets", "get", "/widgets"),
    widgetOp("createWidget", "post", "/widgets"),
    widgetOp("updateWidget", "patch", "/widgets/{id}"),
  ],
  schemas: [],
  crossResourceRefs: [],
};

function specOf(
  id: string,
  appId: string,
  status: ApiSpec["status"],
  version: number,
  ir: IrResourceGroup[],
): ApiSpec {
  return {
    id,
    appId,
    role: "PROVIDER",
    rawDocument: { openapi: "3.1.0" },
    parsedIR: ir,
    analysisExclusions: [],
    version,
    contentHash: `sha256:${id}`,
    status,
    createdAt: CREATED_AT,
  };
}

function confirmedRef(value: ConfirmableRef["value"]): ConfirmableRef {
  return { value, confirmedBy: "operator", confirmedAt: CREATED_AT };
}

function bindingOf(id: string, apiSpecId: string): ResourceBinding {
  return {
    id,
    apiSpecId,
    resourceRef: "widgets",
    nativeIdRef: confirmedRef({ kind: "field", path: "id" }),
    collectionReadRef: confirmedRef({ kind: "operation", operationId: "listWidgets" }),
  };
}

function field(input: {
  mappingId: string;
  sourcePath: string;
  targetPath: string;
  isIdentityKey?: true;
}): FieldMapping {
  return {
    id: randomUUID(),
    mappingId: input.mappingId,
    sourcePath: input.sourcePath,
    targetPath: input.targetPath,
    transform: "rename",
    ...(input.isIdentityKey !== undefined ? { isIdentityKey: input.isIdentityKey } : {}),
  };
}

function widgetOps(mappingId: string): OperationMapping[] {
  return [
    {
      id: randomUUID(),
      mappingId,
      sourceOperationRef: "widgets/createWidget",
      targetOperationRef: "widgets/createWidget",
      action: "create",
    },
    {
      id: randomUUID(),
      mappingId,
      sourceOperationRef: "widgets/updateWidget",
      targetOperationRef: "widgets/updateWidget",
      action: "update",
      targetIdParamRef: "widgets/updateWidget#id",
    },
  ];
}

function ruleOf(id: string, mappingId: string, resourcePairRef: string): SyncRule {
  return {
    id,
    approvedMappingId: mappingId,
    resourcePairRef,
    status: "enabled",
    backfillStatus: "completed",
    backfillMode: "link-only",
    // Full-fetch rule with NO snapshot yet: the first post-adoption poll seeds the snapshot from
    // the current source, then a later poll diffs the changed record.
    cursor: null,
    lastSnapshotRef: null,
    pollOperationRef: "widgets/listWidgets",
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
  public readonly writes: { method: string; path: string; body: JsonValue | undefined }[] = [];

  public send(request: OutboundRequest): Promise<OutboundResponse> {
    const { method, url } = request;
    const isA = url.startsWith(BASE_A);
    const store = isA ? this.appA : this.appB;
    const path = url.slice((isA ? BASE_A : BASE_B).length);
    const bare = path.split("?")[0] ?? path;

    if (method === "GET" && bare === "/widgets") {
      return resp(200, [...store.values()]);
    }
    if (method === "PATCH" && bare.startsWith("/widgets/")) {
      const id = decodeURIComponent(bare.slice("/widgets/".length));
      const merged: JsonRecord = { ...(store.get(id) ?? {}), ...asRecord(request.body), id };
      store.set(id, merged);
      this.writes.push({ method, path: bare, body: request.body });
      return resp(200, merged);
    }
    if (method === "POST" && bare === "/widgets") {
      const id = `gen-${String(store.size + 1)}`;
      const record: JsonRecord = { ...asRecord(request.body), id };
      store.set(id, record);
      this.writes.push({ method, path: bare, body: request.body });
      return resp(200, record);
    }
    return resp(404, undefined);
  }
}

function testConfig(url: string): AppConfig {
  return {
    http: { port: 0 },
    adapterHttp: { port: 0 },
    adapterAuth: { rotationOverlapMs: 86_400_000 },
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
    auth: { accounts: [] },
    sync: { testPollTrigger: false },
  };
}

async function cleanup(db: Database): Promise<void> {
  await db.delete(syncFieldState).where(inArray(syncFieldState.recordLinkId, [LINK_ID]));
  await db.delete(orderingQueue);
  await db.delete(pollSnapshot).where(inArray(pollSnapshot.syncRuleId, ALL_RULE_IDS));
  await db.delete(recordLink).where(inArray(recordLink.id, [LINK_ID]));
  await db.delete(auditLog);
  await db.delete(syncRule).where(inArray(syncRule.approvedMappingId, ALL_MAPPING_IDS));
  // FK-safe: clear graph_edge before registered_app (the sync edge recomputed on adoption).
  await db.delete(graphEdge).where(inArray(graphEdge.sourceNodeId, ALL_APP_IDS));
  await db.delete(credential).where(inArray(credential.appId, ALL_APP_IDS));
  // approvedMapping delete cascades its field/operation/parameter mapping children.
  await db.delete(approvedMapping).where(inArray(approvedMapping.id, ALL_MAPPING_IDS));
  await db
    .delete(resourceBindingRef)
    .where(inArray(resourceBindingRef.resourceBindingId, [BINDING_A_NEW, BINDING_B]));
  await db.delete(resourceBinding).where(inArray(resourceBinding.apiSpecId, ALL_SPEC_IDS));
  await db.delete(apiSpec).where(inArray(apiSpec.id, ALL_SPEC_IDS));
  await db.delete(registeredApp).where(inArray(registeredApp.id, ALL_APP_IDS));
}

suite("Phase-6 SL-8.5 added-field baseline seeding on adoption (requires Postgres)", () => {
  let db: Database;
  const config = testConfig(databaseUrl ?? "");
  const logger: FastifyBaseLogger = pino({ level: "silent" });
  const landscape = new FakeLandscape();
  let sync: SyncBackground;
  let consumer: ReturnType<typeof buildArtifactInstantiation>["consumer"];
  const seedCalls: { ruleId: string; successorMappingId: string }[] = [];

  beforeAll(async () => {
    db = createDb(databaseUrl ?? "");
    await runMigrations(db);
    await cleanup(db);

    landscape.appA.set("a1", { id: "a1", code: "W-1", name: "Alpha", status: "open" });
    landscape.appB.set("b1", { id: "b1", code: "W-1", name: "Alpha", status: "open" });

    await tx(db, async (txn) => {
      const apps = new RegisteredAppRepository(txn);
      await apps.create(appOf(APP_A, "sl85-a", BASE_A));
      await apps.create(appOf(APP_B, "sl85-b", BASE_B));

      const specs = new ApiSpecRepository(txn);
      await specs.create(specOf(SPEC_A_OLD, APP_A, "superseded", 1, [WIDGET_GROUP]));
      await specs.create(specOf(SPEC_A_NEW, APP_A, "active", 2, [WIDGET_GROUP]));
      await specs.create(specOf(SPEC_B, APP_B, "active", 1, [WIDGET_GROUP]));
      await new ResourceBindingRepository(txn).createMany([
        bindingOf(BINDING_A_NEW, SPEC_A_NEW),
        bindingOf(BINDING_B, SPEC_B),
      ]);

      const mappings = new ApprovedMappingRepository(txn);
      const artifacts = new MappingArtifactsRepository(txn);
      const downstream = new DownstreamArtifactRepository(txn);

      // Stale predecessor (A v1 → B) covering widgets [code(identity), name] + gadgets [gid, label].
      await mappings.insert({
        id: M_PRED,
        sourceSpecId: SPEC_A_OLD,
        targetSpecId: SPEC_B,
        sourceAppId: APP_A,
        targetAppId: APP_B,
        variant: "peer-peer",
        approvedBy: "operator",
        approvedAt: CREATED_AT,
        status: "stale",
      });
      await artifacts.replaceChildren(M_PRED, {
        fieldMappings: [
          field({
            mappingId: M_PRED,
            sourcePath: "widgets/code",
            targetPath: "widgets/code",
            isIdentityKey: true,
          }),
          field({ mappingId: M_PRED, sourcePath: "widgets/name", targetPath: "widgets/name" }),
          field({
            mappingId: M_PRED,
            sourcePath: "gadgets/gid",
            targetPath: "gadgets/gid",
            isIdentityKey: true,
          }),
          field({ mappingId: M_PRED, sourcePath: "gadgets/label", targetPath: "gadgets/label" }),
        ],
        operationMappings: widgetOps(M_PRED),
        parameterMappings: [],
      });

      // The successor (A v2 → B), carrying predecessorMappingId, whose child set is the SL-7.6
      // carry-forward union PLUS an ADDED widgets/status field pair; gadgets is unchanged.
      await mappings.insert({
        id: M_SUCC,
        sourceSpecId: SPEC_A_NEW,
        targetSpecId: SPEC_B,
        sourceAppId: APP_A,
        targetAppId: APP_B,
        variant: "peer-peer",
        approvedBy: "reviewer-sl85",
        approvedAt: OBSERVED_AT,
        status: "active",
        predecessorMappingId: M_PRED,
      });
      await artifacts.replaceChildren(M_SUCC, {
        fieldMappings: [
          field({
            mappingId: M_SUCC,
            sourcePath: "widgets/code",
            targetPath: "widgets/code",
            isIdentityKey: true,
          }),
          field({ mappingId: M_SUCC, sourcePath: "widgets/name", targetPath: "widgets/name" }),
          // The ADDED field pair — absent in the predecessor.
          field({ mappingId: M_SUCC, sourcePath: "widgets/status", targetPath: "widgets/status" }),
          field({
            mappingId: M_SUCC,
            sourcePath: "gadgets/gid",
            targetPath: "gadgets/gid",
            isIdentityKey: true,
          }),
          field({ mappingId: M_SUCC, sourcePath: "gadgets/label", targetPath: "gadgets/label" }),
        ],
        operationMappings: widgetOps(M_SUCC),
        parameterMappings: [],
      });

      // Two enabled rules on the predecessor: widgets (whose pair the successor extends) + gadgets
      // (unchanged). Both re-point on adoption; only the widgets rule should be seeded.
      await downstream.insertSyncRuleIfAbsent(ruleOf(RULE_WIDGETS, M_PRED, WIDGETS_PAIR));
      await downstream.insertSyncRuleIfAbsent(ruleOf(RULE_GADGETS, M_PRED, GADGETS_PAIR));

      // A pre-existing RecordLink on the widgets pair (a1 ↔ b1) from before the spec bump.
      const link: RecordLink = {
        id: LINK_ID,
        appAId: APP_A,
        appANativeId: "a1",
        appBId: APP_B,
        appBNativeId: "b1",
        resourcePairRef: WIDGETS_PAIR,
        establishedBy: "identity-match",
        status: "active",
        establishingQueueKey: { kind: "identity-value", value: "W-1" },
        createdAt: CREATED_AT,
        tombstonedAt: null,
      };
      await new RecordLinkRepository(txn).insert(link);

      // Pre-existing reconciled baselines for the PRE-EXISTING fields only (code + name), both
      // sides, with the REAL current-value hashes (so they stay reconciled on the later poll) and
      // KNOWN ids for name (so we can prove the seed never erased them). widgets/status has NONE.
      const nameHash = hashFieldValue("Alpha");
      const codeHash = hashFieldValue("W-1");
      const baseState = (
        id: string,
        side: SyncFieldState["side"],
        fieldPath: string,
        contentHash: string,
      ): SyncFieldState => ({
        id,
        recordLinkId: LINK_ID,
        side,
        fieldPath,
        observedHash: contentHash,
        observedAt: OBSERVED_AT,
        observedChangeTimestamp: null,
        status: "active",
        lastSyncedHash: contentHash,
        lastSyncedAt: OBSERVED_AT,
      });
      await new SyncFieldStateRepository(txn).seed([
        baseState(randomUUID(), "A", "widgets/code", codeHash),
        baseState(randomUUID(), "B", "widgets/code", codeHash),
        baseState(NAME_STATE_A, "A", "widgets/name", nameHash),
        baseState(NAME_STATE_B, "B", "widgets/name", nameHash),
      ]);
    });

    // Store a credential per app so the REAL withCredential read/write path is exercised.
    const credentialStore = new CredentialStore(
      new DbCredentialPersistence(db),
      new EnvKeyProvider(config.credentials.masterKey),
    );
    await credentialStore.store(APP_A, { secret: { type: "apiKey", apiKey: "a-secret" } });
    await credentialStore.store(APP_B, { secret: { type: "apiKey", apiKey: "b-secret" } });

    sync = buildSyncBackground({ db, config, logger, protocolClient: landscape });
    const graphProjection = new GraphProjection({ db, newId: randomUUID });
    consumer = buildArtifactInstantiation({
      db,
      adoption: {
        graphProjection,
        // A peer-peer adoption never drives the adapter half.
        adoptAdapter: () => Promise.reject(new Error("adapter half must not run for peer-peer")),
        // The REAL seeding trigger, wrapped in a spy so the test can assert WHICH rules were seeded.
        seedAddedFieldBaselines: (input) => {
          seedCalls.push(input);
          sync.seedAddedFieldBaselines(input);
        },
      },
    }).consumer;
  });

  afterAll(async () => {
    await sync.stop();
    await cleanup(db);
    await closeDb(db);
  });

  function mappingApprovedEvent(approvedMappingId: string): DeliveredEvent {
    return {
      id: randomUUID(),
      type: MAPPING_APPROVED_EVENT_TYPE,
      occurredAt: OBSERVED_AT,
      payload: { approvedMappingId, variant: "peer-peer" },
    };
  }

  it("seeds the added field's baseline over the existing link (only for the extended pair) and leaves the pre-existing baseline untouched", async () => {
    // Adopt the successor through the REAL consumer: re-points both rules + enqueues the seeding
    // backfill (for the widgets rule only), then run the seeding backfill to completion.
    await tx(db, (txn) => consumer.handle(mappingApprovedEvent(M_SUCC), txn));
    await sync.awaitBackfills();

    // SL-8.5 — the seeding was enqueued ONLY for the rule whose pair gained a field.
    expect(seedCalls).toEqual([{ ruleId: RULE_WIDGETS, successorMappingId: M_SUCC }]);

    const states = await new SyncFieldStateRepository(db).findByLink(LINK_ID);

    // The ADDED field pair now has a RECONCILED baseline on both sides (agree at seed time), so
    // Conflict Detection is well-defined for it — no absent-baseline drift/withhold.
    const statusRows = states.filter((row) => row.fieldPath === "widgets/status");
    expect(statusRows.map((row) => row.side).sort()).toEqual(["A", "B"]);
    expect(statusRows.every((row) => row.lastSyncedHash === hashFieldValue("open"))).toBe(true);

    // The pre-existing widgets/name baseline is UNCHANGED — the seed never erased or replaced it
    // (same rows, same ids, same hashes).
    const nameA = states.find((row) => row.side === "A" && row.fieldPath === "widgets/name");
    const nameB = states.find((row) => row.side === "B" && row.fieldPath === "widgets/name");
    expect(nameA?.id).toBe(NAME_STATE_A);
    expect(nameB?.id).toBe(NAME_STATE_B);
    expect(nameA?.lastSyncedHash).toBe(hashFieldValue("Alpha"));

    // The rule was re-pointed to the successor and kept enabled (SL-7/SL-8), not re-enabled.
    const rule = await new SyncRuleRepository(db).getById(RULE_WIDGETS);
    expect(rule?.approvedMappingId).toBe(M_SUCC);
    expect(rule?.status).toBe("enabled");
    expect(rule?.backfillStatus).toBe("completed");
  });

  it("propagates a subsequent source change to the added field instead of spuriously conflicting", async () => {
    const rules = new SyncRuleRepository(db);
    const writesBefore = landscape.writes.length;

    // Prime the full-fetch snapshot from the current (reconciled) source state, so the NEXT poll
    // diffs a genuine change rather than treating every record as first-seen.
    await sync.pollOnce(RULE_WIDGETS);
    await sync.runQueueOnce();
    // No propagation yet: source == the just-seeded baseline for every field.
    expect(landscape.writes.length).toBe(writesBefore);

    // The source now changes ONLY the added field.
    landscape.appA.set("a1", { id: "a1", code: "W-1", name: "Alpha", status: "closed" });

    const poll = await sync.pollOnce(RULE_WIDGETS);
    expect(poll.kind).toBe("completed");
    await sync.runQueueOnce();

    // The added field PROPAGATED to the target (source-wins over its reconciled baseline) — it did
    // NOT withhold/park as it would have with no baseline.
    const newWrites = landscape.writes.slice(writesBefore);
    expect(newWrites.some((w) => w.method === "PATCH" && w.path === "/widgets/b1")).toBe(true);
    expect(landscape.appB.get("b1")).toMatchObject({ status: "closed" });

    // No parked conflict was created for the added field.
    expect(await sync.parkedConflicts.listOpen(50)).toEqual([]);

    // The rule keeps executing (still enabled) after the propagation.
    expect((await rules.getById(RULE_WIDGETS))?.status).toBe("enabled");
  });
});
