import { z } from "zod";

import { isValuePreservingScopeTransform, scopeTransformSchema } from "./resource-binding.js";

/**
 * `ScopeCorrespondence` — the confirmed, direction-agnostic **configuration** that
 * governs how one scoped resource pair's containers are correlated
 * (`docs/architecture/data-model.md` `ScopeCorrespondence`; `docs/glossary.md`
 * `ScopeCorrespondence`, `scope identity key`; requirement SS-10). **One per scoped
 * resource pair**, under which `ScopeLink` instances (`scope-link.ts`) are
 * established. It is its own entity — neither on the single-spec `ResourceBinding`
 * nor on the one-directional `SyncRule` — because the container pairing is
 * inherently **cross-app** and **direction-agnostic** (SS-10 criterion 6). This is
 * the finalized home of the **scope identity key**.
 *
 * Types only, no behavior: establishing links (discovery/manual) is SS-11; filling /
 * routing from a link is SS-12. References its container resources **by id only** —
 * carries no credential material.
 */

// ── ScopeContainerRef (a container resource in a specific app) ────────────────

/**
 * A pointer at a **container** resource in a specific app (the target's Vikunja
 * `projects`, the source's Gitea repos where it exposes one). The container is a
 * *different* resource from the scoped record resource pair — it is not part of the
 * `resourcePairRef` — so it must name both the app and the resource. Mirrors the
 * `{ appId, resourceRef }` shape a canonical `resourcePairRef` side parses to; the
 * named resource's own `ResourceBinding` (resolved by SS-11) supplies the container
 * collection read and native-id field.
 */
export const scopeContainerRefSchema = z.object({
  appId: z.string().min(1),
  resourceRef: z.string().min(1),
});
export type ScopeContainerRef = z.infer<typeof scopeContainerRefSchema>;

// ── scopeIdentityKey (the scope identity key) ─────────────────────────────────

/**
 * One pairing of the **scope identity key**: a source `sourceScopeRef` component
 * paired to a target **container** resource identity field (source `name` ↔ target
 * `title`). How `identity-match` discovery decides two containers are the same
 * (`docs/architecture/data-model.md` `ScopeCorrespondence.scopeIdentityKey`; SS-10
 * criterion 2).
 *
 * - `sourceScopeKey` — the `key` of a component of the source resource's
 *   `ResourceBinding.sourceScopeRef` (reusing the already-built source-side capture).
 * - `targetFieldPath` — an IR field path into the target container resource's
 *   identity field.
 * - `transform` — optional and, exactly like a record identity key
 *   (`FieldMapping.isIdentityKey` may carry only `transform = rename`, AS-5) and the
 *   `record-derived` scope binding's transform, **value-preserving only**: a scope
 *   value is compared **as-is**, so a `coerce` / `aggregate` / `expression` pairing is
 *   rejected. Reuses {@link isValuePreservingScopeTransform} — the single
 *   value-preserving definition shared with `scopePathBindings`.
 */
export const scopeIdentityKeyPairingSchema = z
  .object({
    sourceScopeKey: z.string().min(1),
    targetFieldPath: z.string().min(1),
    transform: scopeTransformSchema.optional(),
  })
  .superRefine((pairing, ctx) => {
    if (pairing.transform !== undefined && !isValuePreservingScopeTransform(pairing.transform)) {
      ctx.addIssue({
        code: "custom",
        message:
          "a scope identity key pairing must be value-preserving (transform.kind = rename); reject coerce/aggregate/expression",
        path: ["transform", "kind"],
      });
    }
  });
export type ScopeIdentityKeyPairing = z.infer<typeof scopeIdentityKeyPairingSchema>;

/**
 * The **scope identity key**: the value-preserving pairing of the source resource's
 * `sourceScopeRef` component(s) to the target container resource's identity field(s)
 * — at least one pairing, with **unique** `sourceScopeKey`s (each keys the captured
 * scope, so a duplicate would collide, mirroring `sourceScopeRef` component-key
 * uniqueness). Confirmation lives on the owning {@link scopeCorrespondenceSchema}
 * (`confirmedBy`/`confirmedAt`), not per pairing.
 */
export const scopeIdentityKeySchema = z
  .array(scopeIdentityKeyPairingSchema)
  .min(1)
  .superRefine((pairings, ctx) => {
    const seen = new Set<string>();
    pairings.forEach((pairing, index) => {
      if (seen.has(pairing.sourceScopeKey)) {
        ctx.addIssue({
          code: "custom",
          message: `duplicate scope identity key source component '${pairing.sourceScopeKey}'`,
          path: [index, "sourceScopeKey"],
        });
      }
      seen.add(pairing.sourceScopeKey);
    });
  });
export type ScopeIdentityKey = z.infer<typeof scopeIdentityKeySchema>;

// ── ScopeCorrespondence ───────────────────────────────────────────────────────

/**
 * Field notes:
 *
 * - `resourcePairRef` — the scoped record resource pair this configures, in the same
 *   **canonical direction-agnostic form** as `RecordLink`/`SyncRule.resourcePairRef`
 *   (a plain opaque string, exactly as `RecordLink` models it), so both directions of
 *   a bidirectional pair name the same config (SS-10 criterion 1). "One per scoped
 *   resource pair" is a persistence uniqueness invariant (a UNIQUE index on the
 *   column), not a shape the schema can express.
 * - `targetContainerRef` — required: the target app's container resource, whose
 *   `ResourceBinding` supplies the container collection read and the native-id field
 *   a `scope-link` binding fills.
 * - `sourceContainerRef` — optional: the source app's container resource **where it
 *   exposes one** (enables list-based source discovery); absent when the source
 *   container is knowable only from records' `sourceScopeRef` (scenario-1's trimmed
 *   Gitea spec has no repo-list).
 * - `confirmedBy`/`confirmedAt` — the scope-identity-key confirmation; both null
 *   while unconfirmed and both set together on confirmation (the confirmed-pair
 *   invariant, mirroring a `ConfirmableRef` / `sourceScopeRef`). A `SyncRule` carrying
 *   any `kind: scope-link` scope binding cannot enable until this is confirmed (the
 *   gate is SS-15, out of scope here).
 */
export const scopeCorrespondenceSchema = z
  .object({
    id: z.string(),
    resourcePairRef: z.string(),
    scopeIdentityKey: scopeIdentityKeySchema,
    targetContainerRef: scopeContainerRefSchema,
    sourceContainerRef: scopeContainerRefSchema.optional(),
    confirmedBy: z.string().nullable(),
    confirmedAt: z.date().nullable(),
  })
  .superRefine((correspondence, ctx) => {
    const byIsNull = correspondence.confirmedBy === null;
    const atIsNull = correspondence.confirmedAt === null;
    if (byIsNull !== atIsNull) {
      ctx.addIssue({
        code: "custom",
        message:
          "confirmedBy and confirmedAt must both be null (unconfirmed) or both be set (confirmed)",
        path: [byIsNull ? "confirmedBy" : "confirmedAt"],
      });
    }
  });
export type ScopeCorrespondence = z.infer<typeof scopeCorrespondenceSchema>;
