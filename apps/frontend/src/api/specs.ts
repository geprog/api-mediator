import {
  irResponseSchema,
  previewParseResponseSchema,
  updateAnalysisExclusionsResponseSchema,
  type IrResponse,
  type PreviewParseRequest,
  type PreviewParseResponse,
  type UpdateAnalysisExclusionsRequest,
  type UpdateAnalysisExclusionsResponse,
} from "@mediator/contracts";

import { apiRequest } from "./client.js";

/**
 * Spec-scoped routes: view IR (SI-3), stateless preview-parse (AR-3/SI-4), and
 * replace `analysisExclusions` (SI-4). Responses are validated at the boundary.
 */

/** `GET /api/specs/:id/ir` — the stored spec's parsed IR (SI-3). */
export function getSpecIr(specId: string): Promise<IrResponse> {
  return apiRequest(
    `/api/specs/${encodeURIComponent(specId)}/ir`,
    { method: "GET" },
    irResponseSchema,
  );
}

/**
 * `POST /api/specs/preview` — parse a document to IR + resource-group summaries
 * (AR-3 criterion 2). Stateless: creates no `RegisteredApp`/`ApiSpec`.
 */
export function previewParse(request: PreviewParseRequest): Promise<PreviewParseResponse> {
  return apiRequest(
    "/api/specs/preview",
    { method: "POST", body: request },
    previewParseResponseSchema,
  );
}

/** `PATCH /api/specs/:id/analysis-exclusions` — replace the exclusion list (SI-4). */
export function updateAnalysisExclusions(
  specId: string,
  request: UpdateAnalysisExclusionsRequest,
): Promise<UpdateAnalysisExclusionsResponse> {
  return apiRequest(
    `/api/specs/${encodeURIComponent(specId)}/analysis-exclusions`,
    { method: "PATCH", body: request },
    updateAnalysisExclusionsResponseSchema,
  );
}
