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
 *   {@link TransformSuggestion} object for a mapped `kind = field` item. The
 *   superRefine makes the two structural halves of that rule invariants rather
 *   than mere engine conventions: an `operation` item **never** carries a
 *   transform object (it is `null` when mapped, absent when unmapped — so an
 *   engine bug that puts a transform on an operation item is *unrepresentable*),
 *   and a **mapped `field`** item **always** carries a {@link TransformSuggestion}
 *   object (a field suggestion always names a transform). `parameter` items are
 *   deliberately looser: a `ParameterSuggestion.transform` is optional, so a
 *   **pass-through** parameter (a mapped parameter the model proposed with no
 *   transform — e.g. the `owner → project` parameter in the concept's example)
 *   carries `null`, while a transforming one carries the object; the only hard
 *   rule the schema enforces for a mapped parameter is the shared
 *   `unmapped ⇒ absent` one below.
 * - `reviewState` — the initial persisted value is `pending` (Phase-3 review
 *   moves it); it is a required column, not defaulted here.
 * - `identityCandidate` / `targetLookupParamRef` — **peer-peer field detection
 *   metadata**, meaningful *only* on a `kind = field` item with **no** `phase`
 *   (a peer-peer field item). They persist the stage-2 LLM suggestion verbatim
 *   (`peerPeerFieldSuggestionSchema.identityCandidate` / `.targetLookupParamRef`,
 *   see `llm-output.ts` and `docs/architecture/mapping-engine.md`) so Phase-3
 *   review can *pre-select* the identity key and its lookup parameter without
 *   re-running the LLM (see `docs/flows/mapping-review-and-approval.md` step 6).
 *   They are **review-time defaults only** — `FieldMapping.isIdentityKey` is still
 *   set exclusively by explicit reviewer confirmation. The superRefine makes them
 *   *unrepresentable* anywhere else: an operation/parameter item, or a
 *   consumer-provider (phased) field item, carries neither — the same mutual
 *   exclusivity the `MappingSuggestionSet` discriminated union enforces on the LLM
 *   output (the adapter never correlates records across apps, so a phased field
 *   has no identity key).
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
    // Peer-peer field detection metadata — mirrors `peerPeerFieldSuggestionSchema`
    // exactly (an optional boolean flag + an optional lookup-parameter ref string).
    // The superRefine below confines them to a peer-peer (no-phase) `kind = field`
    // item; a present value on any other item is a validation error.
    identityCandidate: z.boolean().optional(),
    targetLookupParamRef: z.string().optional(),
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
    // An operation item never carries a transform object — this is what makes an
    // engine bug (an operation item smuggling a transform) unrepresentable.
    const hasTransformObject =
      item.transformSuggestion !== undefined && item.transformSuggestion !== null;
    if (item.kind === "operation" && hasTransformObject) {
      ctx.addIssue({
        code: "custom",
        message: "kind = operation items carry no transformSuggestion (null when mapped)",
        path: ["transformSuggestion"],
      });
    }
    // A mapped field item always carries a transformSuggestion object — a field
    // suggestion always names a transform, so a mapped field with null/absent
    // transform is malformed. (Mapped parameters may pass through with null;
    // unmapped items are handled by the `unmapped ⇒ absent` rule above.)
    if (item.kind === "field" && !item.unmapped && !hasTransformObject) {
      ctx.addIssue({
        code: "custom",
        message: "a mapped kind = field item requires a transformSuggestion object",
        path: ["transformSuggestion"],
      });
    }
    // `identityCandidate` / `targetLookupParamRef` are peer-peer field detection
    // metadata: only a `kind = field` item with NO `phase` (a peer-peer field
    // item) may carry them. This makes them unrepresentable on operation/parameter
    // items and on consumer-provider (phased) field items — mirroring the
    // `MappingSuggestionSet` discriminated union, where only a peer-peer field
    // suggestion carries these keys. A present `false` is still "carried here" and
    // is likewise rejected on the wrong item (hence the `!== undefined` test).
    const isPeerPeerFieldItem = item.kind === "field" && item.phase === undefined;
    if (item.identityCandidate !== undefined && !isPeerPeerFieldItem) {
      ctx.addIssue({
        code: "custom",
        message: "identityCandidate is only meaningful on a peer-peer (no-phase) kind = field item",
        path: ["identityCandidate"],
      });
    }
    if (item.targetLookupParamRef !== undefined && !isPeerPeerFieldItem) {
      ctx.addIssue({
        code: "custom",
        message:
          "targetLookupParamRef is only meaningful on a peer-peer (no-phase) kind = field item",
        path: ["targetLookupParamRef"],
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
