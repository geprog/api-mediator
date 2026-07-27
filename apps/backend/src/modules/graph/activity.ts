import {
  DownstreamArtifactRepository,
  tx,
  type Database,
  type DbHandle,
  type GraphEdgeActivityAdvance,
  type GraphEdgeAppPair,
} from "@mediator/db";
import type { AuditLogEntry } from "@mediator/domain";

/**
 * **GR-4 — the `GraphEdge` activity updater.** It stamps an edge's
 * `metadata.lastActivityAt` from the **durable Audit/Event Log** — a recorded
 * `sync-execution` `SyncEvent` (attributable to a `SyncRule`) or an `adapter-request`
 * audit row (attributable to an `AdapterBinding`) — **not** from OpenTelemetry (GR-4.4:
 * the two are complementary; this reads the same durable rows other components already
 * read).
 *
 * It is the **disjoint counterpart** of the GR-2/GR-3 status reactor
 * ({@link ./projection.ts}): that one owns `status`+`direction`, this one owns
 * `lastActivityAt`, and the two never touch each other's `metadata` (GR-1.5). The write
 * is **monotonic** and idempotent — an out-of-order or redelivered event with an older
 * timestamp no-ops, so a slow redelivery gives idempotency for free (GR-4.2) — and it is
 * a single cheap conditional DB write, safe to run inside the transaction that durably
 * records the event (the dispatcher-tx constraint).
 *
 * **Wired at the recording points** (inline, not a separate bus reactor): sync via
 * `DbSyncEventStore.record` (the transactional-outbox seam, `@mediator/outbound`), and
 * adapter via the Adapter Server Runtime's audit writer (`build-adapter-runtime.ts`) —
 * exactly where a `SyncEvent` / `adapter-request` row becomes durable.
 */
export class GraphActivity {
  readonly #db: Database;

  public constructor(deps: { readonly db: Database }) {
    this.#db = deps.db;
  }

  /**
   * Advance the edge implied by a just-recorded audit `entry`, **within a caller's
   * transaction** — so the activity advance commits atomically with the durable audit
   * write it rides alongside. A non-`sync-execution`/`adapter-request` row (a `poll-run`,
   * a `backfill-run`, …), or one missing its `relatedRuleId`/`relatedBindingId`, resolves
   * to no edge and is a clean no-op.
   */
  public recordFromAuditEntryWithin(handle: DbHandle, entry: AuditLogEntry): Promise<void> {
    return advanceActivityForAuditEntry(dbGraphActivityOps(handle), entry);
  }

  /**
   * The own-transaction counterpart of {@link recordFromAuditEntryWithin}, for a caller
   * with no ambient transaction (e.g. a reconciliation re-stamp). Idempotent by
   * monotonicity, so running it after the fact converges on the correct timestamp.
   */
  public recordFromAuditEntry(entry: AuditLogEntry): Promise<void> {
    return tx(this.#db, (handle) => this.recordFromAuditEntryWithin(handle, entry));
  }
}

/**
 * The narrow ops the GR-4 core drives, bound to one transaction handle (structurally
 * satisfied by {@link DownstreamArtifactRepository}). Split from {@link GraphActivity} so
 * the edge-resolution + monotonic-advance decision is unit-testable against an in-memory
 * fake that mirrors these exact semantics.
 */
export interface GraphActivityOps {
  resolveSyncEdgeKeyForRule(ruleId: string): Promise<GraphEdgeAppPair | undefined>;
  resolveAdapterEdgeKeyForBinding(bindingId: string): Promise<GraphEdgeAppPair | undefined>;
  advanceGraphEdgeActivity(advance: GraphEdgeActivityAdvance): Promise<void>;
}

/** The real {@link GraphActivityOps} over one handle (the same-handle discipline as the reactor). */
function dbGraphActivityOps(handle: DbHandle): GraphActivityOps {
  const artifacts = new DownstreamArtifactRepository(handle);
  return {
    resolveSyncEdgeKeyForRule: (ruleId) => artifacts.resolveSyncEdgeKeyForRule(ruleId),
    resolveAdapterEdgeKeyForBinding: (bindingId) =>
      artifacts.resolveAdapterEdgeKeyForBinding(bindingId),
    advanceGraphEdgeActivity: (advance) => artifacts.advanceGraphEdgeActivity(advance),
  };
}

/**
 * **GR-4 core — dispatch a recorded audit entry to its edge's activity advance.**
 * Exported over an injected {@link GraphActivityOps} for unit-testability without a
 * database. A `sync-execution` row advances its rule's sync edge; an `adapter-request`
 * row advances its binding's adapter-dependency edge; **only** these two carry an edge's
 * activity (a `poll-run`/`backfill-run`/`mapping-decision`/`credential-access` row does
 * not) — so the reaction is total and never advances a spurious edge. The event's own
 * `timestamp` is the activity time, and the underlying advance is monotonic, so a repeat
 * or out-of-order delivery cannot move the edge backwards (GR-4.1/GR-4.2).
 */
export async function advanceActivityForAuditEntry(
  ops: GraphActivityOps,
  entry: AuditLogEntry,
): Promise<void> {
  if (entry.type === "sync-execution" && entry.relatedRuleId !== undefined) {
    await advanceSyncEdgeActivity(ops, entry.relatedRuleId, entry.timestamp);
    return;
  }
  if (entry.type === "adapter-request" && entry.relatedBindingId !== undefined) {
    await advanceAdapterEdgeActivity(ops, entry.relatedBindingId, entry.timestamp);
  }
}

/** GR-4 — resolve the `SyncRule`'s sync edge and advance its `lastActivityAt` (a no-op if the rule is gone). */
export async function advanceSyncEdgeActivity(
  ops: GraphActivityOps,
  ruleId: string,
  activityAt: Date,
): Promise<void> {
  const pair = await ops.resolveSyncEdgeKeyForRule(ruleId);
  if (pair === undefined) {
    return;
  }
  await ops.advanceGraphEdgeActivity({ ...pair, type: "sync", activityAt });
}

/** GR-4 — resolve the `AdapterBinding`'s adapter-dependency edge and advance its `lastActivityAt`. */
export async function advanceAdapterEdgeActivity(
  ops: GraphActivityOps,
  bindingId: string,
  activityAt: Date,
): Promise<void> {
  const pair = await ops.resolveAdapterEdgeKeyForBinding(bindingId);
  if (pair === undefined) {
    return;
  }
  await ops.advanceGraphEdgeActivity({ ...pair, type: "adapter-dependency", activityAt });
}
