import { type MappingProposalItem, stripUndefined } from "@mediator/domain";

import { mappingProposalItem } from "../schema.js";

/** A selected `mapping_proposal_item` row, with Drizzle's inferred column types. */
export type MappingProposalItemRow = typeof mappingProposalItem.$inferSelect;
/** The insert shape Drizzle expects for `mapping_proposal_item`. */
export type MappingProposalItemInsert = typeof mappingProposalItem.$inferInsert;

/**
 * Row → domain. Three nullable columns collapse to domain-shaped values:
 *
 * - `target_ref` / `phase` — a NULL column becomes an **absent** key
 *   ({@link stripUndefined}), matching the domain's `.optional()` fields.
 * - `transform_suggestion` — a single nullable column carries THREE domain
 *   states, disambiguated by `unmapped`: a stored **object** is the mapped
 *   field/parameter suggestion; a **NULL** column is domain `null` for a mapped
 *   `operation` item (`unmapped = false`) but an **absent** key for an unmapped
 *   item (`unmapped = true`). This is what makes the concept's absent-vs-null
 *   distinction round-trip through one column.
 *
 * `confidence_score` comes back from the `real` column as a plain `number`.
 */
export function mapMappingProposalItemRow(row: MappingProposalItemRow): MappingProposalItem {
  const transformSuggestion =
    row.transformSuggestion !== null ? row.transformSuggestion : row.unmapped ? undefined : null;

  return stripUndefined({
    id: row.id,
    proposalId: row.proposalId,
    kind: row.kind,
    sourceRef: row.sourceRef,
    targetRef: row.targetRef ?? undefined,
    phase: row.phase ?? undefined,
    transformSuggestion,
    confidenceScore: row.confidenceScore,
    ambiguousAlternatives: row.ambiguousAlternatives,
    unmapped: row.unmapped,
    rationale: row.rationale,
    reviewState: row.reviewState,
  });
}

/**
 * Domain → insert. An absent `targetRef`/`phase` becomes a NULL column, and both
 * the absent (unmapped) and `null` (operation) `transformSuggestion` states
 * collapse to a NULL column — the read path reconstructs which one it was from
 * `unmapped`.
 */
export function toMappingProposalItemInsert(item: MappingProposalItem): MappingProposalItemInsert {
  return {
    id: item.id,
    proposalId: item.proposalId,
    kind: item.kind,
    sourceRef: item.sourceRef,
    targetRef: item.targetRef ?? null,
    phase: item.phase ?? null,
    transformSuggestion: item.transformSuggestion ?? null,
    confidenceScore: item.confidenceScore,
    ambiguousAlternatives: item.ambiguousAlternatives,
    unmapped: item.unmapped,
    rationale: item.rationale,
    reviewState: item.reviewState,
  };
}
