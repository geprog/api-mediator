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
 * The extra configuration a multi-input transform needs. Today the concept
 * documents exactly one datum here: a multi-input `aggregate`, or an `expression`
 * over several fields (`fullName = firstName + " " + lastName`), declares its
 * **additional** input paths — beyond the primary `sourcePath` — in
 * `transformConfig` (`docs/architecture/data-model.md` `FieldMapping`). A 1:1
 * transform (`rename`, single-input `coerce`) needs none, so `transformConfig` is
 * omitted entirely rather than carried empty. Shared with `ParameterMapping`.
 *
 * Execution semantics (how the paths feed the evaluator, the `expression`
 * sandbox) are Phase 4/5 and deliberately absent from this shape.
 */
export const transformConfigSchema = z.object({
  additionalInputPaths: z.array(z.string()),
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
