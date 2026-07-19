import {
  PollScopeStateRepository,
  PollSnapshotRepository,
  SyncRuleRepository,
  tx,
  type Database,
  type PollScopeStateAdvance,
  type SyncRuleAdvance,
} from "@mediator/db";

import type { PollAdvance, PollSnapshotState, PollStateStore } from "./types.js";

/**
 * The Postgres-backed {@link PollStateStore} (SP-5; SS-13.3). {@link advance} runs the
 * whole cursor/snapshot/`lastRunAt` update **inside one `tx()`** so the advance is
 * atomic — the snapshot replacement and the cursor advance commit together or roll back
 * together, a crash can never leave the cursor advanced past a snapshot that was not
 * replaced (`docs/architecture/sync-engine.md` *Polling pull pipeline*).
 *
 * SS-13.3 routes on `advance.scopeKey`:
 *  - **absent → cross-scope** (SS-13.1): the tx spans `poll_snapshot` (sentinel scope
 *    key) + `sync_rule` (`cursor`/`last_run_at`/`last_snapshot_ref`) — **unchanged from
 *    SP-5**.
 *  - **present → per-scope** (SS-13.3): the tx spans the scope's `poll_snapshot` +
 *    `poll_scope_state` row (keyed by `(sync_rule_id, scope_key)`), so one scope's
 *    advance never touches another scope's — nor the cross-scope — state (isolation).
 *
 * Thin on purpose: the repositories own the SQL; this store only composes them into the
 * one atomic transaction and adapts the `Map`/`Record` snapshot shapes.
 */
export class DbPollStateStore implements PollStateStore {
  readonly #db: Database;

  public constructor(db: Database) {
    this.#db = db;
  }

  public async loadSnapshot(
    ruleId: string,
    scopeKey?: string,
  ): Promise<PollSnapshotState | undefined> {
    const record = await new PollSnapshotRepository(this.#db).loadByRule(ruleId, scopeKey);
    if (record === undefined) {
      return undefined;
    }
    return { snapshotRef: record.id, entries: new Map(Object.entries(record.entries)) };
  }

  public async loadScopeCursor(ruleId: string, scopeKey: string): Promise<string | undefined> {
    const state = await new PollScopeStateRepository(this.#db).load(ruleId, scopeKey);
    return state?.cursor;
  }

  public async advance(advance: PollAdvance): Promise<void> {
    if (advance.scopeKey !== undefined) {
      await this.#advanceScope(advance, advance.scopeKey);
      return;
    }
    await this.#advanceCrossScope(advance);
  }

  /** SS-13.1 — the cross-scope advance (`sync_rule` + sentinel snapshot), unchanged from SP-5. */
  async #advanceCrossScope(advance: PollAdvance): Promise<void> {
    await tx(this.#db, async (txn) => {
      let lastSnapshotRef: string | undefined;
      if (advance.snapshotEntries !== undefined) {
        const capturedAt = advance.capturedAt ?? advance.lastRunAt;
        lastSnapshotRef = await new PollSnapshotRepository(txn).replace(
          advance.ruleId,
          advance.snapshotEntries,
          capturedAt,
        );
      }
      const patch: SyncRuleAdvance = {
        lastRunAt: advance.lastRunAt,
        ...(advance.cursor !== undefined ? { cursor: advance.cursor } : {}),
        ...(lastSnapshotRef !== undefined ? { lastSnapshotRef } : {}),
      };
      await new SyncRuleRepository(txn).applyAdvance(advance.ruleId, patch);
    });
  }

  /**
   * SS-13.3 — one **scope's** advance: the scope's `poll_snapshot` (keyed by
   * `(sync_rule_id, scope_key)`) + its `poll_scope_state` row, in one atomic tx. A field
   * left `undefined` is not written (a full-fetch scope never clobbers its NULL cursor,
   * a delta scope never invents a snapshot ref), and no other scope's row is touched.
   */
  async #advanceScope(advance: PollAdvance, scopeKey: string): Promise<void> {
    await tx(this.#db, async (txn) => {
      let lastSnapshotRef: string | undefined;
      if (advance.snapshotEntries !== undefined) {
        const capturedAt = advance.capturedAt ?? advance.lastRunAt;
        lastSnapshotRef = await new PollSnapshotRepository(txn).replace(
          advance.ruleId,
          advance.snapshotEntries,
          capturedAt,
          scopeKey,
        );
      }
      const patch: PollScopeStateAdvance = {
        lastRunAt: advance.lastRunAt,
        ...(advance.cursor !== undefined ? { cursor: advance.cursor } : {}),
        ...(lastSnapshotRef !== undefined ? { lastSnapshotRef } : {}),
      };
      await new PollScopeStateRepository(txn).advance(advance.ruleId, scopeKey, patch);
    });
  }
}
