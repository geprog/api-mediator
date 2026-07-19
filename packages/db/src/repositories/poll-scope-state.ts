import { and, eq } from "drizzle-orm";

import type { DbHandle } from "../client.js";
import { pollScopeState } from "../schema.js";

/**
 * One scope's live polling state (`poll_scope_state`) in domain-facing shape — the
 * per-`(rule, scope)` `cursor` / `lastSnapshotRef` / `lastRunAt` a per-scope rule
 * keeps (SS-13.3). `scopeKey` is the scope's `ScopeLink` id.
 */
export interface PollScopeStateRecord {
  readonly id: string;
  readonly syncRuleId: string;
  readonly scopeKey: string;
  readonly cursor: string | undefined;
  readonly lastRunAt: Date | undefined;
  readonly lastSnapshotRef: string | undefined;
}

/**
 * The per-scope atomic advance a per-scope poll run applies **after every detected
 * change for that scope is durably enqueued** (SP-5, per scope — SS-13.3). `lastRunAt`
 * always advances; a delta scope advances `cursor`; a full-fetch scope sets
 * `lastSnapshotRef`. A field left `undefined` is **not written** (the column keeps its
 * prior value), so a full-fetch scope never clobbers a NULL cursor and a delta scope
 * never invents a snapshot ref — exactly {@link SyncRuleAdvance}'s discipline, per scope.
 */
export interface PollScopeStateAdvance {
  readonly lastRunAt: Date;
  readonly cursor?: string;
  readonly lastSnapshotRef?: string;
}

/**
 * Persistence for `poll_scope_state` — the per-`(rule, scope)` live polling state a
 * **per-scope** `SyncRule` keeps (SS-13.3;
 * `docs/requirements/scoped-resource-sync.md` SS-13). Constructor-bound to a
 * {@link DbHandle} (the pooled db or a `tx()`), matching the repo convention — so
 * {@link advance} runs in the **same transaction** as the scope's `poll_snapshot`
 * replace, making the per-scope cursor+snapshot+`lastRunAt` advance atomic **per
 * scope**: one scope's advance (or its abort) never touches another scope's state
 * (per-scope isolation).
 *
 * A **cross-scope** rule (SS-13.1) uses none of this — its single cursor stays on
 * `sync_rule` via {@link SyncRuleRepository.applyAdvance}, unchanged.
 */
export class PollScopeStateRepository {
  public constructor(private readonly db: DbHandle) {}

  /** One scope's state, or `undefined` when it has none yet (the scope's first poll). */
  public async load(
    syncRuleId: string,
    scopeKey: string,
  ): Promise<PollScopeStateRecord | undefined> {
    const [row] = await this.db
      .select()
      .from(pollScopeState)
      .where(and(eq(pollScopeState.syncRuleId, syncRuleId), eq(pollScopeState.scopeKey, scopeKey)))
      .limit(1);
    return row === undefined ? undefined : toRecord(row);
  }

  /** Every scope-state row for a rule (observability / tests). */
  public async listByRule(syncRuleId: string): Promise<PollScopeStateRecord[]> {
    const rows = await this.db
      .select()
      .from(pollScopeState)
      .where(eq(pollScopeState.syncRuleId, syncRuleId))
      .orderBy(pollScopeState.scopeKey);
    return rows.map(toRecord);
  }

  /**
   * Seed-or-advance one scope's state (SP-5, per scope). Upserts on `(sync_rule_id,
   * scope_key)`: the first advance for a scope inserts (seeds), later ones overwrite
   * `last_run_at` and — only when provided — `cursor` / `last_snapshot_ref` in place.
   * An `undefined` cursor / snapshot ref is left out of the `set`, so it keeps its
   * prior column value (never clobbering a NULL cursor with `null` on a full-fetch
   * scope, nor inventing a snapshot ref on a delta scope).
   */
  public async advance(
    syncRuleId: string,
    scopeKey: string,
    advance: PollScopeStateAdvance,
  ): Promise<void> {
    const set: { lastRunAt: Date; cursor?: string; lastSnapshotRef?: string } = {
      lastRunAt: advance.lastRunAt,
    };
    if (advance.cursor !== undefined) {
      set.cursor = advance.cursor;
    }
    if (advance.lastSnapshotRef !== undefined) {
      set.lastSnapshotRef = advance.lastSnapshotRef;
    }
    await this.db
      .insert(pollScopeState)
      .values({
        syncRuleId,
        scopeKey,
        lastRunAt: advance.lastRunAt,
        cursor: advance.cursor ?? null,
        lastSnapshotRef: advance.lastSnapshotRef ?? null,
      })
      .onConflictDoUpdate({
        target: [pollScopeState.syncRuleId, pollScopeState.scopeKey],
        set,
      });
  }
}

function toRecord(row: typeof pollScopeState.$inferSelect): PollScopeStateRecord {
  return {
    id: row.id,
    syncRuleId: row.syncRuleId,
    scopeKey: row.scopeKey,
    cursor: row.cursor ?? undefined,
    lastRunAt: row.lastRunAt ?? undefined,
    lastSnapshotRef: row.lastSnapshotRef ?? undefined,
  };
}
