import type { GeneratedBy, MappingProposal, ShortlistResult } from "@mediator/domain";
import { describe, expect, it } from "vitest";

import {
  mapMappingProposalRow,
  toMappingProposalInsert,
  type MappingProposalRow,
} from "./mapping-proposal.js";

const createdAt = new Date("2026-07-10T00:00:00.000Z");

const generatedBy: GeneratedBy = {
  providerId: "ollama",
  model: "glm-4.7-flash",
  promptVersion: "v1",
};

const shortlistResult: ShortlistResult = {
  candidatePairs: [
    {
      sourceResource: "issues",
      targetResource: "tasks",
      confidence: 0.8,
      rationale: "both track work items",
      analysisFailed: false,
    },
    {
      sourceResource: "labels",
      targetResource: "labels",
      confidence: 0.6,
      rationale: "same concept",
      analysisFailed: true,
    },
  ],
  noCounterpartResources: [{ specId: "spec-source", resourceRef: "milestones" }],
};

function proposalRow(overrides: Partial<MappingProposalRow> = {}): MappingProposalRow {
  return {
    id: "prop-1",
    sourceSpecId: "spec-source",
    targetSpecId: "spec-target",
    generatedBy,
    shortlistResult,
    status: "pending",
    createdAt,
    reReviewOf: null,
    ...overrides,
  };
}

describe("mapMappingProposalRow", () => {
  it("maps a pending proposal, keeping generatedBy/shortlistResult jsonb and a real Date", () => {
    const proposal = mapMappingProposalRow(proposalRow());

    expect(proposal).toStrictEqual({
      id: "prop-1",
      sourceSpecId: "spec-source",
      targetSpecId: "spec-target",
      generatedBy,
      shortlistResult,
      status: "pending",
      createdAt,
    } satisfies MappingProposal);
    expect(proposal.createdAt).toBeInstanceOf(Date);
  });

  it("keeps a NULL shortlist_result as domain `null` (a failed proposal), not stripped", () => {
    const proposal = mapMappingProposalRow(
      proposalRow({ status: "failed", shortlistResult: null }),
    );

    expect(proposal.status).toBe("failed");
    expect(proposal.shortlistResult).toBeNull();
    // The key is present (nullable), never omitted — distinct from the item mapper.
    expect("shortlistResult" in proposal).toBe(true);
  });

  it("collapses a NULL re_review_of to an absent key (an ordinary proposal)", () => {
    const proposal = mapMappingProposalRow(proposalRow({ reReviewOf: null }));

    // SL-6 — the optional re-review link is stripped when absent (unlike shortlistResult).
    expect("reReviewOf" in proposal).toBe(false);
  });

  it("maps a stored re_review_of to the domain `reReviewOf` (a re-review proposal)", () => {
    const proposal = mapMappingProposalRow(proposalRow({ reReviewOf: "stale-mapping-1" }));

    expect(proposal.reReviewOf).toBe("stale-mapping-1");
  });
});

describe("toMappingProposalInsert", () => {
  it("projects every column, passing shortlistResult through", () => {
    const proposal: MappingProposal = {
      id: "prop-1",
      sourceSpecId: "spec-source",
      targetSpecId: "spec-target",
      generatedBy,
      shortlistResult,
      status: "pending",
      createdAt,
    };

    expect(toMappingProposalInsert(proposal)).toStrictEqual({
      id: "prop-1",
      sourceSpecId: "spec-source",
      targetSpecId: "spec-target",
      generatedBy,
      shortlistResult,
      status: "pending",
      createdAt,
      // SL-6 — an ordinary proposal has no re-review link → NULL column.
      reReviewOf: null,
    });
  });

  it("writes a re-review proposal's reReviewOf to the column (SL-6)", () => {
    const proposal: MappingProposal = {
      id: "prop-rr",
      sourceSpecId: "spec-source",
      targetSpecId: "spec-target",
      generatedBy,
      shortlistResult,
      status: "pending",
      createdAt,
      reReviewOf: "stale-mapping-1",
    };

    expect(toMappingProposalInsert(proposal).reReviewOf).toBe("stale-mapping-1");
  });

  it("passes a null shortlistResult through unchanged (failed proposal)", () => {
    const proposal: MappingProposal = {
      id: "prop-2",
      sourceSpecId: "spec-source",
      targetSpecId: "spec-target",
      generatedBy,
      shortlistResult: null,
      status: "failed",
      createdAt,
    };

    expect(toMappingProposalInsert(proposal).shortlistResult).toBeNull();
  });

  it("round-trips a proposal through insert → row → domain", () => {
    const proposal: MappingProposal = {
      id: "prop-3",
      sourceSpecId: "spec-source",
      targetSpecId: "spec-target",
      generatedBy,
      shortlistResult,
      status: "partially_approved",
      createdAt,
    };

    const insert = toMappingProposalInsert(proposal);
    const roundTripped = mapMappingProposalRow({
      id: insert.id ?? "prop-3",
      sourceSpecId: insert.sourceSpecId,
      targetSpecId: insert.targetSpecId,
      generatedBy: insert.generatedBy,
      shortlistResult: insert.shortlistResult ?? null,
      status: insert.status,
      createdAt: insert.createdAt ?? createdAt,
      reReviewOf: insert.reReviewOf ?? null,
    });

    expect(roundTripped).toStrictEqual(proposal);
  });

  it("round-trips a re-review proposal's reReviewOf through insert → row → domain (SL-6)", () => {
    const proposal: MappingProposal = {
      id: "prop-rr2",
      sourceSpecId: "spec-source",
      targetSpecId: "spec-target",
      generatedBy,
      shortlistResult,
      status: "pending",
      createdAt,
      reReviewOf: "stale-mapping-2",
    };

    const insert = toMappingProposalInsert(proposal);
    const roundTripped = mapMappingProposalRow({
      id: insert.id ?? "prop-rr2",
      sourceSpecId: insert.sourceSpecId,
      targetSpecId: insert.targetSpecId,
      generatedBy: insert.generatedBy,
      shortlistResult: insert.shortlistResult ?? null,
      status: insert.status,
      createdAt: insert.createdAt ?? createdAt,
      reReviewOf: insert.reReviewOf ?? null,
    });

    expect(roundTripped).toStrictEqual(proposal);
  });
});
