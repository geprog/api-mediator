import { randomUUID } from "node:crypto";

import type { AppConfig } from "@mediator/config";
import { CredentialStore, DbCredentialPersistence, EnvKeyProvider } from "@mediator/credentials";
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
import { NullRecentlyWrittenCache } from "@mediator/sync-engine";
import type { JsonRecord, JsonValue } from "@mediator/transform";
import { pino } from "pino";
import type { FastifyBaseLogger } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildSyncBackground } from "./modules/sync/background.js";

/**
 * **The Phase-4 sync-engine runtime capstone (minus UI)** — a live-Postgres backend
 * integration that drives the full loop `enable → backfill → poll → pipeline → write →
 * no-echo` through the REAL `buildSyncBackground` composition (real repos, real Outbound
 * Call Executor, real pipeline stages, real Scheduler/Poller/ordering-queue), with only
 * the external HTTP faked by a {@link FakeLandscape} `ProtocolClient` standing in for the
 * two apps. It proves the no-echo loop closes end to end (the running-landscape version
 * is the SU-6 e2e).
 *
 * Requires the compose `postgres` service + a resolvable `DATABASE_URL`; excluded from
 * `pnpm verify`, run via `pnpm --filter @mediator/backend test:integration`. Self-skips
 * when `DATABASE_URL` is unresolvable.
 */

let databaseUrl: string | undefined;
try {
  databaseUrl = resolveDatabaseUrl(process.env);
} catch {
  databaseUrl = undefined;
}
const suite = databaseUrl === undefined ? describe.skip : describe;

// ── Fixture ids ────────────────────────────────────────────────────────────────
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

// The canonical, direction-agnostic resource pair ref both rules share (derive.ts).
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

interface CapturedWrite {
  readonly method: string;
  readonly path: string;
  readonly headers: Record<string, string>;
  readonly body: JsonValue | undefined;
}

class FakeLandscape implements ProtocolClient {
  public readonly appA = new Map<string, JsonRecord>();
  public readonly appB = new Map<string, JsonRecord>();
  public readonly writes: CapturedWrite[] = [];

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
      const id = `gen-${String(this.appB.size + this.appA.size + 1)}`;
      const record: JsonRecord = { ...asRecord(request.body), id };
      store.set(id, record);
      this.#capture(method, bare, request);
      return resp(200, record);
    }
    if (method === "PATCH" && bare.startsWith("/widgets/")) {
      const id = decodeURIComponent(bare.slice("/widgets/".length));
      const merged: JsonRecord = { ...(store.get(id) ?? {}), ...asRecord(request.body), id };
      store.set(id, merged);
      this.#capture(method, bare, request);
      return resp(200, merged);
    }
    return resp(404, undefined);
  }

  #capture(method: string, path: string, request: OutboundRequest): void {
    this.writes.push({ method, path, headers: { ...request.headers }, body: request.body });
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
    auth: { accounts: [] },
    sync: { testPollTrigger: false },
  };
}

async function clearAll(db: Database): Promise<void> {
  await db.delete(orderingQueue);
  await db.delete(syncFieldState);
  await db.delete(pollSnapshot);
  await db.delete(recordLink);
  await db.delete(auditLog);
  await db.delete(credential);
  await db.delete(syncRule);
  await db.delete(operationMapping);
  await db.delete(fieldMapping);
  await db.delete(resourceBindingRef);
  await db.delete(resourceBinding);
  await db.delete(approvedMapping);
  await db.delete(apiSpec);
  await db.delete(registeredApp);
}

