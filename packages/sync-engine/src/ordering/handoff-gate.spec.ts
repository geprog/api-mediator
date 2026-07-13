import { randomUUID } from "node:crypto";

import type { RecordLink, RecordLinkEstablishingQueueKey } from "@mediator/domain";
import { describe, expect, it } from "vitest";

import { FakeOrderingQueue } from "../fake-ordering-queue.js";
import { FakeRecordLinkStore } from "../identity-resolution/fakes.js";
import { OrderingQueueDispatcher, type QueueHandler } from "../ordering-queue-dispatcher.js";
import { HandoffGate } from "./handoff-gate.js";

/**
 * **OQ-4 — the continuation handoff.** A change enqueued under a `RecordLink` id must
 * not begin processing until the **establishing pre-link queue** has drained: the
 * link-keyed queue opens strictly as a *continuation*, never beside it — one record,
 * one queue, at every moment (`docs/requirements/phase-4-ordering-queue.md` OQ-4.2/4.3/
 * 4.4/4.5). Driven over the faithful `FakeOrderingQueue` + `FakeRecordLinkStore` through
 * the `HandoffGate` decorator; the real-Postgres proof is in the integration spec.
 *
 * Link ids are real UUIDs on purpose: the gate only treats a UUID-shaped key as a
 * possible link (a `RecordLink` id always is one), so the fixtures must match.
 */

const APP_A = "app-a";
const APP_B = "app-b";
const RESOURCE_PAIR = "rp:users";
const T0 = new Date("2026-07-13T00:00:00.000Z");
const RECHECK_MS = 100;

function link(
  id: string,
  establishingQueueKey: RecordLinkEstablishingQueueKey,
  overrides: Partial<RecordLink> = {},
): RecordLink {
  return {
    id,
    appAId: APP_A,
    appANativeId: "na",
    appBId: APP_B,
    appBNativeId: "nb",
    resourcePairRef: RESOURCE_PAIR,
    establishedBy:
      establishingQueueKey.kind === "both-native-id-queues" ? "manual" : "identity-match",
    status: "active",
    establishingQueueKey,
    createdAt: T0,
    tombstonedAt: null,
    ...overrides,
  };
}

/** A dispatcher wired over the gate, with a mutable clock the test advances per tick. */
function harness(links: FakeRecordLinkStore): {
  queue: FakeOrderingQueue;
  dispatcher: OrderingQueueDispatcher;
  processed: string[];
  setNow: (now: Date) => void;
} {
  const queue = new FakeOrderingQueue();
  const gate = new HandoffGate(queue, queue, links, { recheckDelayMs: RECHECK_MS });
  const processed: string[] = [];
  const handler: QueueHandler = (ctx) => {
    processed.push(String(ctx.payload.which));
    return Promise.resolve();
  };
  let now = T0;
  const dispatcher = new OrderingQueueDispatcher(gate, handler, { clock: () => now });
  return {
    queue,
    dispatcher,
    processed,
    setNow: (next: Date): void => {
      now = next;
    },
  };
}

