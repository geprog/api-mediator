import type { SyncFieldState } from "@mediator/domain";
import { eq, sql } from "drizzle-orm";

import type { DbHandle } from "../client.js";
import { mapSyncFieldStateRow, toSyncFieldStateInsert } from "../mappers/sync-field-state.js";
import { syncFieldState } from "../schema.js";

/**
 * The narrow persistence port the identity-match seed (RL-3, the BE-4 seed invoked
 * per link) depends on, so the seed is unit-testable against a fake that mirrors
 * these semantics ([[fakes-must-mirror-real-repos]]) — the (link, side, field)
 * uniqueness and the monotone (never-erase) seed especially. The real
 * {@link SyncFieldStateRepository} implements it over Postgres.
 */
export interface SyncFieldStateStore {
  /**
   * Seed per-side-field rows for a link, **monotone**: a row already present for a
   * `(record_link_id, side, field_path)` is left untouched (`ON CONFLICT DO
   * NOTHING`), never overwritten — deleting an existing baseline would forge
   * divergence (`docs/architecture/sync-engine.md` *Initial backfill*). For the
   * fresh link RL-3 establishes there is no conflict; the guard makes a re-run of
   * the same identity match idempotent.
   */
  seed(rows: readonly SyncFieldState[]): Promise<void>;
  /**
   * **Re-baseline** per-side-field rows after a **successful mediator write**
   * (EP-3 / the OC-5 re-baseline deferred to Loop Prevention). Unlike {@link seed},
   * this **overwrites** an existing row's reconciled baseline (`lastSyncedHash`/
   * `lastSyncedAt`) and observed state (`observedHash`/`observedAt`/
   * `observedChangeTimestamp`) for each `(record_link_id, side, field_path)` — that
   * is the whole point of re-baselining: the written side's baseline becomes the
   * target's *stored* representation, the source side's the observed source value the
   * write was computed from (`docs/architecture/sync-engine.md` *Loop prevention* —
   * canonical-form capture). A row absent for the key is inserted. `ON CONFLICT DO
   * UPDATE`, keyed by the same natural key {@link seed} conflicts on.
   *
   * `lastWrittenByMappingId` is overwritten only when the incoming row carries one
   * (the *written* side); a re-baselined *source* side (which the mediator read, not
   * wrote) leaves the prior value untouched via `COALESCE` — the field is
   * audit-only, and clobbering it to NULL would erase which direction last wrote it.
   */
  reBaseline(rows: readonly SyncFieldState[]): Promise<void>;
  /** Every row of a link, in a stable order (side then field) — tests / downstream. */
  findByLink(recordLinkId: string): Promise<SyncFieldState[]>;
}

/**
 * Persistence for `SyncFieldState` (SD-3). Constructor-bound to a {@link DbHandle},
 * matching the repo convention. Implements the narrow {@link SyncFieldStateStore}
 * port the seed depends on, plus reads for tests.
 */
export class SyncFieldStateRepository implements SyncFieldStateStore {
  public constructor(private readonly db: DbHandle) {}

  public async seed(rows: readonly SyncFieldState[]): Promise<void> {
    if (rows.length === 0) {
      return;
    }
    await this.db
      .insert(syncFieldState)
      .values(rows.map(toSyncFieldStateInsert))
      // Monotone: keep any pre-existing row for a (link, side, field) — never erase a
      // recorded baseline. The unique index backs the conflict target.
      .onConflictDoNothing({
        target: [syncFieldState.recordLinkId, syncFieldState.side, syncFieldState.fieldPath],
      });
  }

  public async reBaseline(rows: readonly SyncFieldState[]): Promise<void> {
    if (rows.length === 0) {
      return;
    }
    await this.db
      .insert(syncFieldState)
      .values(rows.map(toSyncFieldStateInsert))
      // Overwrite (not monotone): a successful write re-baselines the reconciled +
      // observed state for each (link, side, field). `lastWrittenByMappingId` is
      // preserved when the new row omits it (a re-baselined source side).
      .onConflictDoUpdate({
        target: [syncFieldState.recordLinkId, syncFieldState.side, syncFieldState.fieldPath],
        set: {
          lastSyncedHash: sql`excluded.last_synced_hash`,
          lastSyncedAt: sql`excluded.last_synced_at`,
          observedHash: sql`excluded.observed_hash`,
          observedAt: sql`excluded.observed_at`,
          observedChangeTimestamp: sql`excluded.observed_change_timestamp`,
          lastWrittenByMappingId: sql`coalesce(excluded.last_written_by_mapping_id, ${syncFieldState.lastWrittenByMappingId})`,
          status: sql`excluded.status`,
        },
      });
  }

  public async findByLink(recordLinkId: string): Promise<SyncFieldState[]> {
    const rows = await this.db
      .select()
      .from(syncFieldState)
      .where(eq(syncFieldState.recordLinkId, recordLinkId))
      .orderBy(syncFieldState.side, syncFieldState.fieldPath);
    return rows.map(mapSyncFieldStateRow);
  }
}
