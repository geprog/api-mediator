import type {
  AdapterBinding,
  AdapterEndpoint,
  ChainInput,
  PostMergeDedup,
  PostMergePagination,
} from "@mediator/domain";
import { resolveRequest } from "@mediator/adapter-engine";
import { describe, expect, it } from "vitest";

import {
  planResolution,
  type BindingHealthInput,
} from "../../http/adapter-runtime/serve/planner.js";
import { adoptionFlagsCompositionRequired, reconstructSubmissionFromContext } from "./adopt.js";
import type { CompositionContext } from "./context.js";
import type { CompositionValidation } from "./validate.js";

/**
 * Unit tests for the **pure** CO-7 successor-adoption pieces:
 *  - {@link reconstructSubmissionFromContext} — the carry-over of a binding's composed
 *    serving state (role / order / dependsOn / `chainInputs`) and the endpoint's config,
 *    so re-validation runs the SAME composition through {@link validateComposition} against
 *    the successor's re-derived facts (CO-7.1/7.3);
 *  - {@link adoptionFlagsCompositionRequired} — the CO-7.4 decision (flag a broken `active`
 *    endpoint `composition-required`, never promote/mutate any other status);
 *  - CO-7.6 through the pure resolution/serve path — a `stale` mapping's binding keeps its
 *    composed configuration and simply fails with `mapping-stale`; staleness **pauses** a
 *    binding, it does not decompose the endpoint (needs no CO-7 code — it is the existing
 *    RP-3 planner behavior).
 *
 * The full re-point / load-in-tx / flag / cache-drop flow is proven against a real Postgres
 * in `apps/backend/src/co-7-successor-adoption.integration.spec.ts`.
 */

const READ_ENDPOINT_ID = "endpoint-read";

function endpointOf(overrides: Partial<AdapterEndpoint> = {}): AdapterEndpoint {
  return {
    id: READ_ENDPOINT_ID,
    consumerAppId: "consumer-app",
    consumerOperationId: "todos/getTodo",
    status: "active",
    aggregationStrategy: "single",
    strictness: "degraded",
    ...overrides,
  };
}

function bindingOf(overrides: Partial<AdapterBinding> = {}): AdapterBinding {
  return {
    id: "binding-1",
    adapterEndpointId: READ_ENDPOINT_ID,
    backendAppId: "backend-app",
    backendOperationId: "tasks/getTask",
    approvedMappingId: "mapping-successor",
    role: "primary",
    status: "active",
    ...overrides,
  };
}

/** A minimal {@link CompositionContext}; only `endpoint` + `bindings` matter for reconstruction. */
function contextOf(
  endpoint: AdapterEndpoint,
  bindings: readonly AdapterBinding[],
): CompositionContext {
  return {
    endpoint,
    bindings,
    bindingFacts: [],
    consumerInputs: { parameters: [], bodyFields: [] },
    requiredConsumerResponseFieldNames: new Set(),
    unionBindingFacts: [],
    consumerParameters: [],
    consumerResponseFieldNames: new Set(),
  };
}

