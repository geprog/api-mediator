import type { ClaimedQueueEntry } from "@mediator/db";
import { describe, expect, it } from "vitest";

import { FakeOrderingQueue } from "./fake-ordering-queue.js";

/**
 * Locks in that `FakeOrderingQueue` mirrors the real `OrderingQueueRepository`'s
 * `FOR UPDATE SKIP LOCKED` claim predicate (`docs/requirements/phase-4-ordering-queue.md`
 * OQ-1). The SAME behaviours are re-proven against real Postgres in
 * `ordering-queue.integration.spec.ts`; if these two ever diverge the fake has stopped
 * being a faithful stand-in and unit tests over it are lying ([[fakes-must-mirror-real-repos]]).
 */

const T0 = new Date("2026-07-13T00:00:00.000Z");
const LEASE_MS = 30_000;

function at(baseMs: number): Date {
  return new Date(T0.getTime() + baseMs);
}

function claim(
  queue: FakeOrderingQueue,
  now: Date,
  owner = "w1",
): Promise<ClaimedQueueEntry | undefined> {
  return queue.claimNext({ now, leaseExpiresAt: new Date(now.getTime() + LEASE_MS), owner });
}

describe("FakeOrderingQueue claim semantics", () => {
  it("enqueue assigns increasing seq; claimNext takes the lowest-seq entry of a free key", async () => {
    const queue = new FakeOrderingQueue();
    const a = await queue.enqueue("K", { n: 1 });
    const b = await queue.enqueue("K", { n: 2 });

    const first = await claim(queue, T0);
    expect(first?.id).toBe(a);
    expect(first?.attempts).toBe(1);
    expect(first?.payload).toStrictEqual({ n: 1 });
    // b is untouched (still pending) while a holds the key.
    expect(queue.getById(b)?.status).toBe("pending");
  });

  it("at most one active worker per key: a later same-key entry is not claimable while an earlier is processing", async () => {
    const queue = new FakeOrderingQueue();
    await queue.enqueue("K", { n: 1 });
    await queue.enqueue("K", { n: 2 });

    const first = await claim(queue, T0);
    expect(first).toBeDefined();
    // Key K is busy → nothing else claimable on K.
    const second = await claim(queue, T0, "w2");
    expect(second).toBeUndefined();
  });

  it("sequential per key: the second entry only becomes claimable after the first is done", async () => {
    const queue = new FakeOrderingQueue();
    const a = await queue.enqueue("K", { n: 1 });
    const b = await queue.enqueue("K", { n: 2 });

    const first = await claim(queue, T0);
    expect(first?.id).toBe(a);
    expect(await queue.markDone(a, "w1", at(10))).toBe(true);

    const second = await claim(queue, at(20));
    expect(second?.id).toBe(b);
  });

  it("different keys are claimed in parallel — concurrent claims take distinct keys", async () => {
    const queue = new FakeOrderingQueue();
    await queue.enqueue("K", { k: true });
    await queue.enqueue("L", { l: true });

    const [first, second] = await Promise.all([claim(queue, T0, "w1"), claim(queue, T0, "w2")]);

    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(new Set([first?.queueKey, second?.queueKey])).toStrictEqual(new Set(["K", "L"]));
  });

  it("atomic claim: two concurrent claims on a single-key queue never both take it", async () => {
    const queue = new FakeOrderingQueue();
    await queue.enqueue("K", { n: 1 });
    await queue.enqueue("K", { n: 2 });

    const [first, second] = await Promise.all([claim(queue, T0, "w1"), claim(queue, T0, "w2")]);

    const claimed = [first, second].filter(
      (entry): entry is ClaimedQueueEntry => entry !== undefined,
    );
    expect(claimed).toHaveLength(1);
    expect(queue.listByStatus("processing")).toHaveLength(1);
    expect(queue.listByStatus("pending")).toHaveLength(1);
  });

  it("durable crash recovery: a processing entry with an expired lease is re-claimable and only then", async () => {
    const queue = new FakeOrderingQueue();
    const a = await queue.enqueue("K", { n: 1 });

    const first = await claim(queue, T0); // lease expires at T0 + 30s
    expect(first?.id).toBe(a);
    expect(first?.attempts).toBe(1);

    // Within the lease window: not re-claimable (the "crashed" worker still owns it).
    expect(await claim(queue, at(LEASE_MS - 1), "w2")).toBeUndefined();

    // Past the lease: the same entry is re-claimed, attempts bumped, order preserved.
    const reclaimed = await claim(queue, at(LEASE_MS + 1), "w2");
    expect(reclaimed?.id).toBe(a);
    expect(reclaimed?.attempts).toBe(2);
  });

  it("park moves on: a parked entry releases its key so the next entry is claimable", async () => {
    const queue = new FakeOrderingQueue();
    const a = await queue.enqueue("K", { n: 1 });
    const b = await queue.enqueue("K", { n: 2 });

    const first = await claim(queue, T0);
    expect(first?.id).toBe(a);
    expect(await queue.park(a, "ceiling reached", "w1", at(5))).toBe(true);

    expect(queue.getById(a)?.status).toBe("parked");
    // The park did not hold the key: b is now claimable.
    const second = await claim(queue, at(10));
    expect(second?.id).toBe(b);
  });

  it("recordRetry returns an entry to pending (re-claimable), attempts unchanged by the retry itself", async () => {
    const queue = new FakeOrderingQueue();
    const a = await queue.enqueue("K", { n: 1 });

    const first = await claim(queue, T0);
    expect(first?.attempts).toBe(1);
    // Backoff not-before at T0 (immediately re-claimable for this test).
    expect(await queue.recordRetry(a, "boom", "w1", T0)).toBe(true);
    expect(queue.getById(a)?.status).toBe("pending");
    expect(queue.getById(a)?.lastError).toBe("boom");

    const retried = await claim(queue, at(10));
    expect(retried?.id).toBe(a);
    expect(retried?.attempts).toBe(2); // bumped by the re-claim, not by recordRetry
  });

  it("heartbeat extends a processing entry's lease so it is not re-claimed", async () => {
    const queue = new FakeOrderingQueue();
    const a = await queue.enqueue("K", { n: 1 });
    const first = await claim(queue, T0); // lease at T0 + 30s
    expect(first?.id).toBe(a);

    // Renew the lease to T0 + 90s just before the original expiry.
    await queue.heartbeat(a, "w1", at(90_000));

    // Past the ORIGINAL lease but within the renewed one → still not re-claimable.
    expect(await claim(queue, at(LEASE_MS + 1), "w2")).toBeUndefined();
  });

  it("empty / fully-terminal queue yields nothing", async () => {
    const queue = new FakeOrderingQueue();
    expect(await claim(queue, T0)).toBeUndefined();

    const a = await queue.enqueue("K", {});
    const first = await claim(queue, T0);
    expect(first?.id).toBe(a);
    expect(await queue.markDone(a, "w1", at(1))).toBe(true);
    expect(queue.getById(a)?.status).toBe("done");
    expect(await claim(queue, at(2))).toBeUndefined();
  });
});

