import type { MappingProposalItemDto } from "@mediator/contracts";
import { describe, expect, it } from "vitest";

import {
  buildEditRequest,
  deriveProposalVariant,
  describeElementRef,
  identityCandidateItems,
  initialEditDraft,
  isRenameItem,
  suggestedIdentityItemId,
} from "./proposal-model";

/** A peer-peer field item with sensible defaults, overridable per test. */
function fieldItem(overrides: Partial<MappingProposalItemDto> = {}): MappingProposalItemDto {
  return {
    id: "item-field",
    proposalId: "prop-1",
    kind: "field",
    sourceRef: { resourceRef: "issues", target: { kind: "field", path: "title" } },
    targetRef: { resourceRef: "tasks", target: { kind: "field", path: "name" } },
    transformSuggestion: { transform: "rename" },
    confidenceScore: 0.9,
    reviewRequired: false,
    ambiguousAlternatives: [],
    unmapped: false,
    rationale: "title maps to name",
    reviewState: "pending",
    ...overrides,
  };
}

describe("deriveProposalVariant", () => {
  it("is consumer-provider when an item carries a phase", () => {
    expect(deriveProposalVariant([fieldItem({ phase: "request" })])).toBe("consumer-provider");
  });

  it("is consumer-provider when a parameter-kind item is present", () => {
    const parameter = fieldItem({
      id: "p",
      kind: "parameter",
      targetRef: {
        resourceRef: "tasks",
        target: { kind: "parameter", operationId: "op", parameter: "q" },
      },
    });
    expect(deriveProposalVariant([parameter])).toBe("consumer-provider");
  });

  it("is peer-peer for phase-less field items", () => {
    expect(deriveProposalVariant([fieldItem()])).toBe("peer-peer");
  });

  it("is indeterminate for an operation-only (or empty) proposal", () => {
    const operation = fieldItem({
      id: "op",
      kind: "operation",
      transformSuggestion: null,
      sourceRef: { resourceRef: "issues", target: { kind: "operation", operationId: "list" } },
      targetRef: { resourceRef: "tasks", target: { kind: "operation", operationId: "index" } },
    });
    expect(deriveProposalVariant([operation])).toBe("indeterminate");
    expect(deriveProposalVariant([])).toBe("indeterminate");
  });
});

describe("identity candidates", () => {
  it("lists only mapped peer-peer field items", () => {
    const mapped = fieldItem({ id: "a" });
    const unmapped = fieldItem({
      id: "b",
      unmapped: true,
      targetRef: undefined,
      transformSuggestion: undefined,
    });
    const phased = fieldItem({ id: "c", phase: "response" });
    const candidates = identityCandidateItems([mapped, unmapped, phased]);
    expect(candidates.map((item) => item.id)).toEqual(["a"]);
  });

  it("returns the LLM-flagged identityCandidate as the pre-selection", () => {
    const plain = fieldItem({ id: "a" });
    const flagged = fieldItem({ id: "b", identityCandidate: true });
    expect(suggestedIdentityItemId([plain, flagged])).toBe("b");
  });

  it("returns null when no candidate is flagged", () => {
    expect(suggestedIdentityItemId([fieldItem({ id: "a" })])).toBeNull();
  });
});

describe("isRenameItem", () => {
  it("is true only for a rename transform", () => {
    expect(isRenameItem(fieldItem({ transformSuggestion: { transform: "rename" } }))).toBe(true);
    expect(isRenameItem(fieldItem({ transformSuggestion: { transform: "coerce" } }))).toBe(false);
    expect(isRenameItem(fieldItem({ transformSuggestion: null }))).toBe(false);
  });
});

describe("describeElementRef", () => {
  it("renders each element kind", () => {
    expect(describeElementRef({ resourceRef: "r", target: { kind: "field", path: "a.b" } })).toBe(
      "r · field a.b",
    );
    expect(
      describeElementRef({ resourceRef: "r", target: { kind: "operation", operationId: "op" } }),
    ).toBe("r · operation op");
    expect(
      describeElementRef({
        resourceRef: "r",
        target: { kind: "parameter", operationId: "op", parameter: "q" },
      }),
    ).toBe("r · parameter op.q");
  });
});

describe("buildEditRequest", () => {
  it("builds a field edit with target + transform", () => {
    const draft = initialEditDraft(
      fieldItem({ transformSuggestion: { transform: "coerce", detail: "toString" } }),
    );
    const request = buildEditRequest(draft);
    expect(request).toEqual({
      decision: "edit",
      targetRef: { resourceRef: "tasks", target: { kind: "field", path: "name" } },
      transform: { transform: "coerce", detail: "toString" },
    });
  });

  it("builds an operation edit without a transform", () => {
    const draft = initialEditDraft(
      fieldItem({
        kind: "operation",
        transformSuggestion: null,
        sourceRef: { resourceRef: "issues", target: { kind: "operation", operationId: "list" } },
        targetRef: { resourceRef: "tasks", target: { kind: "operation", operationId: "index" } },
      }),
    );
    const request = buildEditRequest(draft);
    expect(request).toEqual({
      decision: "edit",
      targetRef: { resourceRef: "tasks", target: { kind: "operation", operationId: "index" } },
    });
  });

  it("seeds an unmapped item's draft from the source resource, no target path", () => {
    const draft = initialEditDraft(
      fieldItem({ unmapped: true, targetRef: undefined, transformSuggestion: undefined }),
    );
    expect(draft).toMatchObject({ kind: "field", resourceRef: "issues", path: "" });
  });
});
