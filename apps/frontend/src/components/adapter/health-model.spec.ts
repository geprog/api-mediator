import type { AdapterEndpointStateDto, AdapterRequestDto } from "@mediator/contracts";
import { describe, expect, it } from "vitest";

import {
  bindingCauseLabel,
  deriveEndpointOperationState,
  requestsForEndpoint,
  summarizeRequests,
} from "./health-model";

function endpoint(overrides: Partial<AdapterEndpointStateDto> = {}): AdapterEndpointStateDto {
  return {
    id: "ep-1",
    consumerAppId: "app-1",
    consumerOperationId: "getThings",
    status: "active",
    aggregationStrategy: "single",
    strictness: "degraded",
    cacheTtl: null,
    union: null,
    bindings: [
      {
        id: "b-1",
        backendAppId: "backend-1",
        backendOperationId: "listThings",
        role: "primary",
        status: "active",
        health: { ok: true },
      },
    ],
    compositionRequired: null,
    ...overrides,
  };
}

function request(overrides: Partial<AdapterRequestDto> = {}): AdapterRequestDto {
  return {
    id: "r-1",
    outcome: "success",
    status: "success",
    cause: null,
    degraded: false,
    relatedEndpointId: "ep-1",
    relatedBindingId: null,
    actor: "adapter",
    details: null,
    traceId: "t-1",
    spanId: "s-1",
    timestamp: "2026-07-21T00:00:00.000Z",
    ...overrides,
  };
}

describe("health-model — consumer-operation state (CU-4.1)", () => {
  it("served: active endpoint with an active binding", () => {
    expect(deriveEndpointOperationState(endpoint())).toBe("served");
  });

  it("composition-required", () => {
    expect(deriveEndpointOperationState(endpoint({ status: "composition-required" }))).toBe(
      "composition-required",
    );
  });

  it("disabled", () => {
    expect(deriveEndpointOperationState(endpoint({ status: "disabled" }))).toBe("disabled");
  });

  it("not-yet-mapped: active endpoint whose last active binding is gone", () => {
    expect(
      deriveEndpointOperationState(
        endpoint({
          status: "active",
          bindings: [
            {
              id: "b-1",
              backendAppId: "backend-1",
              backendOperationId: "listThings",
              role: "primary",
              status: "proposed",
              health: { ok: true },
            },
          ],
        }),
      ),
    ).toBe("not-yet-mapped");
  });
});

describe("health-model — request summary (CU-4.3)", () => {
  it("counts totals, errors, degraded, and cause breakdown", () => {
    const summary = summarizeRequests([
      request(),
      request({ id: "r-2", outcome: "failure", status: "failure", cause: "upstream-error" }),
      request({ id: "r-3", outcome: "degraded", degraded: true, cause: "backend-disabled" }),
    ]);
    expect(summary.total).toBe(3);
    expect(summary.errors).toBe(1);
    expect(summary.degraded).toBe(1);
    expect(summary.byCause.get("upstream-error")).toBe(1);
    expect(summary.byCause.get("backend-disabled")).toBe(1);
  });

  it("filters rows by endpoint", () => {
    const rows = [request(), request({ id: "r-2", relatedEndpointId: "ep-2" })];
    expect(requestsForEndpoint(rows, "ep-1")).toHaveLength(1);
  });
});

describe("health-model — binding cause labels (CU-4.2)", () => {
  it("names each cause distinctly", () => {
    expect(bindingCauseLabel("mapping-stale")).toContain("stale");
    expect(bindingCauseLabel("mapping-suspended")).toContain("suspended");
    expect(bindingCauseLabel("backend-disabled")).toContain("backend");
  });
});
