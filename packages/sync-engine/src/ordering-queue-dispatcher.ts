import type { ClaimedQueueEntry, OrderingQueueWorkerOps } from "@mediator/db";

/**
 * The context handed to the injected pipeline handler for one claimed entry. The
 * actual Sync Engine pipeline (Identity Resolution → Loop Prevention → Conflict
 * Detection → Transformation → Outbound Call, i.e. RL/EP/CF/TX/OC) is **out of
 * scope** for OQ-1: this slice provides only the queue substrate and calls a
 * pluggable, side-effect-free-at-this-layer handler.
 */
export interface QueueHandlerContext {
  readonly id: string;
  /** The opaque ordering key this entry serialized on. */
  readonly queueKey: string;
  /** The opaque work descriptor the producer enqueued. */
  readonly payload: Record<string, unknown>;
  /** This entry's attempt number (1 on the first run), post-claim. */
  readonly attempts: number;
}

/**
 * The pipeline seam. Resolves when the entry's work succeeded (the dispatcher marks
 * it `done`); rejects/throws to signal failure (the dispatcher retries it, or parks
 * it once it reaches the attempt ceiling — OQ-1 criterion 5).
 */
export type QueueHandler = (context: QueueHandlerContext) => Promise<void>;

/** How one `runOnce` / worker tick ended. */
export type TickOutcome = "idle" | "done" | "retried" | "parked";

/** The result of one worker tick. `entry` is present unless the queue was idle. */
export interface TickResult {
  readonly outcome: TickOutcome;
  readonly entry: ClaimedQueueEntry | undefined;
}

/** Reported to {@link OrderingQueueDispatcherOptions.onEntrySettled} after each settle. */
export interface SettledEntry {
  readonly id: string;
  readonly queueKey: string;
  readonly outcome: "done" | "retried" | "parked";
  /** The entry's post-claim attempt count. */
  readonly attempts: number;
  /** The handler failure, on `retried`/`parked` only. */
  readonly error?: unknown;
}

/** Tuning + injection points for {@link OrderingQueueDispatcher}. */
export interface OrderingQueueDispatcherOptions {
  /** Parallel worker loops started by {@link OrderingQueueDispatcher.start} (default 1). */
  readonly concurrency?: number;
  /**
   * How long a claim's lease lasts, in milliseconds (default 30_000). MUST exceed
   * the handler's worst-case runtime, or a slow handler's entry becomes re-claimable
   * mid-flight and its key could get a second active worker; use
   * {@link OrderingQueueWorkerOps.heartbeat} for handlers that can run longer.
   */
  readonly leaseDurationMs?: number;
  /**
   * Attempt ceiling: an entry whose handler has now failed this many times is
   * **parked** (dead-lettered) instead of retried — the OC-4 concept (default 5).
   */
  readonly maxAttempts?: number;
  /** How long a worker waits after finding no claimable work, in ms (default 200). */
  readonly idlePollIntervalMs?: number;
  /** Base id recorded as `lease_owner`; each loop appends its index (default random). */
  readonly ownerId?: string;
  /** Clock for lease/stamps (injected for deterministic tests). */
  readonly clock?: () => Date;
  /** Called with any error a worker loop's claim/settle throws (default: ignore). */
  readonly onError?: (error: unknown) => void;
  /** Observability hook fired after each entry is settled (done/retried/parked). */
  readonly onEntrySettled?: (settled: SettledEntry) => void;
}

const DEFAULT_CONCURRENCY = 1;
const DEFAULT_LEASE_DURATION_MS = 30_000;
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_IDLE_POLL_INTERVAL_MS = 200;

/** A non-secret, human-readable description of a handler failure for `last_error`. */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The ordering-queue dispatcher: runs `concurrency` worker loops, each claiming the
 * next processable entry (at most one active worker per key, sequential per key,
 * different keys in parallel — see `OrderingQueueRepository.claimNext`), running the
 * injected {@link QueueHandler}, and settling the entry (`done` / retry / `parked`).
 *
 * The queue substrate provides durability and the ordering guarantees; the dispatcher
 * only drives claim → handle → settle and owns the lease-duration / attempt-ceiling
 * policy. It is **not** the Event Bus outbox dispatcher — this is its own worker loop,
 * so the "consumer handlers run inside the dispatch transaction" constraint does not
 * apply: the handler runs *outside* any claim transaction, under a lease.
 *
 * The `queue` it drives is the real `OrderingQueueRepository` in production, or the
 * faithful `FakeOrderingQueue` in unit tests — both {@link OrderingQueueWorkerOps}.
 */
