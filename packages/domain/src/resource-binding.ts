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

// ── scopePathBindings (scope path-parameter bindings) ─────────────────────────

/**
 * One **scope path-parameter binding** (`docs/glossary.md`,
 * `docs/architecture/data-model.md` `ResourceBinding.scopePathBindings`): how one
 * of a resource's **non-record-id path parameters** — a *scope* parameter that
 * locates a record's **container** (Gitea/Forgejo `{owner}`/`{repo}`, a Vikunja
 * project `{id}`, a `{tenant}`) — is filled when the Sync Engine calls a scoped
 * operation.
 *
 * A discriminated union over its **fill source** (`kind`), each variant
 * confirmed per parameter with the same `confirmedBy`/`confirmedAt` discipline as
 * a {@link ConfirmableRef}. Layer 1 (SS-1/SS-2) implements only `kind:
 * "constant"`; `record-derived` (the record carries its scope, shared
 * value-space — Layer 2) and `scope-link` (arbitrary value-spaces, resolved
 * through a `ScopeLink` — Layer 3) are added later as **further members of this
 * same union**, so the collection shape and the confirm-per-parameter discipline
 * never change.
 *
 * ## `constant`
 *
 * `{ kind: "constant", parameterName, value, confirmedBy, confirmedAt }` — an
 * operator-supplied literal (the single-scope case, one repo ↔ one board:
 * `owner = alice` / `repo = phoenix`). Unlike a {@link ConfirmableRef}, whose
 * `value` is an IR *pointer* validated against the IR (RB-2), a constant's
 * `value` is **free operator-authored content** (SS-1 criterion 3): only its
 * `parameterName` is validated against the resource's IR, never its `value`.
 * `value` may be an empty string while the entry is unconfirmed (a derived
 * candidate awaiting supply — SS-2 criterion 2); a **confirmed** constant must
 * carry a non-empty value (data-model.md: the operator-authored literal).
 */
export const scopeConstantBindingSchema = z.object({
  kind: z.literal("constant"),
  parameterName: z.string(),
  value: z.string(),
  confirmedBy: z.string().nullable(),
  confirmedAt: z.date().nullable(),
});
export type ScopeConstantBinding = z.infer<typeof scopeConstantBindingSchema>;

/**
 * The `scopePathBindings` entry union. Modeled as a `z.discriminatedUnion` over
 * `kind` so `record-derived` / `scope-link` slot in as additional members
 * without reshaping. The confirmed-pair invariant — `confirmedBy`/`confirmedAt`
 * are **both null while unconfirmed and both set together on confirmation** (SS-1
 * criterion 4, mirroring {@link confirmableRefSchema}) — is enforced here for
 * every kind, since all kinds carry the same confirmation pair.
 */
export const scopePathBindingSchema = z
  .discriminatedUnion("kind", [scopeConstantBindingSchema])
  .superRefine((binding, ctx) => {
    const byIsNull = binding.confirmedBy === null;
    const atIsNull = binding.confirmedAt === null;
    if (byIsNull !== atIsNull) {
      ctx.addIssue({
        code: "custom",
        message:
          "confirmedBy and confirmedAt must both be null (unconfirmed) or both be set (confirmed)",
        path: [byIsNull ? "confirmedBy" : "confirmedAt"],
      });
      return;
    }
    // A confirmed `constant` names an operator-authored literal; it cannot be
    // confirmed empty (data-model.md `ResourceBinding` scopePathBindings). An
    // unconfirmed entry may be empty (a derived candidate awaiting supply). When
    // Layers 2/3 add value-less kinds, `binding.value` stops type-checking here
    // and this must narrow to `binding.kind === "constant"` — enforced by the
    // compiler, so the invariant cannot silently over-apply.
    const confirmed = !byIsNull && !atIsNull;
    if (confirmed && binding.value.length === 0) {
      ctx.addIssue({
        code: "custom",
        message: "a confirmed constant scope binding must carry a non-empty value",
        path: ["value"],
      });
    }
  });
export type ScopePathBinding = z.infer<typeof scopePathBindingSchema>;

/**
 * One resource's operational bindings. Each ref is independently optional and
 * independently confirmable — confirming one never implies another (RB-2
 * criterion 3).
 *
 * `scopePathBindings` is a collection of per-parameter {@link ScopePathBinding}
 * entries, one per distinct **scope** (non-record-id) path parameter of the
 * resource's operations (SS-1 criterion 1) — keyed by `parameterName`, so at most
 * one entry per parameter name. Unlike the optional refs above (absent = "not
 * derivable / not meaningful"), a param-free resource carries an **empty**
 * collection, not an absent one. It is left `.optional()` only so partially
 * constructed bindings elsewhere need not restate it; every producer (the
 * ingestion derivation and the DB mapper) always emits the array.
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
  scopePathBindings: z.array(scopePathBindingSchema).optional(),
});
export type ResourceBinding = z.infer<typeof resourceBindingSchema>;
