import { describe, expect, it } from "vitest";

import {
  type MappingProposal,
  mappingProposalSchema,
  type ShortlistResult,
  shortlistResultSchema,
} from "./index.js";

/**
 * A shortlist result carrying all three enrichment products: candidate pairs
 * (one analyzed successfully, one marked `analysisFailed`) plus the mechanically
 * computed no-counterpart set.
 */
function enrichedShortlistResult(): ShortlistResult {
  return {
    candidatePairs: [
      {
        sourceResource: "issues",
        targetResource: "tasks",
        confidence: 0.9,
        rationale: "both track work items",
        analysisFailed: false,
      },
      {
        sourceResource: "milestones",
        targetResource: "projects",
        confidence: 0.71,
        rationale: "plausible grouping",
        analysisFailed: true,
      },
    ],
    noCounterpartResources: [
      { specId: "spec-source", resourceRef: "labels" },
      { specId: "spec-target", resourceRef: "buckets" },
    ],
  };
}

function pendingProposal(): MappingProposal {
  return {
    id: "prop-1",
    sourceSpecId: "spec-source",
    targetSpecId: "spec-target",
    generatedBy: { providerId: "fake", model: "fake-1", promptVersion: "v1" },
    shortlistResult: enrichedShortlistResult(),
    status: "pending",
    createdAt: new Date("2026-07-10T12:00:00.000Z"),
  };
}

describe("shortlistResult schema", () => {
  it("round-trips candidate pairs, no-counterpart set, and an analysisFailed marker", () => {
    const parsed = shortlistResultSchema.parse(enrichedShortlistResult());
    expect(parsed.candidatePairs).toHaveLength(2);
    expect(parsed.candidatePairs.map((p) => p.analysisFailed)).toEqual([false, true]);
    expect(parsed.noCounterpartResources).toEqual([
      { specId: "spec-source", resourceRef: "labels" },
      { specId: "spec-target", resourceRef: "buckets" },
    ]);
  });

  it("requires every candidate pair to carry an analysisFailed marker", () => {
    const result = shortlistResultSchema.safeParse({
      candidatePairs: [
        { sourceResource: "issues", targetResource: "tasks", confidence: 0.9, rationale: "x" },
      ],
      noCounterpartResources: [],
    });
    expect(result.success).toBe(false);
  });
});

describe("MappingProposal schema", () => {
  it("accepts a pending directional proposal with an enriched shortlistResult", () => {
    const parsed = mappingProposalSchema.parse(pendingProposal());
    expect(parsed.status).toBe("pending");
    expect(parsed.sourceSpecId).toBe("spec-source");
    expect(parsed.generatedBy.promptVersion).toBe("v1");
    expect(parsed.shortlistResult).not.toBeNull();
  });

  it("accepts a failed proposal with a null shortlistResult (stage-1 failure)", () => {
    const result = mappingProposalSchema.safeParse({
      ...pendingProposal(),
      status: "failed",
      shortlistResult: null,
    });
    expect(result.success).toBe(true);
  });

  it("rejects an unknown status", () => {
    const result = mappingProposalSchema.safeParse({ ...pendingProposal(), status: "in_review" });
    expect(result.success).toBe(false);
  });

  it("rejects a proposal missing generatedBy provenance", () => {
    const noProvenance: Record<string, unknown> = {
      id: "prop-2",
      sourceSpecId: "spec-source",
      targetSpecId: "spec-target",
      shortlistResult: enrichedShortlistResult(),
      status: "pending",
      createdAt: new Date(),
    };
    expect(mappingProposalSchema.safeParse(noProvenance).success).toBe(false);
  });
});
