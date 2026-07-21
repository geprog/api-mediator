import {
  auditLog,
  closeDb,
  createDb,
  registeredApp,
  resolveDatabaseUrl,
  runMigrations,
  type Database,
  type DbHandle,
} from "@mediator/db";
import type { AuditLogEntry, DomainEventEnvelope, OutboundLoadLimits } from "@mediator/domain";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { DbSyncEventStore, type SyncEventOutbox } from "./sync-event-store.js";

/**
 * Live-database integration for the OC persistence the unit tests fake: the
 * `sync-execution` `SyncEvent` write (OC-5) and the OC-2 **bounded** idempotency
 * lookback query, plus proof the `0012` migration applies clean (the SD-4 columns
 * + the `registered_app.outbound_limits` column exist and round-trip). Requires the
 * compose `postgres` service + a resolvable `DATABASE_URL`; excluded from
 * `pnpm verify`, run via `pnpm --filter @mediator/outbound test:integration`.
 * Self-skips when `DATABASE_URL` is unresolvable.
 *
 * XI-1 also asserts here — against the real `db.transaction` in `DbSyncEventStore.record` —
 * that a recorded `sync-execution` emits exactly one faithful outbox event through the
 * {@link SyncEventOutbox} seam while a `backfill-run` emits none (a `RecordingOutbox` stands
 * in for the real `PostgresEventBus`; the end-to-end outbox → dispatcher → CH-3 cache drop is
 * proven in the backend integration suite, where the event bus + consumer + cache live).
 */

/** Captures the events `DbSyncEventStore.record` emits, without a real outbox insert. */
class RecordingOutbox implements SyncEventOutbox {
  public readonly emitted: DomainEventEnvelope[] = [];
  public emit(event: DomainEventEnvelope, _tx: DbHandle): Promise<void> {
    void _tx;
    this.emitted.push(event);
    return Promise.resolve();
  }
}

let databaseUrl: string | undefined;
try {
  databaseUrl = resolveDatabaseUrl(process.env);
} catch {
  databaseUrl = undefined;
}
const suite = databaseUrl === undefined ? describe.skip : describe;

const T0 = new Date("2026-07-13T00:00:00.000Z");

function syncEvent(overrides: Partial<AuditLogEntry> & Pick<AuditLogEntry, "id">): AuditLogEntry {
  return {
    type: "sync-execution",
    actor: "system",
    timestamp: T0,
    ...overrides,
  };
}

