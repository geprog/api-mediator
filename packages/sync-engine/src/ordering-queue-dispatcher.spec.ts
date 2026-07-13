import { afterEach, describe, expect, it, vi } from "vitest";

import { FakeOrderingQueue } from "./fake-ordering-queue.js";
import {
  OrderingQueueDispatcher,
  type QueueHandler,
  type QueueHandlerContext,
  type SettledEntry,
} from "./ordering-queue-dispatcher.js";

/**
 * Unit tests for the `OrderingQueueDispatcher` over the faithful `FakeOrderingQueue`
 * (`docs/requirements/phase-4-ordering-queue.md` OQ-1): sequential-per-key order,
 * park-moves-on, cross-key independence, and the injected-handler seam contract. The
 * real-Postgres at-most-one-active-worker-per-key / durability proofs live in
 * `ordering-queue.integration.spec.ts`.
 */

const CLOCK = (): Date => new Date("2026-07-13T00:00:00.000Z");

describe("OrderingQueueDispatcher", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("processes a key's entries sequentially in enqueue order", async () => {
    const queue = new FakeOrderingQueue();
    await queue.enqueue("K", { n: 1 });
    await queue.enqueue("K", { n: 2 });
    await queue.enqueue("K", { n: 3 });

    const seen: unknown[] = [];
    const handler: QueueHandler = (ctx) => {
      seen.push(ctx.payload);
      return Promise.resolve();
    };
    const dispatcher = new OrderingQueueDispatcher(queue, handler, { clock: CLOCK });

    const settled = await dispatcher.drain();
    expect(settled).toBe(3);
    expect(seen).toStrictEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
    expect(queue.listByStatus("done")).toHaveLength(3);
  });

  it("hands the handler the claimed entry's context (id, key, payload, attempts)", async () => {
    const queue = new FakeOrderingQueue();
    const id = await queue.enqueue("record-link-42", { field: "email" });

    const contexts: QueueHandlerContext[] = [];
    const handler: QueueHandler = (ctx) => {
      contexts.push(ctx);
      return Promise.resolve();
    };
    const dispatcher = new OrderingQueueDispatcher(queue, handler, { clock: CLOCK });
    await dispatcher.runOnce();

    expect(contexts).toHaveLength(1);
    expect(contexts[0]).toStrictEqual({
      id,
      queueKey: "record-link-42",
      payload: { field: "email" },
      attempts: 1,
    });
  });

  it("park moves on: a permanently failing entry is parked and its key's next entry still runs", async () => {
    const queue = new FakeOrderingQueue();
    const failing = await queue.enqueue("K", { fail: true });
    const following = await queue.enqueue("K", { fail: false });

    const handler: QueueHandler = (ctx) => {
      if (ctx.payload.fail === true) {
        return Promise.reject(new Error("write failed permanently"));
      }
      return Promise.resolve();
    };
    // Ceiling of 1 → the first failure parks immediately.
    const dispatcher = new OrderingQueueDispatcher(queue, handler, {
      clock: CLOCK,
      maxAttempts: 1,
    });

    const first = await dispatcher.runOnce();
    expect(first.outcome).toBe("parked");
    const second = await dispatcher.runOnce();
    expect(second.outcome).toBe("done");

    expect(queue.getById(failing)?.status).toBe("parked");
    expect(queue.getById(failing)?.lastError).toBe("write failed permanently");
    expect(queue.getById(following)?.status).toBe("done");
    // The queue is drained: nothing is left blocked behind the park.
    expect(await dispatcher.runOnce()).toStrictEqual({ outcome: "idle", entry: undefined });
  });

  it("a parked entry on one key never blocks another key", async () => {
    const queue = new FakeOrderingQueue();
    await queue.enqueue("K", { fail: true });
    const other = await queue.enqueue("L", { fail: false });

    const handler: QueueHandler = (ctx) =>
      ctx.payload.fail === true ? Promise.reject(new Error("boom")) : Promise.resolve();
    const dispatcher = new OrderingQueueDispatcher(queue, handler, {
      clock: CLOCK,
      maxAttempts: 1,
    });

    await dispatcher.drain();
    expect(queue.listByStatus("parked").map((e) => e.queueKey)).toStrictEqual(["K"]);
    expect(queue.getById(other)?.status).toBe("done");
  });

  it("retries under the ceiling, then parks at the ceiling — reporting each settle", async () => {
    const queue = new FakeOrderingQueue();
    await queue.enqueue("K", {});

    const settles: SettledEntry[] = [];
    const handler: QueueHandler = () => Promise.reject(new Error("always down"));
    const dispatcher = new OrderingQueueDispatcher(queue, handler, {
      clock: CLOCK,
      maxAttempts: 3,
      // Zero backoff so `drain` (fixed clock) can re-claim each retry immediately;
      // the backoff-as-`available_at` behavior itself is covered by its own test.
      retryBackoff: () => 0,
      onEntrySettled: (settled) => settles.push(settled),
    });

    const ticks = await dispatcher.drain();
    expect(ticks).toBe(3); // retry, retry, park
    expect(settles.map((s) => ({ outcome: s.outcome, attempts: s.attempts }))).toStrictEqual([
      { outcome: "retried", attempts: 1 },
      { outcome: "retried", attempts: 2 },
      { outcome: "parked", attempts: 3 },
    ]);
    expect(queue.listByStatus("parked")).toHaveLength(1);
  });

  it("a retry defers the entry by the backoff (available_at not-before), not re-claimable until due", async () => {
    const queue = new FakeOrderingQueue();
    const id = await queue.enqueue("K", {});

    let now = new Date("2026-07-13T00:00:00.000Z");
    const handler: QueueHandler = (ctx) =>
      ctx.attempts === 1 ? Promise.reject(new Error("transient")) : Promise.resolve();
    const dispatcher = new OrderingQueueDispatcher(queue, handler, {
      clock: () => now,
      maxAttempts: 5,
      retryBackoff: (attempts) => 1_000 * attempts,
    });

    const first = await dispatcher.runOnce();
    expect(first.outcome).toBe("retried");
    // Deferred 1s out: not claimable yet.
    expect(queue.getById(id)?.status).toBe("pending");
    expect(queue.getById(id)?.availableAt?.toISOString()).toBe("2026-07-13T00:00:01.000Z");
    expect(await dispatcher.runOnce()).toStrictEqual({ outcome: "idle", entry: undefined });

    // Advance past the backoff → re-claimable, and it succeeds.
    now = new Date("2026-07-13T00:00:01.500Z");
    const second = await dispatcher.runOnce();
    expect(second.outcome).toBe("done");
    expect(queue.getById(id)?.status).toBe("done");
  });

  it("defers a throttle without counting a failed attempt (classifyFailure → defer)", async () => {
    const queue = new FakeOrderingQueue();
    const id = await queue.enqueue("K", {});

    let now = new Date("2026-07-13T00:00:00.000Z");
    let throttleCalls = 0;
    const handler: QueueHandler = () => {
      throttleCalls += 1;
      // Throttle the first two claims, then succeed.
      return throttleCalls <= 2 ? Promise.reject(new Error("throttled")) : Promise.resolve();
    };
    const dispatcher = new OrderingQueueDispatcher(queue, handler, {
      clock: () => now,
      maxAttempts: 1, // a real failure would park immediately …
      classifyFailure: () => ({ kind: "defer", delayMs: 500 }), // … but a defer never does.
    });

    const first = await dispatcher.runOnce();
    expect(first.outcome).toBe("deferred");
    // Attempt-neutral: the claim bump was undone.
    expect(queue.getById(id)?.attempts).toBe(0);
    expect(queue.getById(id)?.status).toBe("pending");

    now = new Date("2026-07-13T00:00:00.500Z");
    expect((await dispatcher.runOnce()).outcome).toBe("deferred");
    now = new Date("2026-07-13T00:00:01.000Z");
    expect((await dispatcher.runOnce()).outcome).toBe("done");
    // Never parked despite maxAttempts: 1 — a throttled app is not dead-lettered.
    expect(queue.listByStatus("parked")).toHaveLength(0);
  });

  it("lease-owner fence: a re-claimed entry rejects the original worker's late settle", async () => {
    const queue = new FakeOrderingQueue();
    const id = await queue.enqueue("K", {});

    // Worker A claims (lease 1s), then its lease expires and worker B re-claims.
    const claimA = await queue.claimNext({
      now: new Date("2026-07-13T00:00:00.000Z"),
      leaseExpiresAt: new Date("2026-07-13T00:00:01.000Z"),
      owner: "A",
    });
    expect(claimA?.id).toBe(id);
    const claimB = await queue.claimNext({
      now: new Date("2026-07-13T00:00:02.000Z"),
      leaseExpiresAt: new Date("2026-07-13T00:00:03.000Z"),
      owner: "B",
    });
    expect(claimB?.id).toBe(id);

    // A's late markDone must be rejected (fence): B still owns the processing entry.
    expect(await queue.markDone(id, "A", new Date("2026-07-13T00:00:02.500Z"))).toBe(false);
    expect(queue.getById(id)?.status).toBe("processing");
    expect(queue.getById(id)?.leaseOwner).toBe("B");
    // B settles normally.
    expect(await queue.markDone(id, "B", new Date("2026-07-13T00:00:02.600Z"))).toBe(true);
    expect(queue.getById(id)?.status).toBe("done");
  });

  it("interleaves multiple keys but preserves each key's own enqueue order", async () => {
    const queue = new FakeOrderingQueue();
    // Interleave three keys.
    await queue.enqueue("A", { seq: "a1" });
    await queue.enqueue("B", { seq: "b1" });
    await queue.enqueue("A", { seq: "a2" });
    await queue.enqueue("C", { seq: "c1" });
    await queue.enqueue("B", { seq: "b2" });
    await queue.enqueue("A", { seq: "a3" });

    const perKey = new Map<string, unknown[]>();
    const handler: QueueHandler = (ctx) => {
      const list = perKey.get(ctx.queueKey) ?? [];
      list.push(ctx.payload.seq);
      perKey.set(ctx.queueKey, list);
      return Promise.resolve();
    };
    const dispatcher = new OrderingQueueDispatcher(queue, handler, { clock: CLOCK });
    await dispatcher.drain();

    expect(perKey.get("A")).toStrictEqual(["a1", "a2", "a3"]);
    expect(perKey.get("B")).toStrictEqual(["b1", "b2"]);
    expect(perKey.get("C")).toStrictEqual(["c1"]);
  });

  it("start()/stop() drains a multi-key queue and settles every entry", async () => {
    const queue = new FakeOrderingQueue();
    for (const key of ["A", "B", "C"]) {
      await queue.enqueue(key, { first: true });
      await queue.enqueue(key, { first: false });
    }

    const handler: QueueHandler = () => Promise.resolve();
    const dispatcher = new OrderingQueueDispatcher(queue, handler, {
      clock: CLOCK,
      concurrency: 2,
      idlePollIntervalMs: 1,
    });

    dispatcher.start();
    // Poll until the queue drains, then stop the loops.
    const deadline = Date.now() + 2000;
    while (queue.listByStatus("done").length < 6 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await dispatcher.stop();

    expect(queue.listByStatus("done")).toHaveLength(6);
    expect(queue.listByStatus("pending")).toHaveLength(0);
    expect(queue.listByStatus("processing")).toHaveLength(0);
  });

  it("start() is idempotent and stop() resolves when no loop is running", async () => {
    const queue = new FakeOrderingQueue();
    const dispatcher = new OrderingQueueDispatcher(queue, () => Promise.resolve(), {
      clock: CLOCK,
      idlePollIntervalMs: 1,
    });
    dispatcher.start();
    dispatcher.start(); // no-op
    await dispatcher.stop();
    await dispatcher.stop(); // safe to call again
    expect(queue.listByStatus("processing")).toHaveLength(0);
  });
});
