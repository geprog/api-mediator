import { z } from "zod";

import { transformConfigSchema } from "./field-mapping.js";
import { transformKindSchema } from "./mapping-enums.js";

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

// ── recordAddressRef (container-relative record address, SS-19) ───────────────

/**
 * **The two identities of a container-scoped record** (SS-19,
 * `docs/architecture/data-model.md` `ResourceBinding.recordAddressRef`). A record
 * inside a container commonly carries *two* distinct identifiers, and a single ref
 * cannot serve both jobs:
 *
 * - **Global identity** — unique across *all* containers (a Gitea issue's `id`).
 *   This is {@link ResourceBinding.nativeIdRef}, and it is what a `RecordLink`
 *   stores and links by. It is correct for **linking** precisely because it never
 *   collides across containers.
 * - **Container-relative address** — unique only *within* one container (a Gitea
 *   issue's `number`, the `{index}` of
 *   `PATCH /repos/{owner}/{repo}/issues/{index}`). This is what the API actually
 *   **addresses** records by, and it is what `recordAddressRef` names.
 *
 * Using `nativeIdRef` to address composes `/repos/{owner}/{repo}/issues/<globalId>`
 * and 404s; using the container-relative address to *link* would merge repo A's #1
 * with repo B's #1 — the record-merge failure mode this system guards hardest
 * against. So the two stay separate refs with separate jobs, and both jobs are
 * satisfied at once.
 *
 * Modeled as an ordinary {@link ConfirmableRef} — derived unconfirmed at ingestion
 * (RB-1) and **operator-confirmed** through the exact same RB-3 confirm/correct
 * mechanism as every other ref; nothing auto-confirms it.
 *
 * **Absent** (the key omitted) means "this resource addresses records by their
 * native id" — the case for every unscoped resource, for a scoped resource whose
 * addressing parameter genuinely *is* the native id, and for every binding that
 * predates SS-19. An absent ref therefore reproduces the pre-SS-19 behavior
 * byte for byte.
 */

/**
 * How one side's records are **addressed** by an operation's record-id path
 * parameter — the single decision every write/read composition makes, derived from
 * that side's {@link ResourceBinding.recordAddressRef} plus whether the resource is
 * container-scoped. A discriminated union rather than a boolean because the third
 * state (a derived-but-unconfirmed ref on a scoped resource) must **fail loud**, not
 * silently pick one of the other two.
 *
 * - `native-id` — address from `nativeIdRef`, i.e. exactly the pre-SS-19 behavior.
 * - `stored-address` — address from the `RecordLink`'s frozen per-side record address.
 * - `unconfirmed-address-ref` — the resource is scoped and an address ref was derived
 *   but **not confirmed**: the mediator does not know which of the record's two
 *   identifiers this operation addresses by, so composing a URL would either 404 or
 *   hit the *wrong* record in the right container. Callers park / block enablement.
 */
export type RecordAddressing =
  | { readonly kind: "native-id" }
  | { readonly kind: "stored-address" }
  | { readonly kind: "unconfirmed-address-ref" };

/**
 * Decide how a resource addresses its records (SS-19 criteria 2/4/5). **Pure and
 * total** — like the enablement gate, every input yields a decision and it never
 * throws.
 *
 * The ordering of the branches *is* the backward-compatibility guarantee:
 *
 * 1. **No `recordAddressRef` at all → `native-id`.** Every binding that predates
 *    SS-19, every unscoped resource, and every resource whose address genuinely is its
 *    native id land here, so their composition is byte-for-byte what it was before.
 *    The migration adds no ref rows, so *all* existing rows take this branch.
 * 2. **Confirmed ref → `stored-address`.** The operator has ratified which field is
 *    the container-relative address, so the frozen `RecordLink` address is used.
 * 3. **Present-but-unconfirmed on a container-scoped resource →
 *    `unconfirmed-address-ref`.** Derive-then-confirm: derivation proposed a
 *    candidate, nobody ratified it, and this is precisely the case where guessing
 *    wrong writes to another record. Fail loud.
 * 4. **Present-but-unconfirmed on an *unscoped* resource → `native-id`.** With no
 *    container there is nothing for an address to be relative to, so an unratified
 *    candidate is inert rather than blocking — an unscoped resource is never
 *    penalised for a derivation it does not need.
 */
