import type { AdapterBindingRole } from "@mediator/domain";
import { describe, expect, it } from "vitest";

import type { ConsumerInputUniverse } from "./analysis.js";
import {
  ROLE_VALIDITY_BY_STRATEGY,
  validateComposition,
  type ComposableBindingFacts,
  type CompositionRejectionReason,
  type CompositionSubmission,
  type CompositionValidation,
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
    mappedConsumerParamNames: new Set<string>(),
    mappedConsumerBodyFieldNames: new Set<string>(),
    ...overrides,
  };
}

const EMPTY_CONSUMER_INPUTS: ConsumerInputUniverse = { parameters: [], bodyFields: [] };

/**
 * Run the validator with a default empty consumer-input universe (the CO-2 cases below
 * do not exercise CO-5); a case that needs CO-5 passes `consumerInputs` explicitly.
 */
function validate(input: {
  submission: CompositionSubmission;
  bindingFacts: readonly ComposableBindingFacts[];
  consumerInputs?: ConsumerInputUniverse;
}): CompositionValidation {
  return validateComposition({
    submission: input.submission,
    bindingFacts: input.bindingFacts,
    consumerInputs: input.consumerInputs ?? EMPTY_CONSUMER_INPUTS,
  });
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
        const result = validate({
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
        const result = validate({
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

describe("validateComposition — fanout-merge structural minimum (CO-2.2)", () => {
  it("rejects a fanout-merge with zero primaries (no base object to supplement)", () => {
    const result = validate({
      submission: submission({
        aggregationStrategy: "fanout-merge",
        bindings: [
          submitted("b1", { role: "supplement" }),
          submitted("b2", { role: "supplement" }),
        ],
      }),
      bindingFacts: [facts({ bindingId: "b1" }), facts({ bindingId: "b2" })],
    });
    expect(codesOf(result)).toContain("fanout-merge-primary-count");
  });

  it("rejects a fanout-merge with two primaries (two competing base objects)", () => {
    const result = validate({
      submission: submission({
        aggregationStrategy: "fanout-merge",
        bindings: [submitted("b1", { role: "primary" }), submitted("b2", { role: "primary" })],
      }),
      bindingFacts: [facts({ bindingId: "b1" }), facts({ bindingId: "b2" })],
    });
    expect(codesOf(result)).toContain("fanout-merge-primary-count");
  });

  it("accepts a fanout-merge with exactly one primary and supplements", () => {
    const result = validate({
      submission: submission({
        aggregationStrategy: "fanout-merge",
        bindings: [
          submitted("b1", { role: "primary" }),
          submitted("b2", { role: "supplement" }),
          submitted("b3", { role: "supplement" }),
        ],
      }),
      bindingFacts: [
        facts({ bindingId: "b1" }),
        facts({ bindingId: "b2" }),
        facts({ bindingId: "b3" }),
      ],
    });
    expect(result).toStrictEqual({ ok: true });
  });
});

describe("validateComposition — dependsOnBindingId (CO-2.3)", () => {
  it("accepts a dependency on another binding of the same endpoint under fanout-merge", () => {
    const result = validate({
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
    const result = validate({
      submission: submission({
        aggregationStrategy: "single",
        bindings: [submitted("b1", { dependsOnBindingId: "b2" })],
      }),
      bindingFacts: [facts({ bindingId: "b1" })],
    });
    expect(codesOf(result)).toContain("depends-on-not-allowed-for-strategy");
  });

  it("rejects dependsOnBindingId under fanout-first-success", () => {
    const result = validate({
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
    const result = validate({
      submission: submission({
        aggregationStrategy: "fanout-merge",
        bindings: [submitted("b1", { role: "supplement", dependsOnBindingId: "foreign" })],
      }),
      bindingFacts: [facts({ bindingId: "b1" })],
    });
    expect(codesOf(result)).toContain("depends-on-unknown-binding");
  });

  it("rejects a self-dependency", () => {
    const result = validate({
      submission: submission({
        aggregationStrategy: "fanout-merge",
        bindings: [submitted("b1", { role: "supplement", dependsOnBindingId: "b1" })],
      }),
      bindingFacts: [facts({ bindingId: "b1" })],
    });
    expect(codesOf(result)).toContain("depends-on-self");
  });

  it("rejects a two-node dependency cycle", () => {
    const result = validate({
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
    const result = validate({
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
    const result = validate({
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

  it("CO-2.3: rejects a chained dependent ordered STRICTLY BEFORE its upstream", () => {
    const result = validate({
      submission: submission({
        aggregationStrategy: "fanout-merge",
        bindings: [
          submitted("b1", { executionOrder: 1 }),
          submitted("b2", {
            role: "supplement",
            executionOrder: 0,
            dependsOnBindingId: "b1",
          }),
        ],
      }),
      bindingFacts: [facts({ bindingId: "b1" }), facts({ bindingId: "b2" })],
    });
    expect(result.ok).toBe(false);
    expect(codesOf(result)).toContain("chain-dependent-ordered-before-upstream");
  });

  it("CO-2.3: accepts a dependent ordered AFTER its upstream", () => {
    const result = validate({
      submission: submission({
        aggregationStrategy: "fanout-merge",
        bindings: [
          submitted("b1", { executionOrder: 0 }),
          submitted("b2", {
            role: "supplement",
            executionOrder: 1,
            dependsOnBindingId: "b1",
          }),
        ],
      }),
      bindingFacts: [facts({ bindingId: "b1" }), facts({ bindingId: "b2" })],
    });
    expect(codesOf(result)).not.toContain("chain-dependent-ordered-before-upstream");
  });

  it("CO-2.3: accepts a dependent ordered EQUAL to its upstream (same group; runtime awaits it)", () => {
    const result = validate({
      submission: submission({
        aggregationStrategy: "fanout-merge",
        bindings: [
          submitted("b1", { executionOrder: 2 }),
          submitted("b2", {
            role: "supplement",
            executionOrder: 2,
            dependsOnBindingId: "b1",
          }),
        ],
      }),
      bindingFacts: [facts({ bindingId: "b1" }), facts({ bindingId: "b2" })],
    });
    expect(codesOf(result)).not.toContain("chain-dependent-ordered-before-upstream");
  });
});

describe("validateComposition — executionOrder under fanout-first-success (CO-2.4)", () => {
  it("rejects a tie (two bindings sharing an order)", () => {
    const result = validate({
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
    const result = validate({
      submission: submission({
        aggregationStrategy: "fanout-first-success",
        bindings: [submitted("b1"), submitted("b2", { role: "fallback" })],
      }),
      bindingFacts: [facts({ bindingId: "b1" }), facts({ bindingId: "b2" })],
    });
    expect(codesOf(result)).toContain("execution-order-tie-under-first-success");
  });

  it("accepts a strict total order", () => {
    const result = validate({
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
    const result = validate({
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
    const result = validate({
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
    const result = validate({
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
    const result = validate({
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
    const result = validate({
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
    const result = validate({
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
    const result = validate({
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
    const result = validate({
      submission: submission({ aggregationStrategy: "single", bindings: [submitted("b1")] }),
      bindingFacts: [facts({ bindingId: "b1", isWriteOperation: true })],
    });
    expect(result.ok).toBe(true);
  });
});

describe("validateComposition — submission coverage + passing composition", () => {
  it("rejects a submission that omits a proposed binding", () => {
    const result = validate({
      submission: submission({
        aggregationStrategy: "fanout-merge",
        bindings: [submitted("b1")],
      }),
      bindingFacts: [facts({ bindingId: "b1" }), facts({ bindingId: "b2" })],
    });
    expect(codesOf(result)).toContain("submission-binding-mismatch");
  });

  it("rejects a submission naming a binding that is not part of the endpoint", () => {
    const result = validate({
      submission: submission({
        aggregationStrategy: "fanout-merge",
        bindings: [submitted("b1"), submitted("ghost", { role: "supplement" })],
      }),
      bindingFacts: [facts({ bindingId: "b1" })],
    });
    expect(codesOf(result)).toContain("submission-binding-mismatch");
  });

  it("returns ok for a clean fanout-merge composition", () => {
    const result = validate({
      submission: submission({
        aggregationStrategy: "fanout-merge",
        bindings: [submitted("b1"), submitted("b2", { role: "supplement" })],
      }),
      bindingFacts: [facts({ bindingId: "b1" }), facts({ bindingId: "b2" })],
    });
    expect(result).toStrictEqual({ ok: true });
  });
});

describe("validateComposition — consumer-input coverage (CO-5)", () => {
  it("CO-5.3: a REQUIRED consumer parameter reaching no backend is a blocking finding", () => {
    const result = validate({
      submission: submission({ aggregationStrategy: "single", bindings: [submitted("b1")] }),
      bindingFacts: [facts({ bindingId: "b1", mappedConsumerParamNames: new Set(["todoId"]) })],
      consumerInputs: {
        parameters: [
          { name: "todoId", required: true },
          { name: "tenant", required: true },
        ],
        bodyFields: [],
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const reason = result.reasons.find((r) => r.code === "required-consumer-input-unmapped");
    expect(reason).toEqual({
      code: "required-consumer-input-unmapped",
      inputKind: "parameter",
      inputName: "tenant",
    });
  });

  it("CO-5.3: a REQUIRED request-body field reaching no backend is a blocking finding", () => {
    const result = validate({
      submission: submission({ aggregationStrategy: "single", bindings: [submitted("b1")] }),
      bindingFacts: [facts({ bindingId: "b1" })],
      consumerInputs: {
        parameters: [],
        bodyFields: [{ name: "amount", required: true }],
      },
    });
    expect(codesOf(result)).toContain("required-consumer-input-unmapped");
  });

  it("CO-5.2: an OPTIONAL unmapped input with no acknowledgement is accepted (rejected at request time, not blocked)", () => {
    // The reject-at-request-time option is a valid, non-silent outcome — the composition
    // still activates; RP-2.4 rejects requests using `assignee`.
    const result = validate({
      submission: submission({ aggregationStrategy: "single", bindings: [submitted("b1")] }),
      bindingFacts: [facts({ bindingId: "b1", mappedConsumerParamNames: new Set(["todoId"]) })],
      consumerInputs: {
        parameters: [
          { name: "todoId", required: true },
          { name: "assignee", required: false },
        ],
        bodyFields: [],
      },
    });
    expect(result).toStrictEqual({ ok: true });
  });

  it("CO-5.4: acknowledging an optional unmapped input is accepted", () => {
    const result = validate({
      submission: submission({
        aggregationStrategy: "single",
        bindings: [submitted("b1")],
        acknowledgedIgnoredInputs: [{ kind: "parameter", consumerParamName: "assignee" }],
      }),
      bindingFacts: [facts({ bindingId: "b1", mappedConsumerParamNames: new Set(["todoId"]) })],
      consumerInputs: {
        parameters: [
          { name: "todoId", required: true },
          { name: "assignee", required: false },
        ],
        bodyFields: [],
      },
    });
    expect(result).toStrictEqual({ ok: true });
  });

  it("CO-5.2/5.4: acknowledging a MAPPED input is rejected (only an unmapped input can be acknowledged)", () => {
    const result = validate({
      submission: submission({
        aggregationStrategy: "single",
        bindings: [submitted("b1")],
        acknowledgedIgnoredInputs: [{ kind: "parameter", consumerParamName: "todoId" }],
      }),
      bindingFacts: [facts({ bindingId: "b1", mappedConsumerParamNames: new Set(["todoId"]) })],
      consumerInputs: { parameters: [{ name: "todoId", required: true }], bodyFields: [] },
    });
    expect(codesOf(result)).toContain("acknowledged-input-not-unmapped");
  });

  it("CO-5.2/5.4: acknowledging an UNKNOWN input is rejected", () => {
    const result = validate({
      submission: submission({
        aggregationStrategy: "single",
        bindings: [submitted("b1")],
        acknowledgedIgnoredInputs: [{ kind: "parameter", consumerParamName: "ghost" }],
      }),
      bindingFacts: [facts({ bindingId: "b1", mappedConsumerParamNames: new Set(["todoId"]) })],
      consumerInputs: { parameters: [{ name: "todoId", required: true }], bodyFields: [] },
    });
    expect(codesOf(result)).toContain("acknowledged-input-not-unmapped");
  });

  it("CO-5.3: a required unmapped input cannot be acknowledged away (still blocks)", () => {
    const result = validate({
      submission: submission({
        aggregationStrategy: "single",
        bindings: [submitted("b1")],
        // The composer tries to acknowledge a REQUIRED unmapped parameter.
        acknowledgedIgnoredInputs: [{ kind: "parameter", consumerParamName: "tenant" }],
      }),
      bindingFacts: [facts({ bindingId: "b1", mappedConsumerParamNames: new Set(["todoId"]) })],
      consumerInputs: {
        parameters: [
          { name: "todoId", required: true },
          { name: "tenant", required: true },
        ],
        bodyFields: [],
      },
    });
    expect(codesOf(result)).toContain("required-consumer-input-unmapped");
  });

  it("derive-then-confirm: no acknowledgements submitted → none applied, the composition simply validates", () => {
    // Nothing is auto-acknowledged (CO-5.5): with an optional unmapped input and no
    // submitted acknowledgement, the validator neither invents one nor blocks — the
    // reject-at-request-time default stands.
    const result = validate({
      submission: submission({ aggregationStrategy: "single", bindings: [submitted("b1")] }),
      bindingFacts: [facts({ bindingId: "b1", mappedConsumerParamNames: new Set(["todoId"]) })],
      consumerInputs: {
        parameters: [
          { name: "todoId", required: true },
          { name: "assignee", required: false },
        ],
        bodyFields: [],
      },
    });
    expect(result).toStrictEqual({ ok: true });
  });
});

describe("validateComposition — disabled bindings at (re)composition (CO-6.2)", () => {
  it("still requires a disabled binding to be ADDRESSED (it is not forgotten, just out of service)", () => {
    // Two endpoint bindings, but only `b1` submitted — `b2` is neither active nor marked
    // disabled → an unaddressed binding, exactly as for CO-2.
    const result = validate({
      submission: submission({
        aggregationStrategy: "fanout-merge",
        bindings: [submitted("b1")],
      }),
      bindingFacts: [facts({ bindingId: "b1" }), facts({ bindingId: "b2" })],
    });
    expect(codesOf(result)).toContain("submission-binding-mismatch");
  });

  it("evaluates role validity over the ACTIVE set only — a disabled binding's role is never checked", () => {
    // Under `single`, only `primary` is valid; `b2` carries an invalid `supplement` role but is
    // DISABLED, so it is not served and its role is irrelevant.
    const result = validate({
      submission: submission({
        aggregationStrategy: "single",
        bindings: [submitted("b1"), submitted("b2", { role: "supplement", disabled: true })],
      }),
      bindingFacts: [facts({ bindingId: "b1" }), facts({ bindingId: "b2" })],
    });
    expect(result).toStrictEqual({ ok: true });
  });

  it("CO-6.5: a WRITE endpoint with a second binding DISABLED is single-active and accepted", () => {
    // The write binding `b1` is the single active binding; `b2` is retained but disabled, so the
    // active count is 1 — the recompose that takes the extra binding out of service is valid.
    const result = validate({
      submission: submission({
        aggregationStrategy: "single",
        bindings: [submitted("b1"), submitted("b2", { disabled: true })],
      }),
      bindingFacts: [
        facts({ bindingId: "b1", isWriteOperation: true }),
        facts({ bindingId: "b2" }),
      ],
    });
    expect(result).toStrictEqual({ ok: true });
  });

  it("CO-6.5: two ACTIVE bindings on a write endpoint are still rejected (disabling neither)", () => {
    const result = validate({
      submission: submission({
        aggregationStrategy: "single",
        bindings: [submitted("b1"), submitted("b2")],
      }),
      bindingFacts: [
        facts({ bindingId: "b1", isWriteOperation: true }),
        facts({ bindingId: "b2" }),
      ],
    });
    expect(codesOf(result)).toContain("write-endpoint-not-single-active-binding");
  });

  it("counts only ACTIVE primaries for the fanout-merge structural minimum", () => {
    // Two `primary` bindings would normally be rejected (two base objects); disabling one
    // leaves exactly one active primary, so the composition is valid.
    const result = validate({
      submission: submission({
        aggregationStrategy: "fanout-merge",
        bindings: [
          submitted("b1", { role: "primary" }),
          submitted("b2", { role: "primary", disabled: true }),
          submitted("b3", { role: "supplement" }),
        ],
      }),
      bindingFacts: [
        facts({ bindingId: "b1" }),
        facts({ bindingId: "b2" }),
        facts({ bindingId: "b3" }),
      ],
    });
    expect(result).toStrictEqual({ ok: true });
  });

  it("rejects an active binding that depends on a DISABLED upstream (a chain that could never fill)", () => {
    const result = validate({
      submission: submission({
        aggregationStrategy: "fanout-merge",
        bindings: [
          submitted("b1", { role: "primary" }),
          submitted("up", { role: "supplement", disabled: true }),
          submitted("dep", { role: "supplement", dependsOnBindingId: "up", executionOrder: 1 }),
        ],
      }),
      bindingFacts: [
        facts({ bindingId: "b1" }),
        facts({ bindingId: "up" }),
        facts({ bindingId: "dep" }),
      ],
    });
    expect(codesOf(result)).toContain("depends-on-unknown-binding");
  });

  it("CO-5: a required consumer input covered ONLY by a now-disabled binding becomes a blocking finding", () => {
    // `todoId` is mapped only by `b2`; disabling `b2` means no ACTIVE backend receives it, so the
    // required input reaches nowhere — a blocking coverage finding rather than silent ignoral.
    const result = validate({
      submission: submission({
        aggregationStrategy: "collection-union",
        bindings: [
          submitted("b1", { role: "supplement" }),
          submitted("b2", { role: "supplement", disabled: true }),
        ],
      }),
      bindingFacts: [
        facts({ bindingId: "b1" }),
        facts({ bindingId: "b2", mappedConsumerParamNames: new Set(["todoId"]) }),
      ],
      consumerInputs: { parameters: [{ name: "todoId", required: true }], bodyFields: [] },
    });
    expect(codesOf(result)).toContain("required-consumer-input-unmapped");
  });
});