/**
 * Locks in that `FakeOrderingQueue` mirrors the real `OrderingQueueRepository`'s SA-5
 * dead-letter operations (`listParked` / `isSuperseded` / `reactivate`). The SAME
 * behaviours are re-proven against real Postgres in the db package's
 * `ordering-queue-dead-letter.integration.spec.ts`; if the two diverge the fake has
 * stopped being a faithful stand-in ([[fakes-must-mirror-real-repos]]).
 */
describe("FakeOrderingQueue SA-5 dead-letter operations", () => {
  /** A `DetectedChange`-shaped payload whose `observedRecord` MUST never surface (data boundary). */
  function changePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      ruleId: "rule-1",
      mappingId: "map-1",
      sourceAppId: "app-a",
      targetAppId: "app-b",
      resourcePairRef: "pair::widgets",
      sourceNativeId: "n1",
      changeKind: "update",
      observedRecord: { name: "Alpha", secret: "SENSITIVE-VALUE-123" },
      ...overrides,
    };
  }

  /** Enqueue → claim → park an entry, returning its id (mirrors the OC-4 park at the ceiling). */
  async function park(
    queue: FakeOrderingQueue,
    key: string,
    payload: Record<string, unknown>,
    finishedAt: Date,
    owner = "w1",
  ): Promise<string> {
    const id = await queue.enqueue(key, payload);
    const claimed = await queue.claimNext({ now: T0, leaseExpiresAt: at(LEASE_MS), owner });
    expect(claimed?.id).toBe(id);
    expect(await queue.park(id, "target write failed: 503", owner, finishedAt)).toBe(true);
    return id;
  }

  it("listParked returns only parked rows as a safe projection — ids/refs, no observedRecord (SA-5.1 data boundary)", async () => {
    const queue = new FakeOrderingQueue();
    const parkedId = await park(queue, "link-1", changePayload(), at(1));
    // A pending and a done entry on other keys must NOT appear.
    await queue.enqueue("link-2", changePayload());
    const doneId = await queue.enqueue("link-3", changePayload());
    await queue.claimNext({ now: T0, leaseExpiresAt: at(LEASE_MS), owner: "w2" });
    await queue.markDone(doneId, "w2", at(2));

    const parked = await queue.listParked(50);
    expect(parked).toHaveLength(1);
    const entry = parked[0];
    expect(entry?.id).toBe(parkedId);
    expect(entry?.lastError).toBe("target write failed: 503");
    expect(entry?.attempts).toBe(1);
    expect(entry?.superseded).toBe(false);
    // The context is ids/refs only.
    expect(entry?.context).toStrictEqual({
      ruleId: "rule-1",
      mappingId: "map-1",
      sourceAppId: "app-a",
      targetAppId: "app-b",
      resourcePairRef: "pair::widgets",
      sourceNativeId: "n1",
      changeKind: "update",
    });
    // Data boundary: neither the observedRecord value nor the opaque queue key surfaces.
    expect(JSON.stringify(entry)).not.toContain("SENSITIVE-VALUE-123");
    expect(entry).not.toHaveProperty("payload");
    expect(entry).not.toHaveProperty("queueKey");
  });

  it("listParked is newest-parked first and bounded by limit", async () => {
    const queue = new FakeOrderingQueue();
    const older = await park(queue, "k-old", changePayload(), at(1_000));
    const newer = await park(queue, "k-new", changePayload(), at(2_000));

    const all = await queue.listParked(50);
    expect(all.map((entry) => entry.id)).toStrictEqual([newer, older]);

    const bounded = await queue.listParked(1);
    expect(bounded.map((entry) => entry.id)).toStrictEqual([newer]);
  });

  it("listParked flags a superseded entry once a later same-key done exists (SA-5.3)", async () => {
    const queue = new FakeOrderingQueue();
    const parkedId = await park(queue, "link-1", changePayload(), at(1));

    // Not superseded yet — no later same-key change.
    expect((await queue.listParked(50)).find((e) => e.id === parkedId)?.superseded).toBe(false);

    // A later change on the same key runs to completion → supersedes the parked write.
    const later = await queue.enqueue("link-1", changePayload({ sourceNativeId: "n1" }));
    await queue.claimNext({ now: at(5), leaseExpiresAt: at(LEASE_MS + 5), owner: "w2" });
    await queue.markDone(later, "w2", at(6));

    expect((await queue.listParked(50)).find((e) => e.id === parkedId)?.superseded).toBe(true);
  });

  it("reactivate returns SUPERSEDED (not reactivated) when a later same-key done entry exists (SA-5.3, atomic)", async () => {
    const queue = new FakeOrderingQueue();
    const parkedId = await park(queue, "link-1", changePayload(), at(1));
    const later = await queue.enqueue("link-1", changePayload());
    await queue.claimNext({ now: at(5), leaseExpiresAt: at(LEASE_MS + 5), owner: "w2" });
    await queue.markDone(later, "w2", at(6));

    // The later done makes the write superseded — reactivate refuses (no-op), so the
    // stale change is never re-run. It stays parked.
    expect((await queue.reactivate(parkedId, at(100))).kind).toBe("superseded");
    expect(queue.getById(parkedId)?.status).toBe("parked");
  });

  it("reactivate flips parked → pending, clears the lease, sets available_at = now (SA-5.2)", async () => {
    const queue = new FakeOrderingQueue();
    const parkedId = await park(queue, "link-1", changePayload(), at(1));

    const result = await queue.reactivate(parkedId, at(100));
    expect(result.kind).toBe("reactivated");
    if (result.kind === "reactivated") {
      expect(result.entry.status).toBe("pending");
      expect(result.entry.availableAt?.getTime()).toBe(at(100).getTime());
      expect(result.entry.leaseOwner).toBeNull();
      expect(result.entry.leaseExpiresAt).toBeNull();
    }
    // It is claimable again → the dispatcher re-runs the pipeline.
    const reclaimed = await claim(queue, at(200), "w2");
    expect(reclaimed?.id).toBe(parkedId);
  });

  it("reactivate is BLOCKED when another non-terminal entry shares the queue key (single-active-per-key guard)", async () => {
    const queue = new FakeOrderingQueue();
    const parkedId = await park(queue, "link-1", changePayload(), at(1));
    // A later change for the same record is still queued (pending) under the same key.
    await queue.enqueue("link-1", changePayload());

    const result = await queue.reactivate(parkedId, at(100));
    expect(result.kind).toBe("blocked-key-busy");
    // Untouched — still parked.
    expect(queue.getById(parkedId)?.status).toBe("parked");
  });

  it("reactivate on a non-parked entry → not-parked; on an absent id → not-found", async () => {
    const queue = new FakeOrderingQueue();
    const pendingId = await queue.enqueue("link-1", changePayload());
    expect((await queue.reactivate(pendingId, at(100))).kind).toBe("not-parked");
    expect((await queue.reactivate("no-such-id", at(100))).kind).toBe("not-found");
  });
});
