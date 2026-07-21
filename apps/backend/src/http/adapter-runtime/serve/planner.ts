import type {
  AdapterBinding,
  AdapterEndpoint,
  AggregationStrategy,
  ApprovedMappingStatus,
  EndpointStrictness,
  RegisteredAppStatus,
} from "@mediator/domain";
import { resolveExecutionOrder } from "@mediator/domain";

import type {
  EliminatedBinding,
  PlanExecutionGroup,
  PlannedBinding,
  PlannerBindingCause,
  ResolutionPlan,
} from "./pipeline-types.js";

/**
 * The **Resolution Planner** (RP-3 / RP-4): it re-validates each persisted `active`
 * binding's health at request time and produces the explicit {@link ResolutionPlan}
 * the executor consumes. Pure — a function of the endpoint, its bindings, and their
 * loaded mapping/app health states (RP-4.2). It never re-derives bindings from
 * mappings; the caller loads them (`docs/architecture/adapter-engine.md` *Binding:
 * decided at composition time*).
 *
 * This slice serves the `single` (AG-1), `fanout-merge` (AG-2, with TE-3 chained
 * bindings), and `collection-union` (AG-3/4/5) strategies. `fanout-first-success` is out
 * of scope; the planner fails **loudly** on it rather than serving an approximation.
 */

/** The safe defaults an auto-activated single-binding endpoint serves under (AG-1.4). */
const DEFAULT_AGGREGATION_STRATEGY: AggregationStrategy = "single";
const DEFAULT_STRICTNESS: EndpointStrictness = "degraded";

/**
 * The one strategy `dependsOnBindingId` (and therefore chaining) is valid under
 * (`docs/architecture/adapter-engine.md` order/chaining validity rules;
 * requirement TE-3.6). Named so the runtime backstop reads back against the doc.
 */
const CHAINING_STRATEGY: AggregationStrategy = "fanout-merge";

/** One `active` binding plus the health states the planner re-validates (RP-3). */
export interface BindingHealthInput {
  readonly binding: AdapterBinding;
  /** `ApprovedMapping.status` of the binding's mapping (RP-3.3/3.4). */
  readonly mappingStatus: ApprovedMappingStatus;
  /** The backend app's `RegisteredApp.status` (RP-3.5). */
  readonly backendStatus: RegisteredAppStatus;
}

/** What the planner reasons over: the endpoint and its already-loaded `active` bindings. */
export interface PlannerInput {
  readonly endpoint: AdapterEndpoint;
  /** The endpoint's `active` bindings only — `proposed`/`disabled` are filtered upstream (RP-3.2). */
  readonly activeBindings: readonly BindingHealthInput[];
}

/**
 * The planner outcome: an explicit plan, or a **loud** planning defect (RP-4.4) — a
 * state that should be impossible after composition validation (CO-2), so its
 * occurrence is a mediator-side defect signal (`mediator-transform-error`), never a
 * served request.
 */
export type PlanResult =
  | { readonly ok: true; readonly plan: ResolutionPlan }
  | { readonly ok: false; readonly detail: string };

/**
 * Re-validate one binding's health into the planner cause that eliminates it, or
 * `undefined` when it is healthy. A suspended mapping (an operator hold) and a stale
 * mapping (needs re-review) are their own distinct causes (RP-3.3/3.4); a disabled
 * backend app is `backend-disabled` (RP-3.5).
 *
 * `superseded` / `archived` mapping statuses are Phase-6 successor-adoption /
 * deregistration outcomes not produced in this phase; a binding still pointing at
 * one is reported as `mapping-stale` — the closest "this integration is no longer
 * the live truth, re-review needed" cause — rather than served (a judgment call
 * noted for the reviewer). Mapping health is checked before backend health so an
 * invalid mapping is reported as itself even if the backend is also down.
 */
function validateBindingHealth(input: BindingHealthInput): PlannerBindingCause | undefined {
  switch (input.mappingStatus) {
    case "suspended":
      return { cause: "mapping-suspended" };
    case "stale":
    case "superseded":
    case "archived":
      return { cause: "mapping-stale" };
    case "active":
      break;
  }
  if (input.backendStatus === "disabled") {
    return { cause: "backend-disabled", backendAppId: input.binding.backendAppId };
  }
  return undefined;
}

/**
 * The binding's effective execution order via the domain helper. Passing an object
 * that either carries a concrete `executionOrder` or omits it keeps `resolveExecutionOrder`'s
 * `{ executionOrder?: number }` contract exact under `exactOptionalPropertyTypes`.
 */
function orderOf(binding: AdapterBinding): number {
  return resolveExecutionOrder(
    binding.executionOrder !== undefined ? { executionOrder: binding.executionOrder } : {},
  );
}

/** Group participating bindings by `executionOrder`, ascending (RP-4.1: equal order = one group). */
function groupByExecutionOrder(bindings: readonly PlannedBinding[]): readonly PlanExecutionGroup[] {
  const byOrder = new Map<number, PlannedBinding[]>();
  for (const planned of bindings) {
    const group = byOrder.get(planned.executionOrder);
    if (group === undefined) {
      byOrder.set(planned.executionOrder, [planned]);
    } else {
      group.push(planned);
    }
  }
  return [...byOrder.entries()]
    .sort(([a], [b]) => a - b)
    .map(([executionOrder, groupBindings]) => ({ executionOrder, bindings: groupBindings }));
}

