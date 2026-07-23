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
  ScopeCorrespondenceRepository,
  ScopeLinkRepository,
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
  pollScopeState,
  pollSnapshot,
  recordLink,
  registeredApp,
  resolveDatabaseUrl,
  resourceBinding,
  resourceBindingRef,
  runMigrations,
  scopeCorrespondence,
  scopeLink,
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
  type ScopeCorrespondence,
  type ScopeLink,
  type SyncFieldState,
  type SyncRule,
} from "@mediator/domain";
import type { DeliveredEvent } from "@mediator/event-bus";
import type { OutboundRequest, OutboundResponse, ProtocolClient } from "@mediator/outbound";
import { hashFieldValue } from "@mediator/sync-engine";
import type { JsonValue } from "@mediator/transform";
import { inArray } from "drizzle-orm";
import { pino } from "pino";
import type { FastifyBaseLogger } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { canonicalResourcePairRef } from "./modules/artifact-instantiation/derive.js";
import { buildArtifactInstantiation } from "./modules/artifact-instantiation/index.js";
import { GraphProjection } from "./modules/graph/index.js";
import { buildSyncBackground, type SyncBackground } from "./modules/sync/background.js";

/**
 * **SL-8.5 durability — a PER-SCOPE (fan-out) seed whose one scope aborts must NOT clear the
 * intent** (the delta-review MUST-FIX). A scoped successor-adoption rule's seed fans out over its
 * containers; if scope C2's source collection read returns a transient 5xx it aborts that branch
 * while C1 completes. A `.some(...completed)` clear would drop C2's added-field baselines
 * permanently (C2's records then read the absent baseline as drifted → target-wins-withhold →
 * never propagate the added field). This drives the REAL sync runtime over live Postgres and
 * proves the corrected `every(scope => completed)` predicate: a partial-abort fan-out KEEPS the
 * intent, and a later reconciler pass (once C2 recovers) self-heals C2 to a real completion.
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
const CORRESPONDENCE = randomUUID();
const LINK_C1 = randomUUID();
const LINK_C2 = randomUUID();
const RECLINK_C1 = randomUUID();
const RECLINK_C2 = randomUUID();

const BASE_A = "https://sl85ps-a.test";
const BASE_B = "https://sl85ps-b.test";

const ALL_APP_IDS = [APP_A, APP_B];
const ALL_SPEC_IDS = [SPEC_A_OLD, SPEC_A_NEW, SPEC_B];
const ALL_MAPPING_IDS = [M_PRED, M_SUCC];
const ALL_RECLINK_IDS = [RECLINK_C1, RECLINK_C2];

const WIDGETS_PAIR = canonicalResourcePairRef(
  { appId: APP_A, resourceRef: "widgets" },
  { appId: APP_B, resourceRef: "widgets" },
);

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

function fields(): IrOperation["responseSchema"] {
  return {
    name: "Widget",
    fields: [
      { name: "id", type: "string", required: true },
      { name: "code", type: "string", required: true },
      { name: "name", type: "string", required: false },
      { name: "status", type: "string", required: false },
    ],
  };
}

// Source `widgets`: a PER-CONTAINER collection read `GET /orgs/{org}/widgets`.
const SOURCE_GROUP: IrResourceGroup = {
  resourceRef: "widgets",
  name: "Widgets",
  operations: [
    {
      operationId: "listSourceWidgets",
      method: "get",
      path: "/orgs/{org}/widgets",
      parameters: [{ name: "org", location: "path", required: true, type: "string" }],
      responseSchema: fields(),
    },
  ],
  schemas: [],
  crossResourceRefs: [],
};

// Target `widgets`: an app-wide (unscoped) collection read `GET /widgets`.
const TARGET_GROUP: IrResourceGroup = {
  resourceRef: "widgets",
  name: "Widgets",
  operations: [
    {
      operationId: "listTargetWidgets",
      method: "get",
      path: "/widgets",
      parameters: [],
      responseSchema: fields(),
    },
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

function sourceBinding(): ResourceBinding {
  return {
    id: BINDING_A_NEW,
    apiSpecId: SPEC_A_NEW,
    resourceRef: "widgets",
    nativeIdRef: confirmedRef({ kind: "field", path: "id" }),
    collectionReadRef: confirmedRef({ kind: "operation", operationId: "listSourceWidgets" }),
    // The per-container source read fill: `{org}` from each ScopeLink's source-side scope key.
    scopePathBindings: [
      {
        kind: "scope-link",
        parameterName: "org",
        scopeKeyRef: "org",
        confirmedBy: "operator",
        confirmedAt: CREATED_AT,
      },
    ],
  };
}

function targetBinding(): ResourceBinding {
  return {
    id: BINDING_B,
    apiSpecId: SPEC_B,
    resourceRef: "widgets",
    nativeIdRef: confirmedRef({ kind: "field", path: "id" }),
    // Unscoped target read → the seed's counterpart lookup is app-wide (no target container fill).
    collectionReadRef: confirmedRef({ kind: "operation", operationId: "listTargetWidgets" }),
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

function correspondenceOf(): ScopeCorrespondence {
  return {
    id: CORRESPONDENCE,
    resourcePairRef: WIDGETS_PAIR,
    scopeIdentityKey: [{ sourceScopeKey: "org", targetFieldPath: "widgets/org" }],
    targetContainerRef: { appId: APP_B, resourceRef: "widgets" },
    sourceContainerRef: { appId: APP_A, resourceRef: "widgets" },
    confirmedBy: "operator",
    confirmedAt: CREATED_AT,
  };
}

function scopeLinkOf(id: string, org: string): ScopeLink {
  return {
    id,
    scopeCorrespondenceId: CORRESPONDENCE,
    appAId: APP_A,
    appAScopeKey: { org },
    appBId: APP_B,
    appBScopeKey: { org: `${org}-target` },
    resourcePairRef: WIDGETS_PAIR,
    // Pinned mode polls/seeds only operator-pinned links.
    establishedBy: "manual",
    status: "active",
    createdAt: CREATED_AT,
  };
}

// A RecordLink's canonical A/B must follow the same token ordering the resourcePairRef uses
// (which depends on the random app UUIDs), not hardcode APP_A as appA.
const APP_A_IS_CANONICAL_A = `${APP_A}:widgets` <= `${APP_B}:widgets`;

function recLinkOf(
  id: string,
  aNativeId: string,
  bNativeId: string,
  scopeLinkId: string,
): RecordLink {
  return {
    id,
    appAId: APP_A_IS_CANONICAL_A ? APP_A : APP_B,
    appANativeId: APP_A_IS_CANONICAL_A ? aNativeId : bNativeId,
    appBId: APP_A_IS_CANONICAL_A ? APP_B : APP_A,
    appBNativeId: APP_A_IS_CANONICAL_A ? bNativeId : aNativeId,
    resourcePairRef: WIDGETS_PAIR,
    establishedBy: "identity-match",
    status: "active",
    establishingQueueKey: { kind: "identity-value", value: aNativeId },
    createdAt: CREATED_AT,
    tombstonedAt: null,
    scopeRef: { kind: "scope-link", scopeLinkId },
  };
}

function ruleOf(): SyncRule {
  return {
    id: RULE_WIDGETS,
    approvedMappingId: M_PRED,
    resourcePairRef: WIDGETS_PAIR,
    status: "enabled",
    backfillStatus: "completed",
    backfillMode: "link-only",
    // Pin the rule per-scope so its seed fans out over the two operator-linked containers.
    pollScopeMode: "per-scope-pinned",
    cursor: null,
    lastSnapshotRef: null,
    pollOperationRef: "widgets/listSourceWidgets",
  };
}

function resp(status: number, body: JsonValue | undefined): Promise<OutboundResponse> {
  return Promise.resolve({ status, headers: {}, body });
}

/** Source reads are per-container; C2's read fails while `failC2 > 0` (a transient 5xx). */
class PerScopeLandscape implements ProtocolClient {
  public failC2 = 0;

