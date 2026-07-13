import type { SyncRule } from "@mediator/domain";

/**
 * **The sync-execution reconciler** (RS-1/RS-2;
 * `docs/requirements/phase-4-reconciliation-sweep.md`;
 * `docs/architecture/overview.md` *Components* — the periodic reconciliation sweep;
 * *Deployment model* — "Sync self-heals across downtime"). It is the invariant
 * guardian that makes **"bus loss degrades timeliness, never correctness"** true for
 * the sync-execution reaction: a periodic sweep compares persisted `SyncRule` state
 * against what should have been derived from it and re-triggers any missing reaction.
 *
 * It **extends** the existing sweep framework (`@mediator/event-bus`'s
 * `ReconciliationSweep` — a registry of `{ name, reconcile() }` reconcilers): Phase 2
 * wired detection, Phase 3 (AI-3) wired disabled-artifact instantiation, and this is
 * the Phase-4 sync-execution reconciler. This class is **structurally** a `Reconciler`
 * (`readonly name` + `reconcile(): Promise<void>`) but deliberately does NOT import
 * `@mediator/event-bus`: outbound has no event-bus dependency, so the backend's
 * composition root constructs this with the real ports and registers the instance on
 * the shared sweep (that live wiring is the deferred SA slice).
 *
 * ## What it actually does (RS-1.2 is the only active work)
 *
 *  - **RS-1.1** — it re-derives readiness purely from persisted `SyncRule` state (a
 *    bounded scan; no unbounded event replay).
 *  - **RS-1.2** — for each `enabled` rule whose `backfillStatus = running` but whose
 *    backfill is **not in flight**, it re-triggers the backfill. `running` with no
 *    in-flight entry is the precise **crash-orphaned** signal: the enable action
 *    flips a rule to `running` before the {@link BackfillRunner} executes, so a crash
 *    mid-run leaves `running` persisted with nothing driving it. Re-running is safe —
 *    backfill goes through the normal idempotent pipeline (echo checks + idempotency
 *    keys absorb re-processing; `docs/architecture/sync-engine.md` *Initial backfill*,
 *    *Idempotency*).
 *  - **RS-1.3** — a **documented no-op**. An `enabled`+`completed`/`skipped` rule that
 *    "somehow isn't polling" is *not* a recoverable gap here: the `Scheduler` (SP-1,
 *    `packages/sync-engine/src/poller/scheduler.ts`) re-derives its poll set from
 *    `SyncRuleRepository.listPollCandidates()` **every tick** — it is stateless over
 *    the DB, so an enabled+backfilled rule is a candidate *by construction* and there
 *    is no schedule registration that can be lost. The sweep therefore holds no
 *    scheduling port and re-schedules nothing (asserted by test); it leaves a
 *    completed/skipped rule to the self-healing Scheduler.
 *  - **RS-1.4** — the scan is **bounded** by `limit` per pass (never replays history),
 *    matching AI-3's bounded-reconciliation shape.
 *  - **RS-1.5** — **idempotent**: a rule that is `pending`/`completed`/`skipped` or
 *    in-flight is never re-triggered, so the sweep never double-backfills or double-
 *    enables, and running it twice in a row re-triggers nothing the first pass already
 *    converged (a re-triggered backfill advances the rule to `completed`, or is now in
 *    flight — either way the next pass skips it).
 *
 * Every collaborator is an injected port (real impls wired at the composition root,
 * fakes in tests). No live payload value is ever read here — only rule ids/statuses.
 */

/** The reconciler's stable name — its identity in the {@link ReconciliationSweep} registry. */
export const SYNC_EXECUTION_RECONCILER_NAME = "sync-execution";

// ── Injected ports (the real repos/registry satisfy them; faked in tests) ──────

/**
 * The **bounded** enabled-rule reader (RS-1.1/RS-1.4). The real
 * `SyncRuleRepository.listEnabledForReconciliation` satisfies it: it returns every
 * `enabled` rule up to `limit`, ordered deterministically — never an unbounded scan.
 * A `SyncRule` carries the `backfillStatus` the selection re-derives from.
 */
