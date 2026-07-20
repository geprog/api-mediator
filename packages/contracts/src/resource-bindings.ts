import { irRefTargetSchema, scopeTransformSchema } from "@mediator/domain";
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
 * One resource's **scope path-parameter binding** on the wire (SS-3 criterion 6,
 * SS-8 criterion 1, SS-9): a derived scope entry keyed by `parameterName`, with its
 * confirmed/unconfirmed state and the per-kind datum the SS-6/SS-9 UI consumes. Modeled
 * as a **discriminated union on `kind`** so each fill source reports exactly its own
 * datum (a `record-derived` entry no longer carries a misleading `value: ""` — the SS-8a
 * should-fix), and so the SS-9 kind-choice UI can render each kind correctly:
 *
 * - `constant` — carries the operator-authored literal `value`, shown as entered (operator
 *   config, not credential/live payload — SS-3.6). Empty while unconfirmed
 *   (`confirmedAt: null`); a confirmed constant carries a non-empty literal. The SS-6
 *   constant panel reads this member's `value`.
 * - `record-derived` — carries `sourceScopeKey` (which captured-scope component fills the
 *   parameter — SS-8) and `transform` (present only when set — its value-preserving
 *   transform); it carries **no** constant literal.
 * - `scope-link` — carries `scopeKeyRef` (which target-container key of the record's
 *   resolved `ScopeLink` fills the parameter — SS-12); no literal, no transform (the
 *   value-space bridge is the `ScopeLink` itself). SS-12 is the first slice that persists a
 *   `scope-link` binding, so this member makes the bindings GET **lossless** (the
 *   container-linking screen that reads it is SS-15).
 */
export const resourceBindingScopeConstantDtoSchema = z.object({
  parameterName: z.string(),
  kind: z.literal("constant"),
  value: z.string(),
  confirmedBy: z.string().nullable(),
  confirmedAt: isoDateTimeSchema.nullable(),
});
export type ResourceBindingScopeConstantDto = z.infer<typeof resourceBindingScopeConstantDtoSchema>;

export const resourceBindingScopeRecordDerivedDtoSchema = z.object({
  parameterName: z.string(),
  kind: z.literal("record-derived"),
  /** Which captured-scope component (source `sourceScopeRef` key) fills this parameter (SS-8). */
  sourceScopeKey: z.string(),
  /** Present only when set: the value-preserving transform applied to the captured value (SS-8). */
  transform: scopeTransformSchema.optional(),
  confirmedBy: z.string().nullable(),
  confirmedAt: isoDateTimeSchema.nullable(),
});
export type ResourceBindingScopeRecordDerivedDto = z.infer<
  typeof resourceBindingScopeRecordDerivedDtoSchema
>;

export const resourceBindingScopeScopeLinkDtoSchema = z.object({
  parameterName: z.string(),
  kind: z.literal("scope-link"),
  /** Which target-container key of the resolved `ScopeLink` fills this parameter (SS-12). */
  scopeKeyRef: z.string(),
  confirmedBy: z.string().nullable(),
  confirmedAt: isoDateTimeSchema.nullable(),
});
export type ResourceBindingScopeScopeLinkDto = z.infer<
  typeof resourceBindingScopeScopeLinkDtoSchema
>;

export const resourceBindingScopeDtoSchema = z.discriminatedUnion("kind", [
  resourceBindingScopeConstantDtoSchema,
  resourceBindingScopeRecordDerivedDtoSchema,
  resourceBindingScopeScopeLinkDtoSchema,
]);
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
 *
 * The last two fields carry the SS-18.4 kind-selector context, so the client never has
 * to know about `ScopeCorrespondence`/`ScopeLink` to render the selector correctly:
 *
 * - `scopeLinkAvailable` — whether this resource's pair has a proposed
 *   `ScopeCorrespondence` (SS-18.1). `scope-link` is a **selectable** kind exactly when
 *   this is `true`; for a non-scoped pair it stays `false` and the option stays
 *   disabled, so L1 `constant` / L2 `record-derived` authoring is unchanged.
 * - `scopeKeyRefCandidate` — the mediator's **derived** `scopeKeyRef` for this
 *   resource's scope parameters (which component of that side's
 *   `ScopeLink.appXScopeKey` addresses them), or `null` when it cannot be derived. A
 *   proposal the operator may correct, never a confirmation.
 */
