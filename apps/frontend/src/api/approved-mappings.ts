import {
  approvedMappingListResponseSchema,
  approvedMappingTransitionResponseSchema,
  type ApprovedMappingListResponse,
  type ApprovedMappingTransitionResponse,
} from "@mediator/contracts";

import { apiRequest } from "./client.js";

/**
 * The SL-10 `ApprovedMapping` lifecycle client — read every mapping's current status, and
 * manually suspend / resume one. Each function is a one-liner over {@link apiRequest} that
 * validates the response against its `@mediator/contracts` schema at the boundary.
 *
 * Every invariant is the **server's**: which transitions are legal (suspend only from
 * `active`, resume only from `suspended` — a suspended-then-`stale` mapping needs re-review,
 * not a resume), the operator role gate (OA-2 — a `viewer` is rejected `403`), the audit
 * attribution, the cache drop, and the graph recompute. These are thin calls.
 */

/** `GET /api/approved-mappings` (viewer) — every approved mapping with its current status. */
export function listApprovedMappings(): Promise<ApprovedMappingListResponse> {
  return apiRequest("/api/approved-mappings", { method: "GET" }, approvedMappingListResponseSchema);
}

/** `POST /api/approved-mappings/:id/suspend` (operator) — SL-10.1 `active → suspended`. */
export function suspendApprovedMapping(
  mappingId: string,
): Promise<ApprovedMappingTransitionResponse> {
  return apiRequest(
    `/api/approved-mappings/${encodeURIComponent(mappingId)}/suspend`,
    { method: "POST" },
    approvedMappingTransitionResponseSchema,
  );
}

/** `POST /api/approved-mappings/:id/resume` (operator) — SL-10.2 `suspended → active`. */
export function resumeApprovedMapping(
  mappingId: string,
): Promise<ApprovedMappingTransitionResponse> {
  return apiRequest(
    `/api/approved-mappings/${encodeURIComponent(mappingId)}/resume`,
    { method: "POST" },
    approvedMappingTransitionResponseSchema,
  );
}
