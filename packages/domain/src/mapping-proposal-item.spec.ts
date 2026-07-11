import { describe, expect, it } from "vitest";

import {
  isReviewRequired,
  type MappingProposalItem,
  mappingProposalItemSchema,
  type ProposalElementRef,
} from "./index.js";

function operationRef(operationId: string): ProposalElementRef {
  return { resourceRef: "issues", target: { kind: "operation", operationId } };
}

function fieldRef(path: string): ProposalElementRef {
  return { resourceRef: "issues", target: { kind: "field", path } };
}

/** A mapped operation-kind item — transformSuggestion is null (operations carry none). */
function operationItem(): MappingProposalItem {
  return {
    id: "item-op",
    proposalId: "prop-1",
    kind: "operation",
    sourceRef: operationRef("issueSearchIssues"),
    targetRef: operationRef("tasks_list"),
    transformSuggestion: null,
    confidenceScore: 0.8,
    ambiguousAlternatives: [],
    unmapped: false,
    rationale: "both list work items",
    reviewState: "pending",
  };
}

/** A mapped peer-peer field-kind item — a transformSuggestion, no phase. */
function peerPeerFieldItem(): MappingProposalItem {
  return {
    id: "item-field",
    proposalId: "prop-1",
    kind: "field",
    sourceRef: fieldRef("title"),
    targetRef: fieldRef("title"),
    transformSuggestion: { transform: "rename" },
    confidenceScore: 0.95,
    ambiguousAlternatives: [{ targetRef: fieldRef("name"), confidence: 0.4 }],
    unmapped: false,
    rationale: "same title",
    reviewState: "pending",
  };
}

describe("MappingProposalItem schema", () => {
  it("accepts a mapped operation item with a null transformSuggestion", () => {
    expect(mappingProposalItemSchema.safeParse(operationItem()).success).toBe(true);
  });

  it("accepts a mapped peer-peer field item (transformSuggestion, no phase)", () => {
    expect(mappingProposalItemSchema.safeParse(peerPeerFieldItem()).success).toBe(true);
  });

  it("accepts a consumer-provider field item carrying a phase", () => {
    const result = mappingProposalItemSchema.safeParse({
      ...peerPeerFieldItem(),
      phase: "response",
    });
    expect(result.success).toBe(true);
  });

  it("accepts a parameter item with a populated transformSuggestion", () => {
    const result = mappingProposalItemSchema.safeParse({
      id: "item-param",
      proposalId: "prop-1",
      kind: "parameter",
      sourceRef: {
        resourceRef: "issues",
        target: { kind: "parameter", operationId: "get", parameter: "id" },
      },
      targetRef: {
        resourceRef: "tasks",
        target: { kind: "parameter", operationId: "get", parameter: "taskId" },
      },
      transformSuggestion: { transform: "coerce", detail: "string→int" },
      confidenceScore: 0.7,
      ambiguousAlternatives: [],
      unmapped: false,
      rationale: "path id",
      reviewState: "pending",
    });
    expect(result.success).toBe(true);
  });

  it("accepts an unmapped item with no targetRef and no transformSuggestion", () => {
    const result = mappingProposalItemSchema.safeParse({
      id: "item-unmapped",
      proposalId: "prop-1",
      kind: "field",
      sourceRef: fieldRef("legacyCode"),
      confidenceScore: 0.1,
      ambiguousAlternatives: [],
      unmapped: true,
      rationale: "no counterpart",
      reviewState: "pending",
    });
    expect(result.success).toBe(true);
  });

  it("rejects an unmapped item that still carries a targetRef", () => {
    const result = mappingProposalItemSchema.safeParse({
      ...peerPeerFieldItem(),
      unmapped: true,
    });
    // peerPeerFieldItem has a targetRef + transformSuggestion, which unmapped forbids.
    expect(result.success).toBe(false);
  });

  it("rejects an unmapped item that still carries a transformSuggestion", () => {
    const result = mappingProposalItemSchema.safeParse({
      id: "item-bad",
      proposalId: "prop-1",
      kind: "field",
      sourceRef: fieldRef("legacyCode"),
      transformSuggestion: { transform: "rename" },
      confidenceScore: 0.1,
      ambiguousAlternatives: [],
      unmapped: true,
      rationale: "no counterpart",
      reviewState: "pending",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a phase on a non-field (operation) item", () => {
    const result = mappingProposalItemSchema.safeParse({ ...operationItem(), phase: "request" });
    expect(result.success).toBe(false);
  });

  it("rejects an operation item carrying a transformSuggestion object (unrepresentable)", () => {
    // An operation item must never carry a transform — the superRefine makes the
    // engine bug that put one here impossible to represent.
    const result = mappingProposalItemSchema.safeParse({
      ...operationItem(),
      transformSuggestion: { transform: "rename" },
    });
    expect(result.success).toBe(false);
  });

  it("rejects a mapped field item whose transformSuggestion is null", () => {
    // A mapped field always transforms (a field suggestion always names one), so
    // a null transform on a mapped field is malformed.
    const result = mappingProposalItemSchema.safeParse({
      ...peerPeerFieldItem(),
      transformSuggestion: null,
    });
    expect(result.success).toBe(false);
  });

  it("rejects a mapped field item with no transformSuggestion at all", () => {
    const withoutTransform: Record<string, unknown> = { ...peerPeerFieldItem() };
    delete withoutTransform["transformSuggestion"];
    const result = mappingProposalItemSchema.safeParse(withoutTransform);
    expect(result.success).toBe(false);
  });

  it("accepts a mapped parameter item that passes through with a null transformSuggestion", () => {
    // A pass-through parameter (ParameterSuggestion.transform is optional) carries
    // null — the parameter branch is deliberately looser than the field branch.
    const result = mappingProposalItemSchema.safeParse({
      id: "item-param-passthrough",
      proposalId: "prop-1",
      kind: "parameter",
      sourceRef: {
        resourceRef: "issues",
        target: { kind: "parameter", operationId: "get", parameter: "owner" },
      },
      targetRef: {
        resourceRef: "tasks",
        target: { kind: "parameter", operationId: "get", parameter: "project" },
      },
      transformSuggestion: null,
      confidenceScore: 0.7,
      ambiguousAlternatives: [],
      unmapped: false,
      rationale: "owner scopes issues; project scopes tasks",
      reviewState: "pending",
    });
    expect(result.success).toBe(true);
  });

  it("rejects a confidenceScore outside 0..1", () => {
    const result = mappingProposalItemSchema.safeParse({
      ...peerPeerFieldItem(),
      confidenceScore: 1.2,
    });
    expect(result.success).toBe(false);
  });
});

describe("isReviewRequired (derived, TD-5)", () => {
  it("flags an item strictly below the threshold, not one at or above it", () => {
    expect(isReviewRequired({ confidenceScore: 0.6 }, 0.7)).toBe(true);
    // Exactly at the threshold is not flagged.
    expect(isReviewRequired({ confidenceScore: 0.7 }, 0.7)).toBe(false);
    expect(isReviewRequired({ confidenceScore: 0.85 }, 0.7)).toBe(false);
  });

  it("follows the threshold — the same item flips as the threshold changes", () => {
    const item = { confidenceScore: 0.75 };
    expect(isReviewRequired(item, 0.7)).toBe(false);
    expect(isReviewRequired(item, 0.8)).toBe(true);
  });
});
