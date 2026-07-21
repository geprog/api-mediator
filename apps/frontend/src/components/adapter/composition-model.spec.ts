import { describe, expect, it } from "vitest";

import {
  availableStrategies,
  buildComposeRequest,
  coerceRoleForStrategy,
  firstSuccessTiedOrders,
  hasFirstSuccessOrderTie,
  isRoleValidForStrategy,
  rolesForStrategy,
  strategyUsesChainInputs,
  strategyUsesDependsOn,
  strategyUsesExecutionOrder,
  upstreamConsumerResponseFields,
  type CompositionDraft,
} from "./composition-model";

describe("composition-model — role-validity table (CU-1.2)", () => {
  it("offers exactly each strategy's valid roles", () => {
    expect(rolesForStrategy("single")).toStrictEqual(["primary"]);
    expect(rolesForStrategy("fanout-merge")).toStrictEqual(["primary", "supplement"]);
    expect(rolesForStrategy("collection-union")).toStrictEqual(["supplement"]);
    expect(rolesForStrategy("fanout-first-success")).toStrictEqual(["primary", "fallback"]);
  });

  it("rejects a role outside the strategy's set", () => {
    expect(isRoleValidForStrategy("single", "primary")).toBe(true);
    expect(isRoleValidForStrategy("single", "supplement")).toBe(false);
    expect(isRoleValidForStrategy("collection-union", "primary")).toBe(false);
    expect(isRoleValidForStrategy("fanout-first-success", "supplement")).toBe(false);
  });

  it("keeps a role valid across a strategy change, falling back to the default", () => {
    // fallback is valid under fanout-first-success but not fanout-merge → default (primary).
    expect(coerceRoleForStrategy("fanout-merge", "fallback")).toBe("primary");
    // supplement stays under fanout-merge.
    expect(coerceRoleForStrategy("fanout-merge", "supplement")).toBe("supplement");
    // collection-union has a single role (supplement).
    expect(coerceRoleForStrategy("collection-union", "primary")).toBe("supplement");
  });
});

describe("composition-model — write → single (CU-1.6)", () => {
  it("offers only single for a write operation", () => {
    expect(availableStrategies({ writeOperation: true })).toStrictEqual(["single"]);
  });

  it("offers all four strategies for a read", () => {
    expect(availableStrategies({ writeOperation: false })).toStrictEqual([
      "single",
      "fanout-merge",
      "collection-union",
      "fanout-first-success",
    ]);
  });
});

describe("composition-model — strategy-scoped order/chain fields", () => {
  it("execution order is meaningful for every strategy except single", () => {
    expect(strategyUsesExecutionOrder("single")).toBe(false);
    expect(strategyUsesExecutionOrder("fanout-merge")).toBe(true);
    expect(strategyUsesExecutionOrder("collection-union")).toBe(true);
    expect(strategyUsesExecutionOrder("fanout-first-success")).toBe(true);
  });

  it("dependsOn/chainInputs are meaningful only under fanout-merge", () => {
    expect(strategyUsesDependsOn("fanout-merge")).toBe(true);
    expect(strategyUsesChainInputs("fanout-merge")).toBe(true);
    for (const strategy of ["single", "collection-union", "fanout-first-success"] as const) {
      expect(strategyUsesDependsOn(strategy)).toBe(false);
      expect(strategyUsesChainInputs(strategy)).toBe(false);
    }
  });
});

