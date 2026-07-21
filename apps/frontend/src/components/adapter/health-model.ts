import type {
  AdapterBindingHealthCause,
  AdapterEndpointStateDto,
  AdapterRequestDto,
} from "@mediator/contracts";

/**
 * Pure derivations behind the CU-4 endpoint-health view — kept free of Vue so the
 * consumer-operation state machine, the per-endpoint request summary, and the
 * cause labels are unit-testable without mounting. Everything is read-only
 * metadata (AP-1 / AP-5); no derivation here touches a payload, token, or
 * credential value — the DTOs cannot carry them (CU-4.5).
 */

/**
 * The four states a consumer-app developer experiences differently (CU-4.1 / RT-3):
 * an operation that is **served**, has no approved mapping yet (`not-yet-mapped`),
 * is awaiting a composition decision (`composition-required`), or was operator-
 * `disabled`.
 */
export type OperationHealthState =
  "served" | "not-yet-mapped" | "composition-required" | "disabled";

/**
 * The state of one existing endpoint's consumer operation. A `disabled` endpoint is
 * `disabled`; a `composition-required` one is awaiting a decision; an `active`
 * endpoint with an `active` binding is `served`; an `active` endpoint that has lost
 * its last active binding reads as `not-yet-mapped` (its unmet need), matching AP-1.3.
 */
export function deriveEndpointOperationState(
  endpoint: AdapterEndpointStateDto,
): OperationHealthState {
  if (endpoint.status === "disabled") {
    return "disabled";
  }
  if (endpoint.status === "composition-required") {
    return "composition-required";
  }
  return endpoint.bindings.some((binding) => binding.status === "active")
    ? "served"
    : "not-yet-mapped";
}

/** A per-endpoint roll-up of recent adapter requests (CU-4.3). */
export interface RequestSummary {
  readonly total: number;
  readonly errors: number;
  readonly degraded: number;
  /** Count per `cause`, for the cause breakdown; `null`-cause rows are omitted. */
  readonly byCause: ReadonlyMap<string, number>;
}

/**
 * Summarize a set of `adapter-request` history rows (CU-4.3): total requests,
 * failures, degraded successes, and a cause breakdown. Operator-action rows
 * (`outcome === "other"`) are not served requests, so they do not count as errors.
 */
export function summarizeRequests(rows: readonly AdapterRequestDto[]): RequestSummary {
  const byCause = new Map<string, number>();
  let errors = 0;
  let degraded = 0;
  for (const row of rows) {
    if (row.outcome === "failure") {
      errors += 1;
    }
    if (row.outcome === "degraded" || row.degraded) {
      degraded += 1;
    }
    if (row.cause !== null) {
      byCause.set(row.cause, (byCause.get(row.cause) ?? 0) + 1);
    }
  }
  return { total: rows.length, errors, degraded, byCause };
}

/** Rows for a specific endpoint (CU-4.3 per-endpoint counts). */
export function requestsForEndpoint(
  rows: readonly AdapterRequestDto[],
  endpointId: string,
): readonly AdapterRequestDto[] {
  return rows.filter((row) => row.relatedEndpointId === endpointId);
}

/**
 * The specific cause a binding is eliminated by, phrased for the operator (CU-4.2).
 * `mapping-stale` and `mapping-suspended` are "needs re-review" vs "deliberately
 * held"; `backend-disabled` is the backend app being turned off.
 */
export function bindingCauseLabel(cause: AdapterBindingHealthCause): string {
  switch (cause) {
    case "mapping-stale":
      return "the binding's mapping is stale — it needs re-review before it can serve again";
    case "mapping-suspended":
      return "the binding's mapping is suspended — an operator has deliberately held it";
    case "backend-disabled":
      return "the binding's backend app is disabled";
  }
}

/**
 * The asymmetry the view must state (CU-4.2): a stale adapter binding breaks a
 * **live caller now**, unlike a paused sync rule (an invisible background job) — so
 * it warrants a tighter alerting threshold and immediate attention.
 */
export const ADAPTER_STALENESS_NOTE =
  "Unlike a paused sync rule — an invisible background job — an unhealthy adapter binding breaks a " +
  "live caller right now, so it needs immediate attention.";
