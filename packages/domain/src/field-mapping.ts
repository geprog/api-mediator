import { z } from "zod";

import { conflictPolicySchema } from "./approved-mapping-enums.js";
import { mappingPhaseSchema, transformKindSchema } from "./mapping-enums.js";

/**
 * `FieldMapping` — one approved field-level correspondence under an
 * `ApprovedMapping` (`docs/architecture/data-model.md` `FieldMapping`,
 * requirement AM-3). The persisted form of an accepted `kind = field`
 * `MappingProposalItem`. A types-only shape: no transform is executed here.
 *
 * `FieldMapping` rows exist under both peer-peer and consumer-provider mappings,
 * but not every field is meaningful on both — the same conditionally-meaningful
 * shape the concept uses for `RegisteredApp.baseUrl`. This entity carries **no**
 * `variant` field: like `MappingProposalItem`, its variant is observable from the
 * presence of `phase` (a consumer-provider row carries one, a peer-peer row does
 * not), so the refinements below key off that rather than a redundant discriminant.
 */

// ── transformConfig ──────────────────────────────────────────────────────────

/**
 * The fixed, deterministic date representations a `coerce` can convert between.
 * A closed set (no free-form format strings) keeps the conversion locale- and
 * wall-clock-free — a load-bearing property of transform determinism (TX-1).
 */
export const coerceDateFormatSchema = z.enum([
  "iso-8601", // e.g. "2026-07-12T09:30:00.000Z" (UTC, millisecond precision)
  "date-only", // "YYYY-MM-DD" (UTC calendar date)
  "epoch-millis", // integer milliseconds since the Unix epoch
  "epoch-seconds", // integer seconds since the Unix epoch
]);
export type CoerceDateFormat = z.infer<typeof coerceDateFormatSchema>;
export const CoerceDateFormat = coerceDateFormatSchema.enum;

/**
 * The per-`coerce` conversion spec — the deterministic type/representation
 * conversion a `transform = coerce` field applies (TX-1 criterion 3). Discriminated
 * on the target representation `to`. `enum → boolean` names the exact token sets
 * (an unlisted token is an `impossible-coercion` transform error at execution, not
 * a best-effort guess); `date → date` names a source and target format from the
 * closed {@link coerceDateFormatSchema} set.
 */
export const coerceConfigSchema = z.discriminatedUnion("to", [
  z.object({ to: z.literal("number"), from: z.literal("string") }),
  z.object({ to: z.literal("string"), from: z.literal("number") }),
  z.object({
    to: z.literal("boolean"),
    from: z.literal("enum"),
    truthy: z.array(z.string()),
    falsy: z.array(z.string()),
  }),
  z.object({
    to: z.literal("date"),
    from: z.literal("date"),
    sourceFormat: coerceDateFormatSchema,
    targetFormat: coerceDateFormatSchema,
  }),
]);
export type CoerceConfig = z.infer<typeof coerceConfigSchema>;

/**
 * The per-`aggregate` combine spec — how a `transform = aggregate` field combines
 * its primary input (`sourcePath`) with its `additionalInputPaths` into one value
 * (TX-2). `onMissingInput` fixes how a missing/null input resolves *deterministically*
 * — never best-effort: `error` raises a transform error, `skip` omits the part
 * (concat), `zero` treats it as `0` (sum). Discriminated on `strategy`.
 */
export const aggregateConfigSchema = z.discriminatedUnion("strategy", [
  z.object({
    strategy: z.literal("concat"),
    separator: z.string(),
    onMissingInput: z.enum(["error", "skip"]),
  }),
  z.object({
    strategy: z.literal("sum"),
    onMissingInput: z.enum(["error", "zero"]),
  }),
]);
export type AggregateConfig = z.infer<typeof aggregateConfigSchema>;

/**
 * The extra configuration a transform needs beyond its `sourcePath`/`targetPath`.
 *
 * The concept names `transformConfig` on `FieldMapping` but not its per-kind shape
 * (a flagged open question — see the repo README). Phase 3 (AM-3) shipped the
 * minimal `{ additionalInputPaths }` datum the concept documents explicitly. Phase 4
 * (the Transformation Executor) derives the concrete per-kind config execution
 * needs, added here as **optional** carriers so every existing `FieldMapping`
 * construction stays valid:
 *
 * - `additionalInputPaths` — a multi-input `aggregate`, or an `expression` over
 *   several fields, declares its inputs **beyond** the primary `sourcePath` here.
 *   Every input, primary or additional, gets its own `SyncFieldState` row.
 * - `coerce` — the {@link coerceConfigSchema} conversion spec, meaningful only on a
 *   `transform = coerce` field.
 * - `aggregate` — the {@link aggregateConfigSchema} combine spec, meaningful only on
 *   a `transform = aggregate` field.
 * - `expression` — the expression text, meaningful only on a `transform = expression`
 *   field; it is parsed and evaluated inside the sandbox (`docs/architecture/security.md`).
 *
 * Which carrier a field must populate follows from its sibling `transform` kind;
 * the executor validates that pairing (`@mediator/transform`), so this schema stays
 * a permissive persisted shape rather than a discriminated union self-keyed on a
 * field it does not hold. A tracked follow-up may tighten `transformConfig` once the
 * executor's requirements are settled. Shared with `ParameterMapping`.
 */