describe("composition-model — fanout-first-success order ties (CU-1.3)", () => {
  it("flags a shared order value", () => {
    const draft: CompositionDraft = {
      aggregationStrategy: "fanout-first-success",
      strictness: "strict",
      bindings: [
        { bindingId: "a", role: "primary", executionOrder: 1 },
        { bindingId: "b", role: "fallback", executionOrder: 1 },
      ],
    };
    expect(firstSuccessTiedOrders(draft.bindings)).toStrictEqual([1]);
    expect(hasFirstSuccessOrderTie(draft)).toBe(true);
  });

  it("treats two unordered bindings as tied on the default order (0)", () => {
    expect(
      firstSuccessTiedOrders([
        { bindingId: "a", role: "primary" },
        { bindingId: "b", role: "fallback" },
      ]),
    ).toStrictEqual([0]);
  });

  it("does not flag distinct orders", () => {
    const draft: CompositionDraft = {
      aggregationStrategy: "fanout-first-success",
      strictness: "strict",
      bindings: [
        { bindingId: "a", role: "primary", executionOrder: 1 },
        { bindingId: "b", role: "fallback", executionOrder: 2 },
      ],
    };
    expect(hasFirstSuccessOrderTie(draft)).toBe(false);
  });

  it("does not flag ties under other strategies", () => {
    const draft: CompositionDraft = {
      aggregationStrategy: "collection-union",
      strictness: "degraded",
      bindings: [
        { bindingId: "a", role: "supplement", executionOrder: 1 },
        { bindingId: "b", role: "supplement", executionOrder: 1 },
      ],
    };
    expect(hasFirstSuccessOrderTie(draft)).toBe(false);
  });
});

describe("composition-model — chainInputs source options (CU-1.4)", () => {
  it("returns the upstream binding's consumer-shape response fields", () => {
    expect(
      upstreamConsumerResponseFields(
        {
          applicable: true,
          entries: [
            {
              kind: "supplement",
              bindingId: "up",
              suppliedConsumerResponseFields: ["id", "profile.name"],
              allSuppliedFieldsOptional: true,
              loadBearing: false,
            },
          ],
        },
        "up",
      ),
    ).toStrictEqual(["id", "profile.name"]);
  });

  it("is empty for a primary upstream or when no analysis is loaded", () => {
    expect(
      upstreamConsumerResponseFields(
        {
          applicable: true,
          entries: [{ kind: "primary-always-fails", bindingId: "p", role: "primary" }],
        },
        "p",
      ),
    ).toStrictEqual([]);
    expect(upstreamConsumerResponseFields(null, "p")).toStrictEqual([]);
    expect(
      upstreamConsumerResponseFields({ applicable: false, aggregationStrategy: "single" }, "p"),
    ).toStrictEqual([]);
  });
});

describe("composition-model — buildComposeRequest (strategy-scoped serialization)", () => {
  it("emits order/depends/chain only where the strategy uses them", () => {
    const request = buildComposeRequest({
      aggregationStrategy: "fanout-merge",
      strictness: "degraded",
      bindings: [
        { bindingId: "a", role: "primary", executionOrder: 0 },
        {
          bindingId: "b",
          role: "supplement",
          executionOrder: 1,
          dependsOnBindingId: "a",
          chainInputs: [{ upstreamFieldPath: "id", targetParamRef: "userId" }],
        },
      ],
    });
    expect(request.aggregationStrategy).toBe("fanout-merge");
    expect(request.bindings[1]).toStrictEqual({
      bindingId: "b",
      role: "supplement",
      executionOrder: 1,
      dependsOnBindingId: "a",
      chainInputs: [{ upstreamFieldPath: "id", targetParamRef: "userId" }],
    });
  });

  it("drops union + order/chain fields when the strategy does not use them (single)", () => {
    const request = buildComposeRequest({
      aggregationStrategy: "single",
      strictness: "strict",
      bindings: [{ bindingId: "a", role: "primary", executionOrder: 3, dependsOnBindingId: "z" }],
      postMergeDedup: { mode: "record-link" },
    });
    expect(request.bindings[0]).toStrictEqual({ bindingId: "a", role: "primary" });
    expect(request.postMergeDedup).toBeUndefined();
  });

  it("emits union config only for collection-union", () => {
    const request = buildComposeRequest({
      aggregationStrategy: "collection-union",
      strictness: "degraded",
      bindings: [{ bindingId: "a", role: "supplement" }],
      postMergeDedup: { mode: "dedup-key", dedupKeyFieldPath: "email" },
      postMergePagination: {
        convention: "offset",
        offsetParamRef: "skip",
        sizeParamRef: "take",
      },
      confirmPostMergePagination: true,
    });
    expect(request.postMergeDedup).toStrictEqual({ mode: "dedup-key", dedupKeyFieldPath: "email" });
    expect(request.confirmPostMergePagination).toBe(true);
  });
});
