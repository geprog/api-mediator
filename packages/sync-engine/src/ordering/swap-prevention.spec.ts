import type { RecordLink } from "@mediator/domain";
import { describe, expect, it } from "vitest";

import { FakeOrderingQueue } from "../fake-ordering-queue.js";
import { FakeRecordLinkStore } from "../identity-resolution/fakes.js";
import { OrderingQueueDispatcher, type QueueHandler } from "../ordering-queue-dispatcher.js";
import {
  QueueKeyResolver,
  type QueueKeyChange,
  type QueueKeyResolution,
} from "./queue-key-resolver.js";

/**
 * **OQ-2.3 — the swap-prevention hard test.** Both directions of a bidirectional pair
 * change the same linked record within one poll window; each direction's pipeline does
 * a conflict check (against the shared `SyncFieldState`) and then, if it sees no drift,
 * writes and re-baselines. The concept's worst failure: run *concurrently* on two
 * queues, each checks before the other's write lands, **neither sees drift, both write,
 * and the two sides' values are swapped — permanently and silently**
 * (`docs/architecture/sync-engine.md` *Ordering and consistency*).
 *
 * Keying both directions by the shared `RecordLink` (OQ-2.1) forces them onto **one**
 * queue, so the second to run sees the first's updated baseline and surfaces the
 * conflict instead of writing. This file proves both halves:
 *
 *  1. **The bug is real** — under the *rejected* per-`(mapping, resourceId)` keying
 *     (two queues), a forced concurrent interleave makes BOTH directions pass their
 *     conflict check and write: the swap. (Also proves the fake genuinely permits the
 *     race — a fake that serialized regardless would make test 2 vacuous.)
 *  2. **The keying prevents it** — resolving both directions through
 *     {@link QueueKeyResolver} yields the SAME link-id key, so on one queue exactly one
 *     direction writes and the other records a conflict. No swap.
 *
 * The conflict check + `SyncFieldState` mechanics themselves are CF-1 (out of scope
 * here); this models them minimally as a generation-counter baseline so the ordering
 * property — "the second sees the first's write" — is what is under test.
 */

const RESOURCE_PAIR = "rp:users";
const APP_A = "app-a";
const APP_B = "app-b";
const IDENTITY = "jane@example.test";

/**
 * A minimal stand-in for the pair's shared `SyncFieldState`: `baselineGeneration` is
 * the last-reconciled version both directions read/write. A write bumps it (re-baseline).
 */
interface SharedFieldState {
  baselineGeneration: number;
  readonly writes: string[];
  readonly conflicts: string[];
}

/** Both directions' changes were detected against the same reconciled state (gen 0). */
const BASIS_GENERATION = 0;

/**
 * The pipeline seam under test, modeled as check-then-act on the shared baseline:
 *  - read the current baseline generation,
 *  - `gap()` — the check/act window a concurrent counterpart could interleave into,
 *  - if the baseline advanced past this change's basis, the counterpart already
 *    reconciled → **conflict**, withhold the write,
 *  - else **write**: bump the baseline (re-baseline) and record the write.
 */
function makeHandler(shared: SharedFieldState, gap: () => Promise<void>): QueueHandler {
  return async (ctx): Promise<void> => {
    const direction = String(ctx.payload.direction);
    const observedBaseline = shared.baselineGeneration;
    await gap();
    if (observedBaseline !== BASIS_GENERATION) {
      // Saw the counterpart's write in the shared state → surface the conflict.
      shared.conflicts.push(direction);
      return;
    }
    shared.baselineGeneration = observedBaseline + 1;
    shared.writes.push(direction);
  };
}

/** A single-use N-party barrier: every arriving caller blocks until `parties` have arrived. */
function makeBarrier(parties: number): () => Promise<void> {
  let arrived = 0;
  let release = (): void => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return (): Promise<void> => {
    arrived += 1;
    if (arrived >= parties) {
      release();
    }
    return gate;
  };
}

function activeLink(): RecordLink {
  return {
    id: "link-42",
    appAId: APP_A,
    appANativeId: "a1",
    appBId: APP_B,
    appBNativeId: "b1",
    resourcePairRef: RESOURCE_PAIR,
    establishedBy: "identity-match",
    status: "active",
    establishingQueueKey: { kind: "identity-value", value: IDENTITY },
    createdAt: new Date("2026-07-13T00:00:00.000Z"),
    tombstonedAt: null,
  };
}

const CLOCK = (): Date => new Date("2026-07-13T00:00:00.000Z");

const forwardChange: QueueKeyChange = {
  resourcePairRef: RESOURCE_PAIR,
  sourceAppId: APP_A,
  targetAppId: APP_B,
  sourceNativeId: "a1",
  observedRecord: { email: IDENTITY },
};
const reverseChange: QueueKeyChange = {
  resourcePairRef: RESOURCE_PAIR,
  sourceAppId: APP_B,
  targetAppId: APP_A,
  sourceNativeId: "b1",
  observedRecord: { email: IDENTITY },
};

