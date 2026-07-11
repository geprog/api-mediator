import type { GeneratedBy } from "@mediator/domain";

import type { HarnessConfig } from "./config.js";

/**
 * The scored-report shape (EH-1 crit 2/3). A report is machine-readable JSON that
 * records, per scenario, the **provider identity** (`generatedBy`) alongside every
 * metric, plus the concrete matched / missed / false-positive items — and it is a
 * **scored report, never a red/green accuracy gate**. The only gate-able outcome
 * is `wellFormed` (a non-empty run that produced a structurally complete report);
 * the accuracy numbers are for humans. Every threshold used is echoed in `config`.
 */

// ── Shared metric shape ──────────────────────────────────────────────────────

/**
 * A matched/total ratio. `ratio` is `null` when `total === 0` (no denominator) so
 * "nothing to measure" is never conflated with "scored zero".
 */
export interface RatioMetric {
  readonly matched: number;
  readonly total: number;
  readonly ratio: number | null;
}

export function ratioMetric(matched: number, total: number): RatioMetric {
  return { matched, total, ratio: total === 0 ? null : matched / total };
}

// ── Endpoints (echoed with their aligned IR resourceRef) ─────────────────────

export interface AlignedResource {
  readonly app: string;
  readonly resource: string;
  /** The produced IR `resourceRef` this ground-truth resource aligned to, or `null` if unresolved. */
  readonly resourceRef: string | null;
}

// ── Stage 1 (EH-2) ───────────────────────────────────────────────────────────

export interface Stage1PairResult {
  readonly kind: "peer-peer" | "consumer-provider";
  readonly source: AlignedResource;
  readonly target: AlignedResource;
  /** Whether both sides aligned to an IR resourceRef present in the detection input. */
  readonly resolved: boolean;
  /** Whether the aligned resource pair appears in the produced `shortlistResult` candidate pairs. */
  readonly shortlisted: boolean;
  /** The shortlist confidence of the matched candidate pair, when shortlisted. */
  readonly shortlistConfidence: number | null;
}

export interface NegativeResult {
  readonly verdict: "ambiguous" | "no-counterpart" | "incorrect-but-tempting";
  readonly source: string;
  readonly target: string | null;
  /** Whether both endpoints aligned to IR resource groups present in the detection input. */
  readonly resolved: boolean;
  /** Whether detection **confidently** proposed this pairing (shortlist entry ≥ threshold or a confident item). */
  readonly confidentlyProposed: boolean;
  /** Whether it appears only as a tolerated low-confidence shortlist entry (acceptable for `ambiguous`). */
  readonly lowConfidenceOnly: boolean;
  /** Whether this negative is a scored failure line (a confident proposal of a `no-counterpart`/`incorrect-but-tempting`/`ambiguous`). */
  readonly scoredFailure: boolean;
  readonly detail: string;
}

export interface Stage1Report {
  /** Candidate pairs per spec pair — the concept's named "shortlist yield" metric. */
  readonly shortlistYield: number | null;
  readonly specPairCount: number;
  readonly totalCandidatePairs: number;
  /** Fraction of RESOLVED ground-truth pairs present in the shortlist. */
  readonly recall: RatioMetric;
  /** Fraction of shortlisted candidate pairs that correspond to a genuine ground-truth pair. */
  readonly precision: RatioMetric;
  /** Ground-truth pairs whose resources could not be aligned to the detection input (e.g. full-spec-only). */
  readonly unresolvedPairs: number;
  readonly pairs: readonly Stage1PairResult[];
  /** The subset of `pairs` NOT shortlisted — the offline escape-hatch proxy (each listed explicitly). */
  readonly shortlistMisses: readonly Stage1PairResult[];
  readonly negatives: readonly NegativeResult[];
  /** The subset of `negatives` that are scored failure lines. */
  readonly negativeFailures: readonly NegativeResult[];
}

// ── Stage 2 (EH-3) ───────────────────────────────────────────────────────────

