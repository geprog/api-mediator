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
 * **SL-8.5 durability — live-Postgres integration proving the offloaded added-field baseline seed
 * is crash/abort-recoverable.** The fast-path seed is deliberately made to **abort** (the source
 * app's collection fetch returns 5xx — a routine transient failure for a whole-collection read),
 * which — with fire-and-forget alone — would silently leave the added field unseeded forever
 * (conflict-detection drift, no recovery). This proves the durable seed-intent + the baseline-seed
 * reconciler close that gap:
 *   1. adoption persists a durable seed-intent (`pending_baseline_seed`) in the adoption tx;
 *   2. the fast-path seed ABORTS → the intent stays set, NO baseline is written;
 *   3. once the source recovers, a baseline-seed reconciler pass re-attempts the seed to a real
 *      completion → the added field's baseline is present and the intent is cleared.
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
const LINK_ID = randomUUID();

const BASE_A = "https://sl85r-a.test";
const BASE_B = "https://sl85r-b.test";

const ALL_APP_IDS = [APP_A, APP_B];
const ALL_SPEC_IDS = [SPEC_A_OLD, SPEC_A_NEW, SPEC_B];
const ALL_MAPPING_IDS = [M_PRED, M_SUCC];

const WIDGETS_PAIR = canonicalResourcePairRef(
  { appId: APP_A, resourceRef: "widgets" },
  { appId: APP_B, resourceRef: "widgets" },
);

// A RecordLink's canonical A/B must follow the same token ordering the resourcePairRef uses
// (which depends on the random app UUIDs), not hardcode APP_A as appA.
const WIDGETS_LINK_SIDES =
  `${APP_A}:widgets` <= `${APP_B}:widgets`
    ? { appAId: APP_A, appANativeId: "a1", appBId: APP_B, appBNativeId: "b1" }
    : { appAId: APP_B, appANativeId: "b1", appBId: APP_A, appBNativeId: "a1" };

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
  return {
    operationId,
    method,
    path,
    parameters: [],
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
  operations: [widgetOp("listWidgets", "get", "/widgets")],
  schemas: [],
  crossResourceRefs: [],
};

function specOf(id: string, appId: string, status: ApiSpec["status"], version: number): ApiSpec {
  return {
    id,
    appId,
    role: "PROVIDER",
    rawDocument: { openapi: "3.1.0" },
    parsedIR: [WIDGET_GROUP],
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

function ruleOf(id: string, mappingId: string): SyncRule {
  return {
    id,
    approvedMappingId: mappingId,
    resourcePairRef: WIDGETS_PAIR,
    status: "enabled",
    backfillStatus: "completed",
    backfillMode: "link-only",
    cursor: null,
    lastSnapshotRef: null,
    pollOperationRef: "widgets/listWidgets",
  };
}

function resp(status: number, body: JsonValue | undefined): Promise<OutboundResponse> {
  return Promise.resolve({ status, headers: {}, body });
}

/** A source app that fails its collection read while `failSourceGets > 0` (a transient 5xx). */
class FlakyLandscape implements ProtocolClient {
  public readonly appA = new Map<string, JsonRecord>();
  public readonly appB = new Map<string, JsonRecord>();
  public failSourceGets = 0;

  public send(request: OutboundRequest): Promise<OutboundResponse> {
    const isA = request.url.startsWith(BASE_A);
    const store = isA ? this.appA : this.appB;
    const path = request.url.slice((isA ? BASE_A : BASE_B).length);
    const bare = path.split("?")[0] ?? path;

    if (request.method === "GET" && bare === "/widgets") {
      if (isA && this.failSourceGets > 0) {
        this.failSourceGets -= 1;
        // A transient server error → RestSourceReader returns `{ ok: false }` → the seed ABORTS.
        return resp(500, undefined);
      }
      return resp(200, [...store.values()]);
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
  await db.delete(pollSnapshot).where(inArray(pollSnapshot.syncRuleId, [RULE_WIDGETS]));
  await db.delete(recordLink).where(inArray(recordLink.id, [LINK_ID]));
  await db.delete(auditLog);
  await db.delete(syncRule).where(inArray(syncRule.approvedMappingId, ALL_MAPPING_IDS));
  await db.delete(graphEdge).where(inArray(graphEdge.sourceNodeId, ALL_APP_IDS));
  await db.delete(credential).where(inArray(credential.appId, ALL_APP_IDS));
  await db.delete(approvedMapping).where(inArray(approvedMapping.id, ALL_MAPPING_IDS));
  await db
    .delete(resourceBindingRef)
    .where(inArray(resourceBindingRef.resourceBindingId, [BINDING_A_NEW, BINDING_B]));
  await db.delete(resourceBinding).where(inArray(resourceBinding.apiSpecId, ALL_SPEC_IDS));
  await db.delete(apiSpec).where(inArray(apiSpec.id, ALL_SPEC_IDS));
  await db.delete(registeredApp).where(inArray(registeredApp.id, ALL_APP_IDS));
}

suite("Phase-6 SL-8.5 added-field baseline seed durability / recovery (requires Postgres)", () => {
  let db: Database;
  const config = testConfig(databaseUrl ?? "");
  const logger: FastifyBaseLogger = pino({ level: "silent" });
  const landscape = new FlakyLandscape();
  let sync: SyncBackground;
  let consumer: ReturnType<typeof buildArtifactInstantiation>["consumer"];

  beforeAll(async () => {
    db = createDb(databaseUrl ?? "");
    await runMigrations(db);
    await cleanup(db);

    landscape.appA.set("a1", { id: "a1", code: "W-1", name: "Alpha", status: "open" });
    landscape.appB.set("b1", { id: "b1", code: "W-1", name: "Alpha", status: "open" });

    await tx(db, async (txn) => {
      const apps = new RegisteredAppRepository(txn);
      await apps.create(appOf(APP_A, "sl85r-a", BASE_A));
      await apps.create(appOf(APP_B, "sl85r-b", BASE_B));

      const specs = new ApiSpecRepository(txn);
      await specs.create(specOf(SPEC_A_OLD, APP_A, "superseded", 1));
      await specs.create(specOf(SPEC_A_NEW, APP_A, "active", 2));
      await specs.create(specOf(SPEC_B, APP_B, "active", 1));
      await new ResourceBindingRepository(txn).createMany([
        bindingOf(BINDING_A_NEW, SPEC_A_NEW),
        bindingOf(BINDING_B, SPEC_B),
      ]);

      const mappings = new ApprovedMappingRepository(txn);
      const artifacts = new MappingArtifactsRepository(txn);
      const downstream = new DownstreamArtifactRepository(txn);

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
        ],
        operationMappings: [],
        parameterMappings: [],
      });

      await mappings.insert({
        id: M_SUCC,
        sourceSpecId: SPEC_A_NEW,
        targetSpecId: SPEC_B,
        sourceAppId: APP_A,
        targetAppId: APP_B,
        variant: "peer-peer",
        approvedBy: "reviewer-sl85r",
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
          // The ADDED field pair.
          field({ mappingId: M_SUCC, sourcePath: "widgets/status", targetPath: "widgets/status" }),
        ],
        operationMappings: [],
        parameterMappings: [],
      });

      await downstream.insertSyncRuleIfAbsent(ruleOf(RULE_WIDGETS, M_PRED));

      const link: RecordLink = {
        id: LINK_ID,
        ...WIDGETS_LINK_SIDES,
        resourcePairRef: WIDGETS_PAIR,
        establishedBy: "identity-match",
        status: "active",
        establishingQueueKey: { kind: "identity-value", value: "W-1" },
        createdAt: CREATED_AT,
        tombstonedAt: null,
      };
      await new RecordLinkRepository(txn).insert(link);

      // Pre-existing baselines for the pre-existing fields only (widgets/status has none).
      const baseState = (
        side: SyncFieldState["side"],
        fieldPath: string,
        value: string,
      ): SyncFieldState => ({
        id: randomUUID(),
        recordLinkId: LINK_ID,
        side,
        fieldPath,
        observedHash: hashFieldValue(value),
        observedAt: OBSERVED_AT,
        observedChangeTimestamp: null,
        status: "active",
        lastSyncedHash: hashFieldValue(value),
        lastSyncedAt: OBSERVED_AT,
      });
      await new SyncFieldStateRepository(txn).seed([
        baseState("A", "widgets/code", "W-1"),
        baseState("B", "widgets/code", "W-1"),
        baseState("A", "widgets/name", "Alpha"),
        baseState("B", "widgets/name", "Alpha"),
      ]);
    });

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
        adoptAdapter: () => Promise.reject(new Error("adapter half must not run for peer-peer")),
        seedAddedFieldBaselines: (input) => {
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

  it("keeps the seed-intent outstanding when the fast-path seed ABORTS, then self-heals via the reconciler", async () => {
    const rules = new SyncRuleRepository(db);
    const fieldState = new SyncFieldStateRepository(db);

    // Make the source collection read fail — the fast-path seed will ABORT.
    landscape.failSourceGets = 5;

    await tx(db, (txn) => consumer.handle(mappingApprovedEvent(M_SUCC), txn));
    await sync.awaitBackfills();

    // The seed aborted: the added field is STILL unseeded, but the durable intent is OUTSTANDING
    // (set atomically in the adoption tx and NOT cleared by the aborted run).
    const afterAbort = await rules.getById(RULE_WIDGETS);
    expect(afterAbort?.approvedMappingId).toBe(M_SUCC); // adoption itself committed
    expect(afterAbort?.pendingBaselineSeed).toBe(true);
    const statusAfterAbort = (await fieldState.findByLink(LINK_ID)).filter(
      (row) => row.fieldPath === "widgets/status",
    );
    expect(statusAfterAbort).toEqual([]);

    // The source recovers; a baseline-seed reconciler pass re-attempts the owed seed.
    landscape.failSourceGets = 0;
    await sync.baselineSeedReconciler.reconcile();
    await sync.awaitBackfills();

    // Self-healed: the added field now has a reconciled baseline and the intent is cleared.
    const statusAfterHeal = (await fieldState.findByLink(LINK_ID)).filter(
      (row) => row.fieldPath === "widgets/status",
    );
    expect(statusAfterHeal.map((row) => row.side).sort()).toEqual(["A", "B"]);
    expect(statusAfterHeal.every((row) => row.lastSyncedHash === hashFieldValue("open"))).toBe(
      true,
    );
    expect((await rules.getById(RULE_WIDGETS))?.pendingBaselineSeed).toBeUndefined();

    // A further reconciler pass is a no-op (nothing left owes a seed).
    await sync.baselineSeedReconciler.reconcile();
    await sync.awaitBackfills();
    expect((await rules.getById(RULE_WIDGETS))?.pendingBaselineSeed).toBeUndefined();
  });
});
