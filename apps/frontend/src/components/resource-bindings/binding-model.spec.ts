import type { ResourceBindingRefDto, ResourceBindingScopeDto } from "@mediator/contracts";
import type { IrResourceGroup } from "@mediator/domain";
import { describe, expect, it } from "vitest";

import {
  buildRefTargetOptions,
  canConfirm,
  canSupplyScope,
  defaultTargetKind,
  describeTarget,
  refState,
  scopeBindingState,
} from "./binding-model";

function refDto(overrides: Partial<ResourceBindingRefDto>): ResourceBindingRefDto {
  return {
    kind: "nativeIdRef",
    applicable: true,
    value: { kind: "field", path: "id" },
    confirmedBy: null,
    confirmedAt: null,
    ...overrides,
  };
}

const group: IrResourceGroup = {
  resourceRef: "issues",
  name: "issues",
  operations: [
    {
      operationId: "issueList",
      method: "get",
      path: "/issues",
      parameters: [{ name: "page", location: "query", required: false }],
      responseSchema: { name: "Issue", fields: [{ name: "id", type: "integer", required: true }] },
    },
    {
      operationId: "issueList",
      method: "get",
      path: "/issues",
      parameters: [{ name: "page", location: "query", required: false }],
    },
  ],
  schemas: [
    {
      name: "Issue",
      fields: [
        { name: "id", type: "integer", required: true },
        { name: "title", type: "string", required: true },
      ],
    },
  ],
  crossResourceRefs: [],
};

describe("binding-model", () => {
  it("derives the three display states", () => {
    expect(refState(refDto({ applicable: false, value: null }))).toBe("not-applicable");
    expect(refState(refDto({}))).toBe("unconfirmed");
    expect(refState(refDto({ confirmedBy: "op", confirmedAt: "2026-07-10T00:00:00.000Z" }))).toBe(
      "confirmed",
    );
  });

  it("only allows a plain confirm for an applicable ref with a value", () => {
    expect(canConfirm(refDto({}))).toBe(true);
    expect(canConfirm(refDto({ value: null }))).toBe(false);
    expect(canConfirm(refDto({ applicable: false, value: null }))).toBe(false);
  });

  it("describes targets and the empty guess", () => {
    expect(describeTarget(null)).toContain("no guess");
    expect(describeTarget({ kind: "field", path: "id" })).toBe("field: id");
    expect(describeTarget({ kind: "operation", operationId: "issueList" })).toBe(
      "operation: issueList",
    );
    expect(describeTarget({ kind: "parameter", operationId: "issueList", parameter: "page" })).toBe(
      "parameter: page (issueList)",
    );
  });

  it("defaults the correction kind per ref kind", () => {
    expect(defaultTargetKind("nativeIdRef")).toBe("field");
    expect(defaultTargetKind("collectionReadRef")).toBe("operation");
    expect(defaultTargetKind("paginationRef")).toBe("parameter");
  });

  it("builds deduplicated correction targets from the IR group", () => {
    const options = buildRefTargetOptions(group);
    // Fields from schemas + operation response bodies, deduped.
    expect(options.field.map((option) => option.target)).toEqual([
      { kind: "field", path: "id" },
      { kind: "field", path: "title" },
    ]);
    // Duplicate operationIds collapse to one.
    expect(options.operation).toHaveLength(1);
    expect(options.operation[0]?.target).toEqual({ kind: "operation", operationId: "issueList" });
    // Duplicate operation parameters collapse to one.
    expect(options.parameter).toHaveLength(1);
    expect(options.parameter[0]?.target).toEqual({
      kind: "parameter",
      operationId: "issueList",
      parameter: "page",
    });
  });

  it("returns empty option groups for an undefined group", () => {
    const options = buildRefTargetOptions(undefined);
    expect(options).toEqual({ field: [], operation: [], parameter: [] });
  });
});

function scopeDto(overrides: Partial<ResourceBindingScopeDto>): ResourceBindingScopeDto {
  return {
    parameterName: "owner",
    kind: "constant",
    value: "",
    confirmedBy: null,
    confirmedAt: null,
    ...overrides,
  };
}

describe("binding-model — scope path-parameter bindings (SS-6.2)", () => {
  it("derives confirmed vs. unconfirmed from confirmedAt (no not-applicable state)", () => {
    expect(scopeBindingState(scopeDto({}))).toBe("unconfirmed");
    expect(
      scopeBindingState(
        scopeDto({ value: "alice", confirmedBy: "op", confirmedAt: "2026-07-10T00:00:00.000Z" }),
      ),
    ).toBe("confirmed");
  });

  it("only allows supply+confirm for a non-blank typed value (SS-3.3 reflected)", () => {
    expect(canSupplyScope("")).toBe(false);
    expect(canSupplyScope("   ")).toBe(false);
    expect(canSupplyScope("alice")).toBe(true);
  });
});
