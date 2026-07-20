import type { BackfillMode, SyncRule } from "@mediator/domain";
import { stripUndefined } from "@mediator/domain";
import type { SyncRuleEnableTransition } from "@mediator/db";
import {
  evaluateEnablement,
  type EnablementDegradation,
  type EnablementInput,
  type EnablementRequirement,
  type PollAdvance,
  type PollStateStore,
  type SourceReader,
} from "@mediator/sync-engine";

import type {
  BackfillRunInput,
  BackfillRunResult,
  BackfillScopeResult,
} from "./backfill-runner.js";

/**
 * **`SyncRule` enable orchestration** (BE-3, BE-5.3, BE-6;
 * `docs/architecture/sync-engine.md` *Initial backfill*, *What enablement seeds*;
 * `docs/requirements/phase-4-backfill-enablement.md` BE-3/BE-5/BE-6). The enable
 * action itself: it (1) runs the already-merged {@link evaluateEnablement} gate and
 * refuses a `blocked` rule; (2) enforces the at-most-one-`push` rule across a
 * bidirectional pair (BE-5.3 — the gate omitted the counterpart, so it is enforced
 * here); (3) drives the `status`/`backfillStatus` transitions the Scheduler's SP-1
 * gate reads; (4) triggers the one-time backfill (or records an explicit skip); and
 * (5) seeds the go-live poll state — the **deliberately-early** cursor and the
 * first snapshot (BE-6).
 *
 * It lives in `@mediator/outbound` with the {@link BackfillRunner} it drives (both
 * compose the `RestSourceReader`/`OutboundCallExecutor` that live here). The real
 * composition-root wiring (real repos/readers, exposing this over HTTP) is the
 * deferred SA slice; here every collaborator is injected so the orchestration is
 * unit-tested against fakes + a fake clock.
 *
 * ## Ordering invariants
 *
 *  - **Seed before go-live.** The poll state (cursor/snapshot/`lastRunAt`) is seeded
 *    *before* `backfillStatus` flips to `completed`/`skipped`, so the Scheduler can
 *    never observe a go-live status over an unseeded cursor and poll from the wrong
 *    position. On the running path the rule is flipped `enabled`+`running` first (SP-1
 *    holds polling) and only flipped to `completed` after the seed.
 *  - **Capture the cursor once, before any source read (BE-6.5).** The single early
 *    `clock()` reading is taken before the cursor-returning initialization call and
 *    before the backfill enumeration, so a changed-since cursor is provably `≤` the
 *    moment enumeration began — no later time can leak into it.
 */

// ── Injected ports (the real repos/readers satisfy them) ──────────────────────

/** The `SyncRule` status/backfill transition surface (the real `SyncRuleRepository` satisfies it). */
export interface SyncRuleEnableStore {
  applyEnableTransition(id: string, transition: SyncRuleEnableTransition): Promise<void>;
}

/**
 * Loads the **counterpart** direction's rule's `backfillMode` for the BE-5.3
 * at-most-one-`push` check (`undefined` when there is no counterpart rule, or it has
 * no explicit mode). The real implementation follows `ApprovedMapping.counterpartMappingId`
 * to the counterpart `SyncRule` for the same `resourcePairRef`; injected so the check
 * is unit-testable without the DB.
 */
export interface CounterpartBackfillModeLookup {
  getCounterpartBackfillMode(ruleId: string): Promise<BackfillMode | undefined>;
}

/** The backfill runner surface the orchestration drives (the real {@link BackfillRunner} satisfies it). */
export interface BackfillRunnerPort {
  run(input: BackfillRunInput): Promise<BackfillRunResult>;
}

