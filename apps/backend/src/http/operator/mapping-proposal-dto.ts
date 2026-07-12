import type {
  ApprovedMappingRefDto,
  MappingProposalDetailResponse,
  MappingProposalItemDto,
  MappingProposalSummaryDto,
  ProposalShortlistDto,
} from "@mediator/contracts";
import {
  isReviewRequired,
  type ApprovedMapping,
  type MappingProposal,
  type MappingProposalItem,
  type ShortlistResult,
} from "@mediator/domain";

import type { ProposalDetail } from "../../modules/approval/index.js";

/**
 * Domain entity → wire DTO mappers for the Phase-3 review & approval API (RA-1,
 * RA-4, RA-5). Built **explicitly** (never by spreading a domain entity) so the
 * boundary transforms are visible: `createdAt` (`Date` → ISO string), the
 * **derived** `reviewRequired` flag (confidence against the configured threshold,
 * TD-5), and the null-vs-absent `transformSuggestion` distinction. No mapper
 * carries credential material.
 */

/** `MappingProposal` → summary DTO (RA-1 crit 1). */
export function toMappingProposalSummaryDto(proposal: MappingProposal): MappingProposalSummaryDto {
  return {
    id: proposal.id,
    sourceSpecId: proposal.sourceSpecId,
    targetSpecId: proposal.targetSpecId,
    status: proposal.status,
    generatedBy: proposal.generatedBy,
    createdAt: proposal.createdAt.toISOString(),
  };
}

/**
 * `MappingProposalItem` → item DTO (RA-1 crit 3), deriving `reviewRequired` from
 * `confidenceScore` against `threshold`. Optional keys (`targetRef`, `phase`,
 * `transformSuggestion`, the peer-peer detection metadata) are conditionally
 * spread, preserving `transformSuggestion`'s null-vs-absent distinction under
 * `exactOptionalPropertyTypes`.
 */
export function toMappingProposalItemDto(
  item: MappingProposalItem,
  threshold: number,
): MappingProposalItemDto {
  return {
    id: item.id,
    proposalId: item.proposalId,
    kind: item.kind,
    sourceRef: item.sourceRef,
    confidenceScore: item.confidenceScore,
    reviewRequired: isReviewRequired(item, threshold),
    ambiguousAlternatives: item.ambiguousAlternatives.map((alternative) => ({
      targetRef: alternative.targetRef,
      confidence: alternative.confidence,
    })),
    unmapped: item.unmapped,
    rationale: item.rationale,
    reviewState: item.reviewState,
    ...(item.targetRef !== undefined ? { targetRef: item.targetRef } : {}),
    ...(item.phase !== undefined ? { phase: item.phase } : {}),
    ...(item.transformSuggestion !== undefined
      ? { transformSuggestion: item.transformSuggestion }
      : {}),
    ...(item.identityCandidate !== undefined ? { identityCandidate: item.identityCandidate } : {}),
    ...(item.targetLookupParamRef !== undefined
      ? { targetLookupParamRef: item.targetLookupParamRef }
      : {}),
  };
}

/** A `ProposalDetail` → detail response DTO (RA-1 crit 2-5). */
export function toMappingProposalDetailResponse(
  detail: ProposalDetail,
): MappingProposalDetailResponse {
  return {
    proposal: toMappingProposalSummaryDto(detail.proposal),
    items: detail.sortedItems.map((item) => toMappingProposalItemDto(item, detail.reviewThreshold)),
    shortlist:
      detail.shortlist === null
        ? null
        : {
            noCounterpartResources: detail.shortlist.noCounterpartResources.map((resource) => ({
              specId: resource.specId,
              resourceRef: resource.resourceRef,
            })),
            analysisFailedPairs: detail.shortlist.analysisFailedPairs.map(cloneCandidatePair),
          },
    analysisExclusions: detail.analysisExclusions.map((resource) => ({
      specId: resource.specId,
      resourceRef: resource.resourceRef,
    })),
  };
}

/** A `ShortlistResult` → the `shortlist` projection returned by the escape hatch (RA-5). */
export function toProposalShortlistDto(shortlistResult: ShortlistResult): ProposalShortlistDto {
  return {
    noCounterpartResources: shortlistResult.noCounterpartResources.map((resource) => ({
      specId: resource.specId,
      resourceRef: resource.resourceRef,
    })),
    analysisFailedPairs: shortlistResult.candidatePairs
      .filter((pair) => pair.analysisFailed)
      .map(cloneCandidatePair),
  };
}

/** `ApprovedMapping` → the minimal ref DTO the approve response returns (RA-4 crit 4). */
export function toApprovedMappingRefDto(mapping: ApprovedMapping): ApprovedMappingRefDto {
  return { id: mapping.id, variant: mapping.variant, status: mapping.status };
}

function cloneCandidatePair(pair: {
  sourceResource: string;
  targetResource: string;
  confidence: number;
  rationale: string;
}): { sourceResource: string; targetResource: string; confidence: number; rationale: string } {
  return {
    sourceResource: pair.sourceResource,
    targetResource: pair.targetResource,
    confidence: pair.confidence,
    rationale: pair.rationale,
  };
}
