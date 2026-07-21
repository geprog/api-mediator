import type { AdapterBinding, AdapterEndpoint } from "@mediator/domain";
import { describe, expect, it } from "vitest";

import { resolveRequest, type EndpointState } from "./resolution.js";

function endpoint(status: AdapterEndpoint["status"]): AdapterEndpoint {
  return {
    id: "endpoint-1",
    consumerAppId: "consumer-app-1",
    consumerOperationId: "todos/listTodos",
    status,
  };
}

function binding(status: AdapterBinding["status"], id = "binding-1"): AdapterBinding {
  return {
    id,
    adapterEndpointId: "endpoint-1",
    backendAppId: "backend-app-1",
    backendOperationId: "tasks/listTasks",
    approvedMappingId: "mapping-1",
    role: "primary",
    status,
  };
}

function state(
  endpointValue: AdapterEndpoint | undefined,
  bindings: readonly AdapterBinding[],
): EndpointState {
  return { endpoint: endpointValue, bindings };
}

describe("resolveRequest (RT-3, the three distinct answers)", () => {
  it("no AdapterEndpoint → not-yet-mapped with no endpoint id (RT-3.1)", () => {
    expect(resolveRequest(state(undefined, []))).toEqual({
      kind: "not-yet-mapped",
      endpointId: undefined,
    });
  });

  it("endpoint with no active binding → not-yet-mapped, carrying the endpoint id (RT-3.1)", () => {
    expect(resolveRequest(state(endpoint("active"), []))).toEqual({
      kind: "not-yet-mapped",
      endpointId: "endpoint-1",
    });
  });

  it("only a proposed binding → not-yet-mapped (a binding existing is not a served endpoint)", () => {
    expect(resolveRequest(state(endpoint("composition-required"), [binding("proposed")]))).toEqual({
      kind: "not-yet-mapped",
      endpointId: "endpoint-1",
    });
  });

  it("only a disabled binding → not-yet-mapped", () => {
    expect(resolveRequest(state(endpoint("active"), [binding("disabled")]))).toEqual({
      kind: "not-yet-mapped",
      endpointId: "endpoint-1",
    });
  });

  it("endpoint status = disabled → endpoint-disabled, even with an active binding (RT-3.2)", () => {
    expect(resolveRequest(state(endpoint("disabled"), [binding("active")]))).toEqual({
      kind: "endpoint-disabled",
      endpointId: "endpoint-1",
    });
  });

  it("active endpoint with an active binding → serve (RT-3)", () => {
    const outcome = resolveRequest(state(endpoint("active"), [binding("active")]));
    expect(outcome.kind).toBe("serve");
  });

  it("composition-required WITH an active binding keeps serving — not not-yet-mapped (RT-3.3)", () => {
    const outcome = resolveRequest(
      state(endpoint("composition-required"), [
        binding("active"),
        binding("proposed", "binding-2"),
      ]),
    );
    expect(outcome.kind).toBe("serve");
    if (outcome.kind === "serve") {
      // Only the active binding is handed on for serving; the proposed one is not.
      expect(outcome.activeBindings.map((each) => each.id)).toEqual(["binding-1"]);
    }
  });

  it("composition-required that was NEVER active → not-yet-mapped (RT-3.4)", () => {
    expect(resolveRequest(state(endpoint("composition-required"), [binding("proposed")]))).toEqual({
      kind: "not-yet-mapped",
      endpointId: "endpoint-1",
    });
  });
});