/**
 * How the rule's delta cursor / snapshot is seeded at go-live (BE-6). Per-rule data
 * the composition root resolves from the `SyncRule`/`ResourceBinding`s:
 *  - **`full-fetch`** — no cursor; the backfill's complete enumeration seeds
 *    `lastSnapshotRef` (BE-6.1). When the backfill is skipped, the first poll's own
 *    fetch seeds it (BE-6.2), so nothing is seeded here.
 *  - **`delta-changed-since`** — the cursor starts at a timestamp captured *before*
 *    enumeration began (BE-6.4), deliberately early. `formatCursor` renders the
 *    timestamp into the API's expected cursor string (default ISO-8601).
 *  - **`delta-cursor-returning`** — an initialization call establishes the current
 *    position from where `deltaCursorRef` says the next cursor lives (BE-6.3).
 */
export type PollSeedDescriptor =
  | { readonly kind: "full-fetch" }
  | { readonly kind: "delta-changed-since"; readonly formatCursor?: (at: Date) => string }
  | { readonly kind: "delta-cursor-returning" };

// ── Input / output ────────────────────────────────────────────────────────────

/** Everything the enable action needs — the gate input, the backfill to run, the poll-seed shape. */
export interface EnableRuleInput {
  /** The enablement gate's input (already-loaded domain objects; carries the rule + `backfillSkipped`). */
  readonly enablement: EnablementInput;
  /** The backfill to run when the gate permits it and it is not skipped (mode + resolved context). */
  readonly backfill: BackfillRunInput;
  /** How the go-live cursor/snapshot is seeded for this rule (BE-6). */
  readonly pollSeed: PollSeedDescriptor;
}

/** The go-live backfill outcome carried on an `enabled` result. */
export type EnableBackfillOutcome =
  { readonly kind: "skipped" } | { readonly kind: "ran"; readonly result: BackfillRunResult };

/**
 * The enable action's verdict — a discriminated union (no boolean soup):
 *  - `blocked` — the gate refused; `stillNeeds` drives the enablement checklist (SU-1);
 *  - `rejected` — BE-5.3: both directions of a bidirectional pair would `push`;
 *  - `backfill-aborted` — the backfill's enumeration aborted on a partial fetch, **or**
 *    (per-scope) every one of its scopes failed: the rule is left `enabled`+`running`
 *    (SP-1 keeps polling held), retriable by re-enabling. A per-scope run in which at
 *    least one scope completed is `enabled`, not this (SS-17.5 per-scope isolation);
 *  - `enabled` — the rule is live: its backfill ran (or was explicitly skipped) and the
 *    poll state is seeded.
 */
export type EnableRuleResult =
  | { readonly kind: "blocked"; readonly stillNeeds: readonly EnablementRequirement[] }
  | { readonly kind: "rejected"; readonly reason: "counterpart-also-push" }
  | { readonly kind: "backfill-aborted"; readonly reason: string; readonly enumeratedCount: number }
  | {
      readonly kind: "enabled";
      readonly backfill: EnableBackfillOutcome;
      readonly degradations: readonly EnablementDegradation[];
    };

// ── Construction ──────────────────────────────────────────────────────────────

export interface RuleEnablerDeps {
  readonly rules: SyncRuleEnableStore;
  readonly pollState: PollStateStore;
  readonly backfillRunner: BackfillRunnerPort;
  /** The source reader — for the cursor-returning initialization call (BE-6.3). */
  readonly sourceReader: SourceReader;
  readonly counterpart: CounterpartBackfillModeLookup;
}

export interface RuleEnablerOptions {
  /** Clock seam (default `() => new Date()`) — the single early cursor capture (BE-6.5) reads it. */
  readonly clock?: () => Date;
}

export class RuleEnabler {
  readonly #rules: SyncRuleEnableStore;
  readonly #pollState: PollStateStore;
  readonly #backfillRunner: BackfillRunnerPort;
  readonly #sourceReader: SourceReader;
  readonly #counterpart: CounterpartBackfillModeLookup;
  readonly #clock: () => Date;

