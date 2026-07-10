import { z } from "zod";

import { mappingPhaseSchema, transformKindSchema } from "./mapping-enums.js";

/**
 * The two **LLM structured-output shapes** the Mapping Engine requests and
 * validates at each stage — `ResourceShortlist` (stage 1) and
 * `MappingSuggestionSet` (stage 2). Their fields are fixed **verbatim** by
 * `docs/architecture/mapping-engine.md` "Structured proposal formats"; the
 * concrete Zod encoding is the implementation choice this file makes.
 *
 * These are the provider's *validated outputs*, referenced by the persisted
 * entities (`MappingProposal.shortlistResult`, `MappingProposalItem`), so they
 * live in the domain kernel even though no provider or engine does. This package
 * is types-only: `@mediator/llm` produces these values and `@mediator/mapping-engine`
 * validates and persists them.
 *
 * ## Peer-peer vs. consumer-provider distinction
 *
 * `MappingSuggestionSet` is modeled as a **discriminated union** on `variant`
 * (see `MappingVariant` in `mapping-enums.ts`) so an item cannot carry both
 * `phase` and `identityCandidate`, and `parameterMappings` cannot appear on a
 * peer-peer set:
 *
 * - **peer-peer** — field suggestions carry the optional `identityCandidate`
 *   (+ optional `targetLookupParamRef`) and **no** `phase`; the set has **no**
 *   `parameterMappings`.
 * - **consumer-provider** — field suggestions carry a required `phase` and **no**
 *   `identityCandidate`/`targetLookupParamRef`; the set additionally carries
 *   `parameterMappings`.
 *
 * The four objects that carry these mutually-exclusive fields use `z.strictObject`
 * so a wrong-variant key (a `phase` on a peer-peer field, an `identityCandidate`
 * on a consumer-provider field, a `parameterMappings` on a peer-peer set) is
 * **rejected** at validation, not silently stripped.
 */

// ── Shared scalars ───────────────────────────────────────────────────────────

/**
 * A confidence value, constrained to `0..1` (`docs/architecture/mapping-engine.md`
 * "Confidence & ambiguity"). Reused by every suggestion, every ambiguous
 * alternative, and the persisted `MappingProposalItem.confidenceScore`.
 */
export const confidenceScoreSchema = z.number().min(0).max(1);
export type ConfidenceScore = z.infer<typeof confidenceScoreSchema>;

// ── Stage 1: ResourceShortlist ───────────────────────────────────────────────

/**
 * One plausibly-corresponding resource pair from the shortlist pass.
 * `sourceResource`/`targetResource` are the two sides' `resourceRef`s (the same
 * identifier `IrResourceGroup.resourceRef` carries), in the shortlist's canonical
 * unordered orientation — the shortlist is direction-agnostic and shared by both
 * directional detail passes (see `docs/architecture/mapping-engine.md` Stage 1).
 */
export const candidatePairSchema = z.object({
  sourceResource: z.string(),
  targetResource: z.string(),
  confidence: confidenceScoreSchema,
  rationale: z.string(),
});
export type CandidatePair = z.infer<typeof candidatePairSchema>;

/**
 * `ResourceShortlist` — the validated stage-1 output: the recall-biased set of
 * candidate resource pairs. Mechanically enriched into
 * `MappingProposal.shortlistResult` (the no-counterpart set + `analysisFailed`
 * markers) by the engine — see `shortlistResultSchema` in `mapping-proposal.ts`.
 */
export const resourceShortlistSchema = z.object({
  candidatePairs: z.array(candidatePairSchema),
});
export type ResourceShortlist = z.infer<typeof resourceShortlistSchema>;

// ── Stage 2: ambiguous alternatives ──────────────────────────────────────────

/**
 * An alternative plausible operation target. `ambiguousAlternatives` are
 * structurally identical across operation- and field-kind suggestions (a target
 * reference + its own confidence); they differ only in whether the reference is
 * an operation id or a field path, mirroring the verbatim structured format.
 */
export const operationAlternativeSchema = z.object({
  targetOperationId: z.string(),
  confidence: confidenceScoreSchema,
});
export type OperationAlternative = z.infer<typeof operationAlternativeSchema>;

/** An alternative plausible field target (see {@link operationAlternativeSchema}). */
export const fieldAlternativeSchema = z.object({
  targetField: z.string(),
  confidence: confidenceScoreSchema,
});
export type FieldAlternative = z.infer<typeof fieldAlternativeSchema>;

// ── Stage 2: operation suggestions (shared by both variants) ─────────────────

/**
 * One operation-level correspondence. `targetOperationId` is nullable — `null`
 * when `unmapped` (no counterpart operation was found). Shared unchanged by both
 * variants: a peer-peer and a consumer-provider set describe operations
 * identically; only field suggestions and the presence of `parameterMappings`
 * differ.
 */
export const operationSuggestionSchema = z.object({
  sourceOperationId: z.string(),
  targetOperationId: z.string().nullable(),
  confidence: confidenceScoreSchema,
  rationale: z.string(),
  ambiguousAlternatives: z.array(operationAlternativeSchema),
  unmapped: z.boolean(),
});
export type OperationSuggestion = z.infer<typeof operationSuggestionSchema>;

// ── Stage 2: field suggestions (variant-specific) ────────────────────────────