describe("reconstructSubmissionFromContext (CO-7.1/7.3 carry-over)", () => {
  it("carries a chained binding's role/order/dependsOn/chainInputs over verbatim", () => {
    const chainInputs: ChainInput[] = [
      { upstreamFieldPath: "todos/id", targetParamRef: "tasks/getTask#taskId" },
    ];
    const primary = bindingOf({ id: "b-primary", role: "primary", executionOrder: 0 });
    const supplement = bindingOf({
      id: "b-supplement",
      role: "supplement",
      executionOrder: 1,
      dependsOnBindingId: "b-primary",
      chainInputs,
    });
    const endpoint = endpointOf({ aggregationStrategy: "fanout-merge" });

    const submission = reconstructSubmissionFromContext(contextOf(endpoint, [primary, supplement]));

    expect(submission.aggregationStrategy).toBe("fanout-merge");
    expect(submission.strictness).toBe("degraded");
    const byId = new Map(submission.bindings.map((binding) => [binding.bindingId, binding]));
    expect(byId.get("b-primary")).toEqual({
      bindingId: "b-primary",
      role: "primary",
      executionOrder: 0,
      disabled: false,
    });
    // The chained supplement's dependsOn + chainInputs survived the re-point (they live on
    // the binding row precisely so they carry over, AD-2.4 / CO-7.1).
    const reconstructedSupplement = byId.get("b-supplement");
    expect(reconstructedSupplement?.dependsOnBindingId).toBe("b-primary");
    expect(reconstructedSupplement?.chainInputs).toEqual(chainInputs);
    expect(reconstructedSupplement?.executionOrder).toBe(1);
  });

  it("reconstructs a non-active binding as disabled (proposed/operator-disabled are not served)", () => {
    const active = bindingOf({ id: "b-active", status: "active" });
    const proposed = bindingOf({ id: "b-proposed", status: "proposed" });
    const disabled = bindingOf({ id: "b-disabled", status: "disabled" });

    const submission = reconstructSubmissionFromContext(
      contextOf(endpointOf(), [active, proposed, disabled]),
    );

    const byId = new Map(submission.bindings.map((binding) => [binding.bindingId, binding]));
    expect(byId.get("b-active")?.disabled).toBe(false);
    expect(byId.get("b-proposed")?.disabled).toBe(true);
    expect(byId.get("b-disabled")?.disabled).toBe(true);
  });

  it("carries union post-merge config + acknowledgements + cacheTtl over unchanged", () => {
    const dedup: PostMergeDedup = { mode: "dedup-key", dedupKeyFieldPath: "todos/id" };
    const endpoint = endpointOf({
      aggregationStrategy: "collection-union",
      strictness: "strict",
      cacheTtl: 60_000,
      acknowledgedIgnoredInputs: [{ kind: "parameter", consumerParamName: "expand" }],
      postMergeDedup: dedup,
      postMergeFilters: [
        {
          consumerParamRef: "todos/list#status",
          consumerFieldPath: "todos/status",
          operator: "eq",
        },
      ],
    });
    const supplement = bindingOf({ id: "b-supplement", role: "supplement" });

    const submission = reconstructSubmissionFromContext(contextOf(endpoint, [supplement]));

    expect(submission.aggregationStrategy).toBe("collection-union");
    expect(submission.cacheTtl).toBe(60_000);
    expect(submission.acknowledgedIgnoredInputs).toEqual([
      { kind: "parameter", consumerParamName: "expand" },
    ]);
    expect(submission.postMergeDedup).toEqual(dedup);
    expect(submission.postMergeFilters).toHaveLength(1);
  });

  it("projects a confirmed pagination convention back to confirmPostMergePagination=true", () => {
    const confirmed: PostMergePagination = {
      convention: {
        convention: "page-number",
        pageParamRef: "todos/list#page",
        sizeParamRef: "todos/list#size",
        firstPageNumber: 1,
      },
      confirmedBy: "operator@example.test",
      confirmedAt: new Date("2026-07-21T00:00:00.000Z"),
    };
    const submission = reconstructSubmissionFromContext(
      contextOf(
        endpointOf({ aggregationStrategy: "collection-union", postMergePagination: confirmed }),
        [bindingOf({ role: "supplement" })],
      ),
    );
    expect(submission.postMergePagination).toEqual(confirmed.convention);
    expect(submission.confirmPostMergePagination).toBe(true);
  });

  it("projects an unconfirmed pagination convention back to confirmPostMergePagination=false", () => {
    const unconfirmed: PostMergePagination = {
      convention: {
        convention: "offset",
        offsetParamRef: "todos/list#offset",
        sizeParamRef: "todos/list#size",
      },
      confirmedBy: null,
      confirmedAt: null,
    };
    const submission = reconstructSubmissionFromContext(
      contextOf(
        endpointOf({ aggregationStrategy: "collection-union", postMergePagination: unconfirmed }),
        [bindingOf({ role: "supplement" })],
      ),
    );
    expect(submission.confirmPostMergePagination).toBe(false);
  });
});

describe("adoptionFlagsCompositionRequired (CO-7.4 flag-or-keep)", () => {
  const ok: CompositionValidation = { ok: true };
  const failed: CompositionValidation = {
    ok: false,
    reasons: [
      {
        code: "chain-input-unknown-upstream-field",
        bindingId: "b-supplement",
        upstreamBindingId: "b-primary",
        upstreamFieldPath: "todos/id",
      },
    ],
  };

  it("flags a broken active endpoint composition-required", () => {
    expect(adoptionFlagsCompositionRequired("active", failed)).toBe(true);
  });

  it("keeps a still-valid active endpoint active (does not flag)", () => {
    expect(adoptionFlagsCompositionRequired("active", ok)).toBe(false);
  });

  it("never promotes: a composition-required endpoint stays composition-required even on failure", () => {
    expect(adoptionFlagsCompositionRequired("composition-required", failed)).toBe(false);
  });

  it("leaves a disabled endpoint disabled even on failure", () => {
    expect(adoptionFlagsCompositionRequired("disabled", failed)).toBe(false);
  });
});

describe("CO-7.6 — a stale mapping pauses a binding, it does not decompose the endpoint", () => {
  const endpoint = endpointOf();
  const staleBinding = bindingOf({ approvedMappingId: "mapping-stale" });

  it("keeps the composed configuration serving (resolveRequest → serve, not decomposed)", () => {
    // The binding is still `active` and the endpoint still `active`: staleness lives on the
    // mapping alone, so resolution still hands the request to the serving core — the endpoint
    // is NOT torn down to not-yet-mapped.
    const outcome = resolveRequest({ endpoint, bindings: [staleBinding] });
    expect(outcome.kind).toBe("serve");
  });

  it("fails the resolved binding with mapping-stale at planning time (RP-3)", () => {
    const health: BindingHealthInput = {
      binding: staleBinding,
      mappingStatus: "stale",
      backendStatus: "active",
    };
    const result = planResolution({ endpoint, activeBindings: [health] });
    expect(result.ok).toBe(true);
    if (result.ok) {
      // No healthy group; the binding is eliminated with the distinct mapping-stale cause.
      expect(result.plan.groups).toHaveLength(0);
      expect(result.plan.eliminated).toHaveLength(1);
      expect(result.plan.eliminated[0]?.cause.cause).toBe("mapping-stale");
    }
  });
});
