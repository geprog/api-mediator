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

/**
 * How one `runOnce` / worker tick ended.
 *  - `done` / `retried` / `parked` — the OQ-1 outcomes.
 *  - `deferred` — the entry was re-queued with a not-before delay WITHOUT counting a
 *    failed attempt (OC-3 load-discipline `defer`: a ceiling / `Retry-After` wait).
 *  - `lease-lost` — the handler ran but this worker's lease had expired and the entry
 *    was re-claimed by another worker, so the lease-owner fence rejected the settle
 *    (the other worker owns the outcome now — this run's work is discarded).
 */
export type TickOutcome = "idle" | "done" | "retried" | "parked" | "deferred" | "lease-lost";

/** The result of one worker tick. `entry` is present unless the queue was idle. */
export interface TickResult {
  readonly outcome: TickOutcome;
  readonly entry: ClaimedQueueEntry | undefined;
}

/** Reported to {@link OrderingQueueDispatcherOptions.onEntrySettled} after each settle. */
export interface SettledEntry {
  readonly id: string;
  readonly queueKey: string;
  readonly outcome: "done" | "retried" | "parked" | "deferred";
  /** The entry's post-claim attempt count. */
  readonly attempts: number;
  /** The handler failure, on `retried`/`parked` only. */
  readonly error?: unknown;
}

/**
 * How the dispatcher settles a failed handler run, decided by
 * {@link OrderingQueueDispatcherOptions.classifyFailure}:
 *  - `retry` — return to `pending` with an exponential-backoff not-before
 *    ({@link OrderingQueueDispatcherOptions.retryBackoff}); **counts** toward the
 *    attempt ceiling (OC-4 criterion 1).
 *  - `park` — dead-letter now (OC-4 criterion 2 — the retry ceiling, or a
 *    non-retryable failure the caller wants parked immediately, e.g. a transform
 *    error or credential-refresh failure — OC-4 criterion 6).
 *  - `defer` — re-queue with a not-before of `delayMs`, **not** counted as a failed
 *    attempt (OC-3 criterion 5 — a load-discipline / `Retry-After` wait, so a
 *    rate-limited app is never dead-lettered).
 */
export type FailureDisposition =
  | { readonly kind: "retry" }
  | { readonly kind: "park" }
  | { readonly kind: "defer"; readonly delayMs: number };

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
   * Applies only to the default {@link classifyFailure}; a custom classifier owns
   * its own park decision.
   */
  readonly maxAttempts?: number;
  /**
   * The exponential-backoff delay (ms) for a `retry` disposition, given the entry's
   * post-claim attempt count. The default doubles from a 1s base, capped at 60s —
   * OC-4's "exponential backoff **inside** the per-record ordering queue": the
   * delay is applied as the entry's `available_at` not-before, so the record's
   * queue waits it out without holding a worker.
   */
  readonly retryBackoff?: (attempts: number) => number;
  /**
   * Classify a failed handler run into {@link FailureDisposition}. The default
   * retries (with backoff) until `maxAttempts`, then parks — the OQ-1 behavior. The
   * Outbound Call Executor injects a classifier that parks non-retryable failures
   * (transform error / credential-refresh failure) immediately and `defer`s
   * load-discipline throttles (OC-3 / OC-4).
   */
  readonly classifyFailure?: (
    error: unknown,
    attempts: number,
    maxAttempts: number,
  ) => FailureDisposition;
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
const DEFAULT_RETRY_BASE_DELAY_MS = 1_000;
const DEFAULT_MAX_RETRY_DELAY_MS = 60_000;

/**
 * The default exponential backoff: `base · 2^(attempts-1)`, capped — so the first
 * retry (post-claim `attempts = 1`) waits `base`, the next `2·base`, and so on. The
 * delay becomes the entry's `available_at` not-before (OC-4 backoff-in-queue).
 */
