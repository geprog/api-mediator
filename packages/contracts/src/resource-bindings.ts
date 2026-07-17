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
 * One resource's **scope path-parameter binding** on the wire (SS-3 criterion 6):
 * a derived scope entry, keyed by `parameterName`, with its fill-source `kind`,
 * its literal `value`, and its confirmed/unconfirmed state.
 *
 * Unlike a {@link resourceBindingRefDtoSchema} (whose `value` is an IR *pointer*),
 * a `constant` scope binding's `value` is the operator-authored literal — shown as
 * entered (it is operator config, not credential/live payload — SS-3.6). Empty
 * while unconfirmed (`confirmedAt: null`); a confirmed constant carries a
 * non-empty literal (`confirmedBy`/`confirmedAt` set). `kind` is a `z.enum` so the
 * `record-derived`/`scope-link` members (Layers 2/3) extend it without reshaping.
 */
export const resourceBindingScopeDtoSchema = z.object({
  parameterName: z.string(),
  kind: z.enum(["constant"]),
  value: z.string(),
  confirmedBy: z.string().nullable(),
  confirmedAt: isoDateTimeSchema.nullable(),
});
export type ResourceBindingScopeDto = z.infer<typeof resourceBindingScopeDtoSchema>;

/**
 * One resource's **`sourceScopeRef`** on the wire (SS-7): the record-scope-capture
 * ref's confirmable component set. `components` is the `{ key, fieldPath }` set the
 * Poller would capture each record's scope through; `confirmedBy`/`confirmedAt`
 * report its single confirmed/unconfirmed state (`confirmedAt: null` while
 * unconfirmed). The whole DTO is **null** when the resource carries no container
 * field (the domain **absent** ref) — so SS-9's UI can tell absent apart from a
 * present-unconfirmed ref. Field paths are IR pointers, never live payload.
 */
export const resourceBindingSourceScopeRefDtoSchema = z.object({
  components: z.array(z.object({ key: z.string(), fieldPath: z.string() })),
  confirmedBy: z.string().nullable(),
  confirmedAt: isoDateTimeSchema.nullable(),
});
export type ResourceBindingSourceScopeRefDto = z.infer<
  typeof resourceBindingSourceScopeRefDtoSchema
>;

/**
 * One resource's binding on the wire: its identity, all six operational refs
 * (RB-3 criterion 1), its scope path-parameter bindings (SS-3 criterion 6), and
 * its record-scope-capture ref (SS-7). `scopeBindings` is empty for a resource with
 * no non-record-id path parameter; `sourceScopeRef` is **null** for a resource that
 * carries no container field.
 */
export const resourceBindingDtoSchema = z.object({
  id: z.string(),
  apiSpecId: z.string(),
  resourceRef: z.string(),
  refs: z.array(resourceBindingRefDtoSchema),
  scopeBindings: z.array(resourceBindingScopeDtoSchema),
  sourceScopeRef: resourceBindingSourceScopeRefDtoSchema.nullable(),
});
export type ResourceBindingDto = z.infer<typeof resourceBindingDtoSchema>;

/** `GET /api/specs/:id/resource-bindings` response (RB-3): the spec's bindings. */
export const resourceBindingsResponseSchema = z.object({
  bindings: z.array(resourceBindingDtoSchema),
});
export type ResourceBindingsResponse = z.infer<typeof resourceBindingsResponseSchema>;

/**
 * The **operational-ref** patch of the confirm/correct action (RB-2): confirm or
 * correct **one** of the six refs, addressed by `refKind`. Naming a `refKind` with
 * no `value` confirms the existing guess; supplying `value` corrects the ref to a
 * new IR target and confirms it in the same action (RB-2 criteria 1/2). A
 * correction naming an element not in the resource's IR is rejected (criterion 4);
 * confirming a not-applicable ref is rejected (criterion 5).
 */
export const updateResourceBindingRefRequestSchema = z
  .object({
    refKind: resourceBindingRefKindSchema,
    value: irRefTargetSchema.optional(),
  })
  .strict();
export type UpdateResourceBindingRefRequest = z.infer<typeof updateResourceBindingRefRequestSchema>;

/**
 * The **scope-binding** patch of the same action (SS-3): supply and confirm one
 * scope path-parameter `constant`, addressed by `parameterName` (scope bindings
 * are keyed by parameter name, not `refKind`). A confirm supplies the literal
 * `value` and stamps `confirmedBy`/`confirmedAt` in one action (SS-3.1). `value`
 * is a **free literal**, not IR-validated (SS-3.4 — only `parameterName` is
 * checked, against the resource's derived scope set, server-side). `value` is
 * optional here so an **empty or absent** value reaches the service as the single
 * SS-3.3 rejection ("a scope binding cannot be confirmed into use without a
 * value") — mirroring where RB-2 puts its confirm/correct validations. `.strict()`
 * on both branches makes the two patch shapes mutually exclusive — a payload
 * carrying both `refKind` and `parameterName` is rejected, so a ref patch and a
 * scope patch cannot combine in one request.
 */
export const updateScopeBindingRequestSchema = z
  .object({
    parameterName: z.string().min(1),
    value: z.string().optional(),
  })
  .strict();
export type UpdateScopeBindingRequest = z.infer<typeof updateScopeBindingRequestSchema>;

/**
 * The **`sourceScopeRef`** patch of the same action (SS-7): confirm/correct the
 * whole record-scope-capture ref, addressed by carrying a `components` set — a
 * *third* patch shape, disambiguated from the ref patch (`refKind`) and the scope
 * patch (`parameterName`) purely by which key it carries. Unlike those two,
 * `sourceScopeRef` is **one** ref whose value is the component set, so the operator
 * supplies/adjusts the **full** set (add / remove / rename components, set each
 * `fieldPath`) and it is confirmed as a whole (SS-7.2). Each component's `fieldPath`
 * is validated against the resource's **response** schema server-side (a real field
 * path — as RB-2 validates a ref target); an empty set is rejected there (an absent
 * `sourceScopeRef`, not a confirmed-empty one). `.strict()` keeps the three patch
 * shapes mutually exclusive — a payload mixing `components` with `refKind`/
 * `parameterName` is rejected.
 */
export const sourceScopeComponentPatchSchema = z
  .object({
    key: z.string().min(1),
    fieldPath: z.string().min(1),
  })
  .strict();
export type SourceScopeComponentPatch = z.infer<typeof sourceScopeComponentPatchSchema>;

export const updateSourceScopeRefRequestSchema = z
  .object({
    components: z.array(sourceScopeComponentPatchSchema),
  })
  .strict();
export type UpdateSourceScopeRefRequest = z.infer<typeof updateSourceScopeRefRequestSchema>;

/**
 * `PATCH /api/resource-bindings/:id` request: an operational-ref patch (RB-2), a
 * scope-binding patch (SS-3), **or** a `sourceScopeRef` patch (SS-7), distinguished
 * by which key it carries (`refKind` / `parameterName` / `components`). One PATCH
 * confirms exactly one binding target.
 */
export const updateResourceBindingRequestSchema = z.union([
  updateResourceBindingRefRequestSchema,
  updateScopeBindingRequestSchema,
  updateSourceScopeRefRequestSchema,
]);
export type UpdateResourceBindingRequest = z.infer<typeof updateResourceBindingRequestSchema>;

/** `PATCH /api/resource-bindings/:id` response: the updated binding. */
export const updateResourceBindingResponseSchema = resourceBindingDtoSchema;
export type UpdateResourceBindingResponse = z.infer<typeof updateResourceBindingResponseSchema>;
