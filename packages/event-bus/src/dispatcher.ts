import type { OutboxOps, OutboxRecord, ProcessedEventOps, TransactionScope } from "@mediator/db";

import type { ConsumerRegistry, EventConsumer } from "./consumer.js";
import { reconstructEvent, type DeliveredEvent } from "./event.js";

/** The two outcomes of routing one event to one consumer. */
export type ConsumerInvocation = "handled" | "skipped-duplicate";

/**
 * Deliver one event to one consumer, idempotently. Checks the ledger first and
 * skips if this consumer has already processed this event id; otherwise runs the
 * handler and records the event as processed **through the same `processed`
 * handle** (which the dispatcher binds to the handler's transaction), so the
 * effect and its ledger row commit together.
 *
 * This is the unit-testable core of the "idempotent consumers (deduplicating by
 * event id)" guarantee: with a fake ledger it can be exercised without a
 * database.
 */
export async function invokeConsumer<TTx>(
  consumer: EventConsumer<TTx>,
  event: DeliveredEvent,
  tx: TTx,
  processed: ProcessedEventOps,
): Promise<ConsumerInvocation> {
  if (await processed.isProcessed(consumer.name, event.id)) {
    return "skipped-duplicate";
  }
  await consumer.handle(event, tx);
  await processed.markProcessed(consumer.name, event.id);
  return "handled";
}

/** Tuning + injection points for {@link OutboxDispatcher}. */
export interface DispatcherOptions {
  /** Attempt ceiling: a row that fails this many times is parked (dead-lettered). */
  readonly maxAttempts?: number;
  /** Max rows claimed per {@link OutboxDispatcher.runOnce}. */
  readonly batchSize?: number;
  /** Poll interval for the `start()` loop, in milliseconds. */
  readonly pollIntervalMs?: number;
  /** Clock for `published_at` (injected for deterministic tests). */
  readonly clock?: () => Date;
  /** Called with any error the poll loop's `runOnce()` throws (default: ignore). */
  readonly onError?: (error: unknown) => void;
}

/** Summary of one dispatch pass. */
export interface RunOnceResult {
  /** Rows claimed from the outbox this pass. */
  readonly claimed: number;
  /** Rows fully delivered (all consumers processed) and marked published. */
  readonly published: number;
  /** Rows with at least one failing consumer, left for retry with `attempts` bumped. */
  readonly failed: number;
}

const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_BATCH_SIZE = 50;
const DEFAULT_POLL_INTERVAL_MS = 1000;

/** The outcome of delivering one outbox row to all its consumers. */
type RowOutcome =
  { readonly kind: "published" } | { readonly kind: "failed"; readonly error: string };

/** A non-secret, human-readable description of a handler failure for `last_error`. */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The outbox dispatcher: claims ready rows and delivers each to every registered
 * consumer for its type, at-least-once with idempotent (dedup-by-event-id)
 * consumption.
 *
 * One `runOnce()` opens a single transaction that:
 *  1. claims a batch with `FOR UPDATE SKIP LOCKED` (concurrent dispatchers never
 *     take the same row);
 *  2. for each row, runs each consumer inside a **savepoint** (a nested
 *     transaction), checking the ledger and recording "processed" in that same
 *     savepoint — so a consumer's effect and its ledger row commit together, and
 *     one consumer's failure rolls back only its own savepoint, not the batch;
 *  3. marks a row `published` when every consumer processed it, or records a
 *     failure (`attempts++`, `last_error`) to retry later — where the ledger
 *     makes already-processed consumers skip, so only the failed one re-runs.
 *
 * A row that reaches `maxAttempts` failures is no longer claimed (parked /
 * dead-lettered), visible via `EventOutboxRepository.listParked`.
 *
 * `TTx` is the transaction-handle type; it must itself be able to open nested
 * (savepoint) transactions, hence `TTx extends TransactionScope<TTx>`. In
 * production `TTx = DbTransaction`; unit tests supply an in-memory fake.
 */
