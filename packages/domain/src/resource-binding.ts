import { z } from "zod";

/**
 * `ResourceBinding` — the per-resource operational bindings of an `ApiSpec`:
 * the concrete IR elements that make an app's declared `capabilities`
 * executable against one resource (native-id field, collection read, pagination
 * parameters, delta cursor + its deletion reporting, change-timestamp field).
 *
 * OpenAPI declares none of these conventions, so each ref is derived
 * mechanically at ingestion (RB-1) and confirmed or corrected by the operator
 * (RB-2). See `docs/architecture/data-model.md` `ResourceBinding`.
 *
 * ## Ref + confirmation shape (design decision)
 *
 * Each of the six refs is modeled as an **optional** {@link ConfirmableRef} that
 * co-locates the ref's value with its own confirmation metadata:
 *
 * ```ts
 * { value: IrRefTarget, confirmedBy: string | null, confirmedAt: Date | null }
 * ```
 *
 * This shape (one confirmable object per ref) was chosen over a split
 * "value map + separate confirmation map" because the data model describes
 * `confirmedBy`/`confirmedAt` as living *per ref*: keeping a ref's value and its
 * confirmation state in one object makes them impossible to desync, and makes an
 * absent ref a single top-level key omission. **Absent** = the ref was not
 * derived / is not meaningful for this resource (e.g. no collection read exists,
 * or the app declares neither `supportsDeltaQuery` nor `supportsChangeTimestamps`
 * — RB-1 criteria 3/5/6); the "not-applicable vs. merely-unconfirmed" UI
 * distinction (RB-2/RB-3) is derived from the owning app's `capabilities`, not
 * stored on the binding. A present-but-**unconfirmed** ref carries a value with
 * `confirmedBy = null` and `confirmedAt = null` (RB-1 criterion 7).
 */

/**
 * A typed pointer into the resource's IR — what a ref's `value` is.
 *
 * A discriminated union over the three kinds of IR element a ref can name
 * (RB-2 criterion 4 requires a confirmed/corrected ref to resolve to a field,
 * parameter, or operation of the resource):
 *
 * - `field`     — a schema field, by its path (e.g. the native-id or
 *                 change-timestamp field).
 * - `operation` — an operation, by `operationId` (e.g. the collection read).
 * - `parameter` — an operation input, by `operationId` + parameter name (e.g. a
 *                 pagination or delta-cursor parameter).
 *
 * Phase 1 only needs to *point at* the primary element a heuristic guessed; the
 * richer per-ref execution detail some refs eventually need (a pagination ref's
 * page + limit parameters and exhaustion convention, a delta ref's response
 * cursor location) is layered on in Phase 4 where the refs are first consumed.
 */
export const irRefTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("field"), path: z.string() }),
  z.object({ kind: z.literal("operation"), operationId: z.string() }),
  z.object({ kind: z.literal("parameter"), operationId: z.string(), parameter: z.string() }),
]);
export type IrRefTarget = z.infer<typeof irRefTargetSchema>;

/**
 * A single operational ref: its IR pointer plus its own confirmation state.
 * `confirmedBy`/`confirmedAt` are both `null` while unconfirmed and both set
 * together at confirmation (RB-2 criterion 1).
 */
export const confirmableRefSchema = z.object({
  value: irRefTargetSchema,
  confirmedBy: z.string().nullable(),
  confirmedAt: z.date().nullable(),
});
export type ConfirmableRef = z.infer<typeof confirmableRefSchema>;

/**
 * One resource's operational bindings. Each ref is independently optional and
 * independently confirmable — confirming one never implies another (RB-2
 * criterion 3).
 */
export const resourceBindingSchema = z.object({
  id: z.string(),
  apiSpecId: z.string(),
  resourceRef: z.string(),
  nativeIdRef: confirmableRefSchema.optional(),
  collectionReadRef: confirmableRefSchema.optional(),
  paginationRef: confirmableRefSchema.optional(),
  deltaCursorRef: confirmableRefSchema.optional(),
  deltaDeletionRef: confirmableRefSchema.optional(),
  changeTimestampRef: confirmableRefSchema.optional(),
});
export type ResourceBinding = z.infer<typeof resourceBindingSchema>;