suite(
  "Phase-4 sync runtime: enable → backfill → poll → pipeline → write → no-echo (requires Postgres)",
  () => {
    let db: Database;
    const config = testConfig(databaseUrl ?? "");
    const logger: FastifyBaseLogger = pino({ level: "silent" });

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
        const downstream = new DownstreamArtifactRepository(txn);
        await downstream.insertSyncRuleIfAbsent(ruleOf(RULE_AB, MAPPING_AB));
        await downstream.insertSyncRuleIfAbsent(ruleOf(RULE_BA, MAPPING_BA));
      });

      // A stored credential per app exercises the REAL withCredential + CredentialApplier
      // path (the write must carry the applied auth header; the secret must never leak).
      const credentialStore = new CredentialStore(
        new DbCredentialPersistence(db),
        new EnvKeyProvider(config.credentials.masterKey),
      );
      await credentialStore.store(APP_A, { secret: { type: "apiKey", apiKey: "source-secret" } });
      await credentialStore.store(APP_B, { secret: { type: "apiKey", apiKey: "target-secret" } });
    });

    afterAll(async () => {
      await clearAll(db);
      await closeDb(db);
    });

    it("drives the whole loop and closes the no-echo cycle through the real composition", async () => {
      const landscape = new FakeLandscape();
      landscape.appA.set("a1", { id: "a1", code: "W-100", name: "Alpha", status: "open" });
      landscape.appB.set("b1", { id: "b1", code: "W-100", name: "Alpha", status: "open" });

      const sync = buildSyncBackground({ db, config, logger, protocolClient: landscape });
      const links = new RecordLinkRepository(db);
      const fieldState = new SyncFieldStateRepository(db);
      const rules = new SyncRuleRepository(db);
      const queue = new OrderingQueueRepository(db);
      const audit = new AuditLogRepository(db);

      try {
        // ── 1. enableRule(RULE_AB): link-only backfill seeds baselines + go-live state ──
        const enabledAB = await sync.enableRule(RULE_AB);
        expect(enabledAB.kind).toBe("accepted");
        if (enabledAB.kind !== "accepted") {
          throw new Error("expected accepted");
        }
        const backfillResult = await enabledAB.backfill;
        expect(backfillResult.kind).toBe("enabled");

        // The link was established by identity match (business key), and baselines seeded.
        const linkAfterBackfill = await links.findActiveByRecord(RESOURCE_PAIR_REF, {
          appId: APP_A,
          nativeId: "a1",
        });
        expect(linkAfterBackfill).toBeDefined();
        const linkId = linkAfterBackfill?.id ?? "";
        const seededRows = await fieldState.findByLink(linkId);
        // Every side-field got a reconciled baseline (all pairings agree in the fixture).
        expect(seededRows.length).toBeGreaterThan(0);
        expect(seededRows.every((row) => row.lastSyncedHash !== undefined)).toBe(true);

        // Status → completed, lastRunAt + snapshot seeded (full-fetch → no cursor), in-flight cleared.
        const ruleAfter = await rules.getById(RULE_AB);
        expect(ruleAfter?.status).toBe("enabled");
        expect(ruleAfter?.backfillStatus).toBe("completed");
        expect(ruleAfter?.lastRunAt).toBeInstanceOf(Date);
        expect(ruleAfter?.lastSnapshotRef ?? null).not.toBeNull();
        expect(ruleAfter?.cursor ?? null).toBeNull();
        expect(sync.inFlightRegistry.isBackfillInFlight(RULE_AB)).toBe(false);

        // ── 2. enable the counterpart rule (B→A) so both directions are live ──────────
        const enabledBA = await sync.enableRule(RULE_BA);
        expect(enabledBA.kind).toBe("accepted");
        if (enabledBA.kind === "accepted") {
          expect((await enabledBA.backfill).kind).toBe("enabled");
        }

        // ── 3. The source (App A) reports a changed record ────────────────────────────
        landscape.appA.set("a1", { id: "a1", code: "W-100", name: "Alpha v2", status: "open" });

        const writeCountBefore = landscape.writes.length;

        // ── 4. pollOnce(RULE_AB) → the change is durably enqueued ─────────────────────
        const pollAB = await sync.pollOnce(RULE_AB);
        expect(pollAB.kind).toBe("completed");
        if (pollAB.kind === "completed") {
          expect(pollAB.enqueued).toHaveLength(1);
          expect(pollAB.enqueued[0]?.changeKind).toBe("update");
        }
        expect(await queue.listByStatus("pending")).toHaveLength(1);

        // ── 5. The worker runs the pipeline (RL→EP→CF→TX→OC) → the target records the write ──
        const tick = await sync.queueDispatcher.runOnce();
        expect(tick.outcome).toBe("done");

        // The fake target recorded exactly one write, a PATCH to b1 carrying the new value.
        const newWrites = landscape.writes.slice(writeCountBefore);
        expect(newWrites).toHaveLength(1);
        const write = newWrites[0];
        expect(write?.method).toBe("PATCH");
        expect(write?.path).toBe("/widgets/b1");
        expect(asRecord(write?.body).name).toBe("Alpha v2");
        // The credential path applied the target's auth header inside withCredential.
        expect(write?.headers["authorization"]).toBe("Bearer target-secret");
        expect(landscape.appB.get("b1")).toMatchObject({ name: "Alpha v2" });

        // A `success` sync-execution SyncEvent was recorded (OC-5) — and no secret leaked.
        const events = await audit.listByMappingId(MAPPING_AB);
        const successEvents = events.filter(
          (entry) => entry.type === "sync-execution" && entry.status === "success",
        );
        expect(successEvents.length).toBeGreaterThan(0);
        for (const entry of events) {
          expect(JSON.stringify(entry)).not.toContain("target-secret");
          expect(JSON.stringify(entry)).not.toContain("source-secret");
        }

        // ── 6. Poll the reverse direction — the target now reflects the mediator's write ──
        // App B's poll (RULE_BA) sees the record the mediator just wrote and must recognize
        // it as an ECHO of the mediator's own write: skipped-loop, NO second write.
        //
        // Run this step through a SECOND background whose EP-2 cache is COLD
        // (NullRecentlyWrittenCache) — sharing the same DB (link + baselines from step 5).
        // With the cache disabled, the ONLY thing that can catch the echo is the durable
        // EP-1 field-baseline compare — the cache-independent no-echo guarantee. (The real
        // composition's TtlRecentlyWrittenCache is a fast path; correctness never depends
        // on it, and here we prove the backstop end to end.)
        const syncCold = buildSyncBackground({
          db,
          config,
          logger,
          protocolClient: landscape,
          recentlyWrittenCache: new NullRecentlyWrittenCache(),
        });
        try {
          const writeCountAfterFirst = landscape.writes.length;
          const pollBA = await syncCold.pollOnce(RULE_BA);
          expect(pollBA.kind).toBe("completed");
          // The reverse poll observes the written record as a change and enqueues it...
          if (pollBA.kind === "completed") {
            expect(pollBA.enqueued).toHaveLength(1);
          }
          const echoTick = await syncCold.queueDispatcher.runOnce();
          // ...which the pipeline resolves as done (a conflict/echo park is a successful done).
          expect(echoTick.outcome).toBe("done");

          // No SECOND write happened — the echo was dropped (the loop is closed).
          expect(landscape.writes.length).toBe(writeCountAfterFirst);
          const skippedLoop = (await audit.listByMappingId(MAPPING_BA)).filter(
            (entry) => entry.status === "skipped-loop",
          );
          expect(skippedLoop.length).toBeGreaterThan(0);
          // ...and with the cache cold it was the DURABLE field-baseline path that caught it
          // (EP-1), not the fast-path cache — the LoopPreventionStage records the `via` in
          // the skipped-loop event detail.
          expect(
            skippedLoop.some((entry) => (entry.details ?? "").includes("reconciled baseline")),
          ).toBe(true);
        } finally {
          await syncCold.stop();
        }

        // ── 7. Graceful stop mid-loop leaves consistent state ────────────────────────
        sync.start();
        await sync.stop();
        // The link + its baselines survive a stop (never reset).
        const linkStillActive = await links.findActiveByRecord(RESOURCE_PAIR_REF, {
          appId: APP_A,
          nativeId: "a1",
        });
        expect(linkStillActive?.id).toBe(linkId);
        expect((await fieldState.findByLink(linkId)).length).toBeGreaterThan(0);
      } finally {
        await sync.stop();
      }
    });

    it("disableRule stops polling but retains cursor / snapshot / links / field-state", async () => {
      const sync = buildSyncBackground({ db, config, logger, protocolClient: new FakeLandscape() });
      const rules = new SyncRuleRepository(db);
      try {
        const before = await rules.getById(RULE_AB);
        const snapshotBefore = before?.lastSnapshotRef ?? null;

        await sync.disableRule(RULE_AB);

        const after = await rules.getById(RULE_AB);
        expect(after?.status).toBe("disabled");
        // Live polling state is deliberately retained, never reset.
        expect(after?.lastSnapshotRef ?? null).toBe(snapshotBefore);
        expect(after?.lastRunAt ?? null).toEqual(before?.lastRunAt ?? null);
      } finally {
        await sync.stop();
      }
    });
  },
);