export function resolveRecordAddressing(
  binding: Pick<ResourceBinding, "recordAddressRef">,
  isContainerScoped: boolean,
): RecordAddressing {
  const ref = binding.recordAddressRef;
  if (ref === undefined) {
    return { kind: "native-id" };
  }
  if (ref.confirmedBy !== null && ref.confirmedAt !== null) {
    return { kind: "stored-address" };
  }
  return isContainerScoped ? { kind: "unconfirmed-address-ref" } : { kind: "native-id" };
}

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
 * The optional `transform` a `record-derived` scope binding (below) may carry —
 * modeled by **reusing the `FieldMapping` transform shape**: a
 * {@link transformKindSchema} `kind` plus the optional {@link transformConfigSchema}
 * `config`.
 *
 * A captured scope is a **routing/identity key that must round-trip** (it also keys
 * scoped identity matching under multi-scope — SS-14), so a `record-derived`
 * transform is **value-preserving only**, exactly as an identity `FieldMapping`
 * (`isIdentityKey = true`) may carry only `transform = rename` (AS-5 /
 * `docs/architecture/data-model.md` `FieldMapping.isIdentityKey`). See
 * {@link isValuePreservingScopeTransform}; the constraint is enforced by
 * {@link scopePathBindingSchema}'s refinement below (domain layer) and again at
 * confirm time (SS-8 criterion 3).
 */
export const scopeTransformSchema = z.object({
  kind: transformKindSchema,
  config: transformConfigSchema.optional(),
});
export type ScopeTransform = z.infer<typeof scopeTransformSchema>;

/**
 * The value-preserving rule for a {@link ScopeTransform}, mirroring the identity-key
 * rule **exactly** — the identity `FieldMapping` constraint is
 * `transform === "rename"` (AS-5, `field-mapping.ts`), so the single value-preserving
 * transform **kind** is `rename`. A `coerce` / `aggregate` / `expression` transform
 * alters the value and is rejected for a captured scope that must round-trip.
 */
export function isValuePreservingScopeTransform(transform: ScopeTransform): boolean {
  return transform.kind === "rename";
}

/**
 * The **`record-derived`** scope path-parameter binding (SS-8, Layer 2):
 * `{ kind: "record-derived", parameterName, sourceScopeKey, transform?, confirmedBy,
 * confirmedAt }`. The parameter is filled **per record** from the record's *captured
 * scope* (extracted by the *source* resource's `sourceScopeRef` — SS-7) when the two
 * sides share (or value-preservingly transform between) the scope value-space.
 *
 * - `sourceScopeKey` selects **which** captured component fills this parameter — the
 *   `key` of a component of the source resource's `sourceScopeRef`, resolved through
 *   the rule's source↔target resource pair. It is validated here only as a **required,
 *   non-empty string** (so a confirmed entry always carries one): it is **not** checked
 *   against the source resource's components here — that is cross-resource and per-rule,
 *   which the SS-9 enablement gate does, not this per-binding shape.
 * - `transform` is optional and **value-preserving only** ({@link scopeTransformSchema},
 *   {@link isValuePreservingScopeTransform}); a value-altering transform is rejected by
 *   the refinement below.
 *
 * Choosing `record-derived` **is the operator's assertion** that the captured component
 * and the target parameter share a value-space (SS-8 criterion 4); where they are
 * genuinely arbitrary a `scope-link` (Layer 3) is required instead.
 */
export const scopeRecordDerivedBindingSchema = z.object({
  kind: z.literal("record-derived"),
  parameterName: z.string(),
  sourceScopeKey: z.string().min(1),
  transform: scopeTransformSchema.optional(),
  confirmedBy: z.string().nullable(),
  confirmedAt: z.date().nullable(),
});
export type ScopeRecordDerivedBinding = z.infer<typeof scopeRecordDerivedBindingSchema>;

