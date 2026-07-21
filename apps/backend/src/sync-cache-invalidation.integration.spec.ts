import { randomUUID } from "node:crypto";

import {
  EventOutboxRepository,
  ProcessedEventRepository,
  auditLog,
  closeDb,
  createDb,
  eventOutbox,
  processedEvent,
  resolveDatabaseUrl,
  runMigrations,
  type Database,
  type DbTransaction,
} from "@mediator/db";
import type { AuditLogEntry, AuditLogStatus } from "@mediator/domain";
import { ConsumerRegistry, OutboxDispatcher, PostgresEventBus } from "@mediator/event-bus";
import { DbSyncEventStore, type SyncEventOutbox } from "@mediator/outbound";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { SyncEventCacheInvalidationConsumer } from "./http/adapter-runtime/cache-invalidation.js";
import { ResponseCacheInvalidator } from "./http/adapter-runtime/serve/cache-invalidator.js";
import { InProcessResponseCache } from "./http/adapter-runtime/serve/response-cache.js";

/**
 * **XI-1 — the producer that activates CH-3, end to end on live Postgres.** It wires the real
 * `DbSyncEventStore` (producer) → real `PostgresEventBus`/`event_outbox` → real
 * `OutboxDispatcher` → the real CH-3 `adapter-cache-invalidation` consumer → the real
 * in-process response cache, and proves: a recorded **applied** (`success`) sync-execution
 * drops the changed backend resource's cached responses; a `failure`/`skipped-*`/`conflict`
 * one is still delivered but drops nothing (the consumer's `isAppliedChange` guard); the
 * outbox row commits **atomically** with the audit row (a rolled-back `record` leaves
 * neither); and a redelivered event re-drops idempotently.
 *
 * The consumer's rule → `resourcePairRef` lookup is a small in-test seam that mirrors
 * `SyncRuleRepository.getById` (seeding a full `SyncRule` drags in the entire
 * `ApprovedMapping` FK chain, which is orthogonal to what XI-1 adds — the producer; that
 * lookup's real repository path is integration-tested elsewhere). Everything else — the
 * outbox write, the dispatcher delivery, the consumer, the cache drop — is the real code.
 *
 * Requires the compose `postgres` service + a resolvable `DATABASE_URL`; self-skips when it
 * is unresolvable. Run via `pnpm --filter @mediator/backend run test:integration`.
 */

let databaseUrl: string | undefined;
try {
  databaseUrl = resolveDatabaseUrl(process.env);
} catch {
  databaseUrl = undefined;
}
const suite = databaseUrl === undefined ? describe.skip : describe;

const T0 = new Date("2026-07-21T00:00:00.000Z");
const LIVE = new Date(T0.getTime() + 1_000);
// `origin_app_id` and `related_rule_id` are UUID columns, so the app ids and rule id must be
// valid UUIDs (the executor stamps real `RegisteredApp.id`/`SyncRule.id`s there).
const APP_SOURCE = "a0000000-0000-4000-8000-000000000001";
const APP_TARGET = "b0000000-0000-4000-8000-000000000002";
const RULE_ID = "c0000000-0000-4000-8000-000000000003";
/** A canonical, direction-agnostic pair: the source side, then the changed target side. */
const PAIR = `${APP_SOURCE}:tasks|${APP_TARGET}:issues`;

/** Mirrors `SyncRuleRepository.getById(ruleId)?.resourcePairRef` for the seeded rule only. */
const readResourcePairRef = (ruleId: string): Promise<string | undefined> =>
  Promise.resolve(ruleId === RULE_ID ? PAIR : undefined);

function syncEvent(overrides: Partial<AuditLogEntry> & Pick<AuditLogEntry, "id">): AuditLogEntry {
  return { type: "sync-execution", actor: "system", timestamp: T0, ...overrides };
}

function seed(
  cache: InProcessResponseCache,
  endpointId: string,
  key: string,
  resources: readonly { readonly backendAppId: string; readonly resourceRef: string }[],
): void {
  cache.set(
    {
      endpointId,
      normalizedParams: key,
      body: { seeded: key },
      contributingBackendAppIds: resources.map((resource) => resource.backendAppId),
      contributingBackendResources: resources,
      cacheTtl: 60_000,
    },
    T0,
  );
}

