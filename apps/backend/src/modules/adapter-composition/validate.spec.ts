import type { AdapterBindingRole } from "@mediator/domain";
import { describe, expect, it } from "vitest";

import {
  ROLE_VALIDITY_BY_STRATEGY,
  validateComposition,
  type ComposableBindingFacts,
  type CompositionRejectionReason,
  type CompositionSubmission,
  type SubmittedBindingComposition,
} from "./validate.js";

/**
 * Unit coverage for the CO-2 pure validator: the role-validity table (per strategy),
 * the `dependsOnBindingId`/`executionOrder` rules (fanout-merge-only + acyclic + no
 * order tie under fanout-first-success), `chainInputs` field/param validity, the
 * non-composable required parameter (named), and write => single-with-one-active. Every
 * rejection is asserted by `code`, and every passing composition returns `{ ok: true }`.
 */

/** A composable-binding facts entry with fillable defaults, overridable per test. */
function facts(
  overrides: Partial<ComposableBindingFacts> & { bindingId: string },
): ComposableBindingFacts {
  return {
    isWriteOperation: false,
    backendParameterNames: new Set<string>(),
    requiredBackendParameterNames: new Set<string>(),
    parameterMappedTargetNames: new Set<string>(),
    consumerResponseFieldPaths: new Set<string>(),
    ...overrides,
  };
}

/** A submitted binding with a default `primary` role. */
function submitted(
  bindingId: string,
  overrides: Partial<Omit<SubmittedBindingComposition, "bindingId">> = {},
): SubmittedBindingComposition {
  return { bindingId, role: "primary", ...overrides };
}

function submission(
  overrides: Partial<CompositionSubmission> & { bindings: readonly SubmittedBindingComposition[] },
): CompositionSubmission {
  return { aggregationStrategy: "fanout-merge", strictness: "degraded", ...overrides };
}

/** The set of rejection codes returned (empty when ok). */
function codesOf(
  result: ReturnType<typeof validateComposition>,
): CompositionRejectionReason["code"][] {
  return result.ok ? [] : result.reasons.map((reason) => reason.code);
}

describe("validateComposition — role-validity table (CO-2.2)", () => {
  it("exposes the table exactly as the concept doc states", () => {
    expect(ROLE_VALIDITY_BY_STRATEGY).toStrictEqual({
      single: ["primary"],
      "fanout-merge": ["primary", "supplement"],
      "collection-union": ["supplement"],
      "fanout-first-success": ["primary", "fallback"],
    });
  });

  const cases: {
    strategy: keyof typeof ROLE_VALIDITY_BY_STRATEGY;
    rejected: AdapterBindingRole[];
  }[] = [
    { strategy: "single", rejected: ["fallback", "supplement"] },
    { strategy: "fanout-merge", rejected: ["fallback"] },
    { strategy: "collection-union", rejected: ["primary", "fallback"] },
    { strategy: "fanout-first-success", rejected: ["supplement"] },
  ];

  for (const { strategy, rejected } of cases) {
    for (const role of rejected) {
      it(`rejects role '${role}' under '${strategy}'`, () => {
        const result = validateComposition({
          submission: submission({
            aggregationStrategy: strategy,
            bindings: [submitted("b1", { role })],
          }),
          bindingFacts: [facts({ bindingId: "b1" })],
        });
        expect(result.ok).toBe(false);
        expect(codesOf(result)).toContain("role-invalid-for-strategy");
      });
    }

    for (const role of ROLE_VALIDITY_BY_STRATEGY[strategy]) {
      it(`accepts valid role '${role}' under '${strategy}'`, () => {
        const result = validateComposition({
          submission: submission({
            aggregationStrategy: strategy,
            bindings: [submitted("b1", { role })],
          }),
          bindingFacts: [facts({ bindingId: "b1" })],
        });
        expect(codesOf(result)).not.toContain("role-invalid-for-strategy");
      });
    }
  }
});

