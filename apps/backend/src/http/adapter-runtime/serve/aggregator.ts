import type { JsonValue } from "@mediator/transform";

import {
  plannerCauseToFailure,
  type BindingFailure,
  type BindingResult,
  type ResolutionPlan,
} from "./pipeline-types.js";

/**
 * The **Response Aggregator** — this slice implements `single` only (AG-1): one
 * binding, no aggregation. A pure function of (plan + envelopes), so it is testable
 * over hand-built envelopes with no backend (TE-5.2). It applies **no** field
 * transforms of its own — the envelope payload is already consumer-shape (TE-5.4).
 */

/** The aggregation outcome, before the final consumer-schema validation (AG-7). */
export type AggregateOutcome =
  | {
      readonly kind: "success";
      /** The consumer-shape response body (AG-1.1: the envelope's payload, unmodified). */
      readonly payload: JsonValue;
      readonly contributingBackendAppIds: readonly string[];
      /** `single` never degrades — a lone binding either succeeds or fails the request. */
      readonly degraded: boolean;
    }
  | { readonly kind: "failure"; readonly failure: BindingFailure };

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
      };
    case "failure":
      return { kind: "failure", failure: result.failure };
    case "not-called":
      return { kind: "failure", failure: plannerCauseToFailure(result.cause) };
  }
}