/**
 * The **`scope-link`** scope path-parameter binding (SS-12, Layer 3):
 * `{ kind: "scope-link", parameterName, scopeKeyRef, confirmedBy, confirmedAt }`. The
 * value-spaces are **arbitrary** (a Gitea repo name vs a Vikunja project id), so the
 * parameter is filled from the record's resolved `ScopeLink` — the target-side
 * container key — rather than from the record's captured scope
 * (`docs/architecture/data-model.md` `ResourceBinding.scopePathBindings`).
 *
 * - `scopeKeyRef` selects **which** target container key the resolved `ScopeLink`
 *   supplies — the component of that side's `ScopeLink.appXScopeKey` map this
 *   parameter reads. Validated here only as a **required, non-empty string** (so a
 *   confirmed entry always carries one); resolving it against a live `ScopeLink` is
 *   the SS-12 resolver's job, not this per-binding shape.
 *
 * Carries the same `confirmedBy`/`confirmedAt` pair — and so the same confirmed-pair
 * invariant, enforced for every member by {@link scopePathBindingSchema} below — as
 * the `constant` and `record-derived` members. It slots into the existing
 * discriminated union beside them **without reshaping the collection** (SS-12
 * criterion 1).
 */
export const scopeScopeLinkBindingSchema = z.object({
  kind: z.literal("scope-link"),
  parameterName: z.string(),
  scopeKeyRef: z.string().min(1),
  confirmedBy: z.string().nullable(),
  confirmedAt: z.date().nullable(),
});
export type ScopeScopeLinkBinding = z.infer<typeof scopeScopeLinkBindingSchema>;

/**
 * The `scopePathBindings` entry union. Modeled as a `z.discriminatedUnion` over
 * `kind` so `record-derived` (SS-8) and `scope-link` (SS-12) slot in beside
 * `constant` (SS-1) without reshaping. The confirmed-pair invariant —
 * `confirmedBy`/`confirmedAt` are **both null while unconfirmed and both set together
 * on confirmation** (SS-1 criterion 4, mirroring {@link confirmableRefSchema}) — is
 * enforced here for every kind, since all kinds carry the same confirmation pair.
 */
export const scopePathBindingSchema = z
  .discriminatedUnion("kind", [
    scopeConstantBindingSchema,
    scopeRecordDerivedBindingSchema,
    scopeScopeLinkBindingSchema,
  ])
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
    const confirmed = !byIsNull && !atIsNull;
    // A confirmed `constant` names an operator-authored literal; it cannot be
    // confirmed empty (data-model.md `ResourceBinding` scopePathBindings). An
    // unconfirmed entry may be empty (a derived candidate awaiting supply). The
    // `binding.kind === "constant"` narrow both selects the constant member (so
    // `binding.value` type-checks) and keeps the invariant off the value-less
    // `record-derived` member.
    if (binding.kind === "constant" && confirmed && binding.value.length === 0) {
      ctx.addIssue({
        code: "custom",
        message: "a confirmed constant scope binding must carry a non-empty value",
        path: ["value"],
      });
    }
    // A `record-derived` transform must be value-preserving (mirrors the identity-key
    // rule — SS-8 criterion 3). Enforced whether confirmed or not: a captured scope
    // that must round-trip may never carry a value-altering transform. `sourceScopeKey`
    // is `min(1)` on the member schema, so a confirmed `record-derived` always carries
    // a non-empty one (the confirmed⇒required-field invariant) without a refinement.
    if (
      binding.kind === "record-derived" &&
      binding.transform !== undefined &&
      !isValuePreservingScopeTransform(binding.transform)
    ) {
      ctx.addIssue({
        code: "custom",
        message:
          "a record-derived scope binding's transform must be value-preserving (transform.kind = rename)",
        path: ["transform", "kind"],
      });
    }
  });
export type ScopePathBinding = z.infer<typeof scopePathBindingSchema>;

// ── sourceScopeRef (record scope capture) ────────────────────────────────────

