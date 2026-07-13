import type { AuditLogEntry } from "@mediator/domain";
import { describe, expect, it } from "vitest";

import { FakeSyncEventStore } from "./sync-event-store.js";

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
