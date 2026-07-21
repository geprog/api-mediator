import type { JsonRecord, JsonValue } from "@mediator/transform";

import {
  compareBindingPrecedence,
  plannerCauseToFailure,
  resultFailureCause,
  type BindingFailure,
  type BindingResult,
  type ResolutionPlan,
} from "./pipeline-types.js";

/**
 * The **Response Aggregator** — this slice implements `single` (AG-1: one binding, no
 * aggregation) and `fanout-merge` (AG-2: a `primary` base object plus `supplement`
 * fields, with the load-bearing/degradation rules). A pure function of (plan +
 * envelopes + the request-time composed decision), so every strategy, role rule,
 * degradation rule, and tiebreak is testable over hand-built envelopes with no backend
 * (TE-5.2). It applies **no** field transforms of its own — each envelope payload is
 * already consumer-shape (TE-5.4).
 */

/** The aggregation outcome, before the final consumer-schema validation (AG-7). */
export type AggregateOutcome =
  | {
      readonly kind: "success";
      /** The consumer-shape response body (AG-1.1 / AG-2.6: the merged/unmodified payload). */
      readonly payload: JsonValue;
      readonly contributingBackendAppIds: readonly string[];
      /** True when a failed non-load-bearing `supplement`'s optional fields were omitted (AG-2.3). */
      readonly degraded: boolean;
      /**
       * The failed backend app id(s) whose optional fields a degraded response omitted —
       * the out-of-band signal AG-2.3 names. Empty when not degraded (`single` never
       * degrades, so always empty there).
       */
      readonly degradedBackendAppIds: readonly string[];
    }
  | { readonly kind: "failure"; readonly failure: BindingFailure };

/**
 * The **composed decision AG-2 consumes** (AG-2 out-of-scope note; CO-4.4), derived at
 * request time — never a composition-time snapshot. For each binding: the backend app it
 * calls (to name a failed one out of band) and the **top-level consumer response field
 * names it supplies** (its response-phase `FieldMapping` targets, pair-scoped). Plus the
 * consumer operation's **required** response field names, re-read live from the schema at
 * request time so required-ness is never trusted from a stale snapshot (CO-4.4).
 */
export interface FanoutMergeBindingInfo {
  readonly backendAppId: string;
  readonly suppliedConsumerResponseFields: ReadonlySet<string>;
}
export interface FanoutMergeContext {
  readonly bindingInfo: ReadonlyMap<string, FanoutMergeBindingInfo>;
  readonly requiredConsumerResponseFieldNames: ReadonlySet<string>;
}

/**
 * Aggregate a `single` endpoint's results (AG-1). The plan carries exactly one
 * binding — participating or eliminated — so `results` carries exactly one envelope.
 * A succeeded binding's payload **is** the response (AG-1.1); a failed or eliminated
 * binding fails the whole request with its cause, with no fallback (AG-1.2).
 */
export function aggregateSingle(
  plan: ResolutionPlan,
  results: readonly BindingResult[],
): AggregateOutcome {
  if (plan.aggregationStrategy !== "single") {
    return {
      kind: "failure",
      failure: {
        cause: "mediator-transform-error",
        detail: `aggregateSingle received a '${plan.aggregationStrategy}' plan`,
      },
    };
  }
  if (results.length !== 1) {
    // The plan is single, so exactly one envelope is expected; anything else is an
    // internal inconsistency, surfaced loudly rather than served as data.
    return {
      kind: "failure",
      failure: {
        cause: "mediator-transform-error",
        detail: `single aggregation expected exactly one binding result, got ${String(results.length)}`,
      },
    };
  }

  const result = results[0];
  if (result === undefined) {
    return {
      kind: "failure",
      failure: { cause: "mediator-transform-error", detail: "single aggregation has no result" },
    };
  }

  switch (result.kind) {
    case "success":
      return {
        kind: "success",
        payload: result.payload,
        contributingBackendAppIds: [result.backendAppId],
        degraded: false,
        degradedBackendAppIds: [],
      };
    case "failure":
      return { kind: "failure", failure: result.failure };
    case "not-called":
      return { kind: "failure", failure: plannerCauseToFailure(result.cause) };
  }
}

/** A mediator-side defect outcome — a plan/envelope inconsistency surfaced loudly, never as data. */
function aggregateDefect(detail: string): AggregateOutcome {
  return { kind: "failure", failure: { cause: "mediator-transform-error", detail } };
}

function isJsonRecord(value: JsonValue): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * **Aggregate a `fanout-merge` endpoint's results (AG-2).** The `primary` supplies the
 * base object and `supplement`s contribute additional fields; `fallback` never
 * participates (CO-2 enforces the role table). The decision flow, fail-loud throughout:
 *
 * 1. **Re-validate exactly one `primary`** at execution (AG-2.1 defense-in-depth) — CO-2
 *    guarantees it, but the runtime never *assumes* it.
 * 2. **Primary failed** (call failure or planner cause) → the whole request fails with
 *    that cause (AG-2.2).
 * 3. **Strict mode** → any binding failure fails the whole request regardless of role
 *    (AG-2.5).
 * 4. A **failed `supplement`** is **load-bearing** iff it supplies ≥1 consumer response
 *    field that is **required** — required-ness re-derived live from the consumer schema
 *    (CO-4.4). A load-bearing failure fails the whole request exactly as strict (AG-2.4);
 *    a non-load-bearing one degrades: its fields are simply not merged, the response still
 *    validates (AG-7), and the failed backend is named out of band (AG-2.3), never in the
 *    body.
 * 5. **Merge** the base plus every successful supplement by the deterministic precedence
 *    rule (AG-2.6: `executionOrder`, then binding id).
 *
 * Pure: it reasons only over (plan + envelopes + the request-time {@link FanoutMergeContext}),
 * applying no field transforms of its own (each payload is already consumer-shape, TE-5.4).
 */
