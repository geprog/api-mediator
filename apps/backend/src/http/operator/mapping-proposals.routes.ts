import {
  analyzeResourcePairRequestSchema,
  analyzeResourcePairResponseSchema,
  approveProposalRequestSchema,
  approveProposalResponseSchema,
  identityKeyConfirmationSchema,
  mappingProposalDetailResponseSchema,
  mappingProposalListResponseSchema,
  recordProposalItemDecisionRequestSchema,
  recordProposalItemDecisionResponseSchema,
  type ApproveProposalResponse,
  type IdentityKeyConfirmationDto,
  type OperationOverrideDto,
  type RecordProposalItemDecisionRequest,
} from "@mediator/contracts";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { NotFoundError } from "../../app-errors.js";
import type {
  ApproveResult,
  IdentityKeyConfirmation,
  ItemReviewDecision,
  OperationOverride,
} from "../../modules/approval/index.js";
import { requireOperator, requireViewer } from "../auth/index.js";
import { getPrincipal } from "../auth/principal.js";
import { parseInput } from "../validation.js";
import { idParamSchema, type OperatorApiDeps } from "./deps.js";
import {
  toApprovedMappingRefDto,
  toMappingProposalDetailResponse,
  toMappingProposalItemDto,
  toMappingProposalSummaryDto,
  toProposalShortlistDto,
} from "./mapping-proposal-dto.js";

/**
 * The Phase-3 Review & Approval HTTP API (RA-1..RA-5): the operator-API endpoints
 * that expose the Approval Service. These handlers are **thin** — they
 * authenticate/authorize (OA-1/OA-2), validate the request shape, and delegate
 * every invariant to the Approval Service / read + escape-hatch services. Reads are
 * `viewer`-ok; every mutation requires `operator`.
 *
 * - `GET  /api/mapping-proposals`                              (viewer) — RA-1 list
 * - `GET  /api/mapping-proposals/:id`                          (viewer) — RA-1 detail
 * - `POST /api/mapping-proposals/:id/items/:itemId/decision`   (operator) — RA-2
 * - `POST /api/mapping-proposals/:id/identity-key`             (operator) — RA-3
 * - `POST /api/mapping-proposals/:id/approve`                  (operator) — RA-4
 * - `POST /api/mapping-proposals/:id/analyze-pair`             (operator) — RA-5
 *
 * No response carries credential material.
 */

/** RA-1 list filter — a directional spec pair (see `ProposalReadService.list`). */
const proposalListQuerySchema = z.object({
  sourceSpecId: z.uuid(),
  targetSpecId: z.uuid().optional(),
});

/** The `:id` + `:itemId` path parameters for the per-item decision route (RA-2). */
const itemParamSchema = z.object({ id: z.uuid(), itemId: z.uuid() });

