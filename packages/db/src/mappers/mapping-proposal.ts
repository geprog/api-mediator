import type { MappingProposal } from "@mediator/domain";

import { mappingProposal } from "../schema.js";

/** A selected `mapping_proposal` row, with Drizzle's inferred column types. */
export type MappingProposalRow = typeof mappingProposal.$inferSelect;
/** The insert shape Drizzle expects for `mapping_proposal`. */
export type MappingProposalInsert = typeof mappingProposal.$inferInsert;

/**
 * Row → domain. `generated_by` / `shortlist_result` round-trip through `jsonb`
 * (their `$type<...>` binding carries the domain shape). `shortlistResult` is
 * **nullable** in the domain too, so a NULL column stays `null` (a `failed`
 * proposal) rather than being stripped — the domain field is
 * `.nullable()`, never `.optional()`, so no `stripUndefined` is needed here.
 */
export function mapMappingProposalRow(row: MappingProposalRow): MappingProposal {
  return {
    id: row.id,
    sourceSpecId: row.sourceSpecId,
    targetSpecId: row.targetSpecId,
    generatedBy: row.generatedBy,
    shortlistResult: row.shortlistResult,
    status: row.status,
    createdAt: row.createdAt,
  };
}

/** Domain → insert. `shortlistResult` passes through, `null` included. */
export function toMappingProposalInsert(proposal: MappingProposal): MappingProposalInsert {
  return {
    id: proposal.id,
    sourceSpecId: proposal.sourceSpecId,
    targetSpecId: proposal.targetSpecId,
    generatedBy: proposal.generatedBy,
    shortlistResult: proposal.shortlistResult,
    status: proposal.status,
    createdAt: proposal.createdAt,
  };
}