suite("XI-1 sync-execution → CH-3 cache invalidation (requires Postgres)", () => {
  let db: Database;
  let store: DbSyncEventStore;

  beforeAll(async () => {
    db = createDb(resolveDatabaseUrl(process.env));
    await runMigrations(db);
    // The production producer: audit write + outbox emit in one transaction.
    store = new DbSyncEventStore(db, new PostgresEventBus());
  });

  beforeEach(async () => {
    await db.delete(processedEvent);
    await db.delete(eventOutbox);
    await db.delete(auditLog);
  });

  afterAll(async () => {
    // Leave the shared tables as clean as we found them (the integration suite serializes
    // files over one database), then close the pool.
    await db.delete(processedEvent);
    await db.delete(eventOutbox);
    await db.delete(auditLog);
    await closeDb(db);
  });

  /** The shared outbox dispatcher with only the CH-3 consumer registered (over `cache`). */
  function buildDispatcher(cache: InProcessResponseCache): OutboxDispatcher<DbTransaction> {
    const registry = new ConsumerRegistry<DbTransaction>();
    registry.register(
      new SyncEventCacheInvalidationConsumer<DbTransaction>(
        new ResponseCacheInvalidator(cache),
        readResourcePairRef,
      ),
    );
    return new OutboxDispatcher<DbTransaction>(
      db,
      (tx) => new EventOutboxRepository(tx),
      (tx) => new ProcessedEventRepository(tx),
      registry,
    );
  }

  it("a recorded success sync-execution is delivered to CH-3 and drops the changed resource's cache", async () => {
    const cache = new InProcessResponseCache();
    // Bound to the changed (appB, issues) resource → dropped.
    seed(cache, "ep-changed", "k1", [{ backendAppId: APP_TARGET, resourceRef: "issues" }]);
    // The source side (appA, tasks) → survives (resource-scoped, not a blanket flush).
    seed(cache, "ep-keep", "k2", [{ backendAppId: APP_SOURCE, resourceRef: "tasks" }]);
    const dispatcher = buildDispatcher(cache);

    await store.record(
      syncEvent({
        id: randomUUID(),
        status: "success",
        originAppId: APP_TARGET,
        relatedRuleId: RULE_ID,
        sourceNativeId: "src-1",
      }),
    );
    const result = await dispatcher.runOnce();

    expect(result.published).toBe(1);
    expect(cache.get("ep-changed", "k1", LIVE)).toBeUndefined();
    expect(cache.get("ep-keep", "k2", LIVE)?.body).toStrictEqual({ seeded: "k2" });
  });

  it("a failure/skipped/conflict sync-execution is delivered but the isAppliedChange guard drops nothing (XI-1.3)", async () => {
    const nonApplied: AuditLogStatus[] = ["failure", "skipped-loop", "skipped-policy", "conflict"];
    for (const status of nonApplied) {
      await db.delete(processedEvent);
      await db.delete(eventOutbox);
      await db.delete(auditLog);
      const cache = new InProcessResponseCache();
      seed(cache, "ep-changed", "k1", [{ backendAppId: APP_TARGET, resourceRef: "issues" }]);
      const dispatcher = buildDispatcher(cache);

      await store.record(
        syncEvent({ id: randomUUID(), status, originAppId: APP_TARGET, relatedRuleId: RULE_ID }),
      );
      const result = await dispatcher.runOnce();

      // The producer emits it faithfully and it IS delivered (published) …
      expect(result.published).toBe(1);
      // … but a non-applied change (status !== success) changed no target data → no drop.
      expect(cache.get("ep-changed", "k1", LIVE)?.body).toStrictEqual({ seeded: "k1" });
    }
  });

  it("atomicity: the outbox row commits together with the sync-execution audit row", async () => {
    const id = randomUUID();
    await store.record(
      syncEvent({ id, status: "success", originAppId: APP_TARGET, relatedRuleId: RULE_ID }),
    );

    const auditRows = await db.select().from(auditLog).where(eq(auditLog.id, id));
    const outboxRows = await db.select().from(eventOutbox).where(eq(eventOutbox.eventId, id));
    expect(auditRows).toHaveLength(1);
    expect(outboxRows).toHaveLength(1);
    expect(outboxRows[0]?.type).toBe("sync-execution");
    // The payload carries exactly the fields the CH-3 consumer reads (status carried faithfully).
    expect(outboxRows[0]?.payload).toMatchObject({
      status: "success",
      originAppId: APP_TARGET,
      relatedRuleId: RULE_ID,
    });
  });

  it("atomicity: an outbox emit failure rolls back the WHOLE record — neither row is left (XI-1.4)", async () => {
    const failingOutbox: SyncEventOutbox = {
      emit: (): Promise<void> => Promise.reject(new Error("outbox unavailable")),
    };
    const failingStore = new DbSyncEventStore(db, failingOutbox);
    const id = randomUUID();

    await expect(
      failingStore.record(
        syncEvent({ id, status: "success", originAppId: APP_TARGET, relatedRuleId: RULE_ID }),
      ),
    ).rejects.toThrow(/outbox unavailable/);

    // Both rolled back: a failed enqueue never leaves a half-committed sync execution. And
    // because `record` runs AFTER the executor's outbound write, the already-applied
    // target-side change is untouched — only cache freshness is at risk (bounded by cacheTtl).
    expect(await db.select().from(auditLog).where(eq(auditLog.id, id))).toHaveLength(0);
    expect(await db.select().from(eventOutbox).where(eq(eventOutbox.eventId, id))).toHaveLength(0);
  });

  it("idempotency: a redelivered outbox event re-drops with no error (at-least-once tolerance)", async () => {
    const id = randomUUID();
    const cache = new InProcessResponseCache();
    seed(cache, "ep-changed", "k1", [{ backendAppId: APP_TARGET, resourceRef: "issues" }]);
    const dispatcher = buildDispatcher(cache);

    await store.record(
      syncEvent({ id, status: "success", originAppId: APP_TARGET, relatedRuleId: RULE_ID }),
    );
    expect((await dispatcher.runOnce()).published).toBe(1);
    expect(cache.get("ep-changed", "k1", LIVE)).toBeUndefined();

    // Simulate a redelivery of the same event: clear this consumer's ledger row and the
    // published flag so the SAME outbox row is claimed again, re-seed the entry, and re-run.
    await db.delete(processedEvent).where(eq(processedEvent.eventId, id));
    await db
      .update(eventOutbox)
      .set({ publishedAt: null, attempts: 0 })
      .where(eq(eventOutbox.eventId, id));
    seed(cache, "ep-changed", "k1", [{ backendAppId: APP_TARGET, resourceRef: "issues" }]);

    const redeliver = await dispatcher.runOnce();
    expect(redeliver.published).toBe(1);
    expect(cache.get("ep-changed", "k1", LIVE)).toBeUndefined();
  });
});