export class OrderingQueueDispatcher {
  readonly #queue: OrderingQueueWorkerOps;
  readonly #handler: QueueHandler;
  readonly #concurrency: number;
  readonly #leaseDurationMs: number;
  readonly #maxAttempts: number;
  readonly #idlePollIntervalMs: number;
  readonly #ownerId: string;
  readonly #clock: () => Date;
  readonly #onError: (error: unknown) => void;
  readonly #onEntrySettled: (settled: SettledEntry) => void;
  #loops: Promise<void>[] = [];
  #running = false;

  public constructor(
    queue: OrderingQueueWorkerOps,
    handler: QueueHandler,
    options: OrderingQueueDispatcherOptions = {},
  ) {
    this.#queue = queue;
    this.#handler = handler;
    this.#concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
    this.#leaseDurationMs = options.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS;
    this.#maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.#idlePollIntervalMs = options.idlePollIntervalMs ?? DEFAULT_IDLE_POLL_INTERVAL_MS;
    this.#ownerId = options.ownerId ?? `dispatcher-${Math.random().toString(36).slice(2, 10)}`;
    this.#clock = options.clock ?? ((): Date => new Date());
    this.#onError = options.onError ?? noop;
    this.#onEntrySettled = options.onEntrySettled ?? noop;
  }

  /**
   * Claim and process **one** entry as `owner`, returning how it settled.
   * Deterministic; the unit tests drive this directly. Returns `idle` when nothing
   * is claimable.
   */
  public async runOnce(owner: string = this.#ownerId): Promise<TickResult> {
    const now = this.#clock();
    const leaseExpiresAt = new Date(now.getTime() + this.#leaseDurationMs);
    const entry = await this.#queue.claimNext({ now, leaseExpiresAt, owner });
    if (entry === undefined) {
      return { outcome: "idle", entry: undefined };
    }
    try {
      await this.#handler({
        id: entry.id,
        queueKey: entry.queueKey,
        payload: entry.payload,
        attempts: entry.attempts,
      });
    } catch (error) {
      return await this.#settleFailure(entry, error);
    }
    await this.#queue.markDone(entry.id, this.#clock());
    this.#onEntrySettled({
      id: entry.id,
      queueKey: entry.queueKey,
      outcome: "done",
      attempts: entry.attempts,
    });
    return { outcome: "done", entry };
  }

  /**
   * Drain the queue with a **single** worker until it is idle, returning the number
   * of entries settled (done + retried + parked ticks). Deterministic; a convenience
   * for unit tests that want the whole queue processed in order. A permanently
   * retrying entry would loop, so `iterationCap` bounds it.
   */
  public async drain(iterationCap = 10_000): Promise<number> {
    let settled = 0;
    for (let i = 0; i < iterationCap; i += 1) {
      const result = await this.runOnce();
      if (result.outcome === "idle") {
        return settled;
      }
      settled += 1;
    }
    return settled;
  }

  /** Start `concurrency` worker loops (idempotent; a no-op if already running). */
  public start(): void {
    if (this.#running) {
      return;
    }
    this.#running = true;
    for (let i = 0; i < this.#concurrency; i += 1) {
      this.#loops.push(this.#runLoop(`${this.#ownerId}#${String(i)}`));
    }
  }

  /** Stop the loops and wait for any in-flight ticks to finish. */
  public async stop(): Promise<void> {
    this.#running = false;
    const loops = this.#loops;
    this.#loops = [];
    await Promise.all(loops);
  }

  async #runLoop(owner: string): Promise<void> {
    while (this.#running) {
      let result: TickResult;
      try {
        result = await this.runOnce(owner);
      } catch (error) {
        this.#onError(error);
        await sleep(this.#idlePollIntervalMs);
        continue;
      }
      if (result.outcome === "idle") {
        await sleep(this.#idlePollIntervalMs);
      }
    }
  }

  /**
   * Settle a failed handler: park the entry once it has reached the attempt ceiling
   * (dead-letter, OQ-1 criterion 5 — its key's next entry then becomes claimable),
   * otherwise return it to `pending` for a later retry. Exponential backoff (OC-4)
   * is intentionally out of scope here — a retried entry is immediately re-claimable.
   */
  async #settleFailure(entry: ClaimedQueueEntry, error: unknown): Promise<TickResult> {
    if (entry.attempts >= this.#maxAttempts) {
      await this.#queue.park(entry.id, describeError(error), this.#clock());
      this.#onEntrySettled({
        id: entry.id,
        queueKey: entry.queueKey,
        outcome: "parked",
        attempts: entry.attempts,
        error,
      });
      return { outcome: "parked", entry };
    }
    await this.#queue.recordRetry(entry.id, describeError(error));
    this.#onEntrySettled({
      id: entry.id,
      queueKey: entry.queueKey,
      outcome: "retried",
      attempts: entry.attempts,
      error,
    });
    return { outcome: "retried", entry };
  }
}

function noop(): void {
  /* default hook: swallow — callers pass their own logger-backed handler */
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    // Don't let the idle-wait timer keep the process alive on its own.
    timer.unref();
  });
}
