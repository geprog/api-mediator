import type { AdapterBindingRole } from "@mediator/domain";

import {
  compareBindingPrecedence,
  type BindingFailure,
  type BindingPrecedenceKey,
  type EliminatedBinding,
  type PlannedBinding,
  type ResolutionPlan,
} from "./pipeline-types.js";

/**
 * **The pure decision core of `fanout-first-success` (AG-6).** The lazy, one-binding-at-a-time
 * I/O walk lives on the handler (a success short-circuits the chain, AG-6.2), but every
 * *decision* it makes is a pure function of the plan and the causes recorded so far, so the
 * ordering, role-validity defense, and exhaustion-cause selection are all testable without a
 * backend.
 *
 * `docs/architecture/adapter-engine.md` *Aggregation strategies* / *Role validity*: "`primary`
 * is tried first; `fallback` bindings are tried in `executionOrder` on failure. No
 * `supplement`." Under this strategy `executionOrder` is a **strict total order** over the
 * fallback chain and `dependsOnBindingId` does not apply — the bindings are alternatives, not
 * collaborators.
 */

/**
 * One entry in the ordered attempt chain (AG-6.1): a healthy binding the walk will *call*, or
 * a planner-eliminated binding it *skips exactly like a failure* without calling (AG-6.3).
 * Both carry `role`/`executionOrder`/`bindingId`, so ordering and the role defense reason over
 * either uniformly.
 */
export type FirstSuccessAttempt =
  | { readonly kind: "planned"; readonly planned: PlannedBinding }
  | { readonly kind: "eliminated"; readonly eliminated: EliminatedBinding };

/** The ordered attempt chain, or a loud role-defense defect (AG-6.1 defense-in-depth). */
export type FirstSuccessOrder =
  | { readonly ok: true; readonly attempts: readonly FirstSuccessAttempt[] }
  | { readonly ok: false; readonly detail: string };

/** The `role` of an attempt, from whichever binding shape it wraps. */
function roleOf(attempt: FirstSuccessAttempt): AdapterBindingRole {
  return attempt.kind === "planned" ? attempt.planned.role : attempt.eliminated.role;
}

/** The binding id of an attempt (for a defect message and the precedence tiebreak). */
function bindingIdOf(attempt: FirstSuccessAttempt): string {
  return attempt.kind === "planned" ? attempt.planned.bindingId : attempt.eliminated.bindingId;
}

/** The precedence key (`executionOrder`, then binding id) of an attempt. */
function precedenceKeyOf(attempt: FirstSuccessAttempt): BindingPrecedenceKey {
  const binding = attempt.kind === "planned" ? attempt.planned : attempt.eliminated;
  return { executionOrder: binding.executionOrder, bindingId: binding.bindingId };
}

/**
 * **Order the attempt chain (AG-6.1).** Across BOTH the plan's healthy bindings (flattened
 * from `plan.groups`) and its eliminated bindings, put the single `primary` **first — by role,
 * not by numeric order** — then every `fallback` in ascending `executionOrder`, with
 * {@link compareBindingPrecedence} (order, then binding id) as the deterministic tiebreak.
 *
 * Role validity is re-checked here at execution as **defense-in-depth** (mirroring AG-2.1's
 * exactly-one-primary check), never trusting CO-2/the planner blindly: exactly one `primary`
 * and **zero** `supplement`s. A `supplement` present, or a primary count other than one, is a
 * composition defect CO-2 should have prevented → a loud `mediator-transform-error`, never a
 * plausible-but-wrong served result. (A chained binding cannot reach here at all: the planner's
 * TE-3.6 backstop already fails loud on `dependsOnBindingId` under any non-`fanout-merge`
 * strategy.)
 */
export function orderFirstSuccessAttempts(plan: ResolutionPlan): FirstSuccessOrder {
  if (plan.aggregationStrategy !== "fanout-first-success") {
    return {
      ok: false,
      detail: `orderFirstSuccessAttempts received a '${plan.aggregationStrategy}' plan`,
    };
  }

  const attempts: FirstSuccessAttempt[] = [
    ...plan.groups.flatMap((group) =>
      group.bindings.map((planned): FirstSuccessAttempt => ({ kind: "planned", planned })),
    ),
    ...plan.eliminated.map((eliminated): FirstSuccessAttempt => ({
      kind: "eliminated",
      eliminated,
    })),
  ];

  // AG-6.1 — no `supplement` participates in this strategy.
  const supplement = attempts.find((attempt) => roleOf(attempt) === "supplement");
  if (supplement !== undefined) {
    return {
      ok: false,
      detail: `fanout-first-success binding ${bindingIdOf(supplement)} has role 'supplement'`,
    };
  }

  // AG-6.1 — exactly one `primary`, re-validated at execution (not assumed from CO-2).
  const primaries = attempts.filter((attempt) => roleOf(attempt) === "primary");
  const primary = primaries[0];
  if (primaries.length !== 1 || primary === undefined) {
    return {
      ok: false,
      detail: `fanout-first-success requires exactly one primary at execution, got ${String(primaries.length)}`,
    };
  }

  // Primary first (by role); then every remaining binding — all `fallback` after the two
  // checks above — in ascending `executionOrder`, ties broken by binding id.
  const fallbacks = attempts
    .filter((attempt) => attempt !== primary)
    .sort((a, b) => compareBindingPrecedence(precedenceKeyOf(a), precedenceKeyOf(b)));
  return { ok: true, attempts: [primary, ...fallbacks] };
}

/**
 * **Select the exhaustion cause (AG-6.4).** When the whole chain is exhausted with no success,
 * the request fails with the **first-tried binding's** cause — which is the `primary`'s, since
 * {@link orderFirstSuccessAttempts} always places it first. This preserves the *specific*
 * reason (a chain whose primary is stale reports `mapping-stale`, never a generic
 * `upstream-error`) and is deterministic — the most-preferred binding's cause wins, matching
 * AG-2's "primary's cause wins". `causes` are the per-attempt causes recorded in attempt
 * order; an empty list is unreachable in practice (an exhausted chain always tried the
 * primary), so it degrades to a loud mediator defect rather than a fabricated cause.
 */
export function firstSuccessExhaustionCause(causes: readonly BindingFailure[]): BindingFailure {
  const first = causes[0];
  if (first === undefined) {
    return {
      cause: "mediator-transform-error",
      detail: "fanout-first-success chain exhausted with no recorded cause",
    };
  }
  return first;
}
