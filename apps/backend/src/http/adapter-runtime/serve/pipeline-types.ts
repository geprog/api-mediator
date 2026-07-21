import type {
  AdapterBinding,
  AdapterBindingRole,
  AdapterRequestCause,
  AggregationStrategy,
  ChainInput,
  EndpointStrictness,
} from "@mediator/domain";
import type { JsonValue } from "@mediator/transform";

/**
 * The shared, **protocol-agnostic** value types the adapter serve pipeline
 * (RP/TE/AG) hands between its pure stages: the per-binding failure taxonomy, the
 * planner → executor contract (the {@link ResolutionPlan}, RP-4), and the executor
 * → aggregator contract (the {@link BindingResult} envelope, TE-5).
 *
 * They live in `apps/backend` (not `@mediator/adapter-engine`) with the rest of the
 * serve logic that touches REST, behind the neutral `ServeHandler` seam — but they
 * themselves carry no HTTP: every stage that consumes them is a pure function of
 * these values, unit-testable without a backend.
 */

/**
 * Why one binding could not contribute a valid result — a discriminated union so a
 * live-backend failure (`upstream-error`, naming which backend) is never confused
 * with a mediator-side defect (`mediator-transform-error`) or a planner-detected
 * health failure (`mapping-stale` / `mapping-suspended` / `backend-disabled`). Each
 * variant's `cause` is exactly the machine-readable {@link AdapterRequestCause}
 * token the caller receives (RP-5.1), so the taxonomy is closed and distinguishable.
 */
export type BindingFailure =
  | { readonly cause: "mapping-stale" }
  | { readonly cause: "mapping-suspended" }
  | { readonly cause: "backend-disabled"; readonly backendAppId: string }
  | { readonly cause: "mediator-transform-error"; readonly detail: string }
  | { readonly cause: "upstream-error"; readonly backendAppId: string; readonly detail: string };

/** The stable cause token of a {@link BindingFailure} (RP-5.1: the token is the contract). */
export function bindingFailureCause(failure: BindingFailure): AdapterRequestCause {
  return failure.cause;
}

/**
 * The subset of causes the Resolution Planner assigns **without executing** a
 * binding — a stale/suspended mapping or a disabled backend eliminates the binding
 * at planning time (RP-3), never as a live call failure.
 */
export type PlannerBindingCause =
  | { readonly cause: "mapping-stale" }
  | { readonly cause: "mapping-suspended" }
  | { readonly cause: "backend-disabled"; readonly backendAppId: string };

/** A planner cause is, verbatim, a {@link BindingFailure} — no re-derivation needed. */
export function plannerCauseToFailure(cause: PlannerBindingCause): BindingFailure {
  return cause;
}

/** The failure a binding result carries — a live `failure`'s cause, or a `not-called`'s planner cause. */
export function resultFailureCause(
  result: Extract<BindingResult, { kind: "failure" | "not-called" }>,
): BindingFailure {
  return result.kind === "failure" ? result.failure : plannerCauseToFailure(result.cause);
}

/**
 * **The deterministic field-conflict precedence key** — `docs/architecture/adapter-engine.md`
 * *Aggregation strategies*: "field conflicts resolved by `executionOrder` precedence, an
 * order tie broken deterministically by binding id". The **single** definition of that
 * rule, so `fanout-merge` (AG-2.6) and `collection-union` (AG-3, when built) resolve
 * conflicts identically rather than each inventing an order.
 */
export interface BindingPrecedenceKey {
  readonly executionOrder: number;
  readonly bindingId: string;
}

/**
 * Compare two bindings by precedence: **lower `executionOrder` wins**, an order tie broken
 * by **lower binding id** — the same "first in this order is preferred" reading as
 * `fanout-first-success`'s ordered fallback. A negative result means `a` has the higher
 * precedence (it wins a field conflict against `b`). Total and deterministic, so the same
 * inputs always merge to the same object (the property AG-4.5/TE-5.5 depend on).
 */
export function compareBindingPrecedence(a: BindingPrecedenceKey, b: BindingPrecedenceKey): number {
  if (a.executionOrder !== b.executionOrder) {
    return a.executionOrder - b.executionOrder;
  }
  if (a.bindingId < b.bindingId) {
    return -1;
  }
  return a.bindingId > b.bindingId ? 1 : 0;
}

/**
 * One binding the planner kept, in protocol-neutral terms: its id, `role`, resolved
 * `executionOrder`, and any chaining state (RP-4.1). The concrete {@link AdapterBinding}
 * is carried so the executor runs **exactly** the plan without re-loading (RP-4.5).
 */
export interface PlannedBinding {
  readonly bindingId: string;
  readonly binding: AdapterBinding;
  readonly role: AdapterBindingRole;
  readonly executionOrder: number;
  readonly dependsOnBindingId?: string;
  readonly chainInputs?: readonly ChainInput[];
}

/** One execution group: bindings sharing an `executionOrder` (a parallel group, RP-4.1). */
export interface PlanExecutionGroup {
  readonly executionOrder: number;
  readonly bindings: readonly PlannedBinding[];
}

/** A binding the planner eliminated (RP-3), with the specific cause the aggregator reports (RP-4.3). */
export interface EliminatedBinding {
  readonly bindingId: string;
  readonly role: AdapterBindingRole;
  readonly executionOrder: number;
  readonly cause: PlannerBindingCause;
}

/**
 * **The planner → executor contract (RP-4).** An explicit, inspectable value naming
 * the strategy, strictness, the participating bindings in execution groups, and the
 * bindings eliminated at planning with their causes. A pure function of the endpoint,
 * its bindings, and their mapping/app health states — no I/O — so it is testable in
 * isolation and the executor derives no bindings of its own (RP-4.2/4.5).
 */
export interface ResolutionPlan {
  readonly endpointId: string;
  readonly aggregationStrategy: AggregationStrategy;
  readonly strictness: EndpointStrictness;
  readonly groups: readonly PlanExecutionGroup[];
  readonly eliminated: readonly EliminatedBinding[];
}

/**
 * **The executor → aggregator contract (TE-5).** One uniform envelope per binding of
 * the plan: a success carrying the **consumer-shape** payload (and, for a collection,
 * per-row backend-native-id provenance out of band), a live failure with its cause,
 * or a `not-called` binding the planner eliminated with its planner cause (TE-5.3).
 * The aggregator is a pure function of (plan + envelopes) — it applies no transforms
 * of its own (TE-5.4).
 */
export type BindingResult =
  | {
      readonly kind: "success";
      readonly bindingId: string;
      readonly role: AdapterBindingRole;
      readonly executionOrder: number;
      readonly backendAppId: string;
      /** The response already in consumer shape (TE-4 ran on the executor's side). */
      readonly payload: JsonValue;
      /**
       * TE-4.3/4.4 — per-row backend-native id for a collection payload, carried
       * **out of band** (never injected into the consumer-schema-valid body). `undefined`
       * per row where the resource's `nativeIdRef` is not confirmed (TE-4.5). Absent
       * entirely for a single-object payload (dedup is a union concern, AG-3).
       */
      readonly rowProvenance?: readonly (string | undefined)[];
    }
  | {
      readonly kind: "failure";
      readonly bindingId: string;
      readonly role: AdapterBindingRole;
      readonly executionOrder: number;
      readonly failure: BindingFailure;
    }
  | {
      readonly kind: "not-called";
      readonly bindingId: string;
      readonly role: AdapterBindingRole;
      readonly executionOrder: number;
      readonly cause: PlannerBindingCause;
    };