function defaultRetryBackoff(attempts: number): number {
  const exponent = Math.max(0, attempts - 1);
  const delay = DEFAULT_RETRY_BASE_DELAY_MS * 2 ** exponent;
  return Math.min(delay, DEFAULT_MAX_RETRY_DELAY_MS);
}

/** The OQ-1 default: retry (with backoff) under the ceiling, park at it. */
function defaultClassifyFailure(
  _error: unknown,
  attempts: number,
  maxAttempts: number,
): FailureDisposition {
  return attempts >= maxAttempts ? { kind: "park" } : { kind: "retry" };
}

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
  readonly #retryBackoff: (attempts: number) => number;
  readonly #classifyFailure: (
    error: unknown,
    attempts: number,
    maxAttempts: number,
  ) => FailureDisposition;
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
    this.#retryBackoff = options.retryBackoff ?? defaultRetryBackoff;
    this.#classifyFailure = options.classifyFailure ?? defaultClassifyFailure;
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
      return await this.#settleFailure(entry, owner, error);
    }
    const applied = await this.#queue.markDone(entry.id, owner, this.#clock());
    if (!applied) {
      return this.#leaseLost(entry);
    }
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
   * Settle a failed handler per {@link OrderingQueueDispatcherOptions.classifyFailure}:
   *  - `park` — dead-letter (OC-4 criterion 2 — retry ceiling, or a caller-declared
   *    non-retryable failure): its key's next entry then becomes claimable.
   *  - `retry` — return to `pending` with an exponential-backoff `available_at`
   *    not-before (OC-4 criterion 1 — the backoff is served **inside** the queue, so
   *    the record's queue waits it out without holding a worker).
   *  - `defer` — return to `pending` with a `delayMs` not-before **without** counting
   *    a failed attempt (OC-3 criterion 5 — a load-discipline throttle).
   *
   * Each settle is lease-owner fenced; a `false` return means this worker lost its
   * lease (an expired-lease re-claim by another worker), so the settle is discarded.
   */
  async #settleFailure(
    entry: ClaimedQueueEntry,
    owner: string,
    error: unknown,
  ): Promise<TickResult> {
    const disposition = this.#classifyFailure(error, entry.attempts, this.#maxAttempts);

    if (disposition.kind === "park") {
      const applied = await this.#queue.park(entry.id, describeError(error), owner, this.#clock());
      return applied ? this.#reportSettled(entry, "parked", error) : this.#leaseLost(entry);
    }

    if (disposition.kind === "defer") {
      const availableAt = new Date(this.#clock().getTime() + disposition.delayMs);
      const applied = await this.#queue.defer(entry.id, owner, availableAt);
      return applied ? this.#reportSettled(entry, "deferred") : this.#leaseLost(entry);
    }

    const availableAt = new Date(this.#clock().getTime() + this.#retryBackoff(entry.attempts));
    const applied = await this.#queue.recordRetry(
      entry.id,
      describeError(error),
      owner,
      availableAt,
    );
    return applied ? this.#reportSettled(entry, "retried", error) : this.#leaseLost(entry);
  }

  /** Fire {@link onEntrySettled} and return the matching {@link TickResult}. */
  #reportSettled(
    entry: ClaimedQueueEntry,
    outcome: "done" | "retried" | "parked" | "deferred",
    error?: unknown,
  ): TickResult {
    this.#onEntrySettled({
      id: entry.id,
      queueKey: entry.queueKey,
      outcome,
      attempts: entry.attempts,
      ...(error === undefined ? {} : { error }),
    });
    return { outcome, entry };
  }

  /**
   * A settle the lease-owner fence rejected: this worker's lease had expired and the
   * entry was re-claimed by another worker before it could settle. The other worker
   * owns the outcome; this run's work is discarded (state-convergent sync makes the
   * discarded write safe to re-run). Surfaced to `onError` for visibility.
   */
  #leaseLost(entry: ClaimedQueueEntry): TickResult {
    this.#onError(new Error(`ordering-queue entry ${entry.id} lease lost before settle`));
    return { outcome: "lease-lost", entry };
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