export interface EnabledRuleReader {
  listEnabledForReconciliation(limit: number): Promise<readonly SyncRule[]>;
}

/**
 * The backfill re-trigger port (RS-1.2). Its real impl re-runs the enable action's
 * backfill (the `BackfillRunner`/`RuleEnabler` path) for the orphaned rule; because
 * backfill is idempotent (echo checks + idempotency keys), a re-run yields the same
 * committed side effect (RS-1.5). Injected so the sweep is unit-testable without the
 * live poller/enabler (that wiring is the deferred SA slice).
 */
export interface BackfillRetrigger {
  retriggerBackfill(ruleId: string): Promise<void>;
}

/**
 * The in-flight signal (RS-1.2): is a backfill for `ruleId` being actively run by
 * **this** process right now? It is the precise distinction between "crash mid-run"
 * (a persisted `running` status with **no** in-flight entry — orphaned, re-trigger)
 * and "running now" (an in-flight entry — legitimately in progress, skip). In the
 * single-instance model the in-flight set is empty after a restart, so every
 * persisted `running` rule is by definition orphaned. {@link InMemoryBackfillInFlightRegistry}
 * is the real single-instance impl the backfill runner populates.
 */
export interface BackfillInFlightTracker {
  isBackfillInFlight(ruleId: string): boolean;
}

/**
 * Optional reconciler-activity metrics (default no-op; the composition root wires
 * OTel counters). Counts/ids only — never a live value.
 */
export interface SyncExecutionReconcilerMetrics {
  /** Called once per pass with how many enabled rules were evaluated (RS-1.4 bound). */
  recordEvaluated(enabledRuleCount: number): void;
  /** Called once per re-triggered orphaned backfill (RS-1.2). */
  recordRetriggered(ruleId: string): void;
}

// ── Construction ───────────────────────────────────────────────────────────────

export interface SyncExecutionReconcilerDeps {
  readonly rules: EnabledRuleReader;
  readonly retrigger: BackfillRetrigger;
  readonly inFlight: BackfillInFlightTracker;
  readonly metrics?: SyncExecutionReconcilerMetrics;
}

export interface SyncExecutionReconcilerOptions {
  /** RS-1.4 — the bound on rules scanned per pass (default {@link DEFAULT_RECONCILE_LIMIT}). */
  readonly limit?: number;
}

/**
 * The default per-pass bound (RS-1.4). Deliberately generous — a single-instance
 * deployment holds far fewer enabled rules than this — while still guaranteeing the
 * scan is bounded and never replays unbounded history.
 */
export const DEFAULT_RECONCILE_LIMIT = 500;

const NOOP_METRICS: SyncExecutionReconcilerMetrics = {
  recordEvaluated: (): void => {},
  recordRetriggered: (): void => {},
};

export class SyncExecutionReconciler {
  /** The reconciler's identity in the sweep registry (structural `Reconciler.name`). */
  public readonly name = SYNC_EXECUTION_RECONCILER_NAME;
  readonly #rules: EnabledRuleReader;
  readonly #retrigger: BackfillRetrigger;
  readonly #inFlight: BackfillInFlightTracker;
  readonly #metrics: SyncExecutionReconcilerMetrics;
  readonly #limit: number;

  public constructor(
    deps: SyncExecutionReconcilerDeps,
    options: SyncExecutionReconcilerOptions = {},
  ) {
    this.#rules = deps.rules;
    this.#retrigger = deps.retrigger;
    this.#inFlight = deps.inFlight;
    this.#metrics = deps.metrics ?? NOOP_METRICS;
    this.#limit = options.limit ?? DEFAULT_RECONCILE_LIMIT;
  }

