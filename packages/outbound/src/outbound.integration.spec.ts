import {
  AuditLogRepository,
  auditLog,
  closeDb,
  createDb,
  registeredApp,
  resolveDatabaseUrl,
  runMigrations,
  type Database,
} from "@mediator/db";
import type { AuditLogEntry, OutboundLoadLimits } from "@mediator/domain";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { DbSyncEventStore } from "./sync-event-store.js";

/**
 * Live-database integration for the OC persistence the unit tests fake: the
 * `sync-execution` `SyncEvent` write (OC-5) and the OC-2 **bounded** idempotency
 * lookback query, plus proof the `0012` migration applies clean (the SD-4 columns
 * + the `registered_app.outbound_limits` column exist and round-trip). Requires the
 * compose `postgres` service + a resolvable `DATABASE_URL`; excluded from
 * `pnpm verify`, run via `pnpm --filter @mediator/outbound test:integration`.
 * Self-skips when `DATABASE_URL` is unresolvable.
 */

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

  beforeAll(async () => {
    db = createDb(resolveDatabaseUrl(process.env));
    await runMigrations(db);
    store = new DbSyncEventStore(new AuditLogRepository(db));
  });

  beforeEach(async () => {
    await db.delete(auditLog);
    await db.delete(registeredApp);
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
