import { describe, expect, it } from "vitest";

import { aggregateSingle } from "./aggregator.js";
import type { BindingResult, ResolutionPlan } from "./pipeline-types.js";

function singlePlan(): ResolutionPlan {
  return {
    endpointId: "endpoint-1",
    aggregationStrategy: "single",
    strictness: "degraded",
    groups: [],
    eliminated: [],
  };
}

describe("aggregateSingle — AG-1", () => {
  it("AG-1.1: a succeeded binding's payload is the response, naming the backend", () => {
    const result: BindingResult = {
      kind: "success",
      bindingId: "b1",
      role: "primary",
      executionOrder: 0,
      backendAppId: "backend-app",
      payload: { id: "1", title: "hello" },
    };
    const outcome = aggregateSingle(singlePlan(), [result]);
    expect(outcome).toEqual({
      kind: "success",
      payload: { id: "1", title: "hello" },
      contributingBackendAppIds: ["backend-app"],
      degraded: false,
    });
  });

  it("AG-1.2: a failed binding fails the request with that cause (no fallback)", () => {
    const result: BindingResult = {
      kind: "failure",
      bindingId: "b1",
      role: "primary",
      executionOrder: 0,
      failure: { cause: "upstream-error", backendAppId: "backend-app", detail: "HTTP 500" },
    };
    const outcome = aggregateSingle(singlePlan(), [result]);
    expect(outcome).toEqual({
      kind: "failure",
      failure: { cause: "upstream-error", backendAppId: "backend-app", detail: "HTTP 500" },
    });
  });

  it("surfaces a planner-eliminated (not-called) binding's cause", () => {
    const result: BindingResult = {
      kind: "not-called",
      bindingId: "b1",
      role: "primary",
      executionOrder: 0,
      cause: { cause: "mapping-stale" },
    };
    const outcome = aggregateSingle(singlePlan(), [result]);
    expect(outcome).toEqual({ kind: "failure", failure: { cause: "mapping-stale" } });
  });

  it("fails loud on a non-single plan", () => {
    const outcome = aggregateSingle(
      { ...singlePlan(), aggregationStrategy: "collection-union" },
      [],
    );
    expect(outcome.kind).toBe("failure");
    if (outcome.kind !== "failure") return;
    expect(outcome.failure.cause).toBe("mediator-transform-error");
  });

  it("fails loud when the envelope count is not exactly one", () => {
    const outcome = aggregateSingle(singlePlan(), []);
    expect(outcome.kind).toBe("failure");
    if (outcome.kind !== "failure") return;
    expect(outcome.failure.cause).toBe("mediator-transform-error");
  });
});