describe("validateComposition — dependsOnBindingId (CO-2.3)", () => {
  it("accepts a dependency on another binding of the same endpoint under fanout-merge", () => {
    const result = validateComposition({
      submission: submission({
        aggregationStrategy: "fanout-merge",
        bindings: [
          submitted("b1"),
          submitted("b2", { role: "supplement", dependsOnBindingId: "b1" }),
        ],
      }),
      bindingFacts: [facts({ bindingId: "b1" }), facts({ bindingId: "b2" })],
    });
    expect(result.ok).toBe(true);
  });

  it("rejects dependsOnBindingId under single", () => {
    const result = validateComposition({
      submission: submission({
        aggregationStrategy: "single",
        bindings: [submitted("b1", { dependsOnBindingId: "b2" })],
      }),
      bindingFacts: [facts({ bindingId: "b1" })],
    });
    expect(codesOf(result)).toContain("depends-on-not-allowed-for-strategy");
  });

  it("rejects dependsOnBindingId under fanout-first-success", () => {
    const result = validateComposition({
      submission: submission({
        aggregationStrategy: "fanout-first-success",
        bindings: [
          submitted("b1"),
          submitted("b2", { role: "fallback", executionOrder: 1, dependsOnBindingId: "b1" }),
        ],
      }),
      bindingFacts: [facts({ bindingId: "b1" }), facts({ bindingId: "b2" })],
    });
    expect(codesOf(result)).toContain("depends-on-not-allowed-for-strategy");
  });

  it("rejects a dependency on a binding of another endpoint (unknown id)", () => {
    const result = validateComposition({
      submission: submission({
        aggregationStrategy: "fanout-merge",
        bindings: [submitted("b1", { role: "supplement", dependsOnBindingId: "foreign" })],
      }),
      bindingFacts: [facts({ bindingId: "b1" })],
    });
    expect(codesOf(result)).toContain("depends-on-unknown-binding");
  });

  it("rejects a self-dependency", () => {
    const result = validateComposition({
      submission: submission({
        aggregationStrategy: "fanout-merge",
        bindings: [submitted("b1", { role: "supplement", dependsOnBindingId: "b1" })],
      }),
      bindingFacts: [facts({ bindingId: "b1" })],
    });
    expect(codesOf(result)).toContain("depends-on-self");
  });

  it("rejects a two-node dependency cycle", () => {
    const result = validateComposition({
      submission: submission({
        aggregationStrategy: "fanout-merge",
        bindings: [
          submitted("b1", { dependsOnBindingId: "b2" }),
          submitted("b2", { role: "supplement", dependsOnBindingId: "b1" }),
        ],
      }),
      bindingFacts: [facts({ bindingId: "b1" }), facts({ bindingId: "b2" })],
    });
    expect(result.ok).toBe(false);
    expect(codesOf(result)).toContain("depends-on-cycle");
  });

  it("rejects a three-node dependency cycle", () => {
    const result = validateComposition({
      submission: submission({
        aggregationStrategy: "fanout-merge",
        bindings: [
          submitted("b1", { dependsOnBindingId: "b2" }),
          submitted("b2", { role: "supplement", dependsOnBindingId: "b3" }),
          submitted("b3", { role: "supplement", dependsOnBindingId: "b1" }),
        ],
      }),
      bindingFacts: [
        facts({ bindingId: "b1" }),
        facts({ bindingId: "b2" }),
        facts({ bindingId: "b3" }),
      ],
    });
    expect(codesOf(result)).toContain("depends-on-cycle");
  });

  it("accepts an acyclic chain of three bindings", () => {
    const result = validateComposition({
      submission: submission({
        aggregationStrategy: "fanout-merge",
        bindings: [
          submitted("b1"),
          submitted("b2", { role: "supplement", dependsOnBindingId: "b1" }),
          submitted("b3", { role: "supplement", dependsOnBindingId: "b2" }),
        ],
      }),
      bindingFacts: [
        facts({ bindingId: "b1" }),
        facts({ bindingId: "b2" }),
        facts({ bindingId: "b3" }),
      ],
    });
    expect(result.ok).toBe(true);
  });
});