  public constructor(deps: RuleEnablerDeps, options: RuleEnablerOptions = {}) {
    this.#rules = deps.rules;
    this.#pollState = deps.pollState;
    this.#backfillRunner = deps.backfillRunner;
    this.#sourceReader = deps.sourceReader;
    this.#counterpart = deps.counterpart;
    this.#clock = options.clock ?? ((): Date => new Date());
  }

  /** Enable the rule (BE-3). See the class doc for the ordering invariants. */
  public async enable(input: EnableRuleInput): Promise<EnableRuleResult> {
    const decision = evaluateEnablement(input.enablement);
    if (decision.kind === "blocked") {
      // The gate refused — do nothing, surface exactly what the rule still needs.
      return { kind: "blocked", stillNeeds: decision.stillNeeds };
    }

    const ruleId = input.enablement.rule.id;
    const mode = input.backfill.mode;

    // BE-5.3 — at most one of a bidirectional pair's two rules may use `push`.
    if (mode === "push") {
      const counterpartMode = await this.#counterpart.getCounterpartBackfillMode(ruleId);
      if (counterpartMode === "push") {
        return { kind: "rejected", reason: "counterpart-also-push" };
      }
    }

    // BE-6.5 — the single early capture, BEFORE any source read. A changed-since cursor
    // derives from `earlyAt`; the cursor-returning init call is issued from here too.
    const earlyAt = this.#clock();
    const cursorSeed = await this.#captureCursorSeed(input, earlyAt);

    if (!decision.backfillRequired) {
      // BE-3.1 — the operator explicitly skipped the backfill. Seed the go-live poll
      // state (cursor only; the snapshot is seeded by the first poll's own fetch,
      // BE-6.2), then flip enabled+skipped.
      await this.#pollState.advance(
        buildAdvance({ ruleId, lastRunAt: this.#clock(), cursor: cursorSeed }),
      );
      await this.#rules.applyEnableTransition(ruleId, {
        status: "enabled",
        backfillStatus: "skipped",
      });
      return {
        kind: "enabled",
        backfill: { kind: "skipped" },
        degradations: decision.degradations,
      };
    }

