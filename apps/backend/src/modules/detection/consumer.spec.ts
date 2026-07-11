import type { ProcessedEventOps } from "@mediator/db";
import { SPEC_INGESTED_EVENT_TYPE } from "@mediator/domain";
import { invokeConsumer, type DeliveredEvent } from "@mediator/event-bus";
import { describe, expect, it } from "vitest";

import { DETECTION_CONSUMER_NAME, SpecIngestedDetectionConsumer } from "./consumer.js";

/** A sentinel transaction handle — identity is all that matters for these tests. */
interface FakeTx {
  readonly marker: "fake-tx";
}
const fakeTx: FakeTx = { marker: "fake-tx" };

/** Records every enqueue, and models the DB's idempotent "one job per spec". */
class FakeEnqueuer {
  public readonly calls: { readonly apiSpecId: string; readonly tx: FakeTx }[] = [];
  readonly #enqueued = new Set<string>();

  public enqueue = (apiSpecId: string, tx: FakeTx): Promise<void> => {
    this.calls.push({ apiSpecId, tx });
    this.#enqueued.add(apiSpecId);
    return Promise.resolve();
  };

  public get distinctSpecs(): number {
    return this.#enqueued.size;
  }
}

/** In-memory `processed_event` ledger (mirrors the real dedup-by-event-id). */
class FakeLedger implements ProcessedEventOps {
  readonly #processed = new Set<string>();
  public isProcessed(consumerName: string, eventId: string): Promise<boolean> {
    return Promise.resolve(this.#processed.has(`${consumerName}::${eventId}`));
  }
  public markProcessed(consumerName: string, eventId: string): Promise<void> {
    this.#processed.add(`${consumerName}::${eventId}`);
    return Promise.resolve();
  }
}

function specIngestedEvent(id: string, apiSpecId: string): DeliveredEvent {
  return {
    id,
    type: SPEC_INGESTED_EVENT_TYPE,
    occurredAt: new Date("2026-07-11T00:00:00.000Z"),
    payload: { apiSpecId, appId: "app-1", role: "PROVIDER" },
  };
}

describe("SpecIngestedDetectionConsumer", () => {
  it("handles only SpecIngested", () => {
    const consumer = new SpecIngestedDetectionConsumer<FakeTx>(() => Promise.resolve());
    expect(consumer.name).toBe(DETECTION_CONSUMER_NAME);
    expect(consumer.handles(SPEC_INGESTED_EVENT_TYPE)).toBe(true);
    expect(consumer.handles("MappingApproved")).toBe(false);
  });

  it("records intent by enqueuing the parsed spec id through the handler's tx (no detection)", async () => {
    const enqueuer = new FakeEnqueuer();
    const consumer = new SpecIngestedDetectionConsumer<FakeTx>(enqueuer.enqueue);

    await consumer.handle(specIngestedEvent("evt-1", "spec-42"), fakeTx);

    // The ONLY side effect is the enqueue — no engine/LLM dependency exists on the
    // consumer, so it cannot run detection inline (the dispatcher-tx constraint).
    expect(enqueuer.calls).toStrictEqual([{ apiSpecId: "spec-42", tx: fakeTx }]);
  });

  it("is idempotent under at-least-once redelivery: the same event enqueues one job", async () => {
    const enqueuer = new FakeEnqueuer();
    const consumer = new SpecIngestedDetectionConsumer<FakeTx>(enqueuer.enqueue);
    const ledger = new FakeLedger();
    const event = specIngestedEvent("evt-1", "spec-42");

    const first = await invokeConsumer(consumer, event, fakeTx, ledger);
    const second = await invokeConsumer(consumer, event, fakeTx, ledger);

    expect(first).toBe("handled");
    expect(second).toBe("skipped-duplicate");
    // Redelivery was skipped by the ledger → the handler ran once → one enqueue.
    expect(enqueuer.calls).toHaveLength(1);
    expect(enqueuer.distinctSpecs).toBe(1);
  });
});
