import { type SyncFieldState, stripUndefined } from "@mediator/domain";

import { syncFieldState } from "../schema.js";

/** A selected `sync_field_state` row, with Drizzle's inferred column types. */
export type SyncFieldStateRow = typeof syncFieldState.$inferSelect;
/** The insert shape Drizzle expects for `sync_field_state`. */
export type SyncFieldStateInsert = typeof syncFieldState.$inferInsert;

/**
 * Row → domain. `last_synced_hash`/`last_synced_at` collapse NULL → **absent**
 * domain keys (both together — the seed found the sides divergent), which the
 * `SyncFieldState` refinement requires present-together / absent-together;
 * `last_written_by_mapping_id` collapses NULL → absent; `observed_change_timestamp`
 * stays nullable.
 */
export function mapSyncFieldStateRow(row: SyncFieldStateRow): SyncFieldState {
  return stripUndefined({
    id: row.id,
    recordLinkId: row.recordLinkId,
    side: row.side,
    fieldPath: row.fieldPath,
    lastSyncedHash: row.lastSyncedHash ?? undefined,
    lastSyncedAt: row.lastSyncedAt ?? undefined,
    observedHash: row.observedHash,
    observedAt: row.observedAt,
    observedChangeTimestamp: row.observedChangeTimestamp,
    lastWrittenByMappingId: row.lastWrittenByMappingId ?? undefined,
    status: row.status,
  });
}

/** Domain → insert. Absent optional keys become NULL columns. */
export function toSyncFieldStateInsert(state: SyncFieldState): SyncFieldStateInsert {
  return {
    id: state.id,
    recordLinkId: state.recordLinkId,
    side: state.side,
    fieldPath: state.fieldPath,
    lastSyncedHash: state.lastSyncedHash ?? null,
    lastSyncedAt: state.lastSyncedAt ?? null,
    observedHash: state.observedHash,
    observedAt: state.observedAt,
    observedChangeTimestamp: state.observedChangeTimestamp,
    lastWrittenByMappingId: state.lastWrittenByMappingId ?? null,
    status: state.status,
  };
}