export const resourceBindingDtoSchema = z.object({
  id: z.string(),
  apiSpecId: z.string(),
  resourceRef: z.string(),
  refs: z.array(resourceBindingRefDtoSchema),
  scopeBindings: z.array(resourceBindingScopeDtoSchema),
  sourceScopeRef: resourceBindingSourceScopeRefDtoSchema.nullable(),
  scopeLinkAvailable: z.boolean(),
  scopeKeyRefCandidate: z.string().nullable(),
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
 * The **scope-binding** patch of the same action: supply and confirm one scope
 * path-parameter binding, addressed by `parameterName` (scope bindings are keyed by
 * parameter name, not `refKind`). It is itself a **discriminated confirm** — one
 * shape per fill source it can confirm an entry *into*:
 *
 * - **`constant`** (SS-3) — {@link updateScopeConstantBindingRequestSchema}: supplies
 *   the literal `value` and stamps confirmation in one action (SS-3.1). Carries **no**
 *   `kind` key, so the constant wire shape is **unchanged** from Layer 1 (no SS-3
 *   regression); it is the branch that has no `kind`.
 * - **`record-derived`** (SS-8) — {@link updateScopeRecordDerivedBindingRequestSchema}:
 *   carries `kind: "record-derived"` and sets `sourceScopeKey` (+ optional
 *   value-preserving `transform`) + confirmation in one action (SS-8.1/8.3).
 *
 * Both branches are `.strict()`, so they are mutually exclusive (a `constant` payload
 * cannot carry `kind`/`sourceScopeKey`, and a `record-derived` payload cannot carry
 * `value`) and neither can combine with a `refKind`/`components` patch. Both are
 * routed to the scope-binding service by their shared `parameterName` key; the service
 * then discriminates on `kind`.
 */
export const updateScopeConstantBindingRequestSchema = z
  .object({
    parameterName: z.string().min(1),
    value: z.string().optional(),
  })
  .strict();
export type UpdateScopeConstantBindingRequest = z.infer<
  typeof updateScopeConstantBindingRequestSchema
>;

/**
 * The `record-derived` scope-binding confirm (SS-8). `sourceScopeKey` is **optional**
 * on the wire so an **empty or absent** key reaches the service as the single SS-8
 * rejection ("a record-derived scope binding cannot be confirmed without a
 * sourceScopeKey") — mirroring how {@link updateScopeConstantBindingRequestSchema}
 * defers the empty-`value` check to the service. `transform` is validated for the
 * **value-preserving** rule in the service ({@link scopeTransformSchema} itself accepts
 * any transform kind, so a value-altering one parses but is rejected 400 there),
 * mirroring the identity-key rule exactly.
 */
export const updateScopeRecordDerivedBindingRequestSchema = z
  .object({
    parameterName: z.string().min(1),
    kind: z.literal("record-derived"),
    sourceScopeKey: z.string().optional(),
    transform: scopeTransformSchema.optional(),
  })
  .strict();
export type UpdateScopeRecordDerivedBindingRequest = z.infer<
  typeof updateScopeRecordDerivedBindingRequestSchema
>;

/**
 * The **`scope-link`** scope-binding patch (SS-18.4, extending the SS-9.2 kind
 * selector to Layer 3). Two distinct operator actions share this one shape,
 * discriminated by `confirm` — which is what keeps SS-18.4's "written … left
 * **unconfirmed** until the operator confirms it" and SS-18.8's "nothing is silently
 * auto-confirmed" both true:
 *
 * - **`confirm` absent / `false`** — *selecting* `scope-link` as the parameter's fill
 *   source. The entry is rewritten to the `scope-link` member with its `scopeKeyRef`
 *   and an explicitly **null** confirmation pair, so the choice is recorded but used
 *   nowhere (`resolveScopeLinkScopeValues` skips unconfirmed entries, and the SS-15
 *   gate still blocks the rule).
 * - **`confirm: true`** — the operator ratifying it, stamping `confirmedBy`/
 *   `confirmedAt` exactly as the `constant`/`record-derived` supply-and-confirm does.
 *
 * `scopeKeyRef` is **optional on the wire** so an empty/absent one reaches the service
 * as a single 400 ("cannot be confirmed scope-link without a scopeKeyRef"), mirroring
 * how the constant defers its empty-`value` check and `record-derived` its empty
 * `sourceScopeKey` check. The client normally echoes back the mediator's **derived**
 * candidate (`ResourceBindingDto.scopeKeyRefCandidate`), and may correct it — the
 * derivation is a proposal, never an imposition.
 */
export const updateScopeScopeLinkBindingRequestSchema = z
  .object({
    parameterName: z.string().min(1),
    kind: z.literal("scope-link"),
    scopeKeyRef: z.string().optional(),
    confirm: z.boolean().optional(),
  })
  .strict();
export type UpdateScopeScopeLinkBindingRequest = z.infer<
  typeof updateScopeScopeLinkBindingRequestSchema
>;

export const updateScopeBindingRequestSchema = z.union([
  updateScopeConstantBindingRequestSchema,
  updateScopeRecordDerivedBindingRequestSchema,
  updateScopeScopeLinkBindingRequestSchema,
]);
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
 * scope-binding patch — `constant` (SS-3), `record-derived` (SS-8) **or** `scope-link`
 * (SS-18.4) — **or** a `sourceScopeRef` patch (SS-7), distinguished by which key it
 * carries (`refKind` / `parameterName` / `components`); the three scope-binding shapes are
 * then told apart by their `kind` (the `constant` branch is the one that carries none).
 * One PATCH confirms exactly one binding target.
 */
export const updateResourceBindingRequestSchema = z.union([
  updateResourceBindingRefRequestSchema,
  updateScopeConstantBindingRequestSchema,
  updateScopeRecordDerivedBindingRequestSchema,
  updateScopeScopeLinkBindingRequestSchema,
  updateSourceScopeRefRequestSchema,
]);
export type UpdateResourceBindingRequest = z.infer<typeof updateResourceBindingRequestSchema>;

/** `PATCH /api/resource-bindings/:id` response: the updated binding. */
export const updateResourceBindingResponseSchema = resourceBindingDtoSchema;
export type UpdateResourceBindingResponse = z.infer<typeof updateResourceBindingResponseSchema>;
