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

  it("fails loudly for an unimplemented strategy (fanout-first-success is out of scope)", () => {
    const result = planResolution({
      endpoint: endpoint({ aggregationStrategy: "fanout-first-success" }),
      activeBindings: [health()],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.detail).toContain("not implemented");
  });

  it("AG-3: plans a collection-union, keeping every healthy supplement as a contributor", () => {
    const result = planResolution({
      endpoint: endpoint({ aggregationStrategy: "collection-union", strictness: "degraded" }),
      activeBindings: [
        health({ binding: binding({ id: "a", role: "supplement", executionOrder: 0 }) }),
        health({ binding: binding({ id: "b", role: "supplement", executionOrder: 1 }) }),
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.aggregationStrategy).toBe("collection-union");
    expect(result.plan.groups.flatMap((g) => g.bindings).map((b) => b.bindingId)).toEqual([
      "a",
      "b",
    ]);
    expect(result.plan.eliminated).toEqual([]);
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

describe("planResolution — fanout-merge (AG-2) + TE-3 chaining", () => {
  const fanout = endpoint({ aggregationStrategy: "fanout-merge", strictness: "degraded" });

  function primary(overrides: Partial<AdapterBinding> = {}): BindingHealthInput {
    return health({ binding: binding({ id: "p", role: "primary", ...overrides }) });
  }
  function supplement(id: string, overrides: Partial<AdapterBinding> = {}): BindingHealthInput {
    return health({ binding: binding({ id, role: "supplement", ...overrides }) });
  }

  it("keeps every healthy binding, grouped by executionOrder ascending", () => {
    const result = planResolution({
      endpoint: fanout,
      activeBindings: [
        primary({ executionOrder: 0 }),
        supplement("s1", { executionOrder: 1 }),
        supplement("s2", { executionOrder: 1 }),
      ],
    });
    if (!result.ok) throw new Error("expected ok");
    expect(result.plan.aggregationStrategy).toBe("fanout-merge");
    expect(result.plan.groups).toHaveLength(2);
    expect(result.plan.groups[0]?.executionOrder).toBe(0);
    expect(result.plan.groups[0]?.bindings.map((b) => b.bindingId)).toEqual(["p"]);
    expect(result.plan.groups[1]?.bindings.map((b) => b.bindingId).sort()).toEqual(["s1", "s2"]);
    expect(result.plan.eliminated).toEqual([]);
  });

  it("eliminates an unhealthy supplement (its cause) while keeping the healthy primary", () => {
    const result = planResolution({
      endpoint: fanout,
      activeBindings: [
        primary(),
        // A stale supplement mapping eliminates just that binding.
        health({ binding: binding({ id: "s1", role: "supplement" }), mappingStatus: "stale" }),
      ],
    });
    if (!result.ok) throw new Error("expected ok");
    expect(result.plan.groups.flatMap((g) => g.bindings).map((b) => b.bindingId)).toEqual(["p"]);
    expect(result.plan.eliminated).toHaveLength(1);
    expect(result.plan.eliminated[0]?.bindingId).toBe("s1");
    expect(result.plan.eliminated[0]?.role).toBe("supplement");
    expect(result.plan.eliminated[0]?.cause).toEqual({ cause: "mapping-stale" });
  });

  it("TE-3.1: carries a chained supplement's dependsOnBindingId + chainInputs onto the plan", () => {
    const chainInputs = [
      { upstreamFieldPath: "todos/id", targetParamRef: "workspaces/getWorkspace#workspaceId" },
    ];
    const result = planResolution({
      endpoint: fanout,
      activeBindings: [primary(), supplement("s1", { dependsOnBindingId: "p", chainInputs })],
    });
    if (!result.ok) throw new Error("expected ok");
    const chained = result.plan.groups.flatMap((g) => g.bindings).find((b) => b.bindingId === "s1");
    expect(chained?.dependsOnBindingId).toBe("p");
    expect(chained?.chainInputs).toEqual(chainInputs);
  });

  it("TE-3.6: dependsOnBindingId under a non-fanout-merge strategy fails loud (runtime backstop)", () => {
    const result = planResolution({
      endpoint: endpoint({ aggregationStrategy: "collection-union" }),
      activeBindings: [
        health({ binding: binding({ id: "a", role: "supplement" }) }),
        health({ binding: binding({ id: "b", role: "supplement", dependsOnBindingId: "a" }) }),
      ],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.detail).toContain("fanout-merge only");
  });
});
