import type { AdapterBinding, AdapterEndpoint } from "@mediator/domain";
import { describe, expect, it } from "vitest";

import { planResolution, type BindingHealthInput } from "./planner.js";

function endpoint(overrides: Partial<AdapterEndpoint> = {}): AdapterEndpoint {
  return {
    id: "endpoint-1",
    consumerAppId: "consumer-app",
    consumerOperationId: "todos/getTodo",
    status: "active",
    ...overrides,
  };
}

function binding(overrides: Partial<AdapterBinding> = {}): AdapterBinding {
  return {
    id: "binding-1",
    adapterEndpointId: "endpoint-1",
    backendAppId: "backend-app",
    backendOperationId: "tasks/getTask",
    approvedMappingId: "mapping-1",
    role: "primary",
    status: "active",
    ...overrides,
  };
}

function health(overrides: Partial<BindingHealthInput> = {}): BindingHealthInput {
  return {
    binding: binding(),
    mappingStatus: "active",
    backendStatus: "active",
    ...overrides,
  };
}

describe("planResolution — RP-3 re-validation + RP-4 plan", () => {
  it("keeps a healthy active binding in one execution group (default order 0)", () => {
    const result = planResolution({ endpoint: endpoint(), activeBindings: [health()] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.aggregationStrategy).toBe("single");
    expect(result.plan.eliminated).toEqual([]);
    expect(result.plan.groups).toHaveLength(1);
    expect(result.plan.groups[0]?.executionOrder).toBe(0);
    expect(result.plan.groups[0]?.bindings[0]?.bindingId).toBe("binding-1");
  });

  it("RP-3.3: a stale ApprovedMapping eliminates the binding as mapping-stale (no group)", () => {
    const result = planResolution({
      endpoint: endpoint(),
      activeBindings: [health({ mappingStatus: "stale" })],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.groups).toEqual([]);
    expect(result.plan.eliminated[0]?.cause).toEqual({ cause: "mapping-stale" });
  });

  it("RP-3.4: a suspended ApprovedMapping eliminates the binding as mapping-suspended", () => {
    const result = planResolution({
      endpoint: endpoint(),
      activeBindings: [health({ mappingStatus: "suspended" })],
    });
    if (!result.ok) throw new Error("expected ok");
    expect(result.plan.eliminated[0]?.cause).toEqual({ cause: "mapping-suspended" });
  });

  it("RP-3.5: a disabled backend app eliminates the binding as backend-disabled (naming the app)", () => {
    const result = planResolution({
      endpoint: endpoint(),
      activeBindings: [health({ backendStatus: "disabled" })],
    });
    if (!result.ok) throw new Error("expected ok");
    expect(result.plan.eliminated[0]?.cause).toEqual({
      cause: "backend-disabled",
      backendAppId: "backend-app",
    });
  });

  it("reports the mapping cause ahead of a simultaneously-disabled backend", () => {
    const result = planResolution({
      endpoint: endpoint(),
      activeBindings: [health({ mappingStatus: "suspended", backendStatus: "disabled" })],
    });
    if (!result.ok) throw new Error("expected ok");
    expect(result.plan.eliminated[0]?.cause).toEqual({ cause: "mapping-suspended" });
  });

  it("treats superseded/archived mappings as mapping-stale (needs re-review)", () => {
    for (const status of ["superseded", "archived"] as const) {
      const result = planResolution({
        endpoint: endpoint(),
        activeBindings: [health({ mappingStatus: status })],
      });
      if (!result.ok) throw new Error("expected ok");
      expect(result.plan.eliminated[0]?.cause).toEqual({ cause: "mapping-stale" });
    }
  });

  it("resolves a composed executionOrder through the domain default helper", () => {
    const result = planResolution({
      endpoint: endpoint(),
      activeBindings: [health({ binding: binding({ executionOrder: 3 }) })],
    });
    if (!result.ok) throw new Error("expected ok");
    expect(result.plan.groups[0]?.executionOrder).toBe(3);
  });

  it("fails loudly for a non-single strategy (out of this slice's scope)", () => {
    const result = planResolution({
      endpoint: endpoint({ aggregationStrategy: "fanout-merge" }),
      activeBindings: [health()],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.detail).toContain("fanout-merge");
  });

  it("fails loudly for a single endpoint carrying more than one active binding", () => {
    const result = planResolution({
      endpoint: endpoint(),
      activeBindings: [health(), health({ binding: binding({ id: "binding-2" }) })],
    });
    expect(result.ok).toBe(false);
  });

  it("RP-4.4: fails loudly for a chaining state single cannot represent", () => {
    const result = planResolution({
      endpoint: endpoint(),
      activeBindings: [health({ binding: binding({ dependsOnBindingId: "other" }) })],
    });
    expect(result.ok).toBe(false);
  });
});
