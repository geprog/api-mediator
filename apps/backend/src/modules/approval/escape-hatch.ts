import type { Counter } from "@opentelemetry/api";
import type {
  ApiSpec,
  MappingProposal,
  MappingProposalItem,
  NoCounterpartResource,
  ShortlistResult,
} from "@mediator/domain";
import {
  analyzeCandidate,
  unorderedPairKey,
  type CandidateSpecPair,
  type DetectionDeps,
  type ShortlistOutcome,
} from "@mediator/mapping-engine";
import { getMeter } from "@mediator/telemetry";

import { BadRequestError, NotFoundError } from "../../app-errors.js";
import { noopDetectionMetricsSink, type DetectionMetricsSink } from "../detection/telemetry.js";
import type { SpecReader } from "../persistence.js";
import { deriveVariant } from "./approval-service.js";

/**
 * The **shortlist-miss escape hatch** (RA-5): a scoped stage-2 detail analysis for
 * one resource pair the stage-1 shortlist missed, reusing the Phase-2 detail path
 * (`@mediator/mapping-engine` `analyzeCandidate`, TD-2) over exactly one candidate
 * pair. On success the produced `MappingProposalItem`s are attached to the
 * **existing** proposal and the analyzed resource leaves the no-counterpart set; on
 * a retry-ceiling failure the pair is marked `analysisFailed` and surfaced as
 * needing attention ([mapping-review-and-approval.md](../../../../docs/flows/mapping-review-and-approval.md)
 * step 2; [mapping-engine.md](../../../../docs/architecture/mapping-engine.md)
 * *Escape hatch*).
 *
 * A resource the operator **excluded** via `analysisExclusions` is refused: analyzing
 * it means removing its exclusion, a deliberate scope edit (Phase 6), not a
 * review-screen override (*Scoping down*). The LLM call runs **outside** any
 * transaction (like the detection worker); only the attach — new items +
 * `shortlistResult` — is one atomic write. Every run is OTel-observable as a
 * manually-triggered detail analysis (the shortlist-recall health signal).
 */

/** The outcome of one escape-hatch run. */
export type EscapeHatchOutcome = "attached" | "analysis_failed";

/** The proposal read the escape hatch needs — mirrors `MappingProposalRepository`. */
export interface EscapeHatchProposalReader {
  getById(id: string): Promise<MappingProposal | undefined>;
}

/** The atomic attach: append items + replace the proposal's `shortlistResult`. */
export interface EscapeHatchWriter {
  attach(input: {
    readonly proposalId: string;
    readonly items: readonly MappingProposalItem[];
    readonly shortlistResult: ShortlistResult;
  }): Promise<void>;
}

/** OTel seam for the manually-triggered detail analysis (RA-5 crit 6). */
export interface EscapeHatchTelemetry {
  onAnalysis(outcome: EscapeHatchOutcome): void;
}

/** A total no-op telemetry (tests / telemetry-disabled). */
export const noopEscapeHatchTelemetry: EscapeHatchTelemetry = {
  onAnalysis(): void {
    /* no-op */
  },
};

/**
 * The OTel-backed {@link EscapeHatchTelemetry}: a counter of manually-triggered
 * detail analyses, labeled by `provider` and `outcome` — the health signal for
 * shortlist recall (observability.md). No-ops cleanly when telemetry is disabled
 * (`getMeter` returns the API's no-op meter).
 */
export function createEscapeHatchTelemetry(provider: string): EscapeHatchTelemetry {
  const meter = getMeter("@mediator/mapping-engine");
  const escapeHatch: Counter = meter.createCounter("mapping.detection.escape_hatch.count", {
    description: "Operator-triggered shortlist-miss escape-hatch detail analyses by outcome",
  });
  return {
    onAnalysis(outcome: EscapeHatchOutcome): void {
      escapeHatch.add(1, { provider, outcome });
    },
  };
}

/** The request the escape hatch validates + analyzes (RA-5). */
export interface AnalyzeResourcePairInput {
  readonly proposalId: string;
  readonly sourceResourceRef: string;
  readonly targetResourceRef: string;
}

/** The escape-hatch result: outcome, attached-item count, and the updated shortlist. */
export interface EscapeHatchResult {
  readonly outcome: EscapeHatchOutcome;
  readonly attachedItemCount: number;
  readonly shortlistResult: ShortlistResult;
}

