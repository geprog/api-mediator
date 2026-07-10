import {
  resourceBindingsResponseSchema,
  updateResourceBindingResponseSchema,
  type ResourceBindingsResponse,
  type UpdateResourceBindingRequest,
  type UpdateResourceBindingResponse,
} from "@mediator/contracts";

import { apiRequest } from "./client.js";

/**
 * `ResourceBinding` read + confirm/correct routes (RB-2, RB-3). Responses are
 * validated at the boundary.
 */

/** `GET /api/specs/:id/resource-bindings` — the spec's bindings (RB-3). */
export function getResourceBindings(specId: string): Promise<ResourceBindingsResponse> {
  return apiRequest(
    `/api/specs/${encodeURIComponent(specId)}/resource-bindings`,
    { method: "GET" },
    resourceBindingsResponseSchema,
  );
}

/**
 * `PATCH /api/resource-bindings/:id` — confirm (no `value`) or correct (with
 * `value`) one ref (RB-2).
 */
export function updateResourceBinding(
  bindingId: string,
  request: UpdateResourceBindingRequest,
): Promise<UpdateResourceBindingResponse> {
  return apiRequest(
    `/api/resource-bindings/${encodeURIComponent(bindingId)}`,
    { method: "PATCH", body: request },
    updateResourceBindingResponseSchema,
  );
}
