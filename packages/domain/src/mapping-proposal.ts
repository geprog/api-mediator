import { z } from "zod";

import { candidatePairSchema } from "./llm-output.js";
import { mappingProposalStatusSchema } from "./mapping-enums.js";

/**
 * `MappingProposal` — the persisted output of one Mapping Engine run over a
 * *directional* pair of specs (`sourceSpecId → targetSpecId`), plus its
 * mechanically-enriched `shortlistResult` (see `docs/architecture/data-model.md`
 * `MappingProposal` and requirements PP-1 / PP-3 / LP-4).
 *
 * A proposal is a **reviewable artifact, never executable**: its
 * `MappingProposalItem`s (modeled in `mapping-proposal-item.ts`) are separate
 * rows referencing `proposalId`, so — as with the other Phase-1 entities — this
 * schema is a flat row and does not embed its children.
 */

// ── generatedBy (provenance) ─────────────────────────────────────────────────

/**
 * Which LLM provider/config produced a proposal, for reproducibility (LP-4).
 * `promptVersion` is the single handle covering **both** stage prompts (shortlist
 * + detail), per `docs/architecture/data-model.md` `MappingProposal.generatedBy`.
 * Stamped on every proposal — including a `failed` one.
 */
export const generatedBySchema = z.object({
  providerId: z.string(),
  model: z.string(),
  promptVersion: z.string(),
});
export type GeneratedBy = z.infer<typeof generatedBySchema>;

// ── shortlistResult (the enriched stage-1 result) ────────────────────────────

/**
 * One candidate pair as persisted on the proposal: the validated stage-1 pair
 * plus the mechanical `analysisFailed` marker, set when that pair's stage-2
 * detail call exhausted its retry cap (TD-4). The marker is per-direction — each
 * directional proposal runs its own detail calls, so the same shared candidate
 * pair may be `analysisFailed` in one direction and not the other (PP-3
 * criterion 5). `analysisFailed` defaults to `false` on a pair that analyzed
 * successfully.
 */
export const shortlistResultPairSchema = candidatePairSchema.extend({
  analysisFailed: z.boolean(),
});
export type ShortlistResultPair = z.infer<typeof shortlistResultPairSchema>;

/**
 * An in-scope resource that appears in **no** candidate pair — the mechanically
 * computed no-counterpart set (PP-3 criterion 2). Qualified by its owning
 * `specId` (not by a "source"/"target" role) so it is unambiguous when both
 * specs contain a like-named resource **and** direction-agnostic: both directional
 * proposals of a peer pair list the same two `specId`s, so their no-counterpart
 * sets are identical (PP-3 criterion 5). A resource excluded via
 * `analysisExclusions` is *not* here — excluded is distinct from no-counterpart
 * (PP-3 criterion 3).
 */
export const noCounterpartResourceSchema = z.object({
  specId: z.string(),
  resourceRef: z.string(),
});
export type NoCounterpartResource = z.infer<typeof noCounterpartResourceSchema>;

/**
 * `shortlistResult` — the persisted, mechanically-enriched stage-1 result
 * (`docs/architecture/data-model.md` `MappingProposal.shortlistResult`, PP-3).
 * Holds all three enrichment products:
 *
 * - `candidatePairs` — the validated `ResourceShortlist` pairs (direction-agnostic,
 *   in the shortlist's canonical orientation) each carrying its `analysisFailed`
 *   marker;
 * - `noCounterpartResources` — the in-scope resources with no shortlisted
 *   counterpart, computed by **set difference** by the engine (never trusted from
 *   the LLM).
 *
 * The two directional proposals of a peer pair share identical `candidatePairs`
 * (pair identity/confidence/rationale) and `noCounterpartResources`; only the
 * per-pair `analysisFailed` flags may differ between them.
 */
export const shortlistResultSchema = z.object({
  candidatePairs: z.array(shortlistResultPairSchema),
  noCounterpartResources: z.array(noCounterpartResourceSchema),
});
export type ShortlistResult = z.infer<typeof shortlistResultSchema>;

// ── MappingProposal ──────────────────────────────────────────────────────────

/**
 * The proposal row. `sourceSpecId`/`targetSpecId` are directional (a peer pair
 * A↔B yields two rows, A→B and B→A; a consumer-provider pair yields one, consumer
 * as `sourceSpecId`).
 *
 * `shortlistResult` is **nullable**: a stage-1 (shortlist) failure never produced
 * a valid shortlist, so a `status = "failed"` proposal carries `null` here and
 * has no `MappingProposalItem`s (TD-4 / PP-1 criterion 4). This nullability is a
 * modeling decision the data model leaves implicit — resolved here to represent
 * the "nothing reviewable" failure honestly rather than with an empty-but-present
 * shortlist.
 */
export const mappingProposalSchema = z.object({
  id: z.string(),
  sourceSpecId: z.string(),
  targetSpecId: z.string(),
  generatedBy: generatedBySchema,
  shortlistResult: shortlistResultSchema.nullable(),
  status: mappingProposalStatusSchema,
  createdAt: z.date(),
});
export type MappingProposal = z.infer<typeof mappingProposalSchema>;