    // BE-3.1 — enable + run the backfill. Flip enabled+running FIRST so SP-1 holds
    // polling until the backfill completes, THEN run it.
    await this.#rules.applyEnableTransition(ruleId, {
      status: "enabled",
      backfillStatus: "running",
    });
    const result = await this.#backfillRunner.run(input.backfill);
    if (result.outcome === "aborted") {
      // Abort-on-partial (BE-4.1): leave the rule enabled+running (no seed, no
      // `lastRunAt`) — SP-1 keeps polling held; a re-enable retries.
      return {
        kind: "backfill-aborted",
        reason: result.reason,
        enumeratedCount: result.enumeratedCount,
      };
    }

    if (result.outcome === "completed-per-scope") {
      // A fan-out where NO scope completed is a failed backfill, not a completed one: it
      // seeds nothing at all, so flipping `completed` would take the rule live over an
      // entirely unseeded poll state and make total failure indistinguishable from
      // success. Report it exactly like a single-scope abort (left enabled+running, SP-1
      // keeps polling held, a re-enable retries). Per-scope isolation (SS-17.5) is about
      // one bad scope among good ones — it is preserved below, where a partial run still
      // goes live.
      const failure = allScopesFailed(result.scopes);
      if (failure !== undefined) {
        return { kind: "backfill-aborted", reason: failure.reason, enumeratedCount: failure.count };
      }

      // SS-17.5 — seed each COMPLETED scope's OWN poll_scope_state, keyed by its ScopeLink
      // id (BE-6 per scope). An aborted/parked scope seeds nothing — its next poll re-lists
      // + re-seeds (per-scope isolation; SP-4 per scope). The rule still goes live: one
      // isolated scope's abort never blocks the others.
      const seededAt = this.#clock();
      for (const scope of result.scopes) {
        if (scope.outcome.outcome !== "completed") {
          continue;
        }
        const scopeSnapshot =
          input.pollSeed.kind === "full-fetch" ? scope.outcome.snapshotEntries : undefined;
        await this.#pollState.advance(
          buildAdvance({
            ruleId,
            scopeKey: scope.scopeLinkId,
            lastRunAt: seededAt,
            cursor: cursorSeed,
            snapshotEntries: scopeSnapshot,
            // The snapshot's captured-at is the deliberately-early enumeration start.
            capturedAt: scopeSnapshot !== undefined ? earlyAt : undefined,
          }),
        );
      }
      // BE-6 — stamp the RULE's own `lastRunAt` as well, still BEFORE flipping
      // `completed`. Every per-scope seed above carries a `scopeKey`, so it writes only
      // `poll_scope_state`; without this the rule goes live with `SyncRule.lastRunAt`
      // NULL, which the Scheduler's SP-1 gate reads as "never polled → due now" and polls
      // on the very next tick regardless of the interval. The cross-scope seed below has
      // always stamped it — this is the same `scopeKey`-routing gap, closed for parity.
      // Same `seededAt` as the per-scope seeds, so the rule-level and per-scope stamps
      // agree. An all-scopes-failed fan-out returned above: it seeds nothing and stamps
      // nothing, so SP-1 keeps polling held exactly like a single-scope abort.
      await this.#pollState.advanceRuleRun(ruleId, seededAt);
      await this.#rules.applyEnableTransition(ruleId, { backfillStatus: "completed" });
      return {
        kind: "enabled",
        backfill: { kind: "ran", result },
        degradations: decision.degradations,
      };
    }

    // BE-6 — seed the go-live poll state from the backfill (a full-fetch rule's
    // `lastSnapshotRef` from the complete enumeration, BE-6.1; the changed-since /
    // cursor-returning cursor captured above), THEN flip to completed so the Scheduler
    // never observes `completed` over an unseeded cursor/snapshot.
    const snapshotEntries =
      input.pollSeed.kind === "full-fetch" ? result.snapshotEntries : undefined;
    await this.#pollState.advance(
      buildAdvance({
        ruleId,
        lastRunAt: this.#clock(),
        cursor: cursorSeed,
        snapshotEntries,
        // The snapshot's captured-at is the deliberately-early enumeration start.
        capturedAt: snapshotEntries !== undefined ? earlyAt : undefined,
      }),
    );
    await this.#rules.applyEnableTransition(ruleId, { backfillStatus: "completed" });
    return {
      kind: "enabled",
      backfill: { kind: "ran", result },
      degradations: decision.degradations,
    };
  }

  /**
   * Compute the delta cursor seed BEFORE enumeration (BE-6.3/6.4). Full-fetch → no
   * cursor. Changed-since → the deliberately-early timestamp rendered by `formatCursor`
   * (default ISO-8601), from the single `earlyAt` capture. Cursor-returning → an
   * initialization `readDelta(ruleId, undefined)` whose `nextCursor` is where
   * `deltaCursorRef` says the next cursor lives; a failed init leaves the cursor
   * unseeded (the first poll re-establishes from the beginning — echo/idempotency
   * absorb the overlap).
   */
  async #captureCursorSeed(input: EnableRuleInput, earlyAt: Date): Promise<string | undefined> {
    const seed = input.pollSeed;
    if (seed.kind === "full-fetch") {
      return undefined;
    }
    if (seed.kind === "delta-changed-since") {
      const format = seed.formatCursor ?? defaultChangedSinceCursor;
      return format(earlyAt);
    }
    const delta = await this.#sourceReader.readDelta(input.enablement.rule.id, undefined);
    return delta.ok ? delta.nextCursor : undefined;
  }
}

function defaultChangedSinceCursor(at: Date): string {
  return at.toISOString();
}

