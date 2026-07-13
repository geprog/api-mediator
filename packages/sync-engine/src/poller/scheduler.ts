import type {
  PollCandidateSource,
  PollCandidateView,
  PollDecision,
  PollTrigger,
  SchedulerMetrics,
} from "./types.js";

/**
 * The **Scheduler** — wakes each enabled `SyncRule` on its interval, but only when it
 * is actually eligible to poll (`docs/architecture/sync-engine.md` *Change detection*;
 * `docs/flows/sync-polling-pull.md` step 1; SP-1). The eligibility gate is the pure,
 * directly-testable {@link decidePoll}; the class drives it on a tick, emits poller
 * lag + the stuck-poller alert, and invokes the poll-trigger for each due rule.
 *
 * The scheduling *mechanism* is an implementation choice (SP-1): a self-rescheduling
 * timer that awaits each tick before arming the next, so ticks never overlap. What is
 * fixed is the eligibility gate and the interval.
 */

/** How many multiples of a rule's expected interval without a successful run trips the stuck-poller alert. */
const DEFAULT_STUCK_POLLER_FACTOR = 3;

/**
 * The eligibility gate for one rule this tick (SP-1). Pure and total — a discriminated
 * {@link PollDecision} for every case:
 *
 *  - `poll` — enabled, backfill done, mapping active, and due (interval elapsed, or
 *    never polled). The interval is `pollIntervalOverride ?? source.defaultPollInterval`
 *    (SP-1.1).
 *  - `not-due` — eligible but the interval has not elapsed since `lastRunAt`.
 *  - `hold` — ineligible with a reason: the mapping is `stale`/`suspended` (paused
 *    without touching `status` — SP-1.3), the backfill is not yet `completed`/`skipped`
 *    (SP-1.2), the mapping is neither active nor stale/suspended, the source cannot
 *    poll (SP-1.4 backstop), or a non-enabled row slipped in.
 */
export function decidePoll(candidate: PollCandidateView, now: Date): PollDecision {
  const { rule, mappingStatus, sourceSupportsPolling, sourceDefaultPollInterval } = candidate;

  // Defensive: `listPollCandidates` filters to enabled rules, but the gate is total.
  if (rule.status !== "enabled") {
    return { kind: "hold", reason: "not-enabled" };
  }
  // SP-1.4: a source that cannot poll can never be a source (runtime backstop).
  if (!sourceSupportsPolling) {
    return { kind: "hold", reason: "source-not-pollable" };
  }
  // SP-1.2: an enabled rule with a running (or pending) backfill polls nothing yet.
  if (rule.backfillStatus !== "completed" && rule.backfillStatus !== "skipped") {
    return { kind: "hold", reason: "backfill-not-done" };
  }
  // SP-1.3: staleness/suspension lives on the MAPPING — pause the rule, never its status.
  if (mappingStatus === "stale") {
    return { kind: "hold", reason: "mapping-stale" };
  }
  if (mappingStatus === "suspended") {
    return { kind: "hold", reason: "mapping-suspended" };
  }
  // SP-1.2: the rule only executes while its mapping is active (superseded/archived → hold).
  if (mappingStatus !== "active") {
    return { kind: "hold", reason: "mapping-not-active" };
  }

  // SP-1.1: per-rule override, else the source app's default.
  const intervalMs = rule.pollIntervalOverride ?? sourceDefaultPollInterval;
  const lastRunAt = rule.lastRunAt ?? undefined;
  if (lastRunAt === undefined) {
    // Never polled since going live → due now.
    return { kind: "poll", intervalMs, lastRunAt: undefined };
  }
  const elapsed = now.getTime() - lastRunAt.getTime();
  if (elapsed >= intervalMs) {
    return { kind: "poll", intervalMs, lastRunAt };
  }
  return { kind: "not-due", intervalMs, dueInMs: intervalMs - elapsed, lastRunAt };
}

/** Tuning + injection for {@link Scheduler}. */
export interface SchedulerOptions {
  /** Clock seam (default `() => new Date()`) — drives due-ness + lag. */
  readonly now?: () => Date;
  /** Poller-lag + stuck-poller observability (default no-op). */
  readonly metrics?: SchedulerMetrics;
  /** Multiples of the expected interval without a successful run before the alert (default 3). */
  readonly stuckPollerFactor?: number;
  /** How often the loop ticks, in ms (default 1000). The per-rule interval is the real cadence. */
  readonly tickIntervalMs?: number;
  /** Called with any error a {@link Poller} run or the candidate query throws (default: ignore). */
  readonly onError?: (error: unknown) => void;
}