  public send(request: OutboundRequest): Promise<OutboundResponse> {
    const isA = request.url.startsWith(BASE_A);
    const path = request.url.slice((isA ? BASE_A : BASE_B).length);
    const bare = path.split("?")[0] ?? path;

    if (isA && request.method === "GET" && bare === "/orgs/c1/widgets") {
      return resp(200, [{ id: "a1", code: "W-1", name: "Alpha", status: "open" }]);
    }
    if (isA && request.method === "GET" && bare === "/orgs/c2/widgets") {
      if (this.failC2 > 0) {
        this.failC2 -= 1;
        return resp(500, undefined);
      }
      return resp(200, [{ id: "a2", code: "W-2", name: "Beta", status: "ready" }]);
    }
    if (!isA && request.method === "GET" && bare === "/widgets") {
      return resp(200, [
        { id: "b1", code: "W-1", name: "Alpha", status: "open" },
        { id: "b2", code: "W-2", name: "Beta", status: "ready" },
      ]);
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
  await db.delete(syncFieldState).where(inArray(syncFieldState.recordLinkId, ALL_RECLINK_IDS));
  await db.delete(orderingQueue);
  await db.delete(pollScopeState).where(inArray(pollScopeState.syncRuleId, [RULE_WIDGETS]));
  await db.delete(pollSnapshot).where(inArray(pollSnapshot.syncRuleId, [RULE_WIDGETS]));
  await db.delete(recordLink).where(inArray(recordLink.id, ALL_RECLINK_IDS));
  await db.delete(scopeLink).where(inArray(scopeLink.id, [LINK_C1, LINK_C2]));
  await db.delete(scopeCorrespondence).where(inArray(scopeCorrespondence.id, [CORRESPONDENCE]));
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

suite("Phase-6 SL-8.5 per-scope seed durability / recovery (requires Postgres)", () => {
  let db: Database;
  const config = testConfig(databaseUrl ?? "");
  const logger: FastifyBaseLogger = pino({ level: "silent" });
  const landscape = new PerScopeLandscape();
  let sync: SyncBackground;
  let consumer: ReturnType<typeof buildArtifactInstantiation>["consumer"];

  beforeAll(async () => {
    db = createDb(databaseUrl ?? "");
    await runMigrations(db);
    await cleanup(db);

    await tx(db, async (txn) => {
      const apps = new RegisteredAppRepository(txn);
      await apps.create(appOf(APP_A, "sl85ps-a", BASE_A));
      await apps.create(appOf(APP_B, "sl85ps-b", BASE_B));

      const specs = new ApiSpecRepository(txn);
      await specs.create(specOf(SPEC_A_OLD, APP_A, "superseded", 1, [SOURCE_GROUP]));
      await specs.create(specOf(SPEC_A_NEW, APP_A, "active", 2, [SOURCE_GROUP]));
      await specs.create(specOf(SPEC_B, APP_B, "active", 1, [TARGET_GROUP]));
      await new ResourceBindingRepository(txn).createMany([sourceBinding(), targetBinding()]);

      // The pair's scope correspondence + two operator-pinned container links (C1, C2).
      await new ScopeCorrespondenceRepository(txn).create(correspondenceOf());
      const links = new ScopeLinkRepository(txn);
      await links.create(scopeLinkOf(LINK_C1, "c1"));
      await links.create(scopeLinkOf(LINK_C2, "c2"));

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
        approvedBy: "reviewer-sl85ps",
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

      await downstream.insertSyncRuleIfAbsent(ruleOf());

      // A pre-existing RecordLink per container (C1: a1↔b1, C2: a2↔b2) from before the spec bump.
      const recLinks = new RecordLinkRepository(txn);
      await recLinks.insert(recLinkOf(RECLINK_C1, "a1", "b1", LINK_C1));
      await recLinks.insert(recLinkOf(RECLINK_C2, "a2", "b2", LINK_C2));

      // Pre-existing baselines for the pre-existing fields only (code, name), both sides, both
      // links — so widgets/status is demonstrably the newly-seeded field.
      const baseState = (
        recordLinkId: string,
        side: SyncFieldState["side"],
        fieldPath: string,
        value: string,
      ): SyncFieldState => ({
        id: randomUUID(),
        recordLinkId,
        side,
        fieldPath,
        observedHash: hashFieldValue(value),
        observedAt: OBSERVED_AT,
        observedChangeTimestamp: null,
        status: "active",
        lastSyncedHash: hashFieldValue(value),
        lastSyncedAt: OBSERVED_AT,
      });
      const fieldState = new SyncFieldStateRepository(txn);
      await fieldState.seed([
        baseState(RECLINK_C1, "A", "widgets/code", "W-1"),
        baseState(RECLINK_C1, "B", "widgets/code", "W-1"),
        baseState(RECLINK_C1, "A", "widgets/name", "Alpha"),
        baseState(RECLINK_C1, "B", "widgets/name", "Alpha"),
        baseState(RECLINK_C2, "A", "widgets/code", "W-2"),
        baseState(RECLINK_C2, "B", "widgets/code", "W-2"),
        baseState(RECLINK_C2, "A", "widgets/name", "Beta"),
        baseState(RECLINK_C2, "B", "widgets/name", "Beta"),
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

  function statusBaselines(states: readonly SyncFieldState[]): SyncFieldState[] {
    return states.filter((row) => row.fieldPath === "widgets/status");
  }

  it("a partial per-scope abort KEEPS the intent (C2 unseeded); a later reconciler pass self-heals C2", async () => {
    const rules = new SyncRuleRepository(db);
    const fieldState = new SyncFieldStateRepository(db);

    // C2's per-container source read fails — its scope's seed branch ABORTS while C1 completes.
    landscape.failC2 = 5;

    await tx(db, (txn) => consumer.handle(mappingApprovedEvent(M_SUCC), txn));
    await sync.awaitBackfills();

    // The intent is OUTSTANDING: even though C1 completed, C2 aborted, so `every(completed)` is
    // false → the seed did NOT clear the intent.
    expect((await rules.getById(RULE_WIDGETS))?.pendingBaselineSeed).toBe(true);
    // C1 (the completed scope) got its added-field baseline; C2 (aborted) did NOT.
    expect(statusBaselines(await fieldState.findByLink(RECLINK_C1)).length).toBeGreaterThan(0);
    expect(statusBaselines(await fieldState.findByLink(RECLINK_C2))).toEqual([]);

    // C2's container recovers; one baseline-seed reconciler pass re-attempts the owed seed.
    landscape.failC2 = 0;
    await sync.baselineSeedReconciler.reconcile();
    await sync.awaitBackfills();

    // Self-healed: C2 now has its added-field baseline (reconciled), and the intent is cleared
    // (every scope completed). C1's baseline is untouched (seed-never-erases).
    const c2Status = statusBaselines(await fieldState.findByLink(RECLINK_C2));
    expect(c2Status.map((row) => row.side).sort()).toEqual(["A", "B"]);
    expect(c2Status.every((row) => row.lastSyncedHash === hashFieldValue("ready"))).toBe(true);
    expect((await rules.getById(RULE_WIDGETS))?.pendingBaselineSeed).toBeUndefined();

    // A further pass is a no-op — nothing owes a seed.
    await sync.baselineSeedReconciler.reconcile();
    await sync.awaitBackfills();
    expect((await rules.getById(RULE_WIDGETS))?.pendingBaselineSeed).toBeUndefined();
  });
});
