import {
  analyzeResourcePairResponseSchema,
  approveProposalResponseSchema,
  mappingProposalDetailResponseSchema,
  mappingProposalListResponseSchema,
  recordProposalItemDecisionResponseSchema,
  type AnalyzeResourcePairRequest,
  type AnalyzeResourcePairResponse,
  type ApproveProposalRequest,
  type ApproveProposalResponse,
  type IdentityKeyConfirmationDto,
  type MappingProposalDetailResponse,
  type MappingProposalListResponse,
  type RecordProposalItemDecisionRequest,
  type RecordProposalItemDecisionResponse,
} from "@mediator/contracts";

import { apiRequest } from "./client.js";

/**
 * The Phase-3 Review & Approval HTTP API client (RA-1..RA-5). Each function is a
 * one-liner over {@link apiRequest} that validates the response against its
 * `@mediator/contracts` schema at the boundary. Every invariant (confidence sort,
 * rename-only / shared-pairing locks, target-IR validation, the escape-hatch
 * exclusion rule, role gating) is enforced server-side; these are thin calls.
 */

/** A directional spec-pair filter for the proposal list (RA-1). */
export interface ProposalListFilter {
  readonly sourceSpecId: string;
  readonly targetSpecId?: string;
}

/** `GET /api/mapping-proposals?sourceSpecId=…[&targetSpecId=…]` (RA-1 list). */
export function listMappingProposals(
  filter: ProposalListFilter,
): Promise<MappingProposalListResponse> {
  const params = new URLSearchParams({ sourceSpecId: filter.sourceSpecId });
  if (filter.targetSpecId !== undefined && filter.targetSpecId !== "") {
    params.set("targetSpecId", filter.targetSpecId);
  }
  return apiRequest(
    `/api/mapping-proposals?${params.toString()}`,
    { method: "GET" },
    mappingProposalListResponseSchema,
  );
}

/** `GET /api/mapping-proposals/:id` (RA-1 detail) — items confidence-sorted. */
export function getMappingProposalDetail(
  proposalId: string,
): Promise<MappingProposalDetailResponse> {
  return apiRequest(
    `/api/mapping-proposals/${encodeURIComponent(proposalId)}`,
    { method: "GET" },
    mappingProposalDetailResponseSchema,
  );
}

/** `POST /api/mapping-proposals/:id/items/:itemId/decision` (RA-2). */
export function recordProposalItemDecision(
  proposalId: string,
  itemId: string,
  request: RecordProposalItemDecisionRequest,
): Promise<RecordProposalItemDecisionResponse> {
  return apiRequest(
    `/api/mapping-proposals/${encodeURIComponent(proposalId)}/items/${encodeURIComponent(itemId)}/decision`,
    { method: "POST", body: request },
    recordProposalItemDecisionResponseSchema,
  );
}

/**
 * `POST /api/mapping-proposals/:id/identity-key` (RA-3). Confirms the identity key;
 * the endpoint **delegates to approve**, so this also finalizes a (partial)
 * approval of the currently-decided selection and emits `MappingApproved`.
 */
export function confirmIdentityKey(
  proposalId: string,
  request: IdentityKeyConfirmationDto,
): Promise<ApproveProposalResponse> {
  return apiRequest(
    `/api/mapping-proposals/${encodeURIComponent(proposalId)}/identity-key`,
    { method: "POST", body: request },
    approveProposalResponseSchema,
  );
}

/** `POST /api/mapping-proposals/:id/approve` (RA-4) — approve the decided selection. */
export function approveMappingProposal(
  proposalId: string,
  request: ApproveProposalRequest,
): Promise<ApproveProposalResponse> {
  return apiRequest(
    `/api/mapping-proposals/${encodeURIComponent(proposalId)}/approve`,
    { method: "POST", body: request },
    approveProposalResponseSchema,
  );
}

/** `POST /api/mapping-proposals/:id/analyze-pair` (RA-5) — the shortlist-miss escape hatch. */
export function analyzeResourcePair(
  proposalId: string,
  request: AnalyzeResourcePairRequest,
): Promise<AnalyzeResourcePairResponse> {
  return apiRequest(
    `/api/mapping-proposals/${encodeURIComponent(proposalId)}/analyze-pair`,
    { method: "POST", body: request },
    analyzeResourcePairResponseSchema,
  );
}
