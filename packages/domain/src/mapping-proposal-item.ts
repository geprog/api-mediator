import { z } from "zod";

import { confidenceScoreSchema } from "./llm-output.js";
import {
  mappingPhaseSchema,
  mappingProposalItemKindSchema,
  reviewStateSchema,
  transformKindSchema,
} from "./mapping-enums.js";
import { irRefTargetSchema } from "./resource-binding.js";

/**
 * `MappingProposalItem` — a single persisted candidate correspondence within a
 * `MappingProposal` (see `docs/architecture/data-model.md` `MappingProposalItem`
 * and requirement PP-2). One entity for all three `kind`s (operation/field/
 * parameter): the fields that only apply to some kinds (`phase`,
 * `transformSuggestion`) are conditionally meaningful, the same shape the concept
 * uses for `RegisteredApp.baseUrl` and `FieldMapping.conflictPolicy`.
 */

// ── sourceRef / targetRef ────────────────────────────────────────────────────

/**
 * A **resource-qualified** pointer into a spec's IR — how an item addresses its
 * source/target element. Reuses the Phase-1 {@link irRefTargetSchema}
 * (`field` | `operation` | `parameter`) for the element itself and qualifies it
 * with the owning `resourceRef`, because a proposal spans a resource pair and an
 * `operationId`/field path is only unique within its resource group.
 *
 * The `target` discriminant lines up one-to-one with the item's `kind`
 * (`kind = operation` ↔ `target.kind = "operation"`, etc.); that correspondence
 * is an engine-construction convention, not re-encoded as a cross-field schema
 * constraint, so this stays one flat entity.
 */
export const proposalElementRefSchema = z.object({
  resourceRef: z.string(),
  target: irRefTargetSchema,
});
export type ProposalElementRef = z.infer<typeof proposalElementRefSchema>;

// ── transformSuggestion ──────────────────────────────────────────────────────

/**
 * The transform the Mapping Engine suggested for a field- or parameter-kind item,
 * bundling the stage-2 `transform` + `transformDetail`. `detail` is optional
 * (a parameter may pass through untransformed, and a `rename` may need none).
 * Absent/`null` on the item means "no transform" — see the item schema below.
 */
export const transformSuggestionSchema = z.object({
  transform: transformKindSchema,
  detail: z.string().optional(),
});
export type TransformSuggestion = z.infer<typeof transformSuggestionSchema>;

// ── ambiguousAlternatives (persisted, uniform across kinds) ──────────────────

/**
 * An alternative plausible target for a persisted item. Unlike the stage-2 LLM
 * shapes (which name an operation id or a field path), the persisted alternative
 * is **structurally identical across kinds**: a resource-qualified `targetRef`
 * plus its own confidence (`docs/architecture/data-model.md`: "applies to both
 * `operation`- and `field`-kind items").
 */
export const proposalItemAlternativeSchema = z.object({
  targetRef: proposalElementRefSchema,
  confidence: confidenceScoreSchema,
});
export type ProposalItemAlternative = z.infer<typeof proposalItemAlternativeSchema>;

// ── MappingProposalItem ──────────────────────────────────────────────────────

/**
 * The item row. Field notes:
 *
 * - `targetRef` — **absent when `unmapped`** (there is no counterpart). Modeled
 *   as `.optional()`, not nullable: the `@mediator/db` mapper collapses a NULL
 *   column to an absent key via `stripUndefined`, matching the Phase-1 approach.
 * - `phase` — only on `kind = field` items of consumer-provider proposals; a
 *   refinement enforces `phase ⇒ kind = field` (operation and parameter items
 *   never carry it — parameters are inherently request-phase).
 * - `transformSuggestion` — three distinct states, kept distinct under
 *   `exactOptionalPropertyTypes`: **absent** when `unmapped`; `null` for a
 *   mapped `kind = operation` item (operations carry no transform); a
 *   {@link TransformSuggestion} object for a mapped field/parameter item. The
 *   operation-`null` / field-object population rule is applied by the engine; the
 *   schema enforces only the hard `unmapped ⇒ absent` invariant so the two empty
 *   states never contradict for an unmapped operation item.
 * - `reviewState` — the initial persisted value is `pending` (Phase-3 review
 *   moves it); it is a required column, not defaulted here.
 *
 * `reviewRequired` is **not** a stored field — it is derived from
 * `confidenceScore` against a configurable threshold (see {@link isReviewRequired}
 * and requirement TD-5). Persisting it would let it drift from the threshold.
 */
export const mappingProposalItemSchema = z
  .object({
    id: z.string(),
    proposalId: z.string(),
    kind: mappingProposalItemKindSchema,
    sourceRef: proposalElementRefSchema,
    targetRef: proposalElementRefSchema.optional(),
    phase: mappingPhaseSchema.optional(),
    transformSuggestion: transformSuggestionSchema.nullable().optional(),
    confidenceScore: confidenceScoreSchema,
    ambiguousAlternatives: z.array(proposalItemAlternativeSchema),
    unmapped: z.boolean(),
    rationale: z.string(),
    reviewState: reviewStateSchema,
  })
  .superRefine((item, ctx) => {
    if (item.unmapped) {
      if (item.targetRef !== undefined) {
        ctx.addIssue({
          code: "custom",
          message: "an unmapped item carries no targetRef",
          path: ["targetRef"],
        });
      }
      if (item.transformSuggestion !== undefined) {
        ctx.addIssue({
          code: "custom",
          message: "an unmapped item carries no transformSuggestion",
          path: ["transformSuggestion"],
        });
      }
    }
    if (item.phase !== undefined && item.kind !== "field") {
      ctx.addIssue({
        code: "custom",
        message: "phase is only meaningful on kind = field items",
        path: ["phase"],
      });
    }
  });
export type MappingProposalItem = z.infer<typeof mappingProposalItemSchema>;

// ── Derived reviewRequired (TD-5) ────────────────────────────────────────────

/**
 * Whether an item should be flagged for review, **derived** from its confidence
 * against a configurable `threshold` (`reviewRequired = confidenceScore < threshold`,
 * `docs/architecture/mapping-engine.md` "Confidence & ambiguity", TD-5). Deliberately
 * a pure helper rather than a stored column so it always follows the current
 * threshold — an item exactly *at* the threshold is **not** flagged.
 */
export function isReviewRequired(
  item: Pick<MappingProposalItem, "confidenceScore">,
  threshold: number,
): boolean {
  return item.confidenceScore < threshold;
}
