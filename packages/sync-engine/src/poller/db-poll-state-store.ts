import {
  PollSnapshotRepository,
  SyncRuleRepository,
  tx,
  type Database,
  type SyncRuleAdvance,
} from "@mediator/db";

import type { PollAdvance, PollSnapshotState, PollStateStore } from "./types.js";

/**
 * The Postgres-backed {@link PollStateStore} (SP-5). {@link advance} runs the whole
 * cursor/snapshot/`lastRunAt` update **inside one `tx()`** over the `sync_rule` +
 * `poll_snapshot` tables, so the enqueue-then-advance invariant's advance is atomic:
 * the snapshot replacement and the cursor advance commit together or roll back
 * together — a crash can never leave the cursor advanced past a snapshot that was not
 * replaced (`docs/architecture/sync-engine.md` *Polling pull pipeline*).
 *
 * Thin on purpose: the repositories own the SQL; this store only composes them into the
 * one atomic transaction and adapts the `Map`/`Record` snapshot shapes.
 */
export class DbPollStateStore implements PollStateStore {
  readonly #db: Database;

  public constructor(db: Database) {
    this.#db = db;
  }

  public async loadSnapshot(ruleId: string): Promise<PollSnapshotState | undefined> {
    const record = await new PollSnapshotRepository(this.#db).loadByRule(ruleId);
    if (record === undefined) {
      return undefined;
    }
    return { snapshotRef: record.id, entries: new Map(Object.entries(record.entries)) };
  }

  public async advance(advance: PollAdvance): Promise<void> {
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
}