export class OutboxDispatcher<TTx extends TransactionScope<TTx>> {
  readonly #scope: TransactionScope<TTx>;
  readonly #outbox: (tx: TTx) => OutboxOps;
  readonly #processed: (tx: TTx) => ProcessedEventOps;
  readonly #registry: ConsumerRegistry<TTx>;
  readonly #maxAttempts: number;
  readonly #batchSize: number;
  readonly #pollIntervalMs: number;
  readonly #clock: () => Date;
  readonly #onError: (error: unknown) => void;
  #timer: NodeJS.Timeout | undefined = undefined;
  #running = false;
  #ticking = false;

  public constructor(
    scope: TransactionScope<TTx>,
    outbox: (tx: TTx) => OutboxOps,
    processed: (tx: TTx) => ProcessedEventOps,
    registry: ConsumerRegistry<TTx>,
    options: DispatcherOptions = {},
  ) {
    this.#scope = scope;
    this.#outbox = outbox;
    this.#processed = processed;
    this.#registry = registry;
    this.#maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.#batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
    this.#pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.#clock = options.clock ?? ((): Date => new Date());
    this.#onError = options.onError ?? noop;
  }

  /** Deliver one batch of ready events. Deterministic; used directly in tests. */
  public async runOnce(): Promise<RunOnceResult> {
    return this.#scope.transaction(async (tx) => {
      const outbox = this.#outbox(tx);
      const rows = await outbox.claimReady(this.#batchSize, this.#maxAttempts);
      let published = 0;
      let failed = 0;
      for (const row of rows) {
        const outcome = await this.#deliverRow(tx, row);
        if (outcome.kind === "published") {
          await outbox.markPublished(row.id, this.#clock());
          published += 1;
        } else {
          await outbox.recordFailure(row.id, outcome.error);
          failed += 1;
        }
      }
      return { claimed: rows.length, published, failed };
    });
  }

  async #deliverRow(tx: TTx, row: OutboxRecord): Promise<RowOutcome> {
    const event = reconstructEvent(row);
    const consumers = this.#registry.consumersFor(row.type);
    let firstError: string | undefined;
    for (const consumer of consumers) {
      try {
        await tx.transaction(async (savepoint) => {
          await invokeConsumer(consumer, event, savepoint, this.#processed(savepoint));
        });
      } catch (error) {
        // Savepoint rolled back → this consumer's partial writes + its ledger
        // row are undone; other consumers and the batch continue. The row stays
        // unpublished and is retried; the ledger makes the succeeded consumers
        // skip on the retry.
        firstError ??= describeError(error);
      }
    }
    return firstError === undefined ? { kind: "published" } : { kind: "failed", error: firstError };
  }

  /** Start the interval-driven poll loop (idempotent; a no-op if already running). */
  public start(): void {
    if (this.#running) {
      return;
    }
    this.#running = true;
    this.#scheduleNext();
  }

  /** Stop the poll loop. An in-flight `runOnce()` is allowed to finish. */
  public stop(): void {
    this.#running = false;
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
  }

  #scheduleNext(): void {
    const timer = setTimeout(() => {
      void this.#tick();
    }, this.#pollIntervalMs);
    // Don't let the poll timer keep the process alive on its own; the HTTP
    // server (or a test) governs lifetime.
    timer.unref();
    this.#timer = timer;
  }

  async #tick(): Promise<void> {
    // Re-entrancy guard: a slow pass never overlaps the next tick.
    if (!this.#ticking) {
      this.#ticking = true;
      try {
        await this.runOnce();
      } catch (error) {
        this.#onError(error);
      } finally {
        this.#ticking = false;
      }
    }
    if (this.#running) {
      this.#scheduleNext();
    }
  }
}

function noop(): void {
  /* default onError: swallow — callers pass their own logger-backed handler */
}
