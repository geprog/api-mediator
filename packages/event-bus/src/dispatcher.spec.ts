import type { OutboxOps, OutboxRecord, ProcessedEventOps, TransactionScope } from "@mediator/db";
import { SPEC_INGESTED_EVENT_TYPE } from "@mediator/domain";
import { describe, expect, it } from "vitest";

import { ConsumerRegistry, type EventConsumer } from "./consumer.js";
import { invokeConsumer, OutboxDispatcher } from "./dispatcher.js";
import type { DeliveredEvent } from "./event.js";

// ── In-memory fakes (no Postgres) ────────────────────────────────────────────

/** A transaction handle whose `transaction()` just runs the callback inline and
 * lets rejections propagate (modeling a savepoint that rolls back on throw). */
class FakeTx implements TransactionScope<FakeTx> {
  public transaction<T>(fn: (txn: FakeTx) => Promise<T>): Promise<T> {
    return fn(this);
  }
}

/** In-memory `event_outbox`: unpublished rows stay claimable until published,
 * so a redelivery (re-claim of an unpublished row) is naturally exercised. */
class FakeOutbox implements OutboxOps {
  readonly #rows: OutboxRecord[];
  public readonly published: string[] = [];
  public readonly failures: { readonly id: string; readonly error: string }[] = [];

  public constructor(rows: readonly OutboxRecord[]) {
    this.#rows = rows.map((row) => ({ ...row }));
  }

  public claimReady(limit: number, maxAttempts: number): Promise<OutboxRecord[]> {
    const ready = this.#rows
      .filter((row) => row.publishedAt === null && row.attempts < maxAttempts)
      .slice(0, limit)
      .map((row) => ({ ...row }));
    return Promise.resolve(ready);
  }

  public markPublished(id: string, publishedAt: Date): Promise<void> {
    this.published.push(id);
    this.#replace(id, (row) => ({ ...row, publishedAt }));
    return Promise.resolve();
  }

  public recordFailure(id: string, lastError: string): Promise<void> {
    this.failures.push({ id, error: lastError });
    this.#replace(id, (row) => ({ ...row, attempts: row.attempts + 1, lastError }));
    return Promise.resolve();
  }

  #replace(id: string, update: (row: OutboxRecord) => OutboxRecord): void {
    const index = this.#rows.findIndex((row) => row.id === id);
    const current = this.#rows[index];
    if (current !== undefined) {
      this.#rows[index] = update(current);
    }
  }
}

/** In-memory `processed_event` ledger. */
class FakeLedger implements ProcessedEventOps {
  readonly #processed = new Set<string>();
  public markCount = 0;

