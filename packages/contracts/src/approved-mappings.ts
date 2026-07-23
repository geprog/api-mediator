import { approvedMappingStatusSchema, mappingVariantSchema } from "@mediator/domain";
import { z } from "zod";

import { isoDateTimeSchema } from "./common.js";

/**
 * DTOs for the SL-10 `ApprovedMapping` lifecycle HTTP surface — the operator read of every
 * approved mapping with its current `status`, and the manual **suspend** / **resume**
 * transitions.
 *
 * `status` is the single `ApprovedMapping.status` enum
 * (`docs/architecture/data-model.md`), never a pair of independent markers: `suspended` is
 * the manual operator hold, `stale` the breaking-change outcome, `superseded` the
 * successor-adoption outcome, `archived` the deregistration outcome. Suspend applies to an
 * `active` mapping and resume only to a `suspended` one; the server rejects anything else
 * with `409` (a suspended-then-`stale` mapping needs re-review, not resume).
 *
 * Metadata only — ids, enum values, and timestamps. No credential material, no IR payload,
 * and no reviewed field/operation content appears here (`docs/architecture/security.md`).
 */

/**
 * One `ApprovedMapping` on the wire. The pinned `sourceSpecId`/`targetSpecId` are the
 * source of truth for each side; the denormalized app ids are carried for display
 * convenience, exactly as the data model describes them.
 */
export const approvedMappingDtoSchema = z.object({
  id: z.string(),
  variant: mappingVariantSchema,
  status: approvedMappingStatusSchema,
  sourceAppId: z.string(),
  targetAppId: z.string(),
  sourceSpecId: z.string(),
  targetSpecId: z.string(),
  approvedBy: z.string(),
  approvedAt: isoDateTimeSchema,
});
export type ApprovedMappingDto = z.infer<typeof approvedMappingDtoSchema>;

/** `GET /api/approved-mappings` (viewer) — every approved mapping with its current status. */
export const approvedMappingListResponseSchema = z.object({
  mappings: z.array(approvedMappingDtoSchema),
});
export type ApprovedMappingListResponse = z.infer<typeof approvedMappingListResponseSchema>;

/**
 * `POST /api/approved-mappings/:id/suspend` and `.../resume` (operator) — the mapping in its
 * new state. Both transitions return the same shape; the resulting `status` (`suspended` /
 * `active`) is what distinguishes them.
 */
export const approvedMappingTransitionResponseSchema = z.object({
  mapping: approvedMappingDtoSchema,
});
export type ApprovedMappingTransitionResponse = z.infer<
  typeof approvedMappingTransitionResponseSchema
>;