export interface EscapeHatchServiceDeps {
  readonly proposals: EscapeHatchProposalReader;
  readonly specs: SpecReader;
  /** The detection detail-path deps (provider + retry cap + prompt version). */
  readonly detection: DetectionDeps;
  readonly writer: EscapeHatchWriter;
  /** OTel sink for the reused detail LLM call's metrics (default: no-op). */
  readonly metricsSink?: DetectionMetricsSink;
  /** OTel seam for the manual-trigger health signal (default: no-op). */
  readonly telemetry?: EscapeHatchTelemetry;
}

export class EscapeHatchService {
  readonly #proposals: EscapeHatchProposalReader;
  readonly #specs: SpecReader;
  readonly #detection: DetectionDeps;
  readonly #writer: EscapeHatchWriter;
  readonly #metricsSink: DetectionMetricsSink;
  readonly #telemetry: EscapeHatchTelemetry;

  public constructor(deps: EscapeHatchServiceDeps) {
    this.#proposals = deps.proposals;
    this.#specs = deps.specs;
    this.#detection = deps.detection;
    this.#writer = deps.writer;
    this.#metricsSink = deps.metricsSink ?? noopDetectionMetricsSink;
    this.#telemetry = deps.telemetry ?? noopEscapeHatchTelemetry;
  }