export interface CrudResult {
  readonly action: string;
  /** Whether detection paired the correct target operation for this CRUD action. */
  readonly hit: boolean;
  readonly detail: string;
}

export interface TransformResult {
  readonly source: string;
  readonly target: string;
  readonly expected: string;
  readonly detected: string | null;
  readonly agrees: boolean;
}

export interface FieldFinding {
  readonly source: string;
  readonly target: string | null;
  readonly detail: string;
}

export interface IdentityResult {
  readonly expectedSource: string | null;
  readonly expectedTarget: string | null;
  /** Whether detection flagged the ground-truth identity pairing with `identityCandidate`. */
  readonly hit: boolean;
  /** For a keyless pair (no natural key): whether detection correctly left `identityCandidate` unset. */
  readonly correctlyAbsent: boolean;
  readonly detail: string;
}

export interface Stage2PeerPairResult {
  readonly kind: "peer-peer";
  readonly source: AlignedResource;
  readonly target: AlignedResource;
  readonly analyzed: boolean;
  readonly crud: readonly CrudResult[];
  readonly fieldPrecision: RatioMetric;
  readonly fieldRecall: RatioMetric;
  readonly identity: IdentityResult;
  readonly transforms: readonly TransformResult[];
  readonly falsePositiveFields: readonly FieldFinding[];
}

/** One consumer operation and whether its expected backend binding resolved — informational. */
export interface ConsumerOpResult {
  readonly consumer: string;
  readonly backends: readonly string[];
  readonly detail: string;
}

export interface Stage2ConsumerPairResult {
  readonly kind: "consumer-provider";
  readonly source: AlignedResource;
  readonly targetApp: string;
  readonly targetResourceRef: string | null;
  readonly analyzed: boolean;
  /** Request-phase field-pair recall (backend request field synthesized/renamed from the consumer field). */
  readonly requestPhase: RatioMetric;
  /** Response-phase field-pair recall (consumer result field mapped from the backend field). */
  readonly responsePhase: RatioMetric;
  /** Fraction of produced phased field items whose `phase` matches the ground-truth phase. */
  readonly phaseCorrectness: RatioMetric;
  /** Fraction of ground-truth parameter mappings produced (`parameterMappings` presence, EH-3 crit 5). */
  readonly parameterCoverage: RatioMetric;
  /** The scenario-3 hard case: a request-phase constant synthesized from a bodyless op (e.g. `done = true`). */
  readonly constantSynthesis: { readonly expected: boolean; readonly detected: boolean } | null;
  readonly operations: readonly ConsumerOpResult[];
}

export type Stage2PairResult = Stage2PeerPairResult | Stage2ConsumerPairResult;

export interface Stage2Report {
  /** Operation CRUD-classification accuracy across every peer-peer pair's actions. */
  readonly crud: RatioMetric;
  readonly fieldPrecision: RatioMetric;
  readonly fieldRecall: RatioMetric;
  /** Identity-candidate hit rate (peer-peer pairs that have a natural key). */
  readonly identityHitRate: RatioMetric;
  /** Transform-kind agreement, with ground-truth `direct` scored against the concept's value-preserving `rename`. */
  readonly transformAgreement: RatioMetric;
  /** Consumer-provider phase correctness across operations. */
  readonly phaseCorrectness: RatioMetric;
  /** Consumer-provider parameter coverage. */
  readonly parameterCoverage: RatioMetric;
  /** Confidently-mapped `plausible`/`unmapped` fields detection should have left alone. */
  readonly falsePositiveFields: readonly FieldFinding[];
  readonly pairs: readonly Stage2PairResult[];
}

// ── Health signal (EH-3 crit 6) ──────────────────────────────────────────────

export interface HealthSignal {
  readonly shortlistRecall: number | null;
  readonly recallFloor: number;
  /** True when shortlist recall is below the configured floor — "stage-1 recall too low". */
  readonly stage1RecallTooLow: boolean;
  readonly message: string;
}

// ── The scenario report ──────────────────────────────────────────────────────

