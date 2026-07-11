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
 * - `identity_candidate` / `target_lookup_param_ref` — peer-peer field detection
 *   metadata; a NULL column becomes an **absent** key, while a stored `false`/value
 *   round-trips (a present `false` is preserved — `?? undefined` only collapses
 *   NULL, not `false`).
 *
 * `confidence_score` comes back from the `double precision` column as a plain
 * `number`, round-tripped exactly (no float32 truncation).
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
    // NULL → absent; a stored `false`/value survives (only NULL collapses).
    identityCandidate: row.identityCandidate ?? undefined,
    targetLookupParamRef: row.targetLookupParamRef ?? undefined,
  });
}

/**
 * Domain → insert. An absent `targetRef`/`phase` becomes a NULL column, and both
 * the absent (unmapped) and `null` (operation) `transformSuggestion` states
 * collapse to a NULL column — the read path reconstructs which one it was from
 * `unmapped`. An absent `identityCandidate`/`targetLookupParamRef` likewise becomes
 * a NULL column, while a present `false`/value is written verbatim.
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
    // Absent → NULL; a present `false`/value is written verbatim (`?? null` only
    // maps the absent/undefined case, leaving a stored `false` intact).
    identityCandidate: item.identityCandidate ?? null,
    targetLookupParamRef: item.targetLookupParamRef ?? null,
  };
}