  /**
   * Analyze one resource pair the shortlist missed (RA-5). Validates the pair (both
   * refs resolve; at least one side is in the no-counterpart set; neither is an
   * `analysisExclusion` — refused as a scope edit) **before** spending any LLM
   * budget, runs the reused scoped detail analysis, then atomically attaches the
   * items and updates the proposal's `shortlistResult`.
   */
  public async analyzePair(input: AnalyzeResourcePairInput): Promise<EscapeHatchResult> {
    const proposal = await this.#proposals.getById(input.proposalId);
    if (proposal === undefined) {
      throw new NotFoundError(`Mapping proposal ${input.proposalId} does not exist.`);
    }
    if (proposal.status === "failed" || proposal.shortlistResult === null) {
      throw new BadRequestError(
        "A failed proposal has no shortlist to extend: its whole spec-pair analysis failed.",
      );
    }
    const shortlist = proposal.shortlistResult;

    const sourceSpec = await this.#specs.getById(proposal.sourceSpecId);
    const targetSpec = await this.#specs.getById(proposal.targetSpecId);
    if (sourceSpec === undefined || targetSpec === undefined) {
      throw new BadRequestError("The proposal references a spec that no longer exists.");
    }

    // AC-3: refuse an excluded resource BEFORE any analysis — re-including it is a
    // deliberate scope edit (Phase 6), not a review-screen override.
    if (sourceSpec.analysisExclusions.includes(input.sourceResourceRef)) {
      throw excludedError(input.sourceResourceRef);
    }
    if (targetSpec.analysisExclusions.includes(input.targetResourceRef)) {
      throw excludedError(input.targetResourceRef);
    }

    // Both refs must resolve to real in-scope resource groups.
    if (!resourceResolves(sourceSpec, input.sourceResourceRef)) {
      throw new BadRequestError(
        `Source resource ${input.sourceResourceRef} does not resolve against the source spec's IR.`,
      );
    }
    if (!resourceResolves(targetSpec, input.targetResourceRef)) {
      throw new BadRequestError(
        `Target resource ${input.targetResourceRef} does not resolve against the target spec's IR.`,
      );
    }

    // AC-1: the escape hatch analyzes a resource the shortlist missed — at least
    // one side must be in the no-counterpart set.
    const sourceMissed = isNoCounterpart(shortlist.noCounterpartResources, {
      specId: sourceSpec.id,
      resourceRef: input.sourceResourceRef,
    });
    const targetMissed = isNoCounterpart(shortlist.noCounterpartResources, {
      specId: targetSpec.id,
      resourceRef: input.targetResourceRef,
    });
    if (!sourceMissed && !targetMissed) {
      throw new BadRequestError(
        "The escape hatch analyzes a shortlist miss: at least one side of the pair must be in the no-counterpart set.",
      );
    }

    const variant = deriveVariant(sourceSpec.role, targetSpec.role);
    const analysis = await this.#runScopedDetail(input, sourceSpec, targetSpec, variant);

    const analyzedPair = analysis.shortlistResult?.candidatePairs[0];
    if (analyzedPair === undefined) {
      // Unreachable: a single-pair scoped analysis always yields exactly one pair.
      throw new Error("Escape hatch: the scoped detail analysis produced no candidate pair.");
    }
    const analysisFailed = analyzedPair.analysisFailed;

    // Re-parent the produced items onto the EXISTING proposal (analyzeCandidate
    // built them against a throwaway proposal id).
    const attachedItems = analysis.items.map((item) => ({ ...item, proposalId: input.proposalId }));

    // On success the analyzed resource leaves the no-counterpart set (AC-2); on
    // failure it stays so it can be retried (AC-5).
    const noCounterpartResources = analysisFailed
      ? shortlist.noCounterpartResources
      : shortlist.noCounterpartResources.filter(
          (resource) =>
            !endpointMatches(resource, sourceSpec.id, input.sourceResourceRef) &&
            !endpointMatches(resource, targetSpec.id, input.targetResourceRef),
        );

    const shortlistResult: ShortlistResult = {
      candidatePairs: [...shortlist.candidatePairs, analyzedPair],
      noCounterpartResources,
    };

    await this.#writer.attach({
      proposalId: input.proposalId,
      items: attachedItems,
      shortlistResult,
    });

    const outcome: EscapeHatchOutcome = analysisFailed ? "analysis_failed" : "attached";
    this.#telemetry.onAnalysis(outcome);

    return { outcome, attachedItemCount: attachedItems.length, shortlistResult };
  }

  /**
   * Reuse the Phase-2 stage-2 detail path (`analyzeCandidate`, TD-2) over a
   * **single scoped candidate pair**. The detail LLM call's metrics flow through
   * the detection sink (so a retry-ceiling failure records
   * `mapping.detection.retry_ceiling.count{stage=detail}` — the shortlist-recall
   * health signal). The synthesized shortlist outcome is never emitted (no stage-1
   * call is made); it only carries the one manually-chosen pair.
   */
  async #runScopedDetail(
    input: AnalyzeResourcePairInput,
    sourceSpec: ApiSpec,
    targetSpec: ApiSpec,
    variant: CandidateSpecPair["variant"],
  ): Promise<{
    readonly items: readonly MappingProposalItem[];
    readonly shortlistResult: ShortlistResult | null;
  }> {
    const candidate: CandidateSpecPair = {
      sourceSpecId: sourceSpec.id,
      targetSpecId: targetSpec.id,
      variant,
      unorderedKey: unorderedPairKey(sourceSpec.id, targetSpec.id),
    };
    // canonicalSourceId = the proposal's source, so the pair maps 1:1 onto this
    // direction (no re-orientation) inside analyzeCandidate.
    const shortlist: ShortlistOutcome = {
      status: "ok",
      canonicalSourceId: sourceSpec.id,
      canonicalTargetId: targetSpec.id,
      candidatePairs: [
        {
          sourceResource: input.sourceResourceRef,
          targetResource: input.targetResourceRef,
          confidence: 1,
          rationale:
            "Operator-triggered escape-hatch pairing (stage-1 shortlist missed this pair).",
        },
      ],
      noCounterpartResources: [],
      metrics: {
        stage: "shortlist",
        outcome: "success",
        attempts: 0,
        durationMs: 0,
        usage: { promptEvalCount: 0, evalCount: 0 },
      },
    };

    const analysis = await analyzeCandidate(
      candidate,
      { source: sourceSpec, target: targetSpec },
      shortlist,
      {
        ...this.#detection,
        onMetrics: (metrics): void => {
          this.#metricsSink.onLlmCall(metrics);
        },
      },
    );
    return { items: analysis.items, shortlistResult: analysis.proposal.shortlistResult };
  }
}

function excludedError(resourceRef: string): BadRequestError {
  return new BadRequestError(
    `Resource ${resourceRef} is excluded from analysis: re-include it via a scope edit before analyzing it (analysisExclusions is not overridable from the review screen).`,
  );
}

function resourceResolves(spec: ApiSpec, resourceRef: string): boolean {
  return spec.parsedIR.some((group) => group.resourceRef === resourceRef);
}

function isNoCounterpart(
  resources: readonly NoCounterpartResource[],
  target: NoCounterpartResource,
): boolean {
  return resources.some((resource) => endpointMatches(resource, target.specId, target.resourceRef));
}

function endpointMatches(
  resource: NoCounterpartResource,
  specId: string,
  resourceRef: string,
): boolean {
  return resource.specId === specId && resource.resourceRef === resourceRef;
}