describe("HandoffGate (OQ-4 continuation handoff)", () => {
  it("a link-keyed entry does not begin until its establishing (identity-value) queue drains", async () => {
    const linkId = randomUUID();
    const links = new FakeRecordLinkStore();
    await links.insert(link(linkId, { kind: "identity-value", value: "V" }));
    const { queue, dispatcher, processed, setNow } = harness(links);

    // Enqueue the link-keyed entry FIRST (lowest seq) so the gate's defer path runs,
    // and an establishing pre-link entry still queued under the identity value "V".
    const linkEntry = await queue.enqueue(linkId, { which: "link" });
    await queue.enqueue("V", { which: "establishing" });

    // Tick 1: the gate claims the link entry, finds "V" undrained → defers it, and scans
    // on to run the establishing entry instead. The link handler must NOT have run.
    const first = await dispatcher.runOnce();
    expect(first.outcome).toBe("done");
    expect(first.entry?.queueKey).toBe("V");
    expect(processed).toStrictEqual(["establishing"]);
    // One record, one queue: the link entry was deferred, its handler never invoked.
    expect(queue.getById(linkEntry)?.status).toBe("pending");
    // The handoff wait is attempt-neutral — a waiting entry can never park.
    expect(queue.getById(linkEntry)?.attempts).toBe(0);

    // Tick 2: past the recheck delay; "V" has now drained, so the link entry proceeds —
    // as a continuation of the establishing queue, not beside it.
    setNow(new Date(T0.getTime() + 2 * RECHECK_MS));
    const second = await dispatcher.runOnce();
    expect(second.outcome).toBe("done");
    expect(second.entry?.queueKey).toBe(linkId);
    expect(processed).toStrictEqual(["establishing", "link"]);
  });

  it("a link-keyed entry whose establishing queue is already drained proceeds immediately", async () => {
    const linkId = randomUUID();
    const links = new FakeRecordLinkStore();
    await links.insert(link(linkId, { kind: "identity-value", value: "V" }));
    const { queue, dispatcher, processed } = harness(links);

    // No entries under "V" — the establishing queue already drained.
    await queue.enqueue(linkId, { which: "link" });

    const result = await dispatcher.runOnce();
    expect(result.outcome).toBe("done");
    expect(result.entry?.queueKey).toBe(linkId);
    expect(processed).toStrictEqual(["link"]);
  });

  it("does not gate a pre-link entry (a non-link queue key is never held)", async () => {
    const links = new FakeRecordLinkStore();
    // A link exists, but these entries are keyed by identity values, not link ids.
    await links.insert(link(randomUUID(), { kind: "identity-value", value: "V" }));
    const { queue, dispatcher, processed } = harness(links);

    await queue.enqueue("V", { which: "establishing" });
    await queue.enqueue("other-identity", { which: "unrelated" });

    await dispatcher.drain();
    expect(processed.sort()).toStrictEqual(["establishing", "unrelated"]);
  });

  it("does not gate a UUID-shaped key that matches no link (an identity value that looks like a UUID)", async () => {
    const links = new FakeRecordLinkStore(); // no links at all
    const { queue, dispatcher, processed } = harness(links);

    // A pre-link identity value that happens to be UUID-shaped: getById finds no link,
    // so it is treated as a pre-link key and runs without gating.
    const uuidShapedIdentity = randomUUID();
    await queue.enqueue(uuidShapedIdentity, { which: "identity-uuid" });

    const result = await dispatcher.runOnce();
    expect(result.outcome).toBe("done");
    expect(result.entry?.queueKey).toBe(uuidShapedIdentity);
    expect(processed).toStrictEqual(["identity-uuid"]);
  });

  it("OQ-4.4 — a manual link with the both-native-id-queues marker waits for BOTH native-id queues", async () => {
    const linkId = randomUUID();
    const links = new FakeRecordLinkStore();
    await links.insert(
      link(linkId, { kind: "both-native-id-queues" }, { appANativeId: "na", appBNativeId: "nb" }),
    );
    const { queue, dispatcher, processed, setNow } = harness(links);

    // Link entry first, plus a pending entry on each side's native-id queue.
    const linkEntry = await queue.enqueue(linkId, { which: "link" });
    await queue.enqueue("na", { which: "na" });
    await queue.enqueue("nb", { which: "nb" });

    // Tick 1: link gated (na & nb both pending) → defer; run "na".
    const t1 = await dispatcher.runOnce();
    expect(t1.entry?.queueKey).toBe("na");
    expect(queue.getById(linkEntry)?.status).toBe("pending");

    // Tick 2: "na" drained but "nb" still pending → link STILL gated → defer; run "nb".
    setNow(new Date(T0.getTime() + 2 * RECHECK_MS));
    const t2 = await dispatcher.runOnce();
    expect(t2.entry?.queueKey).toBe("nb");
    expect(queue.getById(linkEntry)?.status).toBe("pending");

    // Tick 3: both native-id queues drained → the link entry finally proceeds.
    setNow(new Date(T0.getTime() + 4 * RECHECK_MS));
    const t3 = await dispatcher.runOnce();
    expect(t3.entry?.queueKey).toBe(linkId);

    // The link-keyed work strictly followed BOTH establishing queues draining.
    expect(processed).toStrictEqual(["na", "nb", "link"]);
  });

  it("does not block OTHER keys while a link entry waits for its establishing queue", async () => {
    const linkId = randomUUID();
    const links = new FakeRecordLinkStore();
    await links.insert(link(linkId, { kind: "identity-value", value: "V" }));
    const { queue, dispatcher, processed } = harness(links);

    // A gated link entry (V undrained) enqueued before unrelated work on another key.
    await queue.enqueue(linkId, { which: "link" });
    await queue.enqueue("V", { which: "establishing" });
    await queue.enqueue("unrelated-key", { which: "unrelated" });

    // One drain pass at a fixed clock: the gated link entry is deferred and left pending,
    // but the establishing entry AND the unrelated key still get processed — no head-of-
    // line block behind the waiting link entry.
    await dispatcher.drain();
    expect(processed.sort()).toStrictEqual(["establishing", "unrelated"]);
    expect(queue.listByStatus("pending").map((e) => e.queueKey)).toStrictEqual([linkId]);
  });
});