/** Build the {@link PlannedBinding} value from a healthy binding, carrying only present chaining state. */
function toPlannedBinding(binding: AdapterBinding): PlannedBinding {
  return {
    bindingId: binding.id,
    binding,
    role: binding.role,
    executionOrder: orderOf(binding),
    ...(binding.dependsOnBindingId !== undefined
      ? { dependsOnBindingId: binding.dependsOnBindingId }
      : {}),
    ...(binding.chainInputs !== undefined ? { chainInputs: binding.chainInputs } : {}),
  };
}

/**
 * Produce the resolution plan for a routed, validated request (RP-3 + RP-4). For a
 * `single` endpoint it re-validates the one active binding; for a `fanout-merge`
 * endpoint it re-validates every active binding, keeping the healthy ones in
 * execution groups and recording the rest as eliminated with their causes (carrying
 * each binding's chaining state through for TE-3). Fails loudly on any state outside
 * this slice's scope, or a chaining defect composition should have prevented — the
 * **TE-3.6 runtime backstop**: `dependsOnBindingId` set under a non-`fanout-merge`
 * strategy fails loud rather than executing an undefined ordering (RP-4.4).
 */
export function planResolution(input: PlannerInput): PlanResult {
  const strategy = input.endpoint.aggregationStrategy ?? DEFAULT_AGGREGATION_STRATEGY;
  const strictness = input.endpoint.strictness ?? DEFAULT_STRICTNESS;

  // TE-3.6 — `dependsOnBindingId` is valid **only** under `fanout-merge`. CO-2 rejects it
  // elsewhere at composition; this is the loud runtime backstop for a plan that somehow
  // still carries it under `single`/`collection-union`/`fanout-first-success`.
  if (strategy !== CHAINING_STRATEGY) {
    const chained = input.activeBindings.find(
      (candidate) => candidate.binding.dependsOnBindingId !== undefined,
    );
    if (chained !== undefined) {
      return {
        ok: false,
        detail: `dependsOnBindingId is set on binding ${chained.binding.id} under '${strategy}' (chaining is ${CHAINING_STRATEGY} only)`,
      };
    }
  }

  switch (strategy) {
    case "single":
      return planSingle(input, strictness);
    case "fanout-merge":
      return planParallelContributors(input, "fanout-merge", strictness);
    case "collection-union":
      return planParallelContributors(input, "collection-union", strictness);
    default:
      return {
        ok: false,
        detail: `aggregation strategy '${strategy}' is not implemented`,
      };
  }
}

/** Re-validate the one binding of a `single` endpoint into its plan (AG-1 / RP-4). */
function planSingle(input: PlannerInput, strictness: EndpointStrictness): PlanResult {
  if (input.activeBindings.length !== 1) {
    // resolveRequest only hands over `serve` with ≥1 active binding; a `single`
    // endpoint with more than one is a composition defect (CO-2 forbids it).
    return {
      ok: false,
      detail: `single endpoint has ${String(input.activeBindings.length)} active bindings (expected exactly one)`,
    };
  }
  const only = input.activeBindings[0];
  if (only === undefined) {
    return { ok: false, detail: "single endpoint has no active binding after filtering" };
  }

  const cause = validateBindingHealth(only);
  const groups: readonly PlanExecutionGroup[] =
    cause === undefined ? groupByExecutionOrder([toPlannedBinding(only.binding)]) : [];
  const eliminated: readonly EliminatedBinding[] =
    cause === undefined ? [] : [toEliminatedBinding(only.binding, cause)];

  return { ok: true, plan: plan(input, "single", strictness, groups, eliminated) };
}

/**
 * Re-validate every binding of a **parallel** endpoint — `fanout-merge` (AG-2) or
 * `collection-union` (AG-3) — into its plan (RP-4). Healthy bindings become execution
 * groups by `executionOrder` (carrying their `dependsOnBindingId` / `chainInputs` for TE-3
 * under `fanout-merge`; a union never chains, guarded by the TE-3.6 backstop above); unhealthy
 * ones are eliminated with their planner cause. The planner does **not** enforce the role
 * table — that is the aggregator's execution-time defense-in-depth (AG-2.1 exactly-one-primary,
 * AG-3.1 all-supplement), evaluated over the full result set (an eliminated binding still
 * surfaces its role to that check as a not-called envelope).
 */
function planParallelContributors(
  input: PlannerInput,
  strategy: "fanout-merge" | "collection-union",
  strictness: EndpointStrictness,
): PlanResult {
  const planned: PlannedBinding[] = [];
  const eliminated: EliminatedBinding[] = [];
  for (const active of input.activeBindings) {
    const cause = validateBindingHealth(active);
    if (cause === undefined) {
      planned.push(toPlannedBinding(active.binding));
    } else {
      eliminated.push(toEliminatedBinding(active.binding, cause));
    }
  }
  return {
    ok: true,
    plan: plan(input, strategy, strictness, groupByExecutionOrder(planned), eliminated),
  };
}

/** Assemble the {@link ResolutionPlan} value (a pure projection of the resolved parts). */
function plan(
  input: PlannerInput,
  aggregationStrategy: AggregationStrategy,
  strictness: EndpointStrictness,
  groups: readonly PlanExecutionGroup[],
  eliminated: readonly EliminatedBinding[],
): ResolutionPlan {
  return { endpointId: input.endpoint.id, aggregationStrategy, strictness, groups, eliminated };
}

/** The eliminated-binding envelope for a binding the planner dropped (RP-4.3). */
function toEliminatedBinding(
  binding: AdapterBinding,
  cause: PlannerBindingCause,
): EliminatedBinding {
  return { bindingId: binding.id, role: binding.role, executionOrder: orderOf(binding), cause };
}
