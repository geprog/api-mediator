import {
  closeDb,
  createDb,
  orderingQueue,
  OrderingQueueRepository,
  resolveDatabaseUrl,
  runMigrations,
  type Database,
} from "@mediator/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { OrderingQueueDispatcher, type QueueHandler } from "./ordering-queue-dispatcher.js";

/**
 * Live-database integration test for the `ordering_queue` OQ-1 claim discipline. The
 * `FOR UPDATE SKIP LOCKED` + per-key-lease semantics CANNOT be faked, so the guarantees
 * the `FakeOrderingQueue` unit tests assert against are re-proven here against REAL
 * Postgres + the `0011` migration:
 *
 *  - **at most one active worker per key** while **different keys run in parallel**
 *    (OQ-1 criteria 1, 4) — driven by concurrent dispatcher workers;
 *  - **durable crash recovery** — an entry left `processing` by a dead worker (expired
 *    lease) is re-claimed and completes **exactly once** (OQ-1 criterion 3);
 *  - **enqueue order preserved per key under contention** (OQ-1 criterion 2);
 *  - the raw `SKIP LOCKED` claim never hands two workers the same key.
 *
 * Requires the compose `postgres` service + a resolvable `DATABASE_URL`; excluded from
 * `pnpm verify`, run via `pnpm --filter @mediator/sync-engine test:integration`.
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function roundOf(payload: Record<string, unknown>): number {
  const round = payload.round;
  return typeof round === "number" ? round : -1;
}

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await sleep(5);
  }
}

suite("Phase-4 ordering_queue OQ-1 integration (requires Postgres)", () => {
  let db: Database;

  beforeAll(async () => {
    db = createDb(resolveDatabaseUrl(process.env));
    await runMigrations(db);
  });

  beforeEach(async () => {
    await db.delete(orderingQueue);
  });

  afterAll(async () => {
    await db.delete(orderingQueue);
    await closeDb(db);
  });

  it("concurrent workers: at most one active per key, different keys in parallel, per-key order preserved", async () => {
    const repo = new OrderingQueueRepository(db);
    const keys = ["K1", "K2", "K3", "K4"];
    const rounds = 6;
    // Interleave: round 0 of every key, then round 1 of every key, ... so a key's
    // entries are spread through the queue and only per-key ordering can hold them.
    for (let round = 0; round < rounds; round += 1) {
      for (const key of keys) {
        await repo.enqueue(key, { key, round });
      }
    }

    // Per-key active counters + observed processing order; a max cross-key concurrency.
    const activePerKey = new Map<string, number>();
    let maxActivePerKey = 0;
    let totalActive = 0;
    let maxTotalActive = 0;
    const orderPerKey = new Map<string, number[]>();

    const handler: QueueHandler = async (ctx) => {
      const active = (activePerKey.get(ctx.queueKey) ?? 0) + 1;
      activePerKey.set(ctx.queueKey, active);
      maxActivePerKey = Math.max(maxActivePerKey, active);
      totalActive += 1;
      maxTotalActive = Math.max(maxTotalActive, totalActive);

      const seen = orderPerKey.get(ctx.queueKey) ?? [];
      seen.push(roundOf(ctx.payload));
      orderPerKey.set(ctx.queueKey, seen);

      // Hold the "active" window so a per-key double-claim (if it happened) or a
      // cross-key overlap is observable.
      await sleep(20);

      activePerKey.set(ctx.queueKey, (activePerKey.get(ctx.queueKey) ?? 1) - 1);
      totalActive -= 1;
    };

    // More workers than keys: if the per-key discipline were broken, the extra
    // workers would double up on a key and push maxActivePerKey above 1.
    const dispatcher = new OrderingQueueDispatcher(repo, handler, {
      concurrency: 6,
      leaseDurationMs: 60_000,
      idlePollIntervalMs: 5,
    });

    dispatcher.start();
    const total = keys.length * rounds;
    await waitUntil(
      () => orderPerKey.size === keys.length && orderedCount(orderPerKey) === total,
      20_000,
    );
    await dispatcher.stop();

    // Every entry processed, done, none left behind.
    expect(await repo.listByStatus("done")).toHaveLength(total);
    expect(await repo.listByStatus("pending")).toHaveLength(0);
    expect(await repo.listByStatus("processing")).toHaveLength(0);

    // OQ-1 criterion 1: never two workers on the same key at once.
    expect(maxActivePerKey).toBe(1);
    // OQ-1 criterion 4: different keys genuinely ran in parallel.
    expect(maxTotalActive).toBeGreaterThan(1);
    // OQ-1 criterion 2: each key processed strictly in enqueue (round) order.
    for (const key of keys) {
      expect(orderPerKey.get(key)).toStrictEqual([0, 1, 2, 3, 4, 5]);
    }
  });

  it("enqueue order preserved per key under heavy contention (single key, many workers)", async () => {
    const repo = new OrderingQueueRepository(db);
    const count = 12;
    for (let round = 0; round < count; round += 1) {
      await repo.enqueue("solo", { round });
    }

    const order: number[] = [];
    let maxActive = 0;
    let active = 0;
    const handler: QueueHandler = async (ctx) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      order.push(roundOf(ctx.payload));
      await sleep(10);
      active -= 1;
    };
    const dispatcher = new OrderingQueueDispatcher(repo, handler, {
      concurrency: 4,
      leaseDurationMs: 60_000,
      idlePollIntervalMs: 5,
    });

    dispatcher.start();
    await waitUntil(() => order.length === count, 20_000);
    await dispatcher.stop();

    // A single key is serialized: exactly one active at a time, strictly in order.
    expect(maxActive).toBe(1);
    expect(order).toStrictEqual([...Array(count).keys()]);
  });

  it("durable crash recovery: an expired-lease entry is re-claimed and completes exactly once", async () => {
    const repo = new OrderingQueueRepository(db);
    const id = await repo.enqueue("K", { work: "unit" });

    // Worker W1 claims with a short lease, then "crashes" — never settles.
    const first = await repo.claimNext({
      now: T0,
      leaseExpiresAt: new Date(T0.getTime() + 1_000),
      owner: "W1",
    });
    expect(first?.id).toBe(id);
    expect(first?.attempts).toBe(1);

    // Within W1's lease, W2 cannot steal the entry (still owned).
    const stolenEarly = await repo.claimNext({
      now: new Date(T0.getTime() + 500),
      leaseExpiresAt: new Date(T0.getTime() + 1_500),
      owner: "W2",
    });
    expect(stolenEarly).toBeUndefined();

    // Past the lease, W2 re-claims the SAME entry (durable recovery), attempts bumped.
    const reclaimed = await repo.claimNext({
      now: new Date(T0.getTime() + 1_001),
      leaseExpiresAt: new Date(T0.getTime() + 2_001),
      owner: "W2",
    });
    expect(reclaimed?.id).toBe(id);
    expect(reclaimed?.attempts).toBe(2);

    // W2 (the current lease owner) settles it; the lease-owner fence lets it through.
    expect(await repo.markDone(id, "W2", new Date(T0.getTime() + 1_100))).toBe(true);

    // Exactly one entry, now done: the crash produced no duplicate.
    const done = await repo.listByStatus("done");
    expect(done).toHaveLength(1);
    expect(done[0]?.id).toBe(id);
    expect(done[0]?.attempts).toBe(2);
    expect(await repo.listByStatus("processing")).toHaveLength(0);
    expect(await repo.listByStatus("pending")).toHaveLength(0);
  });

  it("raw SKIP LOCKED: two concurrent claims on a single key give it to exactly one worker", async () => {
    const repo = new OrderingQueueRepository(db);
    await repo.enqueue("K", { n: 1 });
    await repo.enqueue("K", { n: 2 });

    const params = (owner: string) => ({
      now: T0,
      leaseExpiresAt: new Date(T0.getTime() + 30_000),
      owner,
    });
    const [a, b] = await Promise.all([repo.claimNext(params("A")), repo.claimNext(params("B"))]);

    // One claim wins the key; the other skips the locked row and finds no other
    // eligible entry for K (the later entry is held behind the earlier non-terminal).
    const claimed = [a, b].filter((entry) => entry !== undefined);
    expect(claimed).toHaveLength(1);
    expect(await repo.listByStatus("processing")).toHaveLength(1);
    expect(await repo.listByStatus("pending")).toHaveLength(1);
  });

  it("raw SKIP LOCKED: two concurrent claims on two keys each take a distinct key", async () => {
    const repo = new OrderingQueueRepository(db);
    await repo.enqueue("K", { n: 1 });
    await repo.enqueue("L", { n: 1 });

    const params = (owner: string) => ({
      now: T0,
      leaseExpiresAt: new Date(T0.getTime() + 30_000),
      owner,
    });
    const [a, b] = await Promise.all([repo.claimNext(params("A")), repo.claimNext(params("B"))]);

    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(new Set([a?.queueKey, b?.queueKey])).toStrictEqual(new Set(["K", "L"]));
  });

  it("retry-delay (OC-4): recordRetry sets available_at; the entry is not claimable until it is due", async () => {
    const repo = new OrderingQueueRepository(db);
    const id = await repo.enqueue("K", { n: 1 });

    const claimed = await repo.claimNext({
      now: T0,
      leaseExpiresAt: new Date(T0.getTime() + 30_000),
      owner: "W1",
    });
    expect(claimed?.id).toBe(id);

    // Retry with a 5s backoff not-before.
    const availableAt = new Date(T0.getTime() + 5_000);
    expect(await repo.recordRetry(id, "transient", "W1", availableAt)).toBe(true);
    expect((await repo.getById(id))?.status).toBe("pending");
    expect((await repo.getById(id))?.availableAt?.toISOString()).toBe(availableAt.toISOString());

    // Before the not-before → not claimable (the record's queue waits out the backoff).
    const early = await repo.claimNext({
      now: new Date(T0.getTime() + 1_000),
      leaseExpiresAt: new Date(T0.getTime() + 31_000),
      owner: "W2",
    });
    expect(early).toBeUndefined();

    // After it → claimable again, attempts bumped by the re-claim.
    const late = await repo.claimNext({
      now: new Date(T0.getTime() + 6_000),
      leaseExpiresAt: new Date(T0.getTime() + 36_000),
      owner: "W2",
    });
    expect(late?.id).toBe(id);
    expect(late?.attempts).toBe(2);
  });

  it("defer (OC-3): re-queues with a not-before WITHOUT counting a failed attempt", async () => {
    const repo = new OrderingQueueRepository(db);
    const id = await repo.enqueue("K", { n: 1 });

    const claimed = await repo.claimNext({
      now: T0,
      leaseExpiresAt: new Date(T0.getTime() + 30_000),
      owner: "W1",
    });
    expect(claimed?.attempts).toBe(1);

    expect(await repo.defer(id, "W1", new Date(T0.getTime() + 2_000))).toBe(true);
    // Attempt-neutral: the claim's bump was undone, so a rate-limited app never parks.
    expect((await repo.getById(id))?.attempts).toBe(0);
    expect((await repo.getById(id))?.status).toBe("pending");
    expect((await repo.getById(id))?.lastError).toBeNull();

    const reclaimed = await repo.claimNext({
      now: new Date(T0.getTime() + 3_000),
      leaseExpiresAt: new Date(T0.getTime() + 33_000),
      owner: "W1",
    });
    expect(reclaimed?.id).toBe(id);
    expect(reclaimed?.attempts).toBe(1);
  });

  it("lease-owner fence (OQ-1 review fix): a re-claimed entry rejects the original worker's late settle", async () => {
    const repo = new OrderingQueueRepository(db);
    const id = await repo.enqueue("K", { n: 1 });

    // W1 claims a short lease and "crashes"; W2 re-claims after it expires.
    await repo.claimNext({
      now: T0,
      leaseExpiresAt: new Date(T0.getTime() + 1_000),
      owner: "W1",
    });
    const reclaimed = await repo.claimNext({
      now: new Date(T0.getTime() + 1_001),
      leaseExpiresAt: new Date(T0.getTime() + 31_001),
      owner: "W2",
    });
    expect(reclaimed?.id).toBe(id);

    // W1's late settles are all rejected by the fence — W2 owns the entry now.
    expect(await repo.markDone(id, "W1", new Date(T0.getTime() + 1_100))).toBe(false);
    expect(await repo.park(id, "stale", "W1", new Date(T0.getTime() + 1_100))).toBe(false);
    expect(await repo.recordRetry(id, "stale", "W1", new Date(T0.getTime() + 2_000))).toBe(false);
    const still = await repo.getById(id);
    expect(still?.status).toBe("processing");
    expect(still?.leaseOwner).toBe("W2");

    // W2 settles normally.
    expect(await repo.markDone(id, "W2", new Date(T0.getTime() + 1_200))).toBe(true);
    expect((await repo.getById(id))?.status).toBe("done");
  });
});

function orderedCount(orderPerKey: Map<string, number[]>): number {
  let count = 0;
  for (const seen of orderPerKey.values()) {
    count += seen.length;
  }
  return count;
}
