import type { ApprovedMappingStatus, SyncRule } from "@mediator/domain";
import { eq } from "drizzle-orm";

import type { DbHandle } from "../client.js";
import { mapSyncRuleRow } from "../mappers/sync-rule.js";
import { approvedMapping, registeredApp, syncRule } from "../schema.js";

/**
 * The per-rule view the Scheduler's eligibility gate (SP-1) needs in one query: the
 * `SyncRule` plus the two things that gate polling but live off the rule — the
 * parent `ApprovedMapping`'s `status` (a `stale`/`suspended` mapping pauses its
 * rules) and the **source** app's polling capability + default interval (a source
 * that cannot poll is a runtime backstop; the interval falls back to the app's
 * `defaultPollInterval` when the rule sets no override).
 */
export interface PollCandidate {
  readonly rule: SyncRule;
  readonly mappingStatus: ApprovedMappingStatus;
  readonly sourceAppId: string;
  readonly sourceSupportsPolling: boolean;
  readonly sourceDefaultPollInterval: number;
}

/**
 * The atomic advance the Poller applies to a rule's live polling state after every
 * detected change is durably enqueued (SP-5). `lastRunAt` always advances; `cursor`
 * is set only for a delta rule (a full-fetch rule leaves it untouched); a full-fetch
 * rule sets `lastSnapshotRef` to its `poll_snapshot` row the first time it seeds one.
 * A field left `undefined` is **not written** (the column keeps its prior value).
 */
export interface SyncRuleAdvance {
  readonly lastRunAt: Date;
  readonly cursor?: string;
  readonly lastSnapshotRef?: string;
}

/**
 * Persistence for `SyncRule` reads + the Poller's live-state advance (SP-1/SP-5).
 * Constructor-bound to a {@link DbHandle} (the pooled db or a `tx()` transaction),
 * matching the repo convention — so {@link applyAdvance} runs in the **same
 * transaction** as the `poll_snapshot` replace (the atomic cursor+snapshot+lastRunAt
 * advance). Rule *instantiation* stays in `DownstreamArtifactRepository` (AI-1); this
 * repo owns the execution-time reads and the advance.
 */
export class SyncRuleRepository {
  public constructor(private readonly db: DbHandle) {}

  /** One rule by id (the poll-trigger hook resolves the named rule through this). */
  public async getById(id: string): Promise<SyncRule | undefined> {
    const [row] = await this.db.select().from(syncRule).where(eq(syncRule.id, id)).limit(1);
    return row === undefined ? undefined : mapSyncRuleRow(row);
  }

  /** Every `enabled` rule (tests / a simple enumeration). */
  public async listEnabled(): Promise<SyncRule[]> {
    const rows = await this.db.select().from(syncRule).where(eq(syncRule.status, "enabled"));
    return rows.map(mapSyncRuleRow);
  }

  /**
   * The Scheduler's candidate scan (SP-1): every `enabled` rule joined to its
   * mapping status and its source app's polling capability + default interval — the
   * inputs the eligibility gate decides on. Disabled rules are excluded up front (the
   * partial `sync_rule_enabled_idx` serves this); the finer gates (backfill done,
   * mapping active) are applied in memory by `decidePoll`.
   */
  public async listPollCandidates(): Promise<PollCandidate[]> {
    const rows = await this.db
      .select({
        rule: syncRule,
        mappingStatus: approvedMapping.status,
        sourceAppId: approvedMapping.sourceAppId,
        capabilities: registeredApp.capabilities,
      })
      .from(syncRule)
      .innerJoin(approvedMapping, eq(approvedMapping.id, syncRule.approvedMappingId))
      .innerJoin(registeredApp, eq(registeredApp.id, approvedMapping.sourceAppId))
      .where(eq(syncRule.status, "enabled"));
    return rows.map((row) => ({
      rule: mapSyncRuleRow(row.rule),
      mappingStatus: row.mappingStatus,
      sourceAppId: row.sourceAppId,
      sourceSupportsPolling: row.capabilities.supportsPolling,
      sourceDefaultPollInterval: row.capabilities.defaultPollInterval,
    }));
  }

  /**
   * Advance the rule's live polling state (SP-5). `last_run_at` is always set;
   * `cursor` / `last_snapshot_ref` are written only when provided (so a full-fetch
   * rule never clobbers a NULL cursor and a delta rule never invents a snapshot ref).
   * Runs on whatever handle it was constructed with — the Poller constructs it on a
   * `tx()` so this and the `poll_snapshot` replace commit atomically.
   */
  public async applyAdvance(id: string, advance: SyncRuleAdvance): Promise<void> {
    const set: { lastRunAt: Date; cursor?: string; lastSnapshotRef?: string } = {
      lastRunAt: advance.lastRunAt,
    };
    if (advance.cursor !== undefined) {
      set.cursor = advance.cursor;
    }
    if (advance.lastSnapshotRef !== undefined) {
      set.lastSnapshotRef = advance.lastSnapshotRef;
    }
    await this.db.update(syncRule).set(set).where(eq(syncRule.id, id));
  }
}