const DEFAULT_TICK_INTERVAL_MS = 1_000;

export class Scheduler {
  readonly #candidates: PollCandidateSource;
  readonly #trigger: PollTrigger;
  readonly #now: () => Date;
  readonly #metrics: SchedulerMetrics | undefined;
  readonly #stuckPollerFactor: number;
  readonly #tickIntervalMs: number;
  readonly #onError: (error: unknown) => void;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #running = false;

  public constructor(
    candidates: PollCandidateSource,
    trigger: PollTrigger,
    options: SchedulerOptions = {},
  ) {
    this.#candidates = candidates;
    this.#trigger = trigger;
    this.#now = options.now ?? ((): Date => new Date());
    this.#metrics = options.metrics;
    this.#stuckPollerFactor = options.stuckPollerFactor ?? DEFAULT_STUCK_POLLER_FACTOR;
    this.#tickIntervalMs = options.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS;
    this.#onError = options.onError ?? ((): void => {});
  }

  /**
   * Evaluate every candidate rule once (SP-1): decide, emit lag for actively-scheduled
   * rules, fire the stuck-poller alert past the factor, and poll each due rule. Awaits
   * every due poll so a tick is deterministic. Returns the decision per rule (tests).
   */
  public async tick(): Promise<ReadonlyMap<string, PollDecision>> {
    const now = this.#now();
    const candidates = await this.#candidates.listPollCandidates();
    const decisions = new Map<string, PollDecision>();
    const duePolls: Promise<void>[] = [];

    for (const candidate of candidates) {
      const decision = decidePoll(candidate, now);
      decisions.set(candidate.rule.id, decision);

      // Poller lag + stuck-poller are meaningful only for actively-scheduled rules
      // (poll / not-due). A held rule (paused mapping, running backfill) is intentionally
      // not polling — not "stuck" (SP-1.5 / SP-4.4).
      if (decision.kind === "poll" || decision.kind === "not-due") {
        this.#emitLag(candidate, decision.intervalMs, now);
      }
      if (decision.kind === "poll") {
        duePolls.push(this.#runPoll(candidate.rule.id));
      }
    }

    await Promise.all(duePolls);
    return decisions;
  }

  /** Start the tick loop (idempotent). A self-rescheduling timer that never overlaps ticks. */
  public start(): void {
    if (this.#running) {
      return;
    }
    this.#running = true;
    this.#scheduleNext(0);
  }

  /** Stop the loop and wait for any in-flight tick to finish. */
  public async stop(): Promise<void> {
    this.#running = false;
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    // Give an in-flight tick a chance to settle (its awaits complete on the microtask
    // queue); nothing new is scheduled once `#running` is false.
    await Promise.resolve();
  }

  #scheduleNext(delayMs: number): void {
    if (!this.#running) {
      return;
    }
    this.#timer = setTimeout(() => {
      void this.#tickLoop();
    }, delayMs);
  }

  async #tickLoop(): Promise<void> {
    try {
      await this.tick();
    } catch (error) {
      this.#onError(error);
    }
    this.#scheduleNext(this.#tickIntervalMs);
  }

  #emitLag(candidate: PollCandidateView, intervalMs: number, now: Date): void {
    if (this.#metrics === undefined) {
      return;
    }
    const lastRunAt = candidate.rule.lastRunAt ?? undefined;
    if (lastRunAt === undefined) {
      // Never polled since going live: no meaningful lag baseline yet (this tick polls it).
      return;
    }
    const lagMs = now.getTime() - lastRunAt.getTime();
    this.#metrics.recordPollerLag(candidate.rule.id, lagMs, intervalMs);
    if (lagMs > this.#stuckPollerFactor * intervalMs) {
      this.#metrics.recordStuckPoller(candidate.rule.id, lagMs, intervalMs);
    }
  }

  async #runPoll(ruleId: string): Promise<void> {
    try {
      await this.#trigger.pollOnce(ruleId);
    } catch (error) {
      this.#onError(error);
    }
  }
}