/**
 * One **scope component** of a {@link SourceScopeRef} (`docs/glossary.md`
 * *sourceScopeRef (record scope capture)*): one field of a resource's record
 * representation that carries part of its **container identity**.
 *
 * - `key` — a stable component name (defaulting at derivation to the `fieldPath`'s
 *   leaf segment, operator-correctable), the key under which the captured value
 *   appears in the record's **captured scope** (Gitea `{ owner, name }`, Vikunja
 *   `{ project }`).
 * - `fieldPath` — an IR field path into the resource's **response** schema
 *   (`repository.owner`, `project_id`); validated against that schema at confirm.
 *
 * Distinct from a `record-derived` `scopePathBindings` entry's `sourceScopeKey`
 * (SS-8), which *selects* one already-captured component to fill a *target* scope
 * parameter rather than *defining* the capture.
 */
export const scopeComponentSchema = z.object({
  key: z.string().min(1),
  fieldPath: z.string().min(1),
});
export type ScopeComponent = z.infer<typeof scopeComponentSchema>;

/**
 * `sourceScopeRef` — the `ResourceBinding` ref naming which field(s) of a
 * resource's record carry its **container identity**, so the Poller captures each
 * record's scope from the record it already fetched (`docs/architecture/data-model.md`
 * `ResourceBinding.sourceScopeRef`; SS-7). A **source-side** property of a
 * resource that can act as a scoped sync source.
 *
 * Modeled as **one confirmable ref whose value is the component set** — a single
 * `confirmedBy`/`confirmedAt` pair over the whole {@link ScopeComponent} set, not
 * a per-component confirmation. The confirmed-pair invariant (both null while
 * unconfirmed, both set together on confirmation — mirroring
 * {@link confirmableRefSchema}) is enforced by the refinement below, and component
 * `key`s must be unique (they key the `{ key → value }` captured-scope map, so a
 * duplicate would collide).
 *
 * **Absent** (the top-level ref omitted from the binding) when the resource's
 * records carry no container field — record-derived scope is then unavailable and
 * a `constant`/`scope-link` `scopePathBindings` entry is the only option (SS-7.3).
 * When present it names **at least one** component. Derived-unconfirmed at
 * ingestion and used nowhere until confirmed (SS-7.4).
 */
export const sourceScopeRefSchema = z
  .object({
    components: z.array(scopeComponentSchema).min(1),
    confirmedBy: z.string().nullable(),
    confirmedAt: z.date().nullable(),
  })
  .superRefine((ref, ctx) => {
    const byIsNull = ref.confirmedBy === null;
    const atIsNull = ref.confirmedAt === null;
    if (byIsNull !== atIsNull) {
      ctx.addIssue({
        code: "custom",
        message:
          "confirmedBy and confirmedAt must both be null (unconfirmed) or both be set (confirmed)",
        path: [byIsNull ? "confirmedBy" : "confirmedAt"],
      });
    }
    const seen = new Set<string>();
    ref.components.forEach((component, index) => {
      if (seen.has(component.key)) {
        ctx.addIssue({
          code: "custom",
          message: `duplicate scope component key '${component.key}'`,
          path: ["components", index, "key"],
        });
      }
      seen.add(component.key);
    });
  });
export type SourceScopeRef = z.infer<typeof sourceScopeRefSchema>;

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
  // The container-relative addressing ref (SS-19). Absent = the resource addresses
  // records by their native id (every unscoped resource, and every pre-SS-19 row).
  recordAddressRef: confirmableRefSchema.optional(),
  collectionReadRef: confirmableRefSchema.optional(),
  paginationRef: confirmableRefSchema.optional(),
  deltaCursorRef: confirmableRefSchema.optional(),
  deltaDeletionRef: confirmableRefSchema.optional(),
  changeTimestampRef: confirmableRefSchema.optional(),
  // The record-scope-capture ref (SS-7): absent when records carry no container
  // field. Unlike the six `ConfirmableRef`s above, its "value" is a component set
  // rather than a single IR pointer, so it has its own schema.
  sourceScopeRef: sourceScopeRefSchema.optional(),
  scopePathBindings: z.array(scopePathBindingSchema).optional(),
});
export type ResourceBinding = z.infer<typeof resourceBindingSchema>;
