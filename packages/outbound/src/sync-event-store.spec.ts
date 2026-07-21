import type { AuditLogEntry, AuditLogStatus } from "@mediator/domain";
import { describe, expect, it } from "vitest";

import { FakeSyncEventStore, syncExecutionOutboxEvent } from "./sync-event-store.js";

/**
 * The `FakeSyncEventStore` must mirror the real
 * `AuditLogRepository.findRecentByIdempotencyKey` bounds ([[fakes-must-mirror-real-repos]]):
 * exact key + `timestamp >= since`, most-recent-first, capped at `limit`. The same
 * query is re-proven against real Postgres in `*.integration.spec.ts`.
 */

function event(
  overrides: Partial<AuditLogEntry> & Pick<AuditLogEntry, "id" | "timestamp">,
): AuditLogEntry {
  return {
    type: "sync-execution",
    actor: "system",
    ...overrides,
  };
}

describe("FakeSyncEventStore.findRecentByIdempotencyKey", () => {
  it("returns only matching-key rows no older than `since`, most-recent-first, capped at `limit`", async () => {
    const store = new FakeSyncEventStore();
    await store.record(
      event({ id: "1", idempotencyKey: "K", status: "success", timestamp: new Date(1_000) }),
    );
    await store.record(
      event({ id: "2", idempotencyKey: "K", status: "failure", timestamp: new Date(3_000) }),
    );
    await store.record(
      event({ id: "3", idempotencyKey: "OTHER", status: "success", timestamp: new Date(3_000) }),
    );
    await store.record(
      event({ id: "4", idempotencyKey: "K", status: "success", timestamp: new Date(100) }), // before `since`
    );

    const found = await store.findRecentByIdempotencyKey("K", {
      since: new Date(500),
      limit: 10,
    });
    // id 4 excluded (too old), id 3 excluded (other key); most-recent first.
    expect(found.map((e) => e.id)).toStrictEqual(["2", "1"]);
  });

  it("honors the limit bound (never returns unbounded history)", async () => {
    const store = new FakeSyncEventStore();
    for (let i = 0; i < 10; i += 1) {
      await store.record(
        event({ id: String(i), idempotencyKey: "K", timestamp: new Date(1_000 + i) }),
      );
    }
    const found = await store.findRecentByIdempotencyKey("K", { since: new Date(0), limit: 3 });
    expect(found).toHaveLength(3);
    // The three most recent (9, 8, 7).
    expect(found.map((e) => e.id)).toStrictEqual(["9", "8", "7"]);
  });
});

/**
 * XI-1 — the pure `AuditLogEntry → SyncExecutionOutboxEvent` projection the
 * `DbSyncEventStore` enqueues onto the `event_outbox`. Kept a total, throw-free function so
 * it is safe on the sync write path (XI-1.4); its transactional emit + the end-to-end CH-3
 * drop are proven against live Postgres in the backend integration suite.
 */
describe("syncExecutionOutboxEvent (XI-1 projection)", () => {
  const T0 = new Date("2026-07-21T00:00:00.000Z");

  it("projects a sync-execution row onto the exact envelope the CH-3 consumer reads", () => {
    const entry = event({
      id: "evt-1",
      timestamp: T0,
      status: "success",
      originAppId: "appB",
      relatedRuleId: "rule-1",
      // Fields the consumer does NOT read must not leak into the CH-3 signal shape.
      relatedMappingId: "mapping-1",
      sourceNativeId: "src-1",
      payloadHash: "hash",
    });
    expect(syncExecutionOutboxEvent(entry)).toStrictEqual({
      id: "evt-1",
      type: "sync-execution",
      occurredAt: T0,
      status: "success",
      originAppId: "appB",
      relatedRuleId: "rule-1",
    });
  });

  it("uses the audit row's id and timestamp verbatim (1:1 outbox row, natural de-dup)", () => {
    const result = syncExecutionOutboxEvent(event({ id: "audit-42", timestamp: T0 }));
    expect(result?.id).toBe("audit-42");
    expect(result?.occurredAt).toBe(T0);
  });

  it("carries EVERY status faithfully (the consumer's isAppliedChange guard filters — XI-1.3)", () => {
    const statuses: AuditLogStatus[] = [
      "success",
      "failure",
      "skipped-loop",
      "skipped-policy",
      "conflict",
    ];
    for (const status of statuses) {
      const result = syncExecutionOutboxEvent(
        event({ id: `evt-${status}`, timestamp: T0, status, originAppId: "appB" }),
      );
      expect(result?.status).toBe(status);
    }
  });

  it("omits absent originAppId/relatedRuleId/status rather than emitting explicit undefined", () => {
    const result = syncExecutionOutboxEvent(event({ id: "evt-bare", timestamp: T0 }));
    expect(result).toStrictEqual({ id: "evt-bare", type: "sync-execution", occurredAt: T0 });
    expect(result).not.toHaveProperty("status");
    expect(result).not.toHaveProperty("originAppId");
    expect(result).not.toHaveProperty("relatedRuleId");
  });

  it("returns undefined for a non-sync-execution row — a backfill-run carries no CH-3 signal", () => {
    expect(
      syncExecutionOutboxEvent(
        event({ id: "bf", timestamp: T0, type: "backfill-run", status: "success" }),
      ),
    ).toBeUndefined();
    expect(
      syncExecutionOutboxEvent(event({ id: "pr", timestamp: T0, type: "poll-run" })),
    ).toBeUndefined();
  });
});
