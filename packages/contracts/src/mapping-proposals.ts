import {
  approvedMappingStatusSchema,
  candidatePairSchema,
  confidenceScoreSchema,
  generatedBySchema,
  mappingPhaseSchema,
  mappingProposalItemKindSchema,
  mappingProposalStatusSchema,
  mappingVariantSchema,
  noCounterpartResourceSchema,
  operationActionSchema,
  proposalElementRefSchema,
  proposalItemAlternativeSchema,
  reviewStateSchema,
  transformSuggestionSchema,
} from "@mediator/domain";
import { z } from "zod";

import { isoDateTimeSchema } from "./common.js";

/**
 * DTOs for the Phase-3 Review & Approval HTTP API (RA-1..RA-5). The HTTP surface
 * over the Approval Service: read proposals confidence-sorted, record per-item
 * decisions, confirm the identity key, approve a selection, and trigger the
 * shortlist-miss escape hatch.
 *
 * The structural sub-shapes (`sourceRef`/`targetRef`, `transformSuggestion`,
 * `ambiguousAlternatives`, the enums, `generatedBy`) are reused **verbatim** from
 * `@mediator/domain` — they carry no `Date` and no credential material, so they
 * round-trip unchanged at the boundary. The only boundary transforms here are
 * `createdAt` (`Date` → ISO string) and the **derived** `reviewRequired` flag,
 * which is computed against the configured threshold (Phase-2 TD-5) rather than
 * read from a stored column. No response DTO carries credential material.
 */

// ── Shared item DTO (RA-1 crit 3) ────────────────────────────────────────────

/**
 * A `MappingProposalItem` on the wire. `targetRef`/`transformSuggestion` follow
 * the domain item's three states (absent when `unmapped`; `null` for a mapped
 * operation; an object for a mapped field). `reviewRequired` is **derived** from
 * `confidenceScore` against the configured threshold — not a stored field. The
 * peer-peer detection metadata (`identityCandidate`/`targetLookupParamRef`) is
 * present only on a peer-peer (no-phase) field item.
 */
export const mappingProposalItemDtoSchema = z.object({
  id: z.string(),
  proposalId: z.string(),
  kind: mappingProposalItemKindSchema,
  sourceRef: proposalElementRefSchema,
  targetRef: proposalElementRefSchema.optional(),
  phase: mappingPhaseSchema.optional(),
  transformSuggestion: transformSuggestionSchema.nullable().optional(),
  confidenceScore: confidenceScoreSchema,
  /** Derived: `confidenceScore < threshold` (TD-5) — never a stored column. */
  reviewRequired: z.boolean(),
  ambiguousAlternatives: z.array(proposalItemAlternativeSchema),
  unmapped: z.boolean(),
  rationale: z.string(),
  reviewState: reviewStateSchema,
  identityCandidate: z.boolean().optional(),
  targetLookupParamRef: z.string().optional(),
});
export type MappingProposalItemDto = z.infer<typeof mappingProposalItemDtoSchema>;

// ── Proposal summary (RA-1 crit 1) ───────────────────────────────────────────

/** A `MappingProposal` header on the wire — the list row and detail header. */
export const mappingProposalSummaryDtoSchema = z.object({
  id: z.string(),
  sourceSpecId: z.string(),
  targetSpecId: z.string(),
  status: mappingProposalStatusSchema,
  generatedBy: generatedBySchema,
  createdAt: isoDateTimeSchema,
});
export type MappingProposalSummaryDto = z.infer<typeof mappingProposalSummaryDtoSchema>;

/** `GET /api/mapping-proposals` response (RA-1 crit 1). */
export const mappingProposalListResponseSchema = z.object({
  proposals: z.array(mappingProposalSummaryDtoSchema),
});
export type MappingProposalListResponse = z.infer<typeof mappingProposalListResponseSchema>;

// ── shortlistResult on the wire (RA-1 crit 4) ────────────────────────────────

/**
 * The proposal's `shortlistResult` on the wire: the no-counterpart resources
 * (surfaced like `unmapped`, each carrying its owning `specId`) and any candidate
 * pairs whose stage-2 detail call failed (`analysisFailed`). Distinct from the
 * spec's `analysisExclusions`, which are listed separately as excluded.
 */
export const proposalShortlistDtoSchema = z.object({
  noCounterpartResources: z.array(noCounterpartResourceSchema),
  analysisFailedPairs: z.array(candidatePairSchema),
});
export type ProposalShortlistDto = z.infer<typeof proposalShortlistDtoSchema>;

/**
 * `GET /api/mapping-proposals/:id` response (RA-1 crit 2-5). `items` is sorted
 * riskiest-first and is **empty** for a `failed` proposal; `shortlist` is `null`
 * for a `failed` proposal (whole-spec-pair shortlist failure) — surfacing needs
 * attention rather than an empty success. `analysisExclusions` lists the excluded
 * resources of both specs **separately** from the no-counterpart set.
 */
export const mappingProposalDetailResponseSchema = z.object({
  proposal: mappingProposalSummaryDtoSchema,
  items: z.array(mappingProposalItemDtoSchema),
  shortlist: proposalShortlistDtoSchema.nullable(),
  analysisExclusions: z.array(noCounterpartResourceSchema),
});
export type MappingProposalDetailResponse = z.infer<typeof mappingProposalDetailResponseSchema>;

