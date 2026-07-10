import { irRefTargetSchema } from "@mediator/domain";
import { z } from "zod";

import { isoDateTimeSchema, resourceBindingRefKindSchema } from "./common.js";

/**
 * DTOs for viewing and confirming/correcting `ResourceBinding`s (RB-2, RB-3).
 *
 * The domain `ResourceBinding` models each ref as an optional `ConfirmableRef`
 * (present-with-value vs. absent). The wire DTO flattens all six ref kinds into a
 * uniform list so a caller can render every ref in one pass and tell three states
 * apart (RB-3 criteria 1/4/5):
 *
 * - **not-applicable** — `applicable: false`: the ref is not meaningful for the
 *   resource given the app's `capabilities` (e.g. `deltaCursorRef` when the app
 *   does not declare `supportsDeltaQuery`). Never a confirmable guess.
 * - **unconfirmed** — `applicable: true`, `value` present, `confirmedAt: null`.
 * - **confirmed** — `applicable: true`, `value` present, `confirmedBy`/
 *   `confirmedAt` set.
 *
 * `applicable` is computed server-side from the owning app's `capabilities`; it
 * is not stored on the binding. `confirmedAt` is an ISO string (domain `Date`).
 */
export const resourceBindingRefDtoSchema = z.object({
  kind: resourceBindingRefKindSchema,
  /** Whether the ref is meaningful for this resource per the app's capabilities. */
  applicable: z.boolean(),
  /** The derived/corrected IR target, or `null` when no ref was derived. */
  value: irRefTargetSchema.nullable(),
  confirmedBy: z.string().nullable(),
  confirmedAt: isoDateTimeSchema.nullable(),
});
export type ResourceBindingRefDto = z.infer<typeof resourceBindingRefDtoSchema>;

/**
 * One resource's binding on the wire: its identity plus all six refs (RB-3
 * criterion 1 lists every applicable ref for the resource).
 */
export const resourceBindingDtoSchema = z.object({
  id: z.string(),
  apiSpecId: z.string(),
  resourceRef: z.string(),
  refs: z.array(resourceBindingRefDtoSchema),
});
export type ResourceBindingDto = z.infer<typeof resourceBindingDtoSchema>;

/** `GET /api/specs/:id/resource-bindings` response (RB-3): the spec's bindings. */
export const resourceBindingsResponseSchema = z.object({
  bindings: z.array(resourceBindingDtoSchema),
});
export type ResourceBindingsResponse = z.infer<typeof resourceBindingsResponseSchema>;

/**
 * `PATCH /api/resource-bindings/:id` request (RB-2): confirm or correct **one**
 * ref (confirmation is per-ref — RB-2 criterion 3). Naming a `refKind` with no
 * `value` confirms the existing guess; supplying `value` corrects the ref to a
 * new IR target and confirms it in the same action (RB-2 criteria 1/2). A
 * correction naming an element not in the resource's IR is rejected (criterion
 * 4); confirming a not-applicable ref is rejected (criterion 5).
 */
export const updateResourceBindingRequestSchema = z.object({
  refKind: resourceBindingRefKindSchema,
  value: irRefTargetSchema.optional(),
});
export type UpdateResourceBindingRequest = z.infer<typeof updateResourceBindingRequestSchema>;

/** `PATCH /api/resource-bindings/:id` response: the updated binding. */
export const updateResourceBindingResponseSchema = resourceBindingDtoSchema;
export type UpdateResourceBindingResponse = z.infer<typeof updateResourceBindingResponseSchema>;