/**
 * The abort summary for a per-scope fan-out in which **no** scope completed — every
 * branch aborted (SP-4 per scope) and/or parked (an unresolvable container, SS-11.5) — or
 * `undefined` when at least one scope completed (the SS-17.5 partial run, which still
 * goes live) or the fan-out had no scopes at all.
 *
 * A **zero-scope** fan-out is deliberately *not* a failure: nothing failed, the pair
 * simply has no linked containers yet, and the SS-17.1 re-list establishes them on the
 * next poll. It keeps its existing `completed` outcome.
 *
 * The reason names every failed scope so the operator sees *why* the whole backfill
 * failed rather than one sampled cause, and `count` totals what was enumerated before the
 * branches failed (a parked scope never enumerates, contributing 0).
 */
function allScopesFailed(
  scopes: readonly BackfillScopeResult[],
): { readonly reason: string; readonly count: number } | undefined {
  if (scopes.length === 0) {
    return undefined;
  }
  let count = 0;
  const causes: string[] = [];
  for (const scope of scopes) {
    const outcome = scope.outcome;
    if (outcome.outcome === "completed") {
      return undefined; // at least one scope completed → the SS-17.5 partial run goes live.
    }
    if (outcome.outcome === "aborted") {
      count += outcome.enumeratedCount;
    }
    causes.push(`${scope.scopeLinkId}: ${outcome.reason}`);
  }
  return {
    reason: `all ${String(scopes.length)} scopes failed — ${causes.join("; ")}`,
    count,
  };
}

/**
 * Assemble a {@link PollAdvance}, dropping the optional scopeKey/cursor/snapshot/capturedAt
 * when absent. SS-17.5 — `scopeKey` (a scope's `ScopeLink` id) routes the seed to that
 * scope's own `poll_scope_state`; absent it is the cross-scope seed (SP-5), unchanged.
 */
function buildAdvance(fields: {
  readonly ruleId: string;
  readonly lastRunAt: Date;
  readonly scopeKey?: string | undefined;
  readonly cursor?: string | undefined;
  readonly snapshotEntries?: ReadonlyMap<string, string> | undefined;
  readonly capturedAt?: Date | undefined;
}): PollAdvance {
  return stripUndefined({
    ruleId: fields.ruleId,
    lastRunAt: fields.lastRunAt,
    scopeKey: fields.scopeKey,
    cursor: fields.cursor,
    snapshotEntries: fields.snapshotEntries,
    capturedAt: fields.capturedAt,
  });
}

// ── Fakes (unit tests) ────────────────────────────────────────────────────────

/**
 * In-memory {@link SyncRuleEnableStore} that **mirrors** the real
 * `SyncRuleRepository.applyEnableTransition` partial-`set` semantics
 * ([[fakes-must-mirror-real-repos]]): a transition writes only the field(s) it
 * provides, leaving the other's prior value untouched. Tracks the current status /
 * backfillStatus (and the transition history) for assertions.
 */
export class FakeSyncRuleEnableStore implements SyncRuleEnableStore {
  #status: SyncRule["status"];
  #backfillStatus: SyncRule["backfillStatus"];
  public readonly transitions: SyncRuleEnableTransition[] = [];

  public constructor(
    initial: { status?: SyncRule["status"]; backfillStatus?: SyncRule["backfillStatus"] } = {},
  ) {
    this.#status = initial.status ?? "disabled";
    this.#backfillStatus = initial.backfillStatus ?? "pending";
  }

  public applyEnableTransition(_id: string, transition: SyncRuleEnableTransition): Promise<void> {
    this.transitions.push(transition);
    if (transition.status !== undefined) {
      this.#status = transition.status;
    }
    if (transition.backfillStatus !== undefined) {
      this.#backfillStatus = transition.backfillStatus;
    }
    return Promise.resolve();
  }

  public get status(): SyncRule["status"] {
    return this.#status;
  }

  public get backfillStatus(): SyncRule["backfillStatus"] {
    return this.#backfillStatus;
  }
}