// ── RA-2: per-item review decision ───────────────────────────────────────────

/**
 * A per-item decision request (RA-2). `accept` takes the item as-is; `reject` is
 * permanent; `edit` changes the `targetRef` and/or `transform` (picking a
 * different `ambiguousAlternatives` option is an `edit` whose `targetRef` is that
 * alternative's, and an `edit` supplying a `targetRef` to an `unmapped` item maps
 * it). Target-IR validation of an edit is atomic at approve time (AS-3); the
 * endpoint never persists an invalid edit.
 */
export const recordProposalItemDecisionRequestSchema = z.discriminatedUnion("decision", [
  z.object({ decision: z.literal("accept") }),
  z.object({ decision: z.literal("reject") }),
  z.object({
    decision: z.literal("edit"),
    targetRef: proposalElementRefSchema.optional(),
    transform: transformSuggestionSchema.optional(),
  }),
]);
export type RecordProposalItemDecisionRequest = z.infer<
  typeof recordProposalItemDecisionRequestSchema
>;

/** RA-2 response: the item after its `reviewState` transition. */
export const recordProposalItemDecisionResponseSchema = z.object({
  item: mappingProposalItemDtoSchema,
});
export type RecordProposalItemDecisionResponse = z.infer<
  typeof recordProposalItemDecisionResponseSchema
>;

// ── RA-3: identity-key confirmation (peer-peer) ──────────────────────────────

/**
 * One identity-key confirmation (RA-3 / AS-5): the accepted/edited peer-peer field
 * item to mark `isIdentityKey`, plus the reviewer-confirmed `targetLookupParamRef`
 * when the target's collection read offers a lookup parameter.
 */
export const identityKeyConfirmationSchema = z.object({
  itemId: z.string(),
  targetLookupParamRef: z.string().optional(),
});
export type IdentityKeyConfirmationDto = z.infer<typeof identityKeyConfirmationSchema>;

// ── RA-4: approve a selection ────────────────────────────────────────────────

/** A reviewer's `action`/`targetIdParamRef` correction for an operation item (AS-4). */
export const operationOverrideSchema = z.object({
  itemId: z.string(),
  action: operationActionSchema.optional(),
  targetIdParamName: z.string().optional(),
});
export type OperationOverrideDto = z.infer<typeof operationOverrideSchema>;

/**
 * `POST /api/mapping-proposals/:id/approve` request (RA-4). Approves the current
 * selection (every `accepted`/`edited` item), carrying the reviewer corrections
 * that configure the assembled artifacts: `operationOverrides` (AS-4) and
 * `identityKeys` (AS-5). Both are optional; omitted confirmations from a prior
 * partial approval are carried forward by the service.
 */
export const approveProposalRequestSchema = z.object({
  operationOverrides: z.array(operationOverrideSchema).optional(),
  identityKeys: z.array(identityKeyConfirmationSchema).optional(),
});
export type ApproveProposalRequest = z.infer<typeof approveProposalRequestSchema>;

/** The created/updated `ApprovedMapping` on the wire (RA-4 crit 4) — no credentials. */
export const approvedMappingRefDtoSchema = z.object({
  id: z.string(),
  variant: mappingVariantSchema,
  status: approvedMappingStatusSchema,
});
export type ApprovedMappingRefDto = z.infer<typeof approvedMappingRefDtoSchema>;

/**
 * `POST /api/mapping-proposals/:id/approve` response (RA-4 crit 2/4). `mapping` is
 * present for `approved`/`partially_approved` and **absent** for `rejected` (every
 * item rejected — no `ApprovedMapping` is created).
 */
export const approveProposalResponseSchema = z.object({
  outcome: z.enum(["approved", "partially_approved", "rejected"]),
  mapping: approvedMappingRefDtoSchema.optional(),
});
export type ApproveProposalResponse = z.infer<typeof approveProposalResponseSchema>;

// ── RA-5: shortlist-miss escape hatch ────────────────────────────────────────

/**
 * `POST /api/mapping-proposals/:id/analyze-pair` request (RA-5): the resource pair
 * to analyze in the proposal's direction. At least one side must be in the
 * no-counterpart set; neither may be an `analysisExclusion` (that is a scope edit,
 * Phase 6 — refused here).
 */
export const analyzeResourcePairRequestSchema = z.object({
  sourceResourceRef: z.string().min(1),
  targetResourceRef: z.string().min(1),
});
export type AnalyzeResourcePairRequest = z.infer<typeof analyzeResourcePairRequestSchema>;

/**
 * RA-5 response. `attached` — the scoped detail analysis produced correspondences,
 * now attached to the proposal (the analyzed resource left the no-counterpart set);
 * `analysis_failed` — the detail call hit its retry ceiling and the pair is marked
 * `analysisFailed`, surfaced as needing attention. `shortlist` is the proposal's
 * updated `shortlistResult`.
 */
export const analyzeResourcePairResponseSchema = z.object({
  outcome: z.enum(["attached", "analysis_failed"]),
  attachedItemCount: z.number().int().nonnegative(),
  shortlist: proposalShortlistDtoSchema,
});
export type AnalyzeResourcePairResponse = z.infer<typeof analyzeResourcePairResponseSchema>;
