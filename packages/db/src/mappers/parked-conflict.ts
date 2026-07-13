import { type ParkedConflict, stripUndefined } from "@mediator/domain";

import { parkedConflict } from "../schema.js";

/** A selected `parked_conflict` row, with Drizzle's inferred column types. */
export type ParkedConflictRow = typeof parkedConflict.$inferSelect;
/** The insert shape Drizzle expects for `parked_conflict`. */
export type ParkedConflictInsert = typeof parkedConflict.$inferInsert;

/**
 * Row → domain. Every nullable column collapses NULL → an **absent** domain key
 * ({@link stripUndefined}), matching the `ParkedConflict` `.optional()` fields: a
 * `drifted-delete` row carries no `field_path`/`source_observed_hash`, and an `open`
 * row carries no resolution triple. `created_at`/`updated_at` come back as real `Date`s.
 */
export function mapParkedConflictRow(row: ParkedConflictRow): ParkedConflict {
  return stripUndefined({
    id: row.id,
    recordLinkId: row.recordLinkId,
    syncRuleId: row.syncRuleId,
    mappingId: row.mappingId,
    kind: row.kind,
    side: row.side,
    fieldPath: row.fieldPath ?? undefined,
    sourceObservedHash: row.sourceObservedHash ?? undefined,
    targetObservedHash: row.targetObservedHash ?? undefined,
    status: row.status,
    resolutionChoice: row.resolutionChoice ?? undefined,
    resolvedBy: row.resolvedBy ?? undefined,
    resolvedAt: row.resolvedAt ?? undefined,
    sourceNativeId: row.sourceNativeId ?? undefined,
    details: row.details ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}

/** Domain → insert. Each absent optional key becomes a NULL column. */
export function toParkedConflictInsert(conflict: ParkedConflict): ParkedConflictInsert {
  return {
    id: conflict.id,
    recordLinkId: conflict.recordLinkId,
    syncRuleId: conflict.syncRuleId,
    mappingId: conflict.mappingId,
    kind: conflict.kind,
    side: conflict.side,
    fieldPath: conflict.fieldPath ?? null,
    sourceObservedHash: conflict.sourceObservedHash ?? null,
    targetObservedHash: conflict.targetObservedHash ?? null,
    status: conflict.status,
    resolutionChoice: conflict.resolutionChoice ?? null,
    resolvedBy: conflict.resolvedBy ?? null,
    resolvedAt: conflict.resolvedAt ?? null,
    sourceNativeId: conflict.sourceNativeId ?? null,
    details: conflict.details ?? null,
    createdAt: conflict.createdAt,
    updatedAt: conflict.updatedAt,
  };
}
