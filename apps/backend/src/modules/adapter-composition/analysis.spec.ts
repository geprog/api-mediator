import type { AcknowledgedIgnoredInput } from "@mediator/domain";
import { describe, expect, it } from "vitest";

import {
  acknowledgementInputName,
  acknowledgementMatchesInput,
  analyzeSupplementLoadBearing,
  deriveConsumerInputCoverage,
  topLevelConsumerFieldName,
  type SupplementAnalysisEntry,
} from "./analysis.js";

/**
 * Unit coverage for the CO-4 (supplement load-bearing) and CO-5 (consumer-input
 * coverage) pure derivations: the load-bearing verdict per supplement, the
 * primary-always-fails statement, the fanout-merge-only applicability, the per-binding
 * and endpoint-level unmapped listing, and the required/optional classification — all
 * without touching persistence.
 */

function supplementEntry(
  entries: readonly SupplementAnalysisEntry[],
  bindingId: string,
): Extract<SupplementAnalysisEntry, { kind: "supplement" }> {
  const entry = entries.find((candidate) => candidate.bindingId === bindingId);
  if (entry === undefined || entry.kind !== "supplement") {
    throw new Error(`no supplement entry for ${bindingId}`);
  }
  return entry;
}

describe("topLevelConsumerFieldName", () => {
  it("strips the resource qualification and keeps the top-level record-relative segment", () => {
    expect(topLevelConsumerFieldName("todos/done")).toBe("done");
    expect(topLevelConsumerFieldName("todos/assignee.name")).toBe("assignee");
    expect(topLevelConsumerFieldName("done")).toBe("done");
    expect(topLevelConsumerFieldName("assignee.name")).toBe("assignee");
  });
});

describe("analyzeSupplementLoadBearing — CO-4", () => {
  it("is not applicable outside fanout-merge (CO-4.1)", () => {
    for (const strategy of ["single", "collection-union", "fanout-first-success"] as const) {
      const result = analyzeSupplementLoadBearing({
        aggregationStrategy: strategy,
        bindings: [
          { bindingId: "b1", role: "primary", suppliedConsumerResponseFieldPaths: new Set() },
        ],
        requiredConsumerResponseFieldNames: new Set(),
      });
      expect(result).toStrictEqual({ applicable: false, aggregationStrategy: strategy });
    }
  });

  it("CO-4.1/4.2: a supplement supplying only OPTIONAL consumer fields is degradable (not load-bearing)", () => {
    const result = analyzeSupplementLoadBearing({
      aggregationStrategy: "fanout-merge",
      bindings: [
        { bindingId: "b1", role: "primary", suppliedConsumerResponseFieldPaths: new Set() },
        {
          bindingId: "b2",
          role: "supplement",
          suppliedConsumerResponseFieldPaths: new Set(["todos/tags", "todos/note"]),
        },
      ],
      // `id`/`title` are required; `tags`/`note` are not — the supplement supplies neither.
      requiredConsumerResponseFieldNames: new Set(["id", "title"]),
    });
    expect(result.applicable).toBe(true);
    if (!result.applicable) return;
    const supplement = supplementEntry(result.entries, "b2");
    expect(supplement.allSuppliedFieldsOptional).toBe(true);
    expect(supplement.loadBearing).toBe(false);
    expect(supplement.suppliedConsumerResponseFields).toEqual(["todos/tags", "todos/note"]);
  });

  it("CO-4.2: a supplement supplying ≥1 REQUIRED consumer field is load-bearing (fails even in degraded)", () => {
    const result = analyzeSupplementLoadBearing({
      aggregationStrategy: "fanout-merge",
      bindings: [
        {
          bindingId: "b2",
          role: "supplement",
          // `todos/title` is required (matched by top-level record-relative name).
          suppliedConsumerResponseFieldPaths: new Set(["todos/note", "todos/title"]),
        },
      ],
      requiredConsumerResponseFieldNames: new Set(["title"]),
    });
    expect(result.applicable).toBe(true);
    if (!result.applicable) return;
    const supplement = supplementEntry(result.entries, "b2");
    expect(supplement.allSuppliedFieldsOptional).toBe(false);
    expect(supplement.loadBearing).toBe(true);
  });

  it("CO-4.5: a primary's failure always fails the request (stated independent of strictness)", () => {
    const result = analyzeSupplementLoadBearing({
      aggregationStrategy: "fanout-merge",
      bindings: [
        {
          bindingId: "b1",
          role: "primary",
          suppliedConsumerResponseFieldPaths: new Set(["todos/id"]),
        },
      ],
      requiredConsumerResponseFieldNames: new Set(["id"]),
    });
    expect(result.applicable).toBe(true);
    if (!result.applicable) return;
    expect(result.entries).toEqual([
      { kind: "primary-always-fails", bindingId: "b1", role: "primary" },
    ]);
  });
});