suite("Phase-4 outbound persistence integration (requires Postgres)", () => {
  let db: Database;
  let store: DbSyncEventStore;
  let outbox: RecordingOutbox;

  beforeAll(async () => {
    db = createDb(resolveDatabaseUrl(process.env));
    await runMigrations(db);
    outbox = new RecordingOutbox();
    store = new DbSyncEventStore(db, outbox);
  });

  beforeEach(async () => {
    await db.delete(auditLog);
    await db.delete(registeredApp);
    outbox.emitted.length = 0;
  });

  afterAll(async () => {
    await closeDb(db);
  });

  it("records a sync-execution SyncEvent with the SD-4 fields and reads it back (OC-5)", async () => {
    await store.record(
      syncEvent({
        id: "11111111-1111-1111-1111-111111111111",
        status: "success",
        relatedRuleId: "22222222-2222-2222-2222-222222222222",
        recordLinkId: "33333333-3333-3333-3333-333333333333",
        sourceNativeId: "src-1",
        idempotencyKey: "idem-key-A",
        payloadHash: "payload-hash-A",
        traceId: "trace-abc",
        spanId: "span-def",
      }),
    );

    const [row] = await store.findRecentByIdempotencyKey("idem-key-A", {
      since: new Date(T0.getTime() - 1_000),
      limit: 10,
    });
    expect(row?.status).toBe("success");
    expect(row?.relatedRuleId).toBe("22222222-2222-2222-2222-222222222222");
    expect(row?.recordLinkId).toBe("33333333-3333-3333-3333-333333333333");
    expect(row?.sourceNativeId).toBe("src-1");
    expect(row?.payloadHash).toBe("payload-hash-A");
    expect(row?.traceId).toBe("trace-abc");
    expect(row?.spanId).toBe("span-def");
  });

  it("XI-1: recording a sync-execution also emits exactly one faithful outbox event", async () => {
    await store.record(
      syncEvent({
        id: "66666666-6666-6666-6666-666666666666",
        status: "success",
        originAppId: "77777777-7777-7777-7777-777777777777",
        relatedRuleId: "88888888-8888-8888-8888-888888888888",
        sourceNativeId: "src-2",
      }),
    );

    expect(outbox.emitted).toHaveLength(1);
    // The event id is the audit row's id (1:1), and it carries exactly the CH-3 signal fields.
    expect(outbox.emitted[0]).toStrictEqual({
      id: "66666666-6666-6666-6666-666666666666",
      type: "sync-execution",
      occurredAt: T0,
      status: "success",
      originAppId: "77777777-7777-7777-7777-777777777777",
      relatedRuleId: "88888888-8888-8888-8888-888888888888",
    });
  });

  it("XI-1: a backfill-run row is persisted but emits NO outbox event (CH-3 handles sync-execution only)", async () => {
    await store.record(
      syncEvent({
        id: "99999999-9999-9999-9999-999999999999",
        type: "backfill-run",
        status: "success",
        relatedRuleId: "88888888-8888-8888-8888-888888888888",
      }),
    );

    expect(outbox.emitted).toHaveLength(0);
    // The audit row itself still committed in the same transaction.
    const rows = await db.select().from(auditLog);
    expect(rows.map((r) => r.id)).toStrictEqual(["99999999-9999-9999-9999-999999999999"]);
  });

  it("bounded lookback: filters by key + since, most-recent-first, capped at limit (OC-2)", async () => {
    await store.record(
      syncEvent({
        id: "aaaaaaaa-0000-0000-0000-000000000001",
        status: "success",
        idempotencyKey: "K",
        timestamp: new Date(T0.getTime() + 1_000),
      }),
    );
    await store.record(
      syncEvent({
        id: "aaaaaaaa-0000-0000-0000-000000000002",
        status: "failure",
        idempotencyKey: "K",
        timestamp: new Date(T0.getTime() + 3_000),
      }),
    );
    await store.record(
      syncEvent({
        id: "aaaaaaaa-0000-0000-0000-000000000003",
        status: "success",
        idempotencyKey: "OTHER",
        timestamp: new Date(T0.getTime() + 3_000),
      }),
    );
    await store.record(
      syncEvent({
        id: "aaaaaaaa-0000-0000-0000-000000000004",
        status: "success",
        idempotencyKey: "K",
        timestamp: new Date(T0.getTime() - 10_000), // before `since`
      }),
    );

    const found = await store.findRecentByIdempotencyKey("K", {
      since: new Date(T0.getTime()),
      limit: 10,
    });
    // Only key K, no older than `since`, most-recent first.
    expect(found.map((e) => e.id)).toStrictEqual([
      "aaaaaaaa-0000-0000-0000-000000000002",
      "aaaaaaaa-0000-0000-0000-000000000001",
    ]);

    const capped = await store.findRecentByIdempotencyKey("K", {
      since: new Date(T0.getTime() - 100_000),
      limit: 1,
    });
    expect(capped.map((e) => e.id)).toStrictEqual(["aaaaaaaa-0000-0000-0000-000000000002"]);
  });

  it("registered_app.outbound_limits (OC-3) round-trips as jsonb; a NULL is absent", async () => {
    const limits: OutboundLoadLimits = {
      maxConcurrentRequests: 4,
      maxRequestsPerWindow: 20,
      rateWindowMs: 1_000,
    };
    await db.insert(registeredApp).values({
      id: "44444444-4444-4444-4444-444444444444",
      name: "Limited",
      status: "active",
      capabilities: {
        supportsPolling: true,
        supportsDeltaQuery: false,
        supportsChangeTimestamps: false,
        defaultPollInterval: 60_000,
      },
      outboundLimits: limits,
      createdAt: T0,
    });
    await db.insert(registeredApp).values({
      id: "55555555-5555-5555-5555-555555555555",
      name: "Unlimited",
      status: "active",
      capabilities: {
        supportsPolling: true,
        supportsDeltaQuery: false,
        supportsChangeTimestamps: false,
        defaultPollInterval: 60_000,
      },
      createdAt: T0,
    });

    const rows = await db.select().from(registeredApp);
    const limited = rows.find((r) => r.id === "44444444-4444-4444-4444-444444444444");
    const unlimited = rows.find((r) => r.id === "55555555-5555-5555-5555-555555555555");
    expect(limited?.outboundLimits).toStrictEqual(limits);
    expect(unlimited?.outboundLimits).toBeNull();
  });
});
