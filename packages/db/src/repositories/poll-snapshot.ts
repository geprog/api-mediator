import { and, eq } from "drizzle-orm";

import type { DbHandle } from "../client.js";
import { CROSS_SCOPE_SCOPE_KEY, pollSnapshot } from "../schema.js";

/**
 * A rule's persisted content-hash snapshot (`poll_snapshot`) in domain-facing
 * shape. `entries` is the `native id → content hash` map from the last complete
 * fetch, keyed by `ResourceBinding.nativeIdRef` (SP-2). `id` is the value the
 * rule's `SyncRule.lastSnapshotRef` (cross-scope) or `PollScopeState.lastSnapshotRef`
 * (per-scope, SS-13) points at. `scopeKey` is the {@link CROSS_SCOPE_SCOPE_KEY}
 * sentinel for a cross-scope rule, else the scope's `ScopeLink` id.
 */
export interface PollSnapshotRecord {
  readonly id: string;
  readonly syncRuleId: string;
  readonly scopeKey: string;
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
 * One row per **(rule, scope)** (the `poll_snapshot_rule_scope_uq` UNIQUE index):
 * {@link replace} is an upsert on `(sync_rule_id, scope_key)`, so the first complete
 * fetch of a scope **seeds** its row and every later one **replaces** it in place,
 * returning the stable row id the pointer (`sync_rule.last_snapshot_ref` cross-scope,
 * `poll_scope_state.last_snapshot_ref` per-scope) points at. `scopeKey` defaults to
 * the {@link CROSS_SCOPE_SCOPE_KEY} sentinel, so every existing SP-5 caller (which
 * passes none) keeps the exact single-snapshot cross-scope behaviour (SS-13.1).
 */
export class PollSnapshotRepository {
  public constructor(private readonly db: DbHandle) {}

  /**
   * The rule's current snapshot for a scope, or `undefined` when it has none yet
   * (SP-2 first poll). `scopeKey` defaults to the cross-scope sentinel — a cross-scope
   * rule's single snapshot (SS-13.1); a per-scope rule passes the scope's `ScopeLink`
   * id (SS-13.3).
   */
  public async loadByRule(
    syncRuleId: string,
    scopeKey: string = CROSS_SCOPE_SCOPE_KEY,
  ): Promise<PollSnapshotRecord | undefined> {
    const [row] = await this.db
      .select()
      .from(pollSnapshot)
      .where(and(eq(pollSnapshot.syncRuleId, syncRuleId), eq(pollSnapshot.scopeKey, scopeKey)))
      .limit(1);
    return row === undefined ? undefined : toRecord(row);
  }

  /** One snapshot by its id (tests / observability). */
  public async getById(id: string): Promise<PollSnapshotRecord | undefined> {
    const [row] = await this.db.select().from(pollSnapshot).where(eq(pollSnapshot.id, id)).limit(1);
    return row === undefined ? undefined : toRecord(row);
  }

  /**
   * Seed-or-replace one **(rule, scope)** snapshot from a **complete** fetch, returning
   * the stable `poll_snapshot` row id (SP-5, per scope). Upserts on `(sync_rule_id,
   * scope_key)`: the first call for a scope inserts (seeds), later calls overwrite
   * `entries`/`record_count`/`captured_at` in place — so the id is stable and the
   * pointer never dangles. `scopeKey` defaults to the cross-scope sentinel so an
   * unchanged cross-scope caller upserts the one row exactly as before.
   */
  public async replace(
    syncRuleId: string,
    entries: ReadonlyMap<string, string>,
    capturedAt: Date,
    scopeKey: string = CROSS_SCOPE_SCOPE_KEY,
  ): Promise<string> {
    const entriesObject = Object.fromEntries(entries);
    const recordCount = entries.size;
    const [row] = await this.db
      .insert(pollSnapshot)
      .values({ syncRuleId, scopeKey, entries: entriesObject, recordCount, capturedAt })
      .onConflictDoUpdate({
        target: [pollSnapshot.syncRuleId, pollSnapshot.scopeKey],
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
    scopeKey: row.scopeKey,
    entries: row.entries,
    recordCount: row.recordCount,
    capturedAt: row.capturedAt,
  };
}