export const transformConfigSchema = z.object({
  additionalInputPaths: z.array(z.string()).optional(),
  coerce: coerceConfigSchema.optional(),
  aggregate: aggregateConfigSchema.optional(),
  expression: z.string().optional(),
});
export type TransformConfig = z.infer<typeof transformConfigSchema>;

// ── FieldMapping ─────────────────────────────────────────────────────────────

/**
 * Field notes:
 *
 * - `sourcePath` is always the transform's **primary input**, `targetPath` its
 *   **output** — resource-qualified IR paths, modeled as plain strings (this
 *   entity is field-only, so it needs no `MappingProposalItem`-style kind
 *   discriminant on the ref).
 * - `phase` — **required on consumer-provider** rows, **absent on peer-peer**
 *   rows (AM-3 criterion 2). Its presence is what the refinements read as the
 *   variant.
 * - `isIdentityKey` / `targetLookupParamRef` — **peer-peer only** (AM-3 criterion
 *   3). The refinement makes them unrepresentable on a consumer-provider
 *   (phase-bearing) row — the adapter never correlates records across apps.
 *   `targetLookupParamRef` is meaningful only alongside a confirmed identity key,
 *   so it is unrepresentable without `isIdentityKey = true`.
 * - An **identity** `FieldMapping` (`isIdentityKey = true`) may carry only the
 *   value-preserving `transform = rename` (AM-3 criterion 4) — enforced at the
 *   schema level here, in addition to review-time enforcement (AS-5).
 * - `conflictPolicy` — present in the type but **meaningful only on peer-peer**
 *   (sync-driving) rows (AM-3 criterion 5), the mirror of `phase`; the refinement
 *   makes it unrepresentable on a consumer-provider row. *Setting* it is a
 *   Phase-4 concern, so Phase 3 leaves it absent.
 */
export const fieldMappingSchema = z
  .object({
    id: z.string(),
    mappingId: z.string(),
    sourcePath: z.string(),
    targetPath: z.string(),
    transform: transformKindSchema,
    transformConfig: transformConfigSchema.optional(),
    // Consumer-provider only; required there, absent on peer-peer.
    phase: mappingPhaseSchema.optional(),
    // Peer-peer only.
    isIdentityKey: z.boolean().optional(),
    targetLookupParamRef: z.string().optional(),
    // Peer-peer only; Phase 3 leaves it absent.
    conflictPolicy: conflictPolicySchema.optional(),
  })
  .superRefine((field, ctx) => {
    const isConsumerProvider = field.phase !== undefined;

    // Peer-peer detection/override fields are unrepresentable on a consumer-provider
    // (phase-bearing) row.
    if (isConsumerProvider) {
      if (field.isIdentityKey !== undefined) {
        ctx.addIssue({
          code: "custom",
          message: "isIdentityKey is peer-peer only — absent on a consumer-provider FieldMapping",
          path: ["isIdentityKey"],
        });
      }
      if (field.targetLookupParamRef !== undefined) {
        ctx.addIssue({
          code: "custom",
          message:
            "targetLookupParamRef is peer-peer only — absent on a consumer-provider FieldMapping",
          path: ["targetLookupParamRef"],
        });
      }
      if (field.conflictPolicy !== undefined) {
        ctx.addIssue({
          code: "custom",
          message: "conflictPolicy is peer-peer only — inert on a consumer-provider FieldMapping",
          path: ["conflictPolicy"],
        });
      }
    }

    // An identity key may carry only the value-preserving `rename` transform.
    if (field.isIdentityKey === true && field.transform !== "rename") {
      ctx.addIssue({
        code: "custom",
        message:
          "an identity FieldMapping (isIdentityKey = true) may carry only transform = rename",
        path: ["transform"],
      });
    }

    // A lookup parameter is meaningful only alongside a confirmed identity key.
    if (field.targetLookupParamRef !== undefined && field.isIdentityKey !== true) {
      ctx.addIssue({
        code: "custom",
        message: "targetLookupParamRef is meaningful only alongside isIdentityKey = true",
        path: ["targetLookupParamRef"],
      });
    }
  });
export type FieldMapping = z.infer<typeof fieldMappingSchema>;
