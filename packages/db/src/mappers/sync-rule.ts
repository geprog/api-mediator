import { type SyncRule, stripUndefined } from "@mediator/domain";

import { syncRule } from "../schema.js";

/** A selected `sync_rule` row, with Drizzle's inferred column types. */
export type SyncRuleRow = typeof syncRule.$inferSelect;
/** The insert shape Drizzle expects for `sync_rule`. */
export type SyncRuleInsert = typeof syncRule.$inferInsert;

/**
 * Row → domain. The four AM-6 columns map 1:1; every SD-1 execution column is
 * **nullable with no DB default**, so a NULL collapses to an **absent** domain key
 * (`stripUndefined`) — a Phase-3 minimal-row rule reads back as exactly the four
 * fields, and a disabled rule carries no live execution state. A NULL is treated as
 * absent uniformly (the DB cannot distinguish the domain's absent-vs-explicit-null
 * for the nullable-optional live-state fields; SP/BE only ever write real values or
 * leave the column NULL, so "absent" is the single faithful reading).
 */
export function mapSyncRuleRow(row: SyncRuleRow): SyncRule {
  return stripUndefined({
    id: row.id,
    approvedMappingId: row.approvedMappingId,
    resourcePairRef: row.resourcePairRef,
    status: row.status,
    pollIntervalOverride: row.pollIntervalOverride ?? undefined,
    pollOperationRef: row.pollOperationRef ?? undefined,
    deletePropagation: row.deletePropagation ?? undefined,
    targetDriftCheck: row.targetDriftCheck ?? undefined,
    backfillMode: row.backfillMode ?? undefined,
    backfillStatus: row.backfillStatus ?? undefined,
    pollScopeMode: row.pollScopeMode ?? undefined,
    lastRunAt: row.lastRunAt ?? undefined,
    lastEventAt: row.lastEventAt ?? undefined,
    cursor: row.cursor ?? undefined,
    lastSnapshotRef: row.lastSnapshotRef ?? undefined,
  });
}

/**
 * Domain → insert. An absent execution field becomes a NULL column (the Phase-3
 * AI-1 minimal insert sets none of them, so they all land NULL — backward
 * compatible). A present field is written as-is.
 */
export function toSyncRuleInsert(rule: SyncRule): SyncRuleInsert {
  return {
    id: rule.id,
    approvedMappingId: rule.approvedMappingId,
    resourcePairRef: rule.resourcePairRef,
    status: rule.status,
    pollIntervalOverride: rule.pollIntervalOverride ?? null,
    pollOperationRef: rule.pollOperationRef ?? null,
    deletePropagation: rule.deletePropagation ?? null,
    targetDriftCheck: rule.targetDriftCheck ?? null,
    backfillMode: rule.backfillMode ?? null,
    backfillStatus: rule.backfillStatus ?? null,
    pollScopeMode: rule.pollScopeMode ?? null,
    lastRunAt: rule.lastRunAt ?? null,
    lastEventAt: rule.lastEventAt ?? null,
    cursor: rule.cursor ?? null,
    lastSnapshotRef: rule.lastSnapshotRef ?? null,
  };
}
