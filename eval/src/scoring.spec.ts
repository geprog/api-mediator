import { describe, expect, it } from "vitest";

import { consumerScoringInput, FIXTURE_GENERATED_BY, peerScoringInput } from "./fixtures.js";
import type { Stage2ConsumerPairResult, Stage2PeerPairResult } from "./report.js";
import { scoreScenario } from "./scoring.js";

/**
 * Deterministic scoring tests (the gate-able part of EH-2/EH-3): fixed fixture
 * proposals + fixed ground truth → EXACT metric numbers. No provider, no Ollama —
 * this is what runs in `pnpm verify`.
 */

describe("scoreScenario — peer-peer (EH-2/EH-3)", () => {
  const report = scoreScenario(peerScoringInput());

  it("stage-1 recall / precision / yield are exact", () => {
    expect(report.stage1.recall).toEqual({ matched: 1, total: 1, ratio: 1 });
    expect(report.stage1.precision).toEqual({ matched: 1, total: 3, ratio: 1 / 3 });
    expect(report.stage1.shortlistYield).toBe(3);
    expect(report.stage1.specPairCount).toBe(1);
    expect(report.stage1.totalCandidatePairs).toBe(3);
    expect(report.stage1.unresolvedPairs).toBe(0);
    expect(report.stage1.shortlistMisses).toHaveLength(0);
  });

  it("negatives-avoidance: a confident negative is a failure, a low-confidence ambiguous is not", () => {
    expect(report.stage1.negatives).toHaveLength(2);
    expect(report.stage1.negativeFailures).toHaveLength(1);

    const failure = report.stage1.negativeFailures[0];
    expect(failure?.verdict).toBe("incorrect-but-tempting");
    expect(failure?.confidentlyProposed).toBe(true);

    const ambiguous = report.stage1.negatives.find((n) => n.verdict === "ambiguous");
    expect(ambiguous?.scoredFailure).toBe(false);
    expect(ambiguous?.confidentlyProposed).toBe(false);
    expect(ambiguous?.lowConfidenceOnly).toBe(true);
  });

  it("stage-2 CRUD / field precision-recall / identity are exact", () => {
    expect(report.stage2.crud).toEqual({ matched: 2, total: 2, ratio: 1 });
    expect(report.stage2.fieldPrecision).toEqual({ matched: 2, total: 3, ratio: 2 / 3 });
    expect(report.stage2.fieldRecall).toEqual({ matched: 2, total: 2, ratio: 1 });
    expect(report.stage2.identityHitRate).toEqual({ matched: 1, total: 1, ratio: 1 });
  });

  it("transform agreement scores ground-truth `direct` against the concept's `rename`", () => {
    expect(report.stage2.transformAgreement).toEqual({ matched: 2, total: 2, ratio: 1 });
    const peerPair = report.stage2.pairs[0] as Stage2PeerPairResult;
    const directPair = peerPair.transforms.find((t) => t.expected === "direct");
    expect(directPair?.detected).toBe("rename");
    expect(directPair?.agrees).toBe(true);
  });

  it("flags a confidently-mapped `plausible` field as a false positive", () => {
    expect(report.stage2.falsePositiveFields).toHaveLength(1);
    const fp = report.stage2.falsePositiveFields[0];
    expect(fp?.source).toBe("note");
    expect(fp?.target).toBe("label");
  });

  it("health signal: recall above the floor is not flagged", () => {
    expect(report.health.shortlistRecall).toBe(1);
    expect(report.health.stage1RecallTooLow).toBe(false);
  });
});

describe("scoreScenario — consumer-provider (EH-3 crit 5)", () => {
  const report = scoreScenario(consumerScoringInput());
  const pair = report.stage2.pairs[0] as Stage2ConsumerPairResult;

  it("scores request/response phase recall and phase correctness", () => {
    expect(pair.kind).toBe("consumer-provider");
    expect(pair.responsePhase).toEqual({ matched: 2, total: 2, ratio: 1 });
    expect(pair.requestPhase).toEqual({ matched: 1, total: 1, ratio: 1 });
    expect(pair.phaseCorrectness).toEqual({ matched: 3, total: 3, ratio: 1 });
  });

  it("scores parameter coverage and the constant-synthesis case", () => {
    expect(pair.parameterCoverage).toEqual({ matched: 1, total: 2, ratio: 0.5 });
    expect(pair.constantSynthesis).toEqual({ expected: true, detected: true });
  });

  it("aggregates consumer-provider phase / parameter metrics at the report level", () => {
    expect(report.stage2.phaseCorrectness).toEqual({ matched: 3, total: 3, ratio: 1 });
    expect(report.stage2.parameterCoverage).toEqual({ matched: 1, total: 2, ratio: 0.5 });
    // No peer-peer pairs → the peer-only metrics have no denominator.
    expect(report.stage2.crud.ratio).toBeNull();
    expect(report.stage2.identityHitRate.ratio).toBeNull();
  });
});

describe("scoreScenario — report shape (EH-1 crit 2/3)", () => {
  const report = scoreScenario(peerScoringInput());

  it("is a well-formed, non-empty report attributable to a provider identity", () => {
    expect(report.wellFormed).toBe(true);
    expect(report.proposalCount).toBe(2);
    expect(report.failedProposalCount).toBe(0);
    expect(report.generatedBy).toEqual(FIXTURE_GENERATED_BY);
    expect(typeof report.generatedAt).toBe("string");
    expect(report.notes.length).toBeGreaterThan(0);
    // The direct→rename modeling gap is a REPORTED finding, not a silent coercion.
    expect(report.notes.some((n) => n.includes("direct"))).toBe(true);
  });

  it("records the harness config (thresholds) but never a pass/fail gate", () => {
    expect(report.config).toEqual({ confidenceThreshold: 0.7, shortlistRecallFloor: 0.8 });
    expect(report).not.toHaveProperty("passed");
    expect(report).not.toHaveProperty("gate");
  });
});
