import { type ApprovedMapping, stripUndefined } from "@mediator/domain";

import { approvedMapping } from "../schema.js";

/** A selected `approved_mapping` row, with Drizzle's inferred column types. */
export type ApprovedMappingRow = typeof approvedMapping.$inferSelect;
/** The insert shape Drizzle expects for `approved_mapping`. */
export type ApprovedMappingInsert = typeof approvedMapping.$inferInsert;

/**
 * Row → domain. `counterpart_mapping_id` collapses NULL → an **absent** domain key
 * ({@link stripUndefined}): the Approval Service represents "no counterpart yet"
 * as absent (never a present `null`), which keeps the domain schema's
 * consumer-provider refinement satisfied (a consumer-provider mapping's column is
 * always NULL and so maps to absent). `approved_at` comes back as a real `Date`.
 */
export function mapApprovedMappingRow(row: ApprovedMappingRow): ApprovedMapping {
  return stripUndefined({
    id: row.id,
    sourceSpecId: row.sourceSpecId,
    targetSpecId: row.targetSpecId,
    sourceAppId: row.sourceAppId,
    targetAppId: row.targetAppId,
    variant: row.variant,
    approvedBy: row.approvedBy,
    approvedAt: row.approvedAt,
    status: row.status,
    // NULL → absent (never a present null — keeps the CP refinement satisfiable).
    counterpartMappingId: row.counterpartMappingId ?? undefined,
    // SL-6/SL-7 — NULL → absent (an ordinary mapping); a stored id round-trips (a
    // successor whose `stale` predecessor SL-7 adoption re-points).
    predecessorMappingId: row.predecessorMappingId ?? undefined,
  });
}

/**
 * Domain → insert. An absent (or `null`) `counterpartMappingId` /
 * `predecessorMappingId` becomes a NULL column; a present value is written verbatim
 * (the SL-6 successor is inserted with `predecessorMappingId` set).
 */
export function toApprovedMappingInsert(mapping: ApprovedMapping): ApprovedMappingInsert {
  return {
    id: mapping.id,
    sourceSpecId: mapping.sourceSpecId,
    targetSpecId: mapping.targetSpecId,
    sourceAppId: mapping.sourceAppId,
    targetAppId: mapping.targetAppId,
    variant: mapping.variant,
    approvedBy: mapping.approvedBy,
    approvedAt: mapping.approvedAt,
    status: mapping.status,
    counterpartMappingId: mapping.counterpartMappingId ?? null,
    predecessorMappingId: mapping.predecessorMappingId ?? null,
  };
}
