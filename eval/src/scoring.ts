import { type ScoringInput, ScoringContext } from "./context.js";
import type { HealthSignal, ScenarioReport } from "./report.js";
import { scoreStage1 } from "./score-stage1.js";
import { scoreStage2, TRANSFORM_MODELING_NOTE } from "./score-stage2.js";

/**
 * The deterministic scoring core (EH-1..3): a **pure function** of parsed ground
 * truth + loaded specs + produced proposals → a {@link ScenarioReport}. Given the
 * same inputs it always produces the same metric numbers, which is what makes the
 * scoring unit-testable in `pnpm verify` without a live model (a `FakeProvider` or
 * hand-built proposals stand in for the provider). It never invokes a provider,
 * never reaches the network, and never asserts a threshold — it only measures and
 * records (the report is a scored artifact, not a gate).
 */

/** The offline proxy for production escape-hatch usage (EH-3 crit 6). */
function healthSignal(shortlistRecall: number | null, floor: number): HealthSignal {
  const tooLow = shortlistRecall !== null && shortlistRecall < floor;
  const message =
    shortlistRecall === null
      ? "no resolved ground-truth pairs to measure shortlist recall"
      : tooLow
        ? `stage-1 recall too low: ${(shortlistRecall * 100).toFixed(0)}% < floor ${(floor * 100).toFixed(0)}% — the offline escape-hatch signal`
        : `shortlist recall ${(shortlistRecall * 100).toFixed(0)}% ≥ floor ${(floor * 100).toFixed(0)}%`;
  return { shortlistRecall, recallFloor: floor, stage1RecallTooLow: tooLow, message };
}

function buildNotes(input: ScoringInput): string[] {
  return [
    TRANSFORM_MODELING_NOTE,
    "Resource alignment: ground-truth resources are matched to produced IR resource groups by " +
      "operation identity (METHOD/path), so several ground-truth resources may collapse into one " +
      "IR group (the IR groups by tag/path-prefix); shortlist metrics are measured at that group " +
      "granularity.",
    "Shortlist recall is measured over ground-truth pairs whose resources resolve to the detection " +
      "input; full-spec-only pairs (trimmed away) are reported as unresolved, not recall misses.",
    `Scored against provider ${input.generatedBy.providerId}/${input.generatedBy.model} ` +
      `prompt ${input.generatedBy.promptVersion}; thresholds are harness config, never a gate.`,
  ];
}

/** Score one scenario's produced proposals against its ground truth into a scored report. */
export function scoreScenario(input: ScoringInput): ScenarioReport {
  const ctx = new ScoringContext(input);
  const stage1 = scoreStage1(ctx);
  const stage2 = scoreStage2(ctx);
  const health = healthSignal(stage1.recall.ratio, input.config.shortlistRecallFloor);

  const failedProposalCount = input.proposals.filter((p) => p.proposal.status === "failed").length;

  return {
    scenario: input.scenario,
    generatedBy: input.generatedBy,
    config: input.config,
    wellFormed: input.proposals.length > 0,
    generatedAt: new Date().toISOString(),
    proposalCount: input.proposals.length,
    failedProposalCount,
    stage1,
    stage2,
    health,
    notes: buildNotes(input),
  };
}