export function registerMappingProposalRoutes(app: FastifyInstance, deps: OperatorApiDeps): void {
  // ── RA-1: read proposals, confidence-sorted, filtered by spec pair ──────────
  app.get(
    "/api/mapping-proposals",
    { preHandler: requireViewer },
    async (request): Promise<unknown> => {
      const query = parseInput(proposalListQuerySchema, request.query, "query parameters");
      const filter =
        query.targetSpecId !== undefined
          ? { sourceSpecId: query.sourceSpecId, targetSpecId: query.targetSpecId }
          : { sourceSpecId: query.sourceSpecId };
      const proposals = await deps.proposalReadService.list(filter);
      return mappingProposalListResponseSchema.parse({
        proposals: proposals.map(toMappingProposalSummaryDto),
      });
    },
  );

  app.get(
    "/api/mapping-proposals/:id",
    { preHandler: requireViewer },
    async (request): Promise<unknown> => {
      const { id } = parseInput(idParamSchema, request.params, "path parameters");
      const detail = await deps.proposalReadService.getDetail(id);
      if (detail === undefined) {
        throw new NotFoundError(`Mapping proposal ${id} not found.`);
      }
      return mappingProposalDetailResponseSchema.parse(toMappingProposalDetailResponse(detail));
    },
  );

  // ── RA-2: record a per-item accept / edit / reject decision ─────────────────
  app.post(
    "/api/mapping-proposals/:id/items/:itemId/decision",
    { preHandler: requireOperator },
    async (request): Promise<unknown> => {
      const { id, itemId } = parseInput(itemParamSchema, request.params, "path parameters");
      const body = parseInput(
        recordProposalItemDecisionRequestSchema,
        request.body,
        "decision request",
      );

      // 404 when the item does not exist OR does not belong to the addressed
      // proposal (RA-2 crit 5) — a route-shape check, not approval logic.
      const item = await deps.proposalReadService.getItem(itemId);
      if (item === undefined || item.proposalId !== id) {
        throw new NotFoundError(`Mapping proposal item ${itemId} not found in proposal ${id}.`);
      }

      const actor = getPrincipal(request).identity;
      const updated = await deps.approvalService.decideItem(
        { itemId, decision: toItemReviewDecision(body) },
        actor,
      );
      return recordProposalItemDecisionResponseSchema.parse({
        item: toMappingProposalItemDto(updated, deps.proposalReadService.reviewThreshold),
      });
    },
  );

  // ── RA-3: confirm the identity key (peer-peer) ──────────────────────────────
  // AS-5 (identity-key confirmation) is reached only through `approve` with
  // `identityKeys`; this endpoint delegates there, surfacing the rename-only /
  // shared-pairing / consumer-provider-not-applicable errors AS raises as 4xx.
  app.post(
    "/api/mapping-proposals/:id/identity-key",
    { preHandler: requireOperator },
    async (request): Promise<unknown> => {
      const { id } = parseInput(idParamSchema, request.params, "path parameters");
      const body = parseInput(
        identityKeyConfirmationSchema,
        request.body,
        "identity-key confirmation",
      );
      const actor = getPrincipal(request).identity;
      const result = await deps.approvalService.approve(
        { proposalId: id, identityKeys: [toIdentityKeyConfirmation(body)] },
        actor,
      );
      return approveProposalResponseSchema.parse(toApproveResponse(result));
    },
  );

  // ── RA-4: approve the decided selection ─────────────────────────────────────
  app.post(
    "/api/mapping-proposals/:id/approve",
    { preHandler: requireOperator },
    async (request): Promise<unknown> => {
      const { id } = parseInput(idParamSchema, request.params, "path parameters");
      const body = parseInput(approveProposalRequestSchema, request.body ?? {}, "approve request");
      const actor = getPrincipal(request).identity;
      const result = await deps.approvalService.approve(
        {
          proposalId: id,
          ...(body.operationOverrides !== undefined
            ? { operationOverrides: body.operationOverrides.map(toOperationOverride) }
            : {}),
          ...(body.identityKeys !== undefined
            ? { identityKeys: body.identityKeys.map(toIdentityKeyConfirmation) }
            : {}),
        },
        actor,
      );
      return approveProposalResponseSchema.parse(toApproveResponse(result));
    },
  );

  // ── RA-5: shortlist-miss escape hatch ("analyze this resource pair anyway") ──
  app.post(
    "/api/mapping-proposals/:id/analyze-pair",
    { preHandler: requireOperator },
    async (request): Promise<unknown> => {
      const { id } = parseInput(idParamSchema, request.params, "path parameters");
      const body = parseInput(
        analyzeResourcePairRequestSchema,
        request.body,
        "analyze-pair request",
      );
      const result = await deps.escapeHatchService.analyzePair({
        proposalId: id,
        sourceResourceRef: body.sourceResourceRef,
        targetResourceRef: body.targetResourceRef,
      });
      return analyzeResourcePairResponseSchema.parse({
        outcome: result.outcome,
        attachedItemCount: result.attachedItemCount,
        shortlist: toProposalShortlistDto(result.shortlistResult),
      });
    },
  );
}

/** Map the RA-2 decision DTO to the Approval Service's `ItemReviewDecision` (AS-1). */
function toItemReviewDecision(body: RecordProposalItemDecisionRequest): ItemReviewDecision {
  switch (body.decision) {
    case "accept":
      return { kind: "accept" };
    case "reject":
      return { kind: "reject" };
    case "edit":
      return {
        kind: "edit",
        edit: {
          ...(body.targetRef !== undefined ? { targetRef: body.targetRef } : {}),
          ...(body.transform !== undefined ? { transform: body.transform } : {}),
        },
      };
  }
}

/** Map the identity-key confirmation DTO to the Approval Service shape (AS-5). */
function toIdentityKeyConfirmation(dto: IdentityKeyConfirmationDto): IdentityKeyConfirmation {
  return {
    itemId: dto.itemId,
    ...(dto.targetLookupParamRef !== undefined
      ? { targetLookupParamRef: dto.targetLookupParamRef }
      : {}),
  };
}

/** Map the operation-override DTO to the Approval Service shape (AS-4). */
function toOperationOverride(dto: OperationOverrideDto): OperationOverride {
  return {
    itemId: dto.itemId,
    ...(dto.action !== undefined ? { action: dto.action } : {}),
    ...(dto.targetIdParamName !== undefined ? { targetIdParamName: dto.targetIdParamName } : {}),
  };
}

/** Map an `ApproveResult` to the wire response (RA-4 crit 2/4; RA-3 reuses it). */
function toApproveResponse(result: ApproveResult): ApproveProposalResponse {
  if (result.outcome === "rejected") {
    return { outcome: "rejected" };
  }
  return { outcome: result.outcome, mapping: toApprovedMappingRefDto(result.mapping) };
}
