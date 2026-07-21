import type { EndpointStrictness } from "@mediator/domain";
import type { JsonValue } from "@mediator/transform";
import { describe, expect, it } from "vitest";

import { aggregateFanoutMerge, aggregateSingle, type FanoutMergeContext } from "./aggregator.js";
import type { BindingFailure, BindingResult, ResolutionPlan } from "./pipeline-types.js";

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
      degradedBackendAppIds: [],
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

describe("aggregateFanoutMerge — AG-2", () => {
  function fanoutPlan(strictness: EndpointStrictness = "degraded"): ResolutionPlan {
    return {
      endpointId: "e1",
      aggregationStrategy: "fanout-merge",
      strictness,
      groups: [],
      eliminated: [],
    };
  }

  function success(
    bindingId: string,
    executionOrder: number,
    backendAppId: string,
    payload: JsonValue,
    role: "primary" | "supplement" = "supplement",
  ): BindingResult {
    return { kind: "success", bindingId, role, executionOrder, backendAppId, payload };
  }
  function failure(
    bindingId: string,
    executionOrder: number,
    fail: BindingFailure,
    role: "primary" | "supplement" = "supplement",
  ): BindingResult {
    return { kind: "failure", bindingId, role, executionOrder, failure: fail };
  }

  /** Build the request-time composed decision the aggregator consumes (CO-4.4). */
  function ctx(
    info: Record<string, { backendAppId: string; supplies: readonly string[] }>,
    required: readonly string[] = [],
  ): FanoutMergeContext {
    const bindingInfo = new Map(
      Object.entries(info).map(([id, entry]) => [
        id,
        {
          backendAppId: entry.backendAppId,
          suppliedConsumerResponseFields: new Set(entry.supplies),
        },
      ]),
    );
    return { bindingInfo, requiredConsumerResponseFieldNames: new Set(required) };
  }

  const upstreamErr: BindingFailure = {
    cause: "upstream-error",
    backendAppId: "billing",
    detail: "HTTP 503",
  };

  it("AG-2.1/2.6: assembles the primary base object plus supplement fields", () => {
    const outcome = aggregateFanoutMerge(
      fanoutPlan(),
      [
        success("p", 0, "crm", { id: "1", name: "Ada" }, "primary"),
        success("s", 1, "billing", { plan: "pro" }),
      ],
      ctx({
        p: { backendAppId: "crm", supplies: ["id", "name"] },
        s: { backendAppId: "billing", supplies: ["plan"] },
      }),
    );
    expect(outcome).toEqual({
      kind: "success",
      payload: { id: "1", name: "Ada", plan: "pro" },
      contributingBackendAppIds: ["crm", "billing"],
      degraded: false,
      degradedBackendAppIds: [],
    });
  });

  it("AG-2.2: a failed primary fails the whole request with that cause", () => {
    const outcome = aggregateFanoutMerge(
      fanoutPlan(),
      [
        failure(
          "p",
          0,
          { cause: "upstream-error", backendAppId: "crm", detail: "boom" },
          "primary",
        ),
        success("s", 1, "billing", { plan: "pro" }),
      ],
      ctx({
        p: { backendAppId: "crm", supplies: ["id"] },
        s: { backendAppId: "billing", supplies: ["plan"] },
      }),
    );
    expect(outcome).toEqual({
      kind: "failure",
      failure: { cause: "upstream-error", backendAppId: "crm", detail: "boom" },
    });
  });

  it("AG-2.2: a not-called (planner cause) primary fails the whole request with that cause", () => {
    const notCalledPrimary: BindingResult = {
      kind: "not-called",
      bindingId: "p",
      role: "primary",
      executionOrder: 0,
      cause: { cause: "mapping-stale" },
    };
    const outcome = aggregateFanoutMerge(
      fanoutPlan(),
      [notCalledPrimary, success("s", 1, "billing", { plan: "pro" })],
      ctx({
        p: { backendAppId: "crm", supplies: ["id"] },
        s: { backendAppId: "billing", supplies: ["plan"] },
      }),
    );
    expect(outcome).toEqual({ kind: "failure", failure: { cause: "mapping-stale" } });
  });

  it("AG-2.3: a failed non-load-bearing supplement degrades — fields omitted, backend named, still valid", () => {
    const outcome = aggregateFanoutMerge(
      fanoutPlan("degraded"),
      [success("p", 0, "crm", { id: "1", name: "Ada" }, "primary"), failure("s", 1, upstreamErr)],
      // `plan` is supplied only by the failed supplement and is NOT required → all-optional.
      ctx(
        {
          p: { backendAppId: "crm", supplies: ["id", "name"] },
          s: { backendAppId: "billing", supplies: ["plan"] },
        },
        ["id", "name"],
      ),
    );
    expect(outcome).toEqual({
      kind: "success",
      payload: { id: "1", name: "Ada" },
      contributingBackendAppIds: ["crm"],
      degraded: true,
      degradedBackendAppIds: ["billing"],
    });
  });

  it("AG-2.4: a failed supplement supplying a REQUIRED field fails the whole request (even non-strict)", () => {
    const outcome = aggregateFanoutMerge(
      fanoutPlan("degraded"),
      [success("p", 0, "crm", { id: "1", name: "Ada" }, "primary"), failure("s", 1, upstreamErr)],
      // `plan` is required → the supplement is load-bearing, so its failure is fatal.
      ctx(
        {
          p: { backendAppId: "crm", supplies: ["id", "name"] },
          s: { backendAppId: "billing", supplies: ["plan"] },
        },
        ["id", "plan"],
      ),
    );
    expect(outcome).toEqual({ kind: "failure", failure: upstreamErr });
  });

  it("AG-2.5: strict mode fails the whole request on any supplement failure regardless of role", () => {
    const outcome = aggregateFanoutMerge(
      fanoutPlan("strict"),
      [success("p", 0, "crm", { id: "1", name: "Ada" }, "primary"), failure("s", 1, upstreamErr)],
      // Even though `plan` is optional (non-load-bearing), strict mode fails the request.
      ctx(
        {
          p: { backendAppId: "crm", supplies: ["id", "name"] },
          s: { backendAppId: "billing", supplies: ["plan"] },
        },
        ["id", "name"],
      ),
    );
    expect(outcome).toEqual({ kind: "failure", failure: upstreamErr });
  });

  it("AG-2.6: a same-field conflict resolves by executionOrder, then by binding id", () => {
    // Three writers of `label`: order 0 wins over order 1; the order-1 tie breaks by id (s1<s2).
    const byOrder = aggregateFanoutMerge(
      fanoutPlan(),
      [
        success("p", 0, "crm", { label: "from-primary" }, "primary"),
        success("s1", 1, "b1", { label: "from-s1" }),
        success("s2", 1, "b2", { label: "from-s2" }),
      ],
      ctx({
        p: { backendAppId: "crm", supplies: ["label"] },
        s1: { backendAppId: "b1", supplies: ["label"] },
        s2: { backendAppId: "b2", supplies: ["label"] },
      }),
    );
    expect(byOrder.kind === "success" && byOrder.payload).toEqual({ label: "from-primary" });

    // With the primary at a HIGHER order, the lowest-order supplement wins; an order tie
    // between s1/s2 breaks deterministically to the lower binding id (s1).
    const tie = aggregateFanoutMerge(
      fanoutPlan(),
      [
        success("p", 9, "crm", { label: "from-primary" }, "primary"),
        success("s2", 1, "b2", { label: "from-s2" }),
        success("s1", 1, "b1", { label: "from-s1" }),
      ],
      ctx({
        p: { backendAppId: "crm", supplies: ["label"] },
        s1: { backendAppId: "b1", supplies: ["label"] },
        s2: { backendAppId: "b2", supplies: ["label"] },
      }),
    );
    expect(tie.kind === "success" && tie.payload).toEqual({ label: "from-s1" });
  });

  it("AG-2.1: fails loud unless there is exactly one primary at execution", () => {
    const zero = aggregateFanoutMerge(
      fanoutPlan(),
      [success("s", 0, "billing", { plan: "pro" })],
      ctx({ s: { backendAppId: "billing", supplies: ["plan"] } }),
    );
    expect(zero.kind === "failure" && zero.failure.cause).toBe("mediator-transform-error");

    const two = aggregateFanoutMerge(
      fanoutPlan(),
      [
        success("p1", 0, "crm", { id: "1" }, "primary"),
        success("p2", 1, "crm2", { id: "2" }, "primary"),
      ],
      ctx({
        p1: { backendAppId: "crm", supplies: ["id"] },
        p2: { backendAppId: "crm2", supplies: ["id"] },
      }),
    );
    expect(two.kind === "failure" && two.failure.cause).toBe("mediator-transform-error");
  });

  it("fails loud on a non-fanout-merge plan", () => {
    const outcome = aggregateFanoutMerge(
      { ...fanoutPlan(), aggregationStrategy: "single" },
      [],
      ctx({}),
    );
    expect(outcome.kind === "failure" && outcome.failure.cause).toBe("mediator-transform-error");
  });
});
