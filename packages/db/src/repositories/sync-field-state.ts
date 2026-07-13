import type { SyncFieldState } from "@mediator/domain";
import { eq } from "drizzle-orm";

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

  public async findByLink(recordLinkId: string): Promise<SyncFieldState[]> {
    const rows = await this.db
      .select()
      .from(syncFieldState)
      .where(eq(syncFieldState.recordLinkId, recordLinkId))
      .orderBy(syncFieldState.side, syncFieldState.fieldPath);
    return rows.map(mapSyncFieldStateRow);
  }
}
