import {
  isReviewRequired,
  type CandidatePair,
  type MappingProposal,
  type MappingProposalItem,
  type NoCounterpartResource,
} from "@mediator/domain";

import type { SpecReader } from "../persistence.js";

/**
 * The **read** side of the Phase-3 review screen (RA-1): list `MappingProposal`s
 * by directional spec pair, and open one with its `MappingProposalItem`s sorted
 * riskiest-first — `reviewRequired` items first, then ascending confidence /
 * descending ambiguity ([mapping-review-and-approval.md](../../../../docs/flows/mapping-review-and-approval.md)
 * steps 1-2; [mapping-engine.md](../../../../docs/architecture/mapping-engine.md)
 * *Confidence & ambiguity*).
 *
 * A pure read service: it holds no persistence of its own, deriving everything
 * from the injected pooled readers. `reviewRequired` is **derived** against the
 * configured threshold (Phase-2 TD-5) at read time, never a stored column — so a
 * changed threshold re-flags every item without a re-analysis. No response carries
 * credential material.
 */

/** The proposal reads RA-1/RA-2 need — mirrors `MappingProposalRepository`. */
export interface ProposalReader {
  listBySourceSpecId(specId: string): Promise<MappingProposal[]>;
  getById(id: string): Promise<MappingProposal | undefined>;
  listItems(proposalId: string): Promise<MappingProposalItem[]>;
  getItemById(itemId: string): Promise<MappingProposalItem | undefined>;
}

/** The filter for the proposal list (RA-1 crit 1) — a directional spec pair. */
export interface ProposalListFilter {
  readonly sourceSpecId: string;
  readonly targetSpecId?: string;
}

/**
 * A proposal opened for review: the proposal header, its items **sorted
 * riskiest-first** (empty for a `failed` proposal), the configured review
 * threshold used to derive `reviewRequired`, the `shortlistResult` projection
 * (`null` for a `failed` proposal), and the two specs' `analysisExclusions` listed
 * separately as excluded (RA-1 crit 2-5).
 */
export interface ProposalDetail {
  readonly proposal: MappingProposal;
  readonly sortedItems: readonly MappingProposalItem[];
  readonly reviewThreshold: number;
  readonly shortlist: {
    readonly noCounterpartResources: readonly NoCounterpartResource[];
    readonly analysisFailedPairs: readonly CandidatePair[];
  } | null;
  readonly analysisExclusions: readonly NoCounterpartResource[];
}

export interface ProposalReadServiceDeps {
  readonly proposals: ProposalReader;
  readonly specs: SpecReader;
  /** The confidence threshold `reviewRequired` is derived against (TD-5). */
  readonly reviewThreshold: number;
}

export class ProposalReadService {
  readonly #proposals: ProposalReader;
  readonly #specs: SpecReader;
  public readonly reviewThreshold: number;

  public constructor(deps: ProposalReadServiceDeps) {
    this.#proposals = deps.proposals;
    this.#specs = deps.specs;
    this.reviewThreshold = deps.reviewThreshold;
  }

  /**
   * List proposals by directional spec pair (RA-1 crit 1). Filtered by
   * `sourceSpecId` (the `source_spec_id` index) and, when supplied, narrowed to a
   * single `targetSpecId` — the directional proposal key.
   */
  public async list(filter: ProposalListFilter): Promise<MappingProposal[]> {
    const proposals = await this.#proposals.listBySourceSpecId(filter.sourceSpecId);
    if (filter.targetSpecId === undefined) {
      return proposals;
    }
    return proposals.filter((proposal) => proposal.targetSpecId === filter.targetSpecId);
  }

  /**
   * A single proposal item by id (RA-2): the route reads it to enforce the
   * addressed-proposal membership check (a 404 when the item does not exist or
   * belongs to a different proposal) before delegating the decision to the
   * Approval Service.
   */
  public getItem(itemId: string): Promise<MappingProposalItem | undefined> {
    return this.#proposals.getItemById(itemId);
  }

  /**
   * Open a proposal for review (RA-1 crit 2-5): its items sorted riskiest-first,
   * its `shortlistResult` projection, and both specs' `analysisExclusions`. A
   * `failed` proposal (TD-4) returns with **no** items and a `null` shortlist — it
   * needs attention rather than reading as an empty success. Returns `undefined`
   * when no proposal with `id` exists (the route maps that to 404).
   */
  public async getDetail(id: string): Promise<ProposalDetail | undefined> {
    const proposal = await this.#proposals.getById(id);
    if (proposal === undefined) {
      return undefined;
    }

    const analysisExclusions = await this.#exclusionsFor(proposal);

    // A failed proposal carries no reviewable items and a null shortlistResult
    // (the whole-spec-pair shortlist failure) — surface it as needing attention.
    if (proposal.status === "failed" || proposal.shortlistResult === null) {
      return {
        proposal,
        sortedItems: [],
        reviewThreshold: this.reviewThreshold,
        shortlist: null,
        analysisExclusions,
      };
    }

    const items = await this.#proposals.listItems(id);
    const sortedItems = sortReviewItems(items, this.reviewThreshold);
    const analysisFailedPairs = proposal.shortlistResult.candidatePairs
      .filter((pair) => pair.analysisFailed)
      .map(toCandidatePair);

    return {
      proposal,
      sortedItems,
      reviewThreshold: this.reviewThreshold,
      shortlist: {
        noCounterpartResources: proposal.shortlistResult.noCounterpartResources,
        analysisFailedPairs,
      },
      analysisExclusions,
    };
  }

  /** Both specs' `analysisExclusions`, each qualified by its owning `specId`. */
  async #exclusionsFor(proposal: MappingProposal): Promise<NoCounterpartResource[]> {
    const specIds = [proposal.sourceSpecId, proposal.targetSpecId];
    const exclusions: NoCounterpartResource[] = [];
    for (const specId of specIds) {
      const spec = await this.#specs.getById(specId);
      if (spec === undefined) {
        continue;
      }
      for (const resourceRef of spec.analysisExclusions) {
        exclusions.push({ specId, resourceRef });
      }
    }
    return exclusions;
  }
}

/** Drop the `analysisFailed` marker from a persisted shortlist pair for the wire. */
function toCandidatePair(pair: {
  sourceResource: string;
  targetResource: string;
  confidence: number;
  rationale: string;
}): CandidatePair {
  return {
    sourceResource: pair.sourceResource,
    targetResource: pair.targetResource,
    confidence: pair.confidence,
    rationale: pair.rationale,
  };
}

/**
 * Sort proposal items **riskiest-first** for the review screen (RA-1 crit 2):
 * `reviewRequired` items (confidence below `threshold`) first, then **ascending
 * confidence**, then **descending ambiguity** (more `ambiguousAlternatives`
 * first), with a stable final tiebreak on `id` so the order is deterministic.
 * A pure function (does not mutate its input) so it is unit-testable in isolation.
 */
export function sortReviewItems(
  items: readonly MappingProposalItem[],
  threshold: number,
): MappingProposalItem[] {
  return [...items].sort((a, b) => {
    const aReview = isReviewRequired(a, threshold);
    const bReview = isReviewRequired(b, threshold);
    if (aReview !== bReview) {
      return aReview ? -1 : 1;
    }
    if (a.confidenceScore !== b.confidenceScore) {
      return a.confidenceScore - b.confidenceScore;
    }
    if (a.ambiguousAlternatives.length !== b.ambiguousAlternatives.length) {
      return b.ambiguousAlternatives.length - a.ambiguousAlternatives.length;
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}