  /**
   * One reconciliation pass (RS-1). Scans the bounded set of enabled rules, and for
   * each crash-orphaned `running` backfill re-triggers it. Everything else is left
   * untouched — a `pending`/`completed`/`skipped` or in-flight rule is not a missing
   * reaction (RS-1.5), and a completed/skipped rule's polling self-heals via the
   * stateless Scheduler (RS-1.3).
   */
  public async reconcile(): Promise<void> {
    const rules = await this.#rules.listEnabledForReconciliation(this.#limit);
    this.#metrics.recordEvaluated(rules.length);
    for (const rule of rules) {
      if (!this.#isOrphanedBackfill(rule)) {
        continue;
      }
      await this.#retrigger.retriggerBackfill(rule.id);
      this.#metrics.recordRetriggered(rule.id);
    }
  }

  /**
   * The RS-1.2 selection predicate — the orphaned-vs-in-flight signal, decided purely
   * from persisted `SyncRule` state (RS-1.1) plus the in-flight tracker.
   */
  #isOrphanedBackfill(rule: SyncRule): boolean {
    // RS-1.2/RS-1.5: only a `running` backfill can be crash-orphaned. `pending` was
    // never started, `completed`/`skipped` already reached their terminal committed
    // side effect, and an absent status carries no live backfill — none is a missing
    // reaction, so none is re-triggered (no double-backfill, no double-enable).
    //
    // RS-1.3 (documented no-op): a `completed`/`skipped` enabled rule that "isn't
    // polling" is NOT repaired here. The Scheduler re-derives its poll set from
    // `SyncRuleRepository.listPollCandidates()` every tick — stateless over the DB —
    // so an enabled+backfilled rule is a candidate by construction and no schedule
    // registration can be lost (see `packages/sync-engine/src/poller/scheduler.ts`).
    // The sweep holds no scheduling port and re-schedules nothing.
    if (rule.backfillStatus !== "running") {
      return false;
    }
    // RS-1.2: a backfill THIS process is actively running is legitimately in progress
    // — never re-triggered. A persisted `running` status with NO in-flight entry is by
    // definition orphaned by a crash/restart (after a restart the in-flight set is
    // empty), and re-running is safe because backfill goes through the normal
    // idempotent pipeline.
    return !this.#inFlight.isBackfillInFlight(rule.id);
  }
}

// ── Real single-instance in-flight registry (also the test double) ─────────────

/**
 * The single-instance {@link BackfillInFlightTracker}: an in-memory set of the rule
 * ids whose backfill this process is actively running. The backfill runner marks a
 * rule in flight before executing and clears it in a `finally` afterwards (that
 * runner wiring is the deferred SA slice), so the sweep can tell a live backfill from
 * a crash-orphaned one. After a restart the registry is empty — every persisted
 * `running` rule is therefore correctly seen as orphaned (RS-1.2).
 */
export class InMemoryBackfillInFlightRegistry implements BackfillInFlightTracker {
  readonly #inFlight = new Set<string>();

  /** Mark a rule's backfill as actively running in this process. */
  public markInFlight(ruleId: string): void {
    this.#inFlight.add(ruleId);
  }

  /** Clear a rule's in-flight mark (call from a `finally` when the backfill settles). */
  public clear(ruleId: string): void {
    this.#inFlight.delete(ruleId);
  }

  public isBackfillInFlight(ruleId: string): boolean {
    return this.#inFlight.has(ruleId);
  }
}

// ── Fake metrics (unit tests) ─────────────────────────────────────────────────

/** Records reconciler-activity signals for assertions (RS-1.2/RS-1.4). */
export class FakeSyncExecutionReconcilerMetrics implements SyncExecutionReconcilerMetrics {
  public readonly evaluated: number[] = [];
  public readonly retriggered: string[] = [];

  public recordEvaluated(enabledRuleCount: number): void {
    this.evaluated.push(enabledRuleCount);
  }

  public recordRetriggered(ruleId: string): void {
    this.retriggered.push(ruleId);
  }
}