/** Narrow a resolution to its enqueued key (these OQ-2 cases never park). */
function queued(resolution: QueueKeyResolution): { queueKey: string; basis: string } {
  if (resolution.outcome !== "queue") {
    throw new Error(`expected an enqueued key, got ${resolution.outcome}`);
  }
  return { queueKey: resolution.queueKey, basis: resolution.basis };
}

describe("OQ-2 cross-direction swap prevention", () => {
  it("the bug is real: two queues (per-(mapping,resourceId)) + concurrency → both write (swap)", async () => {
    const queue = new FakeOrderingQueue();
    const shared: SharedFieldState = { baselineGeneration: 0, writes: [], conflicts: [] };

    // The REJECTED keying: each direction on its own (mapping, resourceId) queue.
    await queue.enqueue("A->B:a1", { direction: "A->B" });
    await queue.enqueue("B->A:b1", { direction: "B->A" });

    // Force the race: both handlers reach the check/act window before either writes.
    const barrier = makeBarrier(2);
    const dispatcher = new OrderingQueueDispatcher(queue, makeHandler(shared, barrier), {
      clock: CLOCK,
    });

    // Two workers claim the two DISTINCT keys and run concurrently.
    await Promise.all([dispatcher.runOnce("W1"), dispatcher.runOnce("W2")]);

    // Both passed their conflict check and wrote — the silent permanent swap.
    expect(shared.writes.sort()).toStrictEqual(["A->B", "B->A"]);
    expect(shared.conflicts).toStrictEqual([]);
    // The lost update made visible: two writes, yet the baseline advanced only once
    // (both computed from generation 0) — each side's write clobbered the other's.
    expect(shared.baselineGeneration).toBe(1);
  });

  it("the keying prevents it: RecordLink keys both directions onto ONE queue → one writes, one conflicts", async () => {
    const links = new FakeRecordLinkStore();
    await links.insert(activeLink());
    const resolver = new QueueKeyResolver(links);

    // OQ-2.1: resolve BOTH directions' keys — they must be the SAME shared link id.
    const forwardKey = queued(
      await resolver.resolve(forwardChange, { identitySourcePath: "email" }),
    );
    const reverseKey = queued(
      await resolver.resolve(reverseChange, { identitySourcePath: "email" }),
    );
    expect(forwardKey.basis).toBe("record-link");
    expect(reverseKey.queueKey).toBe(forwardKey.queueKey);

    const queue = new FakeOrderingQueue();
    const shared: SharedFieldState = { baselineGeneration: 0, writes: [], conflicts: [] };
    await queue.enqueue(forwardKey.queueKey, { direction: "A->B" });
    await queue.enqueue(reverseKey.queueKey, { direction: "B->A" });

    // Even with an eager microtask yield in the check/act window, the single queue
    // serializes the two: the second cannot start until the first is done.
    const dispatcher = new OrderingQueueDispatcher(
      queue,
      makeHandler(shared, () => Promise.resolve()),
      { clock: CLOCK },
    );
    const settled = await dispatcher.drain();

    // Exactly one direction wrote; the other saw the first's re-baseline and conflicted.
    expect(settled).toBe(2);
    expect(shared.writes).toStrictEqual(["A->B"]);
    expect(shared.conflicts).toStrictEqual(["B->A"]);
    expect(shared.baselineGeneration).toBe(1);
    // Never a double write: the two sides' values are never swapped.
    expect(shared.writes).toHaveLength(1);
  });

  it("keying holds regardless of which direction is enqueued first", async () => {
    const links = new FakeRecordLinkStore();
    await links.insert(activeLink());
    const resolver = new QueueKeyResolver(links);
    const forwardKey = queued(
      await resolver.resolve(forwardChange, { identitySourcePath: "email" }),
    );
    const reverseKey = queued(
      await resolver.resolve(reverseChange, { identitySourcePath: "email" }),
    );

    const queue = new FakeOrderingQueue();
    const shared: SharedFieldState = { baselineGeneration: 0, writes: [], conflicts: [] };
    // Reverse first this time.
    await queue.enqueue(reverseKey.queueKey, { direction: "B->A" });
    await queue.enqueue(forwardKey.queueKey, { direction: "A->B" });

    const dispatcher = new OrderingQueueDispatcher(
      queue,
      makeHandler(shared, () => Promise.resolve()),
      { clock: CLOCK },
    );
    await dispatcher.drain();

    // Whichever ran first wins the write; the second conflicts. Still exactly one write.
    expect(shared.writes).toStrictEqual(["B->A"]);
    expect(shared.conflicts).toStrictEqual(["A->B"]);
    expect(shared.writes).toHaveLength(1);
  });
});
