import { irSchema } from "@mediator/domain";
import { z } from "zod";

import { apiSpecMetadataDtoSchema, openApiDocumentSchema } from "./apps.js";

/**
 * DTOs for viewing a spec's IR (SI-3), stateless preview-parsing (AR-3/SI-4),
 * and editing `analysisExclusions` (SI-4). The IR itself is reused verbatim from
 * `@mediator/domain`'s {@link irSchema} — it is already a plain,
 * JSON-serializable structure (no `Date`s, no secrets), so no boundary transform
 * is needed. The IR is derived from the OpenAPI document only and can never
 * contain credential material (SI-3 criterion 4).
 */

/** `GET /api/specs/:id/ir` response (SI-3): the stored spec's parsed IR. */
export const irResponseSchema = z.object({
  apiSpecId: z.string(),
  ir: irSchema,
});
export type IrResponse = z.infer<typeof irResponseSchema>;

/**
 * A resource group summarized for the registration form's exclusion toggles
 * (AR-3 criterion 2): its stable `resourceRef`, display `name`, and operation
 * count. The full IR is returned alongside for a preview.
 */
export const resourceGroupSummarySchema = z.object({
  resourceRef: z.string(),
  name: z.string(),
  operationCount: z.number().int().nonnegative(),
});
export type ResourceGroupSummary = z.infer<typeof resourceGroupSummarySchema>;

/**
 * `POST /api/specs/preview` request (AR-3/SI-4): a document to parse. This
 * endpoint is **stateless** — it creates no `RegisteredApp` or `ApiSpec`.
 */
export const previewParseRequestSchema = z.object({
  document: openApiDocumentSchema,
});
export type PreviewParseRequest = z.infer<typeof previewParseRequestSchema>;

/**
 * `POST /api/specs/preview` response: the parsed IR plus its resource-group
 * summaries (the toggles offered for `analysisExclusions`).
 */
export const previewParseResponseSchema = z.object({
  ir: irSchema,
  resourceGroups: z.array(resourceGroupSummarySchema),
});
export type PreviewParseResponse = z.infer<typeof previewParseResponseSchema>;

/**
 * `PATCH /api/specs/:id/analysis-exclusions` request (SI-4 criterion 3):
 * **replace** the exclusion list. Each `resourceRef` is validated against the
 * spec's IR server-side; an unknown ref is rejected (SI-4 criterion 4). Setting
 * or editing exclusions triggers no analysis in Phase 1 (SI-4 criterion 5).
 */
export const updateAnalysisExclusionsRequestSchema = z.object({
  analysisExclusions: z.array(z.string()),
});
export type UpdateAnalysisExclusionsRequest = z.infer<typeof updateAnalysisExclusionsRequestSchema>;

/**
 * `PATCH /api/specs/:id/analysis-exclusions` response: the updated spec
 * metadata, carrying the new `analysisExclusions`.
 */
export const updateAnalysisExclusionsResponseSchema = apiSpecMetadataDtoSchema;
export type UpdateAnalysisExclusionsResponse = z.infer<
  typeof updateAnalysisExclusionsResponseSchema
>;
