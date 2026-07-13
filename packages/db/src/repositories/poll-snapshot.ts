import { eq } from "drizzle-orm";

import type { DbHandle } from "../client.js";
import { pollSnapshot } from "../schema.js";

/**
 * A rule's persisted content-hash snapshot (`poll_snapshot`) in domain-facing
 * shape. `entries` is the `native id → content hash` map from the last complete
 * fetch, keyed by `ResourceBinding.nativeIdRef` (SP-2). `id` is the value the
 * rule's `SyncRule.lastSnapshotRef` points at.
 */
export interface PollSnapshotRecord {
  readonly id: string;
  readonly syncRuleId: string;
  readonly entries: Record<string, string>;
  readonly recordCount: number;
  readonly capturedAt: Date;
}

/**
 * Persistence for the per-rule `poll_snapshot` (SP-2/SP-4/SP-5). Constructor-bound
 * to a {@link DbHandle} (the pooled db or a `tx()` transaction), matching the repo
 * convention — so {@link replace} can run in the **same transaction** as the
 * `sync_rule` cursor/`last_run_at` advance, which is what makes SP-5's
 * enqueue-then-advance atomic (the snapshot and the cursor move together or not at
 * all).
 *
 * One row per rule (the `poll_snapshot_sync_rule_uq` UNIQUE index): {@link replace}
 * is an upsert on `sync_rule_id`, so the first complete fetch **seeds** the row and
 * every later one **replaces** it in place, returning the stable row id the rule's
 * `last_snapshot_ref` points at.
 */
export class PollSnapshotRepository {
  public constructor(private readonly db: DbHandle) {}

  /** The rule's current snapshot, or `undefined` when it has none yet (SP-2 first poll). */
  public async loadByRule(syncRuleId: string): Promise<PollSnapshotRecord | undefined> {
    const [row] = await this.db
      .select()
      .from(pollSnapshot)
      .where(eq(pollSnapshot.syncRuleId, syncRuleId))
      .limit(1);
    return row === undefined ? undefined : toRecord(row);
  }

  /** One snapshot by its id (tests / observability). */
  public async getById(id: string): Promise<PollSnapshotRecord | undefined> {
    const [row] = await this.db.select().from(pollSnapshot).where(eq(pollSnapshot.id, id)).limit(1);
    return row === undefined ? undefined : toRecord(row);
  }

  /**
   * Seed-or-replace the rule's snapshot from a **complete** fetch, returning the
   * stable `poll_snapshot` row id (SP-5). Upserts on `sync_rule_id`: the first call
   * inserts (seeds), later calls overwrite `entries`/`record_count`/`captured_at` in
   * place — so the id is stable and the rule's `last_snapshot_ref` never dangles.
   */
  public async replace(
    syncRuleId: string,
    entries: ReadonlyMap<string, string>,
    capturedAt: Date,
  ): Promise<string> {
    const entriesObject = Object.fromEntries(entries);
    const recordCount = entries.size;
    const [row] = await this.db
      .insert(pollSnapshot)
      .values({ syncRuleId, entries: entriesObject, recordCount, capturedAt })
      .onConflictDoUpdate({
        target: pollSnapshot.syncRuleId,
        set: { entries: entriesObject, recordCount, capturedAt },
      })
      .returning({ id: pollSnapshot.id });
    if (row === undefined) {
      throw new Error("poll_snapshot replace returned no id");
    }
    return row.id;
  }
}

function toRecord(row: typeof pollSnapshot.$inferSelect): PollSnapshotRecord {
  return {
    id: row.id,
    syncRuleId: row.syncRuleId,
    entries: row.entries,
    recordCount: row.recordCount,
    capturedAt: row.capturedAt,
  };
}
