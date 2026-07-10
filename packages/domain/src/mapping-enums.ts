import { z } from "zod";

/**
 * Canonical domain enumerations for Phase 2 mapping detection.
 *
 * Same triple-derivation pattern as the Phase-1 `enums.ts` (a single tuple of
 * literals yields the Zod validator, the string-union type, and the
 * `as const`-style value object):
 *
 * ```ts
 * export const fooSchema = z.enum(["a", "b"]);   // runtime validator
 * export type Foo = z.infer<typeof fooSchema>;   // "a" | "b"
 * export const Foo = fooSchema.enum;             // { a: "a"; b: "b" }
 * ```
 *
 * Literal spellings are taken **verbatim** from `docs/glossary.md`,
 * `docs/architecture/data-model.md`, and `docs/architecture/mapping-engine.md`
 * ("Structured proposal formats") and must not be renamed.
 */

// ── MappingProposal.status ───────────────────────────────────────────────────

/**
 * `failed` is the stage-1 (shortlist) retry-ceiling outcome — the whole spec-pair
 * run has nothing reviewable (see `docs/architecture/mapping-engine.md` and
 * requirement TD-4). `partially_approved` / `approved` / `rejected` are Phase-3
 * review outcomes, modeled here because this is the single naming authority for
 * every value the column can hold.
 */
export const mappingProposalStatusSchema = z.enum([
  "pending",
  "partially_approved",
  "approved",
  "rejected",
  "failed",
]);
export type MappingProposalStatus = z.infer<typeof mappingProposalStatusSchema>;
export const MappingProposalStatus = mappingProposalStatusSchema.enum;

// ── MappingProposalItem.kind ─────────────────────────────────────────────────

/**
 * `parameter` items exist **only** on consumer-provider proposals (see
 * `docs/architecture/data-model.md` `MappingProposalItem`); the three kinds line
 * up one-to-one with the three `IrRefTarget` element kinds an item's
 * `sourceRef`/`targetRef` can address (operation ↔ operation, field ↔ field,
 * parameter ↔ parameter).
 */
export const mappingProposalItemKindSchema = z.enum(["operation", "field", "parameter"]);
export type MappingProposalItemKind = z.infer<typeof mappingProposalItemKindSchema>;
export const MappingProposalItemKind = mappingProposalItemKindSchema.enum;

// ── MappingProposalItem.reviewState ──────────────────────────────────────────

/**
 * A persisted proposal item starts `pending`; `accepted` / `edited` / `rejected`
 * are the Phase-3 per-item review outcomes. The full set is modeled here so the
 * single naming authority owns every value.
 */
export const reviewStateSchema = z.enum(["pending", "accepted", "edited", "rejected"]);
export type ReviewState = z.infer<typeof reviewStateSchema>;
export const ReviewState = reviewStateSchema.enum;

// ── phase (consumer-provider field & the adapter round trip) ─────────────────

/**
 * Which half of the adapter round trip a consumer-provider correspondence
 * transforms: `request` (consumer → backend) or `response` (backend → consumer).
 * Only meaningful on consumer-provider proposals; the two phases are independent
 * transform sets, never inverses of each other (see
 * `docs/architecture/mapping-engine.md` "Structured proposal formats").
 */
export const mappingPhaseSchema = z.enum(["request", "response"]);
export type MappingPhase = z.infer<typeof mappingPhaseSchema>;
export const MappingPhase = mappingPhaseSchema.enum;

// ── TransformKind ────────────────────────────────────────────────────────────

/**
 * The transform vocabulary a field- or parameter-level suggestion can carry.
 * Introduced here for the Phase-2 `MappingSuggestionSet` / proposal items; the
 * Phase-3 `FieldMapping` / `OperationMapping` (which also use it) reuse this same
 * enum. An identity-key pairing may carry only the value-preserving `rename`
 * (see `docs/architecture/data-model.md` `FieldMapping.isIdentityKey` and the
 * `identityCandidate` constraint enforced in `llm-output.ts`).
 */
export const transformKindSchema = z.enum(["rename", "coerce", "aggregate", "expression"]);
export type TransformKind = z.infer<typeof transformKindSchema>;
export const TransformKind = transformKindSchema.enum;

// ── MappingVariant (modeling discriminant) ───────────────────────────────────

/**
 * The peer-peer vs. consumer-provider distinction, as a discriminant.
 *
 * This is **not** a new glossary entity — "peer-peer" and "consumer-provider"
 * are the exact terms the concept uses throughout — but a small tag introduced
 * to encode, in the type system, the two structurally-different shapes a
 * `MappingSuggestionSet` can take (see `llm-output.ts`): a peer-peer set's field
 * suggestions carry `identityCandidate` and no `phase`/`parameterMappings`; a
 * consumer-provider set's field suggestions carry `phase`, plus
 * `parameterMappings`, and no `identityCandidate`. The core knows which variant
 * it is requesting from the pair's spec roles, so the tag is mechanical, not an
 * LLM decision.
 */
export const mappingVariantSchema = z.enum(["peer-peer", "consumer-provider"]);
export type MappingVariant = z.infer<typeof mappingVariantSchema>;
export const MappingVariant = mappingVariantSchema.enum;