  public isProcessed(consumerName: string, eventId: string): Promise<boolean> {
    return Promise.resolve(this.#processed.has(`${consumerName}::${eventId}`));
  }

  public markProcessed(consumerName: string, eventId: string): Promise<void> {
    this.#processed.add(`${consumerName}::${eventId}`);
    this.markCount += 1;
    return Promise.resolve();
  }

  public get rows(): readonly string[] {
    return [...this.#processed];
  }
}

interface RecordingConsumer extends EventConsumer<FakeTx> {
  readonly calls: readonly DeliveredEvent[];
}

function recordingConsumer(
  name: string,
  type: string,
  behavior: { failWhile?: () => boolean } = {},
): RecordingConsumer {
  const calls: DeliveredEvent[] = [];
  return {
    name,
    calls,
    handles: (candidate) => candidate === type,
    handle: (event) => {
      calls.push(event);
      if (behavior.failWhile?.() === true) {
        return Promise.reject(new Error(`handler ${name} failed`));
      }
      return Promise.resolve();
    },
  };
}

const occurredAt = new Date("2026-07-10T00:00:00.000Z");

function outboxRow(id: string, eventId: string): OutboxRecord {
  return {
    id,
    eventId,
    type: SPEC_INGESTED_EVENT_TYPE,
    payload: { apiSpecId: "spec-1", appId: "app-1", role: "PROVIDER" },
    occurredAt,
    publishedAt: null,
    attempts: 0,
    lastError: null,
    createdAt: occurredAt,
  };
}

function newDispatcher(
  outbox: FakeOutbox,
  ledger: FakeLedger,
  registry: ConsumerRegistry<FakeTx>,
  maxAttempts = 3,
): OutboxDispatcher<FakeTx> {
  return new OutboxDispatcher<FakeTx>(
    new FakeTx(),
    () => outbox,
    () => ledger,
    registry,
    { maxAttempts, clock: () => new Date("2026-07-10T01:00:00.000Z") },
  );
}

// ── invokeConsumer: the idempotent-consumer skip unit ─────────────────────────

describe("invokeConsumer", () => {
  const event: DeliveredEvent = {
    id: "evt-1",
    type: SPEC_INGESTED_EVENT_TYPE,
    occurredAt,
    payload: {},
  };

  it("handles then records the event id as processed on first delivery", async () => {
    const ledger = new FakeLedger();
    const consumer = recordingConsumer("c", SPEC_INGESTED_EVENT_TYPE);

    const outcome = await invokeConsumer(consumer, event, new FakeTx(), ledger);

    expect(outcome).toBe("handled");
    expect(consumer.calls).toHaveLength(1);
    expect(ledger.rows).toStrictEqual(["c::evt-1"]);
  });

  it("skips (dedup by event id) when already processed, without calling the handler", async () => {
    const ledger = new FakeLedger();
    await ledger.markProcessed("c", "evt-1");
    ledger.markCount = 0;
    const consumer = recordingConsumer("c", SPEC_INGESTED_EVENT_TYPE);

    const outcome = await invokeConsumer(consumer, event, new FakeTx(), ledger);

    expect(outcome).toBe("skipped-duplicate");
    expect(consumer.calls).toHaveLength(0);
    expect(ledger.markCount).toBe(0);
  });
});

// ── OutboxDispatcher.runOnce: routing, publish, dedup, retry ───────────────────

describe("OutboxDispatcher.runOnce", () => {
  it("routes an event only to consumers that handle its type, then publishes", async () => {
    const outbox = new FakeOutbox([outboxRow("row-1", "evt-1")]);
    const ledger = new FakeLedger();
    const registry = new ConsumerRegistry<FakeTx>();
    const specConsumer = recordingConsumer("spec", SPEC_INGESTED_EVENT_TYPE);
    const otherConsumer = recordingConsumer("other", "MappingApproved");
    registry.register(specConsumer);
    registry.register(otherConsumer);

    const result = await newDispatcher(outbox, ledger, registry).runOnce();

    expect(result).toStrictEqual({ claimed: 1, published: 1, failed: 0 });
    expect(specConsumer.calls).toHaveLength(1);
    expect(specConsumer.calls[0]).toStrictEqual({
      id: "evt-1",
      type: SPEC_INGESTED_EVENT_TYPE,
      occurredAt,
      payload: { apiSpecId: "spec-1", appId: "app-1", role: "PROVIDER" },
    });
    expect(otherConsumer.calls).toHaveLength(0);
    expect(outbox.published).toStrictEqual(["row-1"]);
    expect(ledger.rows).toStrictEqual(["spec::evt-1"]);
  });

  it("publishes an event with no interested consumer as a no-op delivery", async () => {
    const outbox = new FakeOutbox([outboxRow("row-1", "evt-1")]);
    const ledger = new FakeLedger();
    const registry = new ConsumerRegistry<FakeTx>();
    registry.register(recordingConsumer("other", "MappingApproved"));

    const result = await newDispatcher(outbox, ledger, registry).runOnce();

    expect(result).toStrictEqual({ claimed: 1, published: 1, failed: 0 });
    expect(outbox.published).toStrictEqual(["row-1"]);
    expect(ledger.rows).toStrictEqual([]);
  });

  it("re-claiming an unpublished row does not re-run an already-processed consumer", async () => {
    // consumerGood succeeds; consumerBad fails on the first pass only. Pass 1
    // leaves the row unpublished (bad failed); pass 2 re-claims it and must skip
    // consumerGood (ledger) while retrying consumerBad — proving idempotent
    // redelivery: the good side effect runs exactly once.
    let badShouldFail = true;
    const outbox = new FakeOutbox([outboxRow("row-1", "evt-1")]);
    const ledger = new FakeLedger();
    const registry = new ConsumerRegistry<FakeTx>();
    const good = recordingConsumer("good", SPEC_INGESTED_EVENT_TYPE);
    const bad = recordingConsumer("bad", SPEC_INGESTED_EVENT_TYPE, {
      failWhile: () => badShouldFail,
    });
    registry.register(good);
    registry.register(bad);
    const dispatcher = newDispatcher(outbox, ledger, registry);

    const pass1 = await dispatcher.runOnce();
    expect(pass1).toStrictEqual({ claimed: 1, published: 0, failed: 1 });
    expect(good.calls).toHaveLength(1);
    expect(bad.calls).toHaveLength(1);
    expect(outbox.failures).toStrictEqual([{ id: "row-1", error: "handler bad failed" }]);
    expect(outbox.published).toStrictEqual([]);
    expect(ledger.rows).toStrictEqual(["good::evt-1"]);

    badShouldFail = false;
    const pass2 = await dispatcher.runOnce();
    expect(pass2).toStrictEqual({ claimed: 1, published: 1, failed: 0 });
    // The already-processed good consumer was skipped; only bad re-ran.
    expect(good.calls).toHaveLength(1);
    expect(bad.calls).toHaveLength(2);
    expect(outbox.published).toStrictEqual(["row-1"]);
    expect([...ledger.rows].sort()).toStrictEqual(["bad::evt-1", "good::evt-1"]);
  });

  it("stops claiming a row once it reaches the attempt ceiling (parked)", async () => {
    const outbox = new FakeOutbox([outboxRow("row-1", "evt-1")]);
    const ledger = new FakeLedger();
    const registry = new ConsumerRegistry<FakeTx>();
    registry.register(
      recordingConsumer("bad", SPEC_INGESTED_EVENT_TYPE, { failWhile: () => true }),
    );
    const dispatcher = newDispatcher(outbox, ledger, registry, 2);

    const first = await dispatcher.runOnce();
    expect(first).toStrictEqual({ claimed: 1, published: 0, failed: 1 });
    const second = await dispatcher.runOnce();
    expect(second).toStrictEqual({ claimed: 1, published: 0, failed: 1 });
    // attempts is now 2 == maxAttempts → parked → no longer claimed.
    const third = await dispatcher.runOnce();
    expect(third).toStrictEqual({ claimed: 0, published: 0, failed: 0 });
    expect(outbox.published).toStrictEqual([]);
  });
});
