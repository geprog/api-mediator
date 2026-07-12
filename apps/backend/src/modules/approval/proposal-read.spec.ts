import type { MappingProposalItem, ProposalElementRef } from "@mediator/domain";
import { describe, expect, it } from "vitest";

import { sortReviewItems } from "./proposal-read.js";

/**
 * Unit tests for the pure `sortReviewItems` ordering (RA-1 crit 2): riskiest-first
 * — `reviewRequired` (confidence below threshold) items first, then ascending
 * confidence, then descending ambiguity, with a deterministic id tiebreak.
 */

function operationRef(operationId: string): ProposalElementRef {
  return { resourceRef: "res", target: { kind: "operation", operationId } };
}

/** A minimal mapped `kind = operation` item (the fields the sort reads). */
function item(input: {
  id: string;
  confidenceScore: number;
  ambiguityCount?: number;
}): MappingProposalItem {
  return {
    id: input.id,
    proposalId: "proposal",
    kind: "operation",
    sourceRef: operationRef(`src-${input.id}`),
    targetRef: operationRef(`tgt-${input.id}`),
    transformSuggestion: null,
    confidenceScore: input.confidenceScore,
    ambiguousAlternatives: Array.from({ length: input.ambiguityCount ?? 0 }, (_, index) => ({
      targetRef: operationRef(`alt-${input.id}-${String(index)}`),
      confidence: 0.5,
    })),
    unmapped: false,
    rationale: "r",
    reviewState: "pending",
  };
}

describe("sortReviewItems (RA-1)", () => {
  it("puts reviewRequired (below-threshold) items first, then ascending confidence", () => {
    const items = [
      item({ id: "high", confidenceScore: 0.95 }),
      item({ id: "low", confidenceScore: 0.2 }),
      item({ id: "mid", confidenceScore: 0.65 }),
    ];

    const sorted = sortReviewItems(items, 0.7);

    // low (0.2) + mid (0.65) are reviewRequired and come first, ascending; high last.
    expect(sorted.map((entry) => entry.id)).toEqual(["low", "mid", "high"]);
  });

  it("treats an item exactly at the threshold as not reviewRequired", () => {
    const items = [
      item({ id: "at", confidenceScore: 0.7 }),
      item({ id: "below", confidenceScore: 0.699 }),
    ];

    const sorted = sortReviewItems(items, 0.7);

    // `below` is reviewRequired (< threshold); `at` (== threshold) is not.
    expect(sorted.map((entry) => entry.id)).toEqual(["below", "at"]);
  });

  it("breaks equal confidence by descending ambiguity, then by id", () => {
    const items = [
      item({ id: "b", confidenceScore: 0.9, ambiguityCount: 0 }),
      item({ id: "a", confidenceScore: 0.9, ambiguityCount: 2 }),
      item({ id: "c", confidenceScore: 0.9, ambiguityCount: 0 }),
    ];

    const sorted = sortReviewItems(items, 0.7);

    // Most ambiguous first (a); the two zero-ambiguity items tiebreak by id (b, c).
    expect(sorted.map((entry) => entry.id)).toEqual(["a", "b", "c"]);
  });

  it("does not mutate its input", () => {
    const items = [
      item({ id: "x", confidenceScore: 0.9 }),
      item({ id: "y", confidenceScore: 0.1 }),
    ];
    const before = items.map((entry) => entry.id);

    sortReviewItems(items, 0.7);

    expect(items.map((entry) => entry.id)).toEqual(before);
  });
});
