import type {
  ApprovedMappingStatus,
  BackfillStatus,
  SyncRule,
  SyncRuleStatus,
} from "@mediator/domain";
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
 * The `SyncRule.status` / `SyncRule.backfillStatus` transition the enable action
 * drives (BE-3). Both fields are optional so a single method covers every step of the
 * enable flow, writing **only** the field(s) that move at that step (a field left
 * `undefined` keeps its prior value — a `set` never clobbers the other column):
 *
 *  - **enable + run backfill**: `{ status: "enabled", backfillStatus: "running" }`;
 *  - **enable + explicit skip**: `{ status: "enabled", backfillStatus: "skipped" }`
 *    (skipping is an explicit operator choice, never a default — BE-3.1);
 *  - **backfill completed**: `{ backfillStatus: "completed" }` (status already
 *    `enabled` — this is the flip the Scheduler's SP-1 gate reads to start polling).
 */
export interface SyncRuleEnableTransition {
  readonly status?: SyncRuleStatus;
  readonly backfillStatus?: BackfillStatus;
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
   * The reconciliation sweep's **bounded** scan of enabled rules (RS-1.4;
   * `docs/requirements/phase-4-reconciliation-sweep.md` RS-1): every `enabled`
   * rule up to `limit`, ordered by `id` so a pass is deterministic. The sweep
   * re-derives each rule's readiness from its persisted `backfillStatus` alone
   * (RS-1.1, no unbounded replay) — an `enabled`+`running` rule whose backfill is
   * not in flight is the crash-orphaned reaction it re-triggers (RS-1.2). The
   * `limit` is the never-scan-unbounded-history guardrail (RS-1.4); a single-
   * instance deployment holds far fewer enabled rules than the cap. Deliberately
   * separate from {@link listPollCandidates} (the Scheduler's join): the sweep
   * needs only the rule's own state, not the mapping/source polling inputs.
   */
  public async listEnabledForReconciliation(limit: number): Promise<SyncRule[]> {
    const rows = await this.db
      .select()
      .from(syncRule)
      .where(eq(syncRule.status, "enabled"))
      .orderBy(syncRule.id)
      .limit(limit);
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

  /**
   * Apply the enable action's `status` / `backfillStatus` transition (BE-3). Writes
   * **only** the provided field(s) — an absent field is not part of the `set`, so it
   * keeps its current column value (e.g. flipping `backfillStatus` to `completed`
   * leaves `status = enabled` untouched). A transition with no fields is a no-op.
   *
   * Deliberately **separate** from {@link applyAdvance} (the go-live cursor/snapshot
   * seed): the status flip and the poll-state seed move different columns at different
   * moments of the enable flow, and BE-6 seeds the poll state *before* the
   * `backfillStatus → completed` flip so the Scheduler never observes `completed` over
   * an unseeded cursor/snapshot.
   */
  public async applyEnableTransition(
    id: string,
    transition: SyncRuleEnableTransition,
  ): Promise<void> {
    const set: { status?: SyncRuleStatus; backfillStatus?: BackfillStatus } = {};
    if (transition.status !== undefined) {
      set.status = transition.status;
    }
    if (transition.backfillStatus !== undefined) {
      set.backfillStatus = transition.backfillStatus;
    }
    if (set.status === undefined && set.backfillStatus === undefined) {
      return;
    }
    await this.db.update(syncRule).set(set).where(eq(syncRule.id, id));
  }
}