export interface ScenarioReport {
  readonly scenario: string;
  /** The provider identity every metric is attributable to (EH-1 crit 2). */
  readonly generatedBy: GeneratedBy;
  /** The thresholds/floors used — recorded, never asserted as a gate. */
  readonly config: HarnessConfig;
  /** The ONLY gate-able outcome: a non-empty run that produced a complete report. */
  readonly wellFormed: boolean;
  readonly generatedAt: string;
  readonly proposalCount: number;
  readonly failedProposalCount: number;
  readonly stage1: Stage1Report;
  readonly stage2: Stage2Report;
  readonly health: HealthSignal;
  /** Reported modeling findings (e.g. the `direct` → `rename` mapping) — never silent coercions. */
  readonly notes: readonly string[];
}

// ── Human-readable summary ───────────────────────────────────────────────────

function pct(metric: RatioMetric): string {
  if (metric.ratio === null) return "n/a";
  return `${(metric.ratio * 100).toFixed(0)}% (${String(metric.matched)}/${String(metric.total)})`;
}

/** A printable, terminal-friendly summary of a scored report. */
export function formatSummary(report: ScenarioReport): string {
  const lines: string[] = [];
  const { generatedBy: gb, stage1: s1, stage2: s2, health } = report;
  lines.push(`Detection eval — ${report.scenario}`);
  lines.push(`  provider: ${gb.providerId} / ${gb.model} / prompt ${gb.promptVersion}`);
  lines.push(
    `  proposals: ${String(report.proposalCount)} (${String(report.failedProposalCount)} failed) · spec pairs: ${String(s1.specPairCount)}`,
  );
  lines.push(
    `  thresholds: confident ≥ ${String(report.config.confidenceThreshold)} · recall floor ${String(report.config.shortlistRecallFloor)}`,
  );
  lines.push("");
  lines.push("  Stage 1 (shortlist)");
  lines.push(
    `    recall ${pct(s1.recall)} · precision ${pct(s1.precision)} · yield ${s1.shortlistYield === null ? "n/a" : s1.shortlistYield.toFixed(1)} pairs/spec-pair`,
  );
  lines.push(
    `    misses: ${String(s1.shortlistMisses.length)} · unresolved pairs: ${String(s1.unresolvedPairs)}`,
  );
  for (const miss of s1.shortlistMisses) {
    lines.push(
      `      MISS ${miss.source.app}/${miss.source.resource} ↔ ${miss.target.app}/${miss.target.resource}` +
        (miss.resolved ? "" : " (unresolved)"),
    );
  }
  lines.push(
    `    negatives: ${String(s1.negatives.length)} · confident-proposal failures: ${String(s1.negativeFailures.length)}`,
  );
  for (const neg of s1.negativeFailures) {
    lines.push(`      FAIL [${neg.verdict}] ${neg.source} ↔ ${neg.target ?? "∅"} — ${neg.detail}`);
  }
  lines.push("");
  lines.push("  Stage 2 (detail)");
  lines.push(
    `    CRUD ${pct(s2.crud)} · field precision ${pct(s2.fieldPrecision)} · field recall ${pct(s2.fieldRecall)}`,
  );
  lines.push(
    `    identity-candidate hit ${pct(s2.identityHitRate)} · transform agreement ${pct(s2.transformAgreement)}`,
  );
  lines.push(
    `    consumer-provider: phase ${pct(s2.phaseCorrectness)} · parameters ${pct(s2.parameterCoverage)}`,
  );
  if (s2.falsePositiveFields.length > 0) {
    lines.push(
      `    false-positive fields (must-not-map): ${String(s2.falsePositiveFields.length)}`,
    );
    for (const fp of s2.falsePositiveFields) {
      lines.push(`      FP ${fp.source} ↔ ${fp.target ?? "∅"} — ${fp.detail}`);
    }
  }
  lines.push("");
  lines.push(`  Health: ${health.message}`);
  if (report.notes.length > 0) {
    lines.push("  Notes:");
    for (const note of report.notes) lines.push(`    - ${note}`);
  }
  return lines.join("\n");
}