/**
 * A **peer-peer** field-level correspondence. Carries the optional
 * `identityCandidate` flag (+ optional `targetLookupParamRef`) and **no** `phase`
 * — `phase` is a strict-mode-rejected unknown key here. At most one field per
 * resource pair may set `identityCandidate: true`, and only on a value-preserving
 * (`rename`) pairing — the latter is enforced per-suggestion below, the former on
 * the peer-peer set's `fieldMappings` array (see `peerPeerMappingSuggestionSetSchema`).
 *
 * `targetField` is nullable (`null` when `unmapped`).
 */
export const peerPeerFieldSuggestionSchema = z
  .strictObject({
    sourceField: z.string(),
    targetField: z.string().nullable(),
    transform: transformKindSchema,
    transformDetail: z.string(),
    identityCandidate: z.boolean().optional(),
    targetLookupParamRef: z.string().optional(),
    confidence: confidenceScoreSchema,
    rationale: z.string(),
    ambiguousAlternatives: z.array(fieldAlternativeSchema),
    unmapped: z.boolean(),
  })
  .refine((s) => s.identityCandidate !== true || s.transform === "rename", {
    message: "identityCandidate may only mark a value-preserving (rename) pairing",
    path: ["transform"],
  });
export type PeerPeerFieldSuggestion = z.infer<typeof peerPeerFieldSuggestionSchema>;

/**
 * A **consumer-provider** field-level correspondence. Carries a required `phase`
 * (which half of the round trip it transforms) and **no** `identityCandidate` /
 * `targetLookupParamRef` — both are strict-mode-rejected unknown keys here (the
 * adapter never correlates records across apps). `targetField` is nullable
 * (`null` when `unmapped`).
 */
export const consumerProviderFieldSuggestionSchema = z.strictObject({
  sourceField: z.string(),
  targetField: z.string().nullable(),
  phase: mappingPhaseSchema,
  transform: transformKindSchema,
  transformDetail: z.string(),
  confidence: confidenceScoreSchema,
  rationale: z.string(),
  ambiguousAlternatives: z.array(fieldAlternativeSchema),
  unmapped: z.boolean(),
});
export type ConsumerProviderFieldSuggestion = z.infer<typeof consumerProviderFieldSuggestionSchema>;

// ── Stage 2: parameter suggestions (consumer-provider only) ──────────────────

/**
 * One parameter-level (path/query/header) correspondence — **consumer-provider
 * only**, scoped per operation pair. `transform`/`transformDetail` are optional
 * (a parameter may pass through untransformed), and `targetParam` is nullable
 * (`null` when `unmapped`).
 *
 * Note: the verbatim structured format lists **no** `ambiguousAlternatives` on
 * `parameterMappings`, unlike operation/field suggestions — the prose remark that
 * `ambiguousAlternatives` is "structurally identical across ... parameterMappings"
 * is not reflected in the explicit shape or the requirements, so this encoding
 * follows the explicit shape (no alternatives on parameters). See the report note.
 */
export const parameterSuggestionSchema = z.object({
  sourceOperationId: z.string(),
  targetOperationId: z.string(),
  sourceParam: z.string(),
  targetParam: z.string().nullable(),
  transform: transformKindSchema.optional(),
  transformDetail: z.string().optional(),
  confidence: confidenceScoreSchema,
  rationale: z.string(),
  unmapped: z.boolean(),
});
export type ParameterSuggestion = z.infer<typeof parameterSuggestionSchema>;

// ── Stage 2: MappingSuggestionSet (discriminated union) ──────────────────────

/**
 * A **peer-peer** stage-2 result: operation + field correspondences, no
 * `parameterMappings` (a strict-mode-rejected unknown key). The `fieldMappings`
 * array enforces "at most one `identityCandidate: true` per resource pair"
 * (`docs/architecture/mapping-engine.md`: "flag at most one field pairing").
 */
export const peerPeerMappingSuggestionSetSchema = z.strictObject({
  variant: z.literal("peer-peer"),
  operationMappings: z.array(operationSuggestionSchema),
  fieldMappings: z
    .array(peerPeerFieldSuggestionSchema)
    .refine((fields) => fields.filter((f) => f.identityCandidate === true).length <= 1, {
      message: "at most one field pairing may set identityCandidate: true per resource pair",
    }),
});
export type PeerPeerMappingSuggestionSet = z.infer<typeof peerPeerMappingSuggestionSetSchema>;

/**
 * A **consumer-provider** stage-2 result: operation + field (phased)
 * correspondences plus the per-operation-pair `parameterMappings`. All of it
 * comes out of the *same single* detail call (the prompt already contains both
 * resources in full).
 */
export const consumerProviderMappingSuggestionSetSchema = z.strictObject({
  variant: z.literal("consumer-provider"),
  operationMappings: z.array(operationSuggestionSchema),
  fieldMappings: z.array(consumerProviderFieldSuggestionSchema),
  parameterMappings: z.array(parameterSuggestionSchema),
});
export type ConsumerProviderMappingSuggestionSet = z.infer<
  typeof consumerProviderMappingSuggestionSetSchema
>;

/**
 * `MappingSuggestionSet` — the validated stage-2 output for one shortlisted
 * resource pair, discriminated on `variant`. The union is what makes the
 * peer-peer vs. consumer-provider fields mutually exclusive in the type system.
 */
export const mappingSuggestionSetSchema = z.discriminatedUnion("variant", [
  peerPeerMappingSuggestionSetSchema,
  consumerProviderMappingSuggestionSetSchema,
]);
export type MappingSuggestionSet = z.infer<typeof mappingSuggestionSetSchema>;
