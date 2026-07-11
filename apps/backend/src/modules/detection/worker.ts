import type { DetectionJobWorkerOps, TransactionScope } from "@mediator/db";

/**
 * The durable async detection worker (DT-2). It is the piece that keeps the slow
 * LLM/network analysis **out of the Event Bus dispatcher transaction**: the
 * `SpecIngested` consumer only records a `mapping_detection_job`; this worker
 * claims that job in its own short transaction and then runs the ~1,000-call
 * two-stage detection **outside any dispatcher transaction** (the engine opens its
 * own transaction per persisted proposal).
 *
 * Its shape mirrors the `@mediator/event-bus` `OutboxDispatcher`: `start`/`stop`
 * drive an `unref`'d, re-entrancy-guarded poll loop, and `runOnce()` is the
 * deterministic single pass used directly by tests.
 *
 * Lifecycle per pass (`runOnce`):
 *  1. **reclaim stale** — any `running` job whose `started_at` predates the stale
 *     timeout (a worker that crashed mid-run) is returned to `pending` so its
 *     detection re-runs. Single-instance mediator: the only `running` jobs visible
 *     at the top of a fresh pass are crash orphans (the re-entrancy guard prevents
 *     the current in-flight run from overlapping a new pass).
 *  2. **claim** the oldest `pending` job (`FOR UPDATE SKIP LOCKED`; the claim bumps
 *     `attempts` and stamps `started_at`).
 *  3. **run** detection for the claimed spec, outside any transaction.
 *  4. **settle** — `completed` on success; on failure, back to `pending` for a
 *     retry while under the attempt ceiling, or parked `failed` at the ceiling
 *     (surfaced, never silently looped).
 *
 * **Re-run duplicate-proposal note.** Detection is idempotent-safe to *re-run*: a
 * reclaimed job re-runs `runDetection`, which produces fresh proposals. Because
 * `runDetectionForSpec` persists each proposal in its own transaction as the final
 * step (after all analysis), a crash *during* that short persistence loop can leave
 * a partial set committed, and the re-run then **appends** a duplicate set for the
 * pairs already persisted. This slice bounds duplication where it matters — the
 * idempotent `enqueue` guarantees a redelivered `SpecIngested` never creates a
 * second job (DT-2 crit 2/3) — and deliberately leaves proposal-level supersede/
 * replace-on-re-analysis to the Phase-6 spec-update lifecycle (successor adoption),
 * per the requirement's "Phase-2 re-run appends; dedup is a later concern".
 */

/** Injected dependencies + tuning for {@link DetectionWorker}. */
export interface DetectionWorkerDeps<TTx> {
  /** Transaction scope for the short claim/settle transactions. */
  readonly scope: TransactionScope<TTx>;
  /** Binds the job ops to a transaction handle (production: `DetectionJobRepository`). */
  readonly jobs: (tx: TTx) => DetectionJobWorkerOps;
  /**
   * Run detection for one spec — **outside** any transaction. Production wraps
   * `runDetectionForSpec(specId, deps)` (which opens its own per-proposal
   * transactions) and emits the run's shortlist-yield telemetry.
   */
  readonly runDetection: (apiSpecId: string) => Promise<void>;
  /** Attempt ceiling: a job that fails this many claims is parked `failed`. */
  readonly maxAttempts?: number;
  /** A `running` job older than this (ms) is treated as a crash orphan and reclaimed. */
  readonly staleAfterMs?: number;
  /** Poll interval for the `start()` loop, in milliseconds. */
  readonly pollIntervalMs?: number;
  /** Clock (injected for deterministic tests). */
  readonly clock?: () => Date;
  /** Called with any error the poll loop's `runOnce()` throws (default: ignore). */
  readonly onError?: (error: unknown) => void;
}

/** The settlement of one {@link DetectionWorker.runOnce} pass. */
export type DetectionRunOnceResult =
  | { readonly claimed: false }
  | { readonly claimed: true; readonly outcome: "completed" | "retry" | "failed" };

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_STALE_AFTER_MS = 30 * 60 * 1000;
const DEFAULT_POLL_INTERVAL_MS = 2000;

/** A non-secret, human-readable description of a failure for `last_error`. */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class DetectionWorker<TTx> {
  readonly #scope: TransactionScope<TTx>;
  readonly #jobs: (tx: TTx) => DetectionJobWorkerOps;
  readonly #runDetection: (apiSpecId: string) => Promise<void>;
  readonly #maxAttempts: number;
  readonly #staleAfterMs: number;
  readonly #pollIntervalMs: number;
  readonly #clock: () => Date;
  readonly #onError: (error: unknown) => void;
  #timer: NodeJS.Timeout | undefined = undefined;
  #running = false;
  #ticking = false;

  public constructor(deps: DetectionWorkerDeps<TTx>) {
    this.#scope = deps.scope;
    this.#jobs = deps.jobs;
    this.#runDetection = deps.runDetection;
    this.#maxAttempts = deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.#staleAfterMs = deps.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
    this.#pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.#clock = deps.clock ?? ((): Date => new Date());
    this.#onError = deps.onError ?? noop;
  }

  /** Reclaim stale jobs, claim one pending job, run it, and settle. Deterministic. */
  public async runOnce(): Promise<DetectionRunOnceResult> {
    const staleBefore = new Date(this.#clock().getTime() - this.#staleAfterMs);
    await this.#scope.transaction((tx) => this.#jobs(tx).reclaimStale(staleBefore));

    const claimed = await this.#scope.transaction((tx) => this.#jobs(tx).claimNext(this.#clock()));
    if (claimed === undefined) {
      return { claimed: false };
    }

    try {
      // OUTSIDE any transaction: the engine opens its own transaction per persisted
      // proposal, so the dispatcher/claim transaction never spans the LLM work.
      await this.#runDetection(claimed.apiSpecId);
      await this.#scope.transaction((tx) =>
        this.#jobs(tx).markCompleted(claimed.id, this.#clock()),
      );
      return { claimed: true, outcome: "completed" };
    } catch (error) {
      const message = describeError(error);
      if (claimed.attempts >= this.#maxAttempts) {
        await this.#scope.transaction((tx) =>
          this.#jobs(tx).markFailed(claimed.id, message, this.#clock()),
        );
        return { claimed: true, outcome: "failed" };
      }
      await this.#scope.transaction((tx) => this.#jobs(tx).recordRetry(claimed.id, message));
      return { claimed: true, outcome: "retry" };
    }
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
    // Don't let the poll timer keep the process alive on its own; the HTTP server
    // (or a test) governs lifetime.
    timer.unref();
    this.#timer = timer;
  }

  async #tick(): Promise<void> {
    // Re-entrancy guard: a slow detection run never overlaps the next tick.
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