export function aggregateFanoutMerge(
  plan: ResolutionPlan,
  results: readonly BindingResult[],
  context: FanoutMergeContext,
): AggregateOutcome {
  if (plan.aggregationStrategy !== "fanout-merge") {
    return aggregateDefect(`aggregateFanoutMerge received a '${plan.aggregationStrategy}' plan`);
  }

  // Only `primary`/`supplement` are valid here (the role table, CO-2). A stray role is a
  // composition defect surfaced loudly rather than merged into a plausible-but-wrong object.
  const stray = results.find((result) => result.role !== "primary" && result.role !== "supplement");
  if (stray !== undefined) {
    return aggregateDefect(`fanout-merge binding ${stray.bindingId} has role '${stray.role}'`);
  }

  // AG-2.1 — exactly one `primary`, re-validated at execution (not assumed from CO-2).
  const primaries = results.filter((result) => result.role === "primary");
  const primary = primaries[0];
  if (primaries.length !== 1 || primary === undefined) {
    return aggregateDefect(
      `fanout-merge requires exactly one primary at execution, got ${String(primaries.length)}`,
    );
  }

  // AG-2.2 — the primary supplies the base object; its failure (call or planner cause)
  // fails the whole request with that cause.
  if (primary.kind !== "success") {
    return { kind: "failure", failure: resultFailureCause(primary) };
  }
  if (!isJsonRecord(primary.payload)) {
    return aggregateDefect(
      `fanout-merge primary binding ${primary.bindingId} is not an object body`,
    );
  }

  const supplements = results.filter((result) => result.role === "supplement");
  const failedSupplements = supplements
    .filter((result): result is Extract<BindingResult, { kind: "failure" | "not-called" }> => {
      return result.kind !== "success";
    })
    .sort(compareBindingPrecedence);

  // AG-2.5 — in strict mode, ANY binding failure fails the whole request regardless of role.
  if (plan.strictness === "strict") {
    const firstFailed = failedSupplements[0];
    if (firstFailed !== undefined) {
      return { kind: "failure", failure: resultFailureCause(firstFailed) };
    }
  }

  // AG-2.4 — a failed supplement supplying ANY required consumer field is load-bearing:
  // there is no valid degraded response, so the whole request fails exactly as strict.
  // Required-ness is re-derived live from the consumer schema (CO-4.4), never snapshotted.
  for (const failed of failedSupplements) {
    if (isLoadBearing(failed.bindingId, context)) {
      return { kind: "failure", failure: resultFailureCause(failed) };
    }
  }

  // AG-2.6 — merge the base plus each successful supplement's fields by the shared
  // precedence rule. A failed non-load-bearing supplement contributes nothing; its
  // (all-optional) fields are simply omitted — the degradation, signalled out of band.
  const successfulSupplements = supplements.filter(
    (result): result is Extract<BindingResult, { kind: "success" }> => result.kind === "success",
  );
  const merged = mergeByPrecedence([primary, ...successfulSupplements]);

  const degradedBackendAppIds = failedSupplements.map((failed) =>
    backendAppIdOf(failed.bindingId, context),
  );
  const contributingBackendAppIds = [primary, ...successfulSupplements].map(
    (result) => result.backendAppId,
  );

  return {
    kind: "success",
    payload: merged,
    contributingBackendAppIds,
    degraded: degradedBackendAppIds.length > 0,
    degradedBackendAppIds,
  };
}

/** Whether the failed supplement supplies ≥1 field that is required in the consumer schema (CO-4.4). */
function isLoadBearing(bindingId: string, context: FanoutMergeContext): boolean {
  const supplied = context.bindingInfo.get(bindingId)?.suppliedConsumerResponseFields;
  if (supplied === undefined) {
    return false;
  }
  for (const field of supplied) {
    if (context.requiredConsumerResponseFieldNames.has(field)) {
      return true;
    }
  }
  return false;
}

/** The backend app id a binding calls, for naming a failed backend out of band (AG-2.3). */
function backendAppIdOf(bindingId: string, context: FanoutMergeContext): string {
  return context.bindingInfo.get(bindingId)?.backendAppId ?? bindingId;
}

/**
 * Merge successful contributors' consumer-shape objects into one, resolving field
 * conflicts by the deterministic precedence rule (AG-2.6): sort highest-precedence first,
 * then let the first writer of each field win — a lower-precedence contributor never
 * overwrites a field an earlier one set. The same rule `collection-union` (AG-3) reuses.
 */
function mergeByPrecedence(
  contributors: readonly Extract<BindingResult, { kind: "success" }>[],
): JsonRecord {
  const ordered = [...contributors].sort(compareBindingPrecedence);
  const merged: JsonRecord = {};
  const written = new Set<string>();
  for (const contributor of ordered) {
    if (!isJsonRecord(contributor.payload)) {
      // A supplement that is not an object supplies no mergeable fields — skipped, never
      // spread lossily. (The primary being a non-object is a defect handled above.)
      continue;
    }
    for (const [key, value] of Object.entries(contributor.payload)) {
      if (!written.has(key)) {
        merged[key] = value;
        written.add(key);
      }
    }
  }
  return merged;
}