describe("deriveConsumerInputCoverage — CO-5", () => {
  it("CO-5.1: lists per binding the parameters and body fields it does not map", () => {
    const coverage = deriveConsumerInputCoverage({
      consumerInputs: {
        parameters: [
          { name: "todoId", required: true },
          { name: "assignee", required: false },
        ],
        bodyFields: [
          { name: "title", required: true },
          { name: "note", required: false },
        ],
      },
      bindings: [
        {
          bindingId: "b1",
          mappedConsumerParamNames: new Set(["todoId"]),
          mappedConsumerBodyFieldNames: new Set(["title"]),
        },
      ],
      // single binding: unmapped-for-binding == unmapped-by-all.
    });
    expect(coverage.perBinding).toEqual([
      { bindingId: "b1", unmappedParameters: ["assignee"], unmappedBodyFields: ["note"] },
    ]);
    expect(coverage.unmappedByAllBackends).toEqual([
      { kind: "parameter", name: "assignee", required: false },
      { kind: "body-field", name: "note", required: false },
    ]);
  });

  it("CO-5.1 endpoint-level: an input mapped by ONE binding reaches a backend (not unmapped-by-all)", () => {
    const coverage = deriveConsumerInputCoverage({
      consumerInputs: {
        parameters: [{ name: "assignee", required: false }],
        bodyFields: [],
      },
      bindings: [
        {
          bindingId: "b1",
          mappedConsumerParamNames: new Set(["assignee"]),
          mappedConsumerBodyFieldNames: new Set(),
        },
        {
          bindingId: "b2",
          mappedConsumerParamNames: new Set(),
          mappedConsumerBodyFieldNames: new Set(),
        },
      ],
    });
    // b2 does not map `assignee` (per-binding lists it), but b1 does → it reaches a
    // backend, so it is NOT an endpoint-level unmapped-by-all input.
    expect(coverage.perBinding).toEqual([
      { bindingId: "b1", unmappedParameters: [], unmappedBodyFields: [] },
      { bindingId: "b2", unmappedParameters: ["assignee"], unmappedBodyFields: [] },
    ]);
    expect(coverage.unmappedByAllBackends).toEqual([]);
  });

  it("carries the required flag through so CO-5.3 can block a required unmapped input", () => {
    const coverage = deriveConsumerInputCoverage({
      consumerInputs: {
        parameters: [{ name: "tenant", required: true }],
        bodyFields: [{ name: "amount", required: true }],
      },
      bindings: [
        {
          bindingId: "b1",
          mappedConsumerParamNames: new Set(),
          mappedConsumerBodyFieldNames: new Set(),
        },
      ],
    });
    expect(coverage.unmappedByAllBackends).toEqual([
      { kind: "parameter", name: "tenant", required: true },
      { kind: "body-field", name: "amount", required: true },
    ]);
  });
});

describe("acknowledgement matching helpers", () => {
  it("matches a parameter acknowledgement to a parameter input by name only", () => {
    const ack: AcknowledgedIgnoredInput = { kind: "parameter", consumerParamName: "assignee" };
    expect(
      acknowledgementMatchesInput(ack, { kind: "parameter", name: "assignee", required: false }),
    ).toBe(true);
    // Same name but a body field is a different input space.
    expect(
      acknowledgementMatchesInput(ack, { kind: "body-field", name: "assignee", required: false }),
    ).toBe(false);
    expect(acknowledgementInputName(ack)).toBe("assignee");
  });

  it("matches a body-field acknowledgement to a body-field input", () => {
    const ack: AcknowledgedIgnoredInput = { kind: "body-field", consumerFieldPath: "note" };
    expect(
      acknowledgementMatchesInput(ack, { kind: "body-field", name: "note", required: false }),
    ).toBe(true);
    expect(acknowledgementInputName(ack)).toBe("note");
  });
});