describe("validateComposition — executionOrder under fanout-first-success (CO-2.4)", () => {
  it("rejects a tie (two bindings sharing an order)", () => {
    const result = validateComposition({
      submission: submission({
        aggregationStrategy: "fanout-first-success",
        bindings: [
          submitted("b1", { executionOrder: 0 }),
          submitted("b2", { role: "fallback", executionOrder: 0 }),
        ],
      }),
      bindingFacts: [facts({ bindingId: "b1" }), facts({ bindingId: "b2" })],
    });
    expect(codesOf(result)).toContain("execution-order-tie-under-first-success");
  });

  it("rejects the implicit tie of two order-absent bindings (both default 0)", () => {
    const result = validateComposition({
      submission: submission({
        aggregationStrategy: "fanout-first-success",
        bindings: [submitted("b1"), submitted("b2", { role: "fallback" })],
      }),
      bindingFacts: [facts({ bindingId: "b1" }), facts({ bindingId: "b2" })],
    });
    expect(codesOf(result)).toContain("execution-order-tie-under-first-success");
  });

  it("accepts a strict total order", () => {
    const result = validateComposition({
      submission: submission({
        aggregationStrategy: "fanout-first-success",
        bindings: [
          submitted("b1", { executionOrder: 0 }),
          submitted("b2", { role: "fallback", executionOrder: 1 }),
        ],
      }),
      bindingFacts: [facts({ bindingId: "b1" }), facts({ bindingId: "b2" })],
    });
    expect(result.ok).toBe(true);
  });
});

describe("validateComposition — chainInputs validity (CO-2.5)", () => {
  const base = {
    aggregationStrategy: "fanout-merge" as const,
  };

  it("rejects an upstreamFieldPath the upstream response does not provide", () => {
    const result = validateComposition({
      submission: submission({
        ...base,
        bindings: [
          submitted("up"),
          submitted("down", {
            role: "supplement",
            dependsOnBindingId: "up",
            chainInputs: [{ upstreamFieldPath: "issues/ghost", targetParamRef: "issueId" }],
          }),
        ],
      }),
      bindingFacts: [
        facts({ bindingId: "up", consumerResponseFieldPaths: new Set(["issues/id"]) }),
        facts({ bindingId: "down", backendParameterNames: new Set(["issueId"]) }),
      ],
    });
    expect(codesOf(result)).toContain("chain-input-unknown-upstream-field");
  });

  it("rejects a targetParamRef that is not a backend parameter of this binding", () => {
    const result = validateComposition({
      submission: submission({
        ...base,
        bindings: [
          submitted("up"),
          submitted("down", {
            role: "supplement",
            dependsOnBindingId: "up",
            chainInputs: [{ upstreamFieldPath: "issues/id", targetParamRef: "notAParam" }],
          }),
        ],
      }),
      bindingFacts: [
        facts({ bindingId: "up", consumerResponseFieldPaths: new Set(["issues/id"]) }),
        facts({ bindingId: "down", backendParameterNames: new Set(["issueId"]) }),
      ],
    });
    expect(codesOf(result)).toContain("chain-input-unknown-target-param");
  });

  it("accepts a chainInput whose field and param both resolve (targetParamRef as a full ref)", () => {
    const result = validateComposition({
      submission: submission({
        ...base,
        bindings: [
          submitted("up"),
          submitted("down", {
            role: "supplement",
            dependsOnBindingId: "up",
            chainInputs: [
              { upstreamFieldPath: "issues/id", targetParamRef: "issues/getComments#issueId" },
            ],
          }),
        ],
      }),
      bindingFacts: [
        facts({ bindingId: "up", consumerResponseFieldPaths: new Set(["issues/id"]) }),
        facts({ bindingId: "down", backendParameterNames: new Set(["issueId"]) }),
      ],
    });
    expect(result.ok).toBe(true);
  });
});

