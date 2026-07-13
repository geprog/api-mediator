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
    await queue.markDone(a, at(10));

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
    await queue.park(a, "ceiling reached", at(5));

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
    await queue.recordRetry(a, "boom");
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
    await queue.heartbeat(a, at(90_000));

    // Past the ORIGINAL lease but within the renewed one → still not re-claimable.
    expect(await claim(queue, at(LEASE_MS + 1), "w2")).toBeUndefined();
  });

  it("empty / fully-terminal queue yields nothing", async () => {
    const queue = new FakeOrderingQueue();
    expect(await claim(queue, T0)).toBeUndefined();

    const a = await queue.enqueue("K", {});
    const first = await claim(queue, T0);
    expect(first?.id).toBe(a);
    await queue.markDone(a, at(1));
    expect(queue.getById(a)?.status).toBe("done");
    expect(await claim(queue, at(2))).toBeUndefined();
  });
});
