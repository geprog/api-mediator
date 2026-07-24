import type {
  PollCandidateSource,
  PollCandidateView,
  PollDecision,
  PollHoldReason,
  PollTrigger,
  SchedulerMetrics,
} from "./types.js";

/**
 * The **Scheduler** — wakes each enabled `SyncRule` on its interval, but only when it
 * is actually eligible to poll (`docs/architecture/sync-engine.md` *Change detection*;
 * `docs/flows/sync-polling-pull.md` step 1; SP-1). The eligibility gate is the pure,
 * directly-testable {@link decidePoll} — itself the "no {@link pollPauseConditions}
 * condition applies, and it is due" decision; the class drives it on a tick, emits poller
 * lag + the stuck-poller alert, and invokes the poll-trigger for each due rule.
 *
 * The scheduling *mechanism* is an implementation choice (SP-1): a self-rescheduling
 * timer that awaits each tick before arming the next, so ticks never overlap. What is
 * fixed is the eligibility gate and the interval.
 */

/** How many multiples of a rule's expected interval without a successful run trips the stuck-poller alert. */
const DEFAULT_STUCK_POLLER_FACTOR = 3;

/**
 * **Every pause condition that currently applies to one rule (SP-1.3 / SL-4 / SL-10 /
 * AL-1.6), in a fixed reporting order.** The conditions are **independent** and are all
 * evaluated: a rule can be paused by an app disable *and* a suspended mapping *and* an
 * unfinished backfill at the same time, and it resumes only when **all** of them clear
 * (AL-1.6). This is deliberately not a precedence chain that stops at the first hit —
 * {@link decidePoll} polls a rule only when this list is **empty**, so lifting one
 * condition can never accidentally resume a rule another condition still holds.
 *
 * Not one of these is stored on the rule: staleness/suspension is a condition of the
 * `ApprovedMapping` (SP-1.3) and disabledness a condition of the `RegisteredApp`
 * (AL-1.1), both re-derived here from state the candidate join re-reads every tick, so
 * `SyncRule.status` (and its cursor/snapshot) is never touched by a pause or a resume.
 *
 * The **unconfirmed-ref** condition AL-1.6 also names is enforced one step later, by the
 * Poller's SP-2.5 backstop (`PollPlanResolver` → a `skipped` run) rather than here: the
 * candidate view carries no `ResourceBinding` refs. It composes the same way — a rule
 * runs only when this gate passes *and* the plan resolves — so an app re-enabled while a
 * ref is still unconfirmed stays parked at that backstop.
 *
 * The order is the *reporting* order only (which single reason {@link decidePoll}
 * surfaces when several apply): the coarse execution backstops first, then the mapping's
 * lifecycle, then the app's.
 */
export function pollPauseConditions(candidate: PollCandidateView): readonly PollHoldReason[] {
  const { rule, mappingStatus, sourceSupportsPolling, sourceAppStatus, targetAppStatus } =
    candidate;
  const conditions: PollHoldReason[] = [];

  // Defensive: `listPollCandidates` filters to enabled rules, but the gate is total.
  if (rule.status !== "enabled") {
    conditions.push("not-enabled");
  }
  // SP-1.4: a source that cannot poll can never be a source (runtime backstop).
  if (!sourceSupportsPolling) {
    conditions.push("source-not-pollable");
  }
  // SP-1.2: an enabled rule with a running (or pending) backfill polls nothing yet.
  if (rule.backfillStatus !== "completed" && rule.backfillStatus !== "skipped") {
    conditions.push("backfill-not-done");
  }
  // SP-1.3: staleness/suspension lives on the MAPPING — pause the rule, never its status.
  // One enum, so these three are the mutually exclusive classification of ONE condition
  // (not three independent ones): `active` contributes nothing.
  if (mappingStatus === "stale") {
    conditions.push("mapping-stale");
  } else if (mappingStatus === "suspended") {
    conditions.push("mapping-suspended");
  } else if (mappingStatus !== "active") {
    // SP-1.2: superseded/archived — the rule only executes while its mapping is active.
    conditions.push("mapping-not-active");
  }
  // AL-1.1: the rule stops executing while EITHER of its apps is disabled — the app it
  // reads from and the app it writes to are equally load-bearing.
  if (sourceAppStatus === "disabled" || targetAppStatus === "disabled") {
    conditions.push("app-disabled");
  }
  return conditions;
}

/**
 * The eligibility gate for one rule this tick (SP-1). Pure and total — a discriminated
 * {@link PollDecision} for every case:
 *
 *  - `poll` — no pause condition applies (enabled, backfill done, mapping active,
 *    neither app disabled) and it is due (interval elapsed, or never polled). The
 *    interval is `pollIntervalOverride ?? source.defaultPollInterval` (SP-1.1).
 *  - `not-due` — eligible but the interval has not elapsed since `lastRunAt`.
 *  - `hold` — at least one {@link pollPauseConditions} condition applies; `reason` is the
 *    first of them in that function's documented order. A rule is polled **only** when
 *    the condition list is empty (AL-1.6), so several simultaneous conditions each have
 *    to clear before it resumes.
 */
export function decidePoll(candidate: PollCandidateView, now: Date): PollDecision {
  const { rule, sourceDefaultPollInterval } = candidate;

  // AL-1.6 — hold while ANY applicable condition stands; poll only on an empty list.
  const [held] = pollPauseConditions(candidate);
  if (held !== undefined) {
    return { kind: "hold", reason: held };
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