describe("validateComposition — required parameter coverage (CO-2.6)", () => {
  it("rejects a required backend parameter with neither a ParameterMapping nor a chainInput, naming it", () => {
    const result = validateComposition({
      submission: submission({ aggregationStrategy: "single", bindings: [submitted("b1")] }),
      bindingFacts: [
        facts({
          bindingId: "b1",
          backendParameterNames: new Set(["owner", "repo"]),
          requiredBackendParameterNames: new Set(["owner", "repo"]),
        }),
      ],
    });
    expect(result.ok).toBe(false);
    const named = result.ok
      ? []
      : result.reasons
          .filter((reason) => reason.code === "required-parameter-not-composable")
          .map((reason) => reason.parameterName);
    expect(named).toStrictEqual(expect.arrayContaining(["owner", "repo"]));
  });

  it("accepts a required parameter covered by a ParameterMapping", () => {
    const result = validateComposition({
      submission: submission({ aggregationStrategy: "single", bindings: [submitted("b1")] }),
      bindingFacts: [
        facts({
          bindingId: "b1",
          backendParameterNames: new Set(["owner"]),
          requiredBackendParameterNames: new Set(["owner"]),
          parameterMappedTargetNames: new Set(["owner"]),
        }),
      ],
    });
    expect(result.ok).toBe(true);
  });

  it("accepts a required parameter covered by a chainInput", () => {
    const result = validateComposition({
      submission: submission({
        aggregationStrategy: "fanout-merge",
        bindings: [
          submitted("up"),
          submitted("down", {
            role: "supplement",
            dependsOnBindingId: "up",
            chainInputs: [{ upstreamFieldPath: "issues/id", targetParamRef: "issueId" }],
          }),
        ],
      }),
      bindingFacts: [
        facts({ bindingId: "up", consumerResponseFieldPaths: new Set(["issues/id"]) }),
        facts({
          bindingId: "down",
          backendParameterNames: new Set(["issueId"]),
          requiredBackendParameterNames: new Set(["issueId"]),
        }),
      ],
    });
    expect(result.ok).toBe(true);
  });
});

describe("validateComposition — write endpoints (CO-2.7)", () => {
  it("rejects a write endpoint composed as fanout-merge and with more than one binding", () => {
    const result = validateComposition({
      submission: submission({
        aggregationStrategy: "fanout-merge",
        bindings: [submitted("b1"), submitted("b2", { role: "supplement" })],
      }),
      bindingFacts: [
        facts({ bindingId: "b1", isWriteOperation: true }),
        facts({ bindingId: "b2" }),
      ],
    });
    expect(codesOf(result)).toContain("write-endpoint-not-single");
    expect(codesOf(result)).toContain("write-endpoint-not-single-active-binding");
  });

  it("accepts a write endpoint composed as single with exactly one binding", () => {
    const result = validateComposition({
      submission: submission({ aggregationStrategy: "single", bindings: [submitted("b1")] }),
      bindingFacts: [facts({ bindingId: "b1", isWriteOperation: true })],
    });
    expect(result.ok).toBe(true);
  });
});

describe("validateComposition — submission coverage + passing composition", () => {
  it("rejects a submission that omits a proposed binding", () => {
    const result = validateComposition({
      submission: submission({
        aggregationStrategy: "fanout-merge",
        bindings: [submitted("b1")],
      }),
      bindingFacts: [facts({ bindingId: "b1" }), facts({ bindingId: "b2" })],
    });
    expect(codesOf(result)).toContain("submission-binding-mismatch");
  });

  it("rejects a submission naming a binding that is not part of the endpoint", () => {
    const result = validateComposition({
      submission: submission({
        aggregationStrategy: "fanout-merge",
        bindings: [submitted("b1"), submitted("ghost", { role: "supplement" })],
      }),
      bindingFacts: [facts({ bindingId: "b1" })],
    });
    expect(codesOf(result)).toContain("submission-binding-mismatch");
  });

  it("returns ok for a clean fanout-merge composition", () => {
    const result = validateComposition({
      submission: submission({
        aggregationStrategy: "fanout-merge",
        bindings: [submitted("b1"), submitted("b2", { role: "supplement" })],
      }),
      bindingFacts: [facts({ bindingId: "b1" }), facts({ bindingId: "b2" })],
    });
    expect(result).toStrictEqual({ ok: true });
  });
});
