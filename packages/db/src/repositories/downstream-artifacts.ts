import type {
  AdapterBinding,
  AdapterEndpoint,
  ApprovedMapping,
  GraphEdge,
  GraphEdgeMetadata,
  SyncRule,
} from "@mediator/domain";
import { and, eq, exists, inArray, notExists, notInArray, or, sql, type SQL } from "drizzle-orm";

import type { DbHandle } from "../client.js";
import { mapAdapterBindingRow, toAdapterBindingInsert } from "../mappers/adapter-binding.js";
import { mapAdapterEndpointRow, toAdapterEndpointInsert } from "../mappers/adapter-endpoint.js";
import { mapGraphEdgeRow, toGraphEdgeInsert } from "../mappers/graph-edge.js";
import { mapSyncRuleRow, toSyncRuleInsert } from "../mappers/sync-rule.js";
import {
  adapterBinding,
  adapterEndpoint,
  approvedMapping,
  fieldMapping,
  graphEdge,
  operationMapping,
  syncRule,
} from "../schema.js";

/**
 * The status-recompute patch GR-1's {@link DownstreamArtifactRepository.updateGraphEdge}
 * applies to an existing `graph_edge`, addressed by its stable
 * `(sourceNodeId, targetNodeId, type)` app-pair+type key (GR-1.4 —
 * `docs/requirements/phase-6-graph.md`). It carries exactly the two things a status
 * recompute owns — the recomputed `status` and the aggregated `direction` — and
 * DELIBERATELY EXCLUDES `metadata.lastActivityAt`: that field is owned by GR-4's
 * activity updater, and the two updaters touch **disjoint** `metadata` fields
 * (GR-1.5), so a status recompute cannot reset activity by construction. `status`
 * is a plain string: the concept does not enumerate `GraphEdge.status`'s value set
 * (`docs/architecture/data-model.md` `GraphEdge`), so no enum is coined here — the
 * projection writes the value it derives from the aggregate's rule/binding health.
 */
/**
 * **AL-2.2 — what deleting a backend app's `AdapterBinding`s left behind.** Two disjoint
 * sets, because the caller reacts to them differently:
 *
 * - `endpointIds` — every endpoint a deleted binding hung off. The caller re-inspects
 *   each: one left with **no** bindings serves `not-yet-mapped` (RT-3.1).
 * - `unchained` — the **surviving** bindings whose `dependsOnBindingId`/`chainInputs`
 *   were cleared because their upstream was one of the deleted rows (a cross-backend
 *   `fanout-merge` chain). Their endpoints still have bindings, so they are never in the
 *   binding-less set; the caller flags them `composition-required` instead — the chain
 *   they were composed with is gone and the composition has to be redone.
 *
 * Both sets feed the by-endpoint cache drop (XI-2).
 */
export interface AdapterBindingBackendDeletion {
  readonly endpointIds: readonly string[];
  readonly unchained: readonly { readonly id: string; readonly adapterEndpointId: string }[];
}

export interface GraphEdgeStatusUpdate {
  readonly sourceNodeId: string;
  readonly targetNodeId: string;
  readonly type: GraphEdge["type"];
  readonly status: string;
  readonly direction: GraphEdgeMetadata["direction"];
}

/**
 * **GR-4 — the activity advance patch** {@link DownstreamArtifactRepository.advanceGraphEdgeActivity}
 * applies to an existing `graph_edge`, addressed by the same stable
 * `(sourceNodeId, targetNodeId, type)` app-pair+type key (GR-1.4). It carries **only**
 * `metadata.lastActivityAt` — the exact **disjoint** counterpart of
 * {@link GraphEdgeStatusUpdate} (GR-1.5): the activity updater never rewrites `status`
 * or `direction`, and the status recompute never rewrites `lastActivityAt`. The write
 * is **monotonic** (GR-4.2): it only advances a strictly-newer `activityAt`, so a slow
 * redelivery or an out-of-order event with an older timestamp can never move a live
 * edge backwards.
 */
export interface GraphEdgeActivityAdvance {
  readonly sourceNodeId: string;
  readonly targetNodeId: string;
  readonly type: GraphEdge["type"];
  readonly activityAt: Date;
}

/**
 * The `(source → target)` app pair a `SyncEvent`/`adapter-request` audit row resolves
 * to, so GR-4 can key the activity advance by the stable node pair (GR-1.4) rather than
 * the rule/binding id the audit row carries. For a sync edge the pair is the rule's
 * `ApprovedMapping` `(sourceAppId → targetAppId)`; for an adapter-dependency edge it is
 * the binding's `(consumer app → backend app)`.
 */
export interface GraphEdgeAppPair {
  readonly sourceNodeId: string;
  readonly targetNodeId: string;
}

/**
 * The optional filter for {@link DownstreamArtifactRepository.listGraphEdges} (GR-5.2).
 * Each field narrows the returned edge set (AND-combined): `appId` to edges **incident**
 * to that node (source or target), `status` to a single edge status, `type` to one
 * connection type (`sync` / `adapter-dependency`).
 */
export interface GraphEdgeQuery {
  readonly appId?: string;
  readonly status?: string;
  readonly type?: GraphEdge["type"];
}

/**
 * One member of a **sync** `GraphEdge`'s aggregate: a single `SyncRule` of the
 * `(sourceApp → targetApp)` direction paired with its parent `ApprovedMapping`'s
 * status and direction (`docs/requirements/phase-6-graph.md` GR-2.1/GR-2.2). The
 * incremental sync-edge projection reduces the full set of these facts for a node
 * pair to one edge `status` — a rule's *effective* health is a function of both its
 * own `status` (enabled/disabled) and its mapping's `status` (a `stale`/`suspended`
 * mapping pauses/stales its rules, SL-4/SL-10). `sourceSpecId`/`targetSpecId` are the
 * aggregated mappings' shared direction, carried so the recompute can restate the
 * edge's `metadata.direction` without a second query.
 */
export interface SyncEdgeMemberFact {
  readonly ruleStatus: SyncRule["status"];
  readonly mappingStatus: ApprovedMapping["status"];
  readonly sourceSpecId: string;
  readonly targetSpecId: string;
}

/**
 * One member of an **adapter-dependency** `GraphEdge`'s aggregate: a single
 * `AdapterBinding` of the `(consumerApp → backendApp)` pair paired with its parent
 * `ApprovedMapping`'s status and direction (`docs/requirements/phase-6-graph.md`
 * GR-3.1/GR-3.3). Same shape/role as {@link SyncEdgeMemberFact} for the adapter
 * side: a binding's effective health is a function of its own `status`
 * (active/proposed/disabled) and its mapping's `status`.
 */
export interface AdapterEdgeMemberFact {
  readonly bindingStatus: AdapterBinding["status"];
  readonly endpointStatus: AdapterEndpoint["status"];
  readonly mappingStatus: ApprovedMapping["status"];
  readonly sourceSpecId: string;
  readonly targetSpecId: string;
}

/**
 * The write operations the Phase-3 `MappingApproved` consumer drives to
 * instantiate an approval's disabled downstream artifacts (AI-1..AI-3), bound to
 * ONE transaction handle. A narrow interface (rather than the whole
 * {@link DownstreamArtifactRepository}) so the consumer/instantiation core is
 * unit-testable against an in-memory fake that mirrors these exact
 * insert-if-absent / ensure-exists semantics.
 *
 * Every write is **idempotent** by its natural key (`ON CONFLICT DO NOTHING`): a
 * redelivered `MappingApproved` (same event id) and an incremental one (new event
 * id, more coverage) both converge on the same committed set of rows, leaving any
 * already-instantiated artifact — and any operator state on it — untouched.
 */
export interface DownstreamArtifactOps {
  /**
   * Insert a disabled `SyncRule` unless one already exists for its
   * `(approvedMappingId, resourcePairRef)` — the peer-peer per-resource-pair
   * instantiation (AI-1).
   */
  insertSyncRuleIfAbsent(rule: SyncRule): Promise<void>;
  /**
   * Ensure the `AdapterEndpoint` for `(consumerAppId, consumerOperationId)` exists,
   * returning the persisted row (the `candidate` when freshly created, the existing
   * one — never a duplicate — otherwise). AI-2 criterion 1's ensure-exists.
   */
  ensureAdapterEndpoint(candidate: AdapterEndpoint): Promise<AdapterEndpoint>;
  /**
   * Attach an `AdapterBinding` unless one already exists for its
   * `(adapterEndpointId, backendAppId, backendOperationId, approvedMappingId)`
   * (AI-2 criterion 2). CO-1 chooses its `status` before calling — `active` for an
   * endpoint's first binding, `proposed` for any further one — and this insert is
   * `ON CONFLICT DO NOTHING`, so a redelivery never re-attaches, re-activates, or
   * resets an existing binding (including one an operator later `disabled`, CO-1.6).
   */
  insertAdapterBindingIfAbsent(binding: AdapterBinding): Promise<void>;
  /**
   * Every existing `AdapterBinding` of an endpoint, in any status
   * (`active`/`proposed`/`disabled`). CO-1 reads this to decide whether an
   * attaching binding is the endpoint's **first** (→ auto-activate) or a **further**
   * one (→ attach `proposed`, endpoint `composition-required`): "already has a
   * binding" (CO-1.3) is any existing binding row, whatever its status.
   */
  listAdapterBindingsByEndpoint(adapterEndpointId: string): Promise<AdapterBinding[]>;
  /**
   * CO-1.2 first-binding auto-activation. Promote an as-yet-unserved endpoint to its
   * zero-friction single-backend serving state — `status = active`,
   * `aggregationStrategy = single`, `strictness = degraded`, `cacheTtl` cleared (no
   * caching) — **only** while it is still `composition-required` (the neutral
   * "attached, nothing composed" create state). The `status` guard makes it a no-op
   * on an already-`active` (composed), operator-`disabled`, or otherwise non-neutral
   * endpoint, so a redelivery or a later mapping never re-activates or resets a
   * composed endpoint (CO-1.6). Returns the endpoint's resulting persisted state.
   */
  activateAdapterEndpointForSingleBinding(adapterEndpointId: string): Promise<AdapterEndpoint>;
  /**
   * CO-1.3 second-binding transition. Move an `active` endpoint to
   * `composition-required` so a human composes the now-multiple backends, **only**
   * from `active`. It changes `status` alone — the endpoint's serving config
   * (`aggregationStrategy`/`strictness`/`cacheTtl`) and its already-`active` binding
   * are left untouched, so the prior configuration keeps serving (RT-3.3). The
   * `status` guard makes it a no-op on an already-`composition-required` or
   * `disabled` endpoint (idempotent, never re-flips). Returns the resulting state.
   */
  markAdapterEndpointCompositionRequired(adapterEndpointId: string): Promise<AdapterEndpoint>;
  /**
   * Ensure the projected `GraphEdge` for `(sourceNodeId, targetNodeId, type)`
   * exists (AI-1/AI-2 criterion 3). Ensure-exists (not update): for a fixed node
   * pair + type the projected direction is invariant and Phase 3 produces no
   * activity, so a repeat approval must not clobber a later phase's edge state.
   */
  upsertGraphEdge(edge: GraphEdge): Promise<void>;
}

/**
 * Persistence for the four Phase-3 downstream-artifact tables (`sync_rule`,
 * `adapter_endpoint`, `adapter_binding`, `graph_edge`). Constructor-bound to a
 * {@link DbHandle} (the pooled db or a `tx()` transaction), matching the repo
 * convention; it implements {@link DownstreamArtifactOps} plus the reconciliation
 * sweep's "active mapping with no instantiated artifacts" query and read helpers
 * for tests/observability.
 */
export class DownstreamArtifactRepository implements DownstreamArtifactOps {
  public constructor(private readonly db: DbHandle) {}

  public async insertSyncRuleIfAbsent(rule: SyncRule): Promise<void> {
    await this.db
      .insert(syncRule)
      .values(toSyncRuleInsert(rule))
      .onConflictDoNothing({ target: [syncRule.approvedMappingId, syncRule.resourcePairRef] });
  }

  public async ensureAdapterEndpoint(candidate: AdapterEndpoint): Promise<AdapterEndpoint> {
    const [inserted] = await this.db
      .insert(adapterEndpoint)
      .values(toAdapterEndpointInsert(candidate))
      .onConflictDoNothing({
        target: [adapterEndpoint.consumerAppId, adapterEndpoint.consumerOperationId],
      })
      .returning();
    if (inserted !== undefined) {
      return mapAdapterEndpointRow(inserted);
    }
    // Conflict: an endpoint already exists for this consumer operation → reuse it.
    const [existing] = await this.db
      .select()
      .from(adapterEndpoint)
      .where(
        and(
          eq(adapterEndpoint.consumerAppId, candidate.consumerAppId),
          eq(adapterEndpoint.consumerOperationId, candidate.consumerOperationId),
        ),
      );
    if (existing === undefined) {
      throw new Error("adapter_endpoint ensure-exists found no row after a conflict");
    }
    return mapAdapterEndpointRow(existing);
  }

  public async insertAdapterBindingIfAbsent(binding: AdapterBinding): Promise<void> {
    await this.db
      .insert(adapterBinding)
      .values(toAdapterBindingInsert(binding))
      .onConflictDoNothing({
        target: [
          adapterBinding.adapterEndpointId,
          adapterBinding.backendAppId,
          adapterBinding.backendOperationId,
          adapterBinding.approvedMappingId,
        ],
      });
  }

  public async activateAdapterEndpointForSingleBinding(
    adapterEndpointId: string,
  ): Promise<AdapterEndpoint> {
    // Guarded UPDATE (CO-1.2): promote ONLY a still-neutral `composition-required`
    // endpoint. The `status` predicate is a correctness guard, not just defensive —
    // it makes activation a no-op on an already-composed (`active`), operator
    // (`disabled`), or otherwise non-neutral endpoint, so a redelivery / a later
    // mapping can never re-activate or reset a composed endpoint (CO-1.6). Composition
    // fields are set to the documented single-binding safe defaults; `cacheTtl` NULL
    // = no caching.
    await this.db
      .update(adapterEndpoint)
      .set({
        status: "active",
        aggregationStrategy: "single",
        strictness: "degraded",
        cacheTtl: null,
      })
      .where(
        and(
          eq(adapterEndpoint.id, adapterEndpointId),
          eq(adapterEndpoint.status, "composition-required"),
        ),
      );
    return this.requireAdapterEndpointById(adapterEndpointId);
  }

  public async markAdapterEndpointCompositionRequired(
    adapterEndpointId: string,
  ): Promise<AdapterEndpoint> {
    // Guarded UPDATE (CO-1.3): move ONLY an `active` endpoint to `composition-required`.
    // `status` alone changes — the serving config and the already-`active` binding are
    // untouched, so the prior configuration keeps serving (RT-3.3). The guard makes it
    // a no-op on an already-`composition-required` or `disabled` endpoint (idempotent).
    await this.db
      .update(adapterEndpoint)
      .set({ status: "composition-required" })
      .where(and(eq(adapterEndpoint.id, adapterEndpointId), eq(adapterEndpoint.status, "active")));
    return this.requireAdapterEndpointById(adapterEndpointId);
  }

  /** Load an endpoint by id after a guarded CO-1 transition; it always exists here. */
  private async requireAdapterEndpointById(id: string): Promise<AdapterEndpoint> {
    const [row] = await this.db.select().from(adapterEndpoint).where(eq(adapterEndpoint.id, id));
    if (row === undefined) {
      throw new Error("adapter_endpoint not found after a CO-1 status transition");
    }
    return mapAdapterEndpointRow(row);
  }

  public async upsertGraphEdge(edge: GraphEdge): Promise<void> {
    await this.db
      .insert(graphEdge)
      .values(toGraphEdgeInsert(edge))
      .onConflictDoNothing({
        target: [graphEdge.sourceNodeId, graphEdge.targetNodeId, graphEdge.type],
      });
  }

  /**
   * **GR-1.1/GR-1.4/GR-1.5 — in-place status recompute.** Rewrite the `status` and
   * `metadata.direction` of the existing edge addressed by
   * `(sourceNodeId, targetNodeId, type)`, **replacing** the prior values on the
   * **same row** (the `id` is never touched) — the gap the ensure-exists
   * {@link upsertGraphEdge} (`ON CONFLICT DO NOTHING`) cannot fill. An incremental
   * updater (GR-2/GR-3) calls this when that `(app pair, direction)`'s aggregate of
   * rules/bindings is non-empty but its health changed.
   *
   * `metadata.lastActivityAt` is **preserved** (GR-1.5): the write replaces only the
   * `direction` sub-object via `jsonb_set`, leaving `lastActivityAt` — GR-4's
   * disjoint activity field — exactly as persisted. A status recompute never resets
   * activity; an activity update (GR-4) never rewrites status. Keyed by the
   * app-pair+type triple (nodes = app ids), **never** by a mapping/rule/binding id,
   * since one edge aggregates many of those (GR-1.4).
   *
   * A no-such-edge update matches no row and writes nothing: the incremental updater
   * chooses create-if-absent vs. update vs. remove **explicitly** (GR-1.3), so a
   * missing edge is its `upsertGraphEdge` create case, not a silent insert here.
   */
  public async updateGraphEdge(update: GraphEdgeStatusUpdate): Promise<void> {
    await this.db
      .update(graphEdge)
      .set({
        status: update.status,
        // Replace ONLY metadata.direction; jsonb_set leaves metadata.lastActivityAt
        // (GR-4's disjoint field) untouched — GR-1.5's preserve-activity guarantee,
        // atomic in one UPDATE (no read-then-write race with a concurrent GR-4 write).
        metadata: sql`jsonb_set(${graphEdge.metadata}, '{direction}', ${JSON.stringify(
          update.direction,
        )}::jsonb)`,
      })
      .where(
        and(
          eq(graphEdge.sourceNodeId, update.sourceNodeId),
          eq(graphEdge.targetNodeId, update.targetNodeId),
          eq(graphEdge.type, update.type),
        ),
      );
  }

  /**
   * **GR-1.2/GR-1.4 — remove.** Delete the edge addressed by
   * `(sourceNodeId, targetNodeId, type)` — used when that `(app pair, direction)`'s
   * **last** underlying `SyncRule`/`AdapterBinding` is gone (e.g. an AL-2 deregister
   * cascade) and the aggregate is now empty, so the graph never shows a dependency
   * backed by nothing (GR-1.2). Keyed by the app-pair+type triple, **never** by a
   * rule/binding id (GR-1.4). A no-such-edge remove matches no row and is a safe
   * no-op — idempotent on redelivery or a repeat recompute.
   */
  public async removeGraphEdge(
    sourceNodeId: string,
    targetNodeId: string,
    type: GraphEdge["type"],
  ): Promise<void> {
    await this.db
      .delete(graphEdge)
      .where(
        and(
          eq(graphEdge.sourceNodeId, sourceNodeId),
          eq(graphEdge.targetNodeId, targetNodeId),
          eq(graphEdge.type, type),
        ),
      );
  }

  /**
   * **GR-4 — advance an edge's `metadata.lastActivityAt` from the durable Audit/Event
   * Log.** Stamp the edge addressed by `(sourceNodeId, targetNodeId, type)` with the
   * recorded `SyncEvent`/`adapter-request` timestamp, touching **only**
   * `metadata.lastActivityAt` via `jsonb_set` — exactly as {@link updateGraphEdge}
   * isolates `metadata.direction` — so `status` and `direction` (GR-1's disjoint fields,
   * GR-1.5) are left byte-identical. Keyed by the app-pair+type triple, **never** by a
   * rule/binding id, since one edge aggregates many of those (GR-1.4).
   *
   * **Monotonic (GR-4.2), atomic under concurrency.** The `WHERE` advances only when the
   * stored `lastActivityAt` is NULL (never stamped) or strictly older than `activityAt`,
   * evaluated inside the same UPDATE — so an out-of-order or redelivered event with an
   * older timestamp matches no row and **no-ops** (it can never move a live edge
   * backwards), and two concurrent advances converge on the newest without a
   * read-then-write race. A no-such-edge advance (the edge was removed, GR-1.2, or never
   * created) likewise matches no row and is a safe no-op — the nullable `lastActivityAt`
   * simply stays absent (GR-4.3). The timestamp is stored as an ISO string in the jsonb
   * (the mapper reconstructs it to a `Date`), and compared as `timestamptz` so the order
   * is chronological, not lexical.
   */
  public async advanceGraphEdgeActivity(advance: GraphEdgeActivityAdvance): Promise<void> {
    const activityAt = advance.activityAt.toISOString();
    await this.db
      .update(graphEdge)
      .set({
        // Replace ONLY metadata.lastActivityAt; jsonb_set leaves metadata.direction and
        // the row's `status` untouched — GR-1.5's disjoint-field guarantee, mirrored from
        // updateGraphEdge's direction isolation. `to_jsonb(text)` stores it as a JSON
        // string (jsonb has no Date), which the graph-edge mapper reconstructs to a Date.
        metadata: sql`jsonb_set(${graphEdge.metadata}, '{lastActivityAt}', to_jsonb(${activityAt}::text))`,
      })
      .where(
        and(
          eq(graphEdge.sourceNodeId, advance.sourceNodeId),
          eq(graphEdge.targetNodeId, advance.targetNodeId),
          eq(graphEdge.type, advance.type),
          // Monotonic guard: advance only past a NULL or strictly-older stamp.
          sql`((${graphEdge.metadata} ->> 'lastActivityAt') IS NULL OR (${graphEdge.metadata} ->> 'lastActivityAt')::timestamptz < ${activityAt}::timestamptz)`,
        ),
      );
  }

  /**
   * **GR-4 — resolve a `SyncEvent`'s sync edge key.** A `sync-execution` row references
   * a `SyncRule` (`relatedRuleId`); its edge is that rule's `ApprovedMapping`
   * `(sourceAppId → targetAppId)` sync edge. Returns the node pair, or `undefined` when
   * the rule no longer resolves (a redelivery after the rule/mapping was deleted) — the
   * caller then advances nothing.
   */
  public async resolveSyncEdgeKeyForRule(ruleId: string): Promise<GraphEdgeAppPair | undefined> {
    const [row] = await this.db
      .select({
        sourceAppId: approvedMapping.sourceAppId,
        targetAppId: approvedMapping.targetAppId,
      })
      .from(syncRule)
      .innerJoin(approvedMapping, eq(syncRule.approvedMappingId, approvedMapping.id))
      .where(eq(syncRule.id, ruleId));
    return row === undefined
      ? undefined
      : { sourceNodeId: row.sourceAppId, targetNodeId: row.targetAppId };
  }

  /**
   * **GR-4 — resolve an `adapter-request`'s adapter-dependency edge key.** An
   * `adapter-request` row references an `AdapterBinding` (`relatedBindingId`); its edge
   * is that binding's `(consumer app → backend app)` adapter-dependency edge — the
   * consumer from the binding's `AdapterEndpoint`, the backend from the binding itself.
   * Returns the node pair, or `undefined` when the binding no longer resolves.
   */
  public async resolveAdapterEdgeKeyForBinding(
    bindingId: string,
  ): Promise<GraphEdgeAppPair | undefined> {
    const [row] = await this.db
      .select({
        consumerAppId: adapterEndpoint.consumerAppId,
        backendAppId: adapterBinding.backendAppId,
      })
      .from(adapterBinding)
      .innerJoin(adapterEndpoint, eq(adapterBinding.adapterEndpointId, adapterEndpoint.id))
      .where(eq(adapterBinding.id, bindingId));
    return row === undefined
      ? undefined
      : { sourceNodeId: row.consumerAppId, targetNodeId: row.backendAppId };
  }

  // ── Reconciliation sweep query ─────────────────────────────────────────────

  /**
   * The ids of `active` `ApprovedMapping`s that ended up with **no** instantiated
   * downstream artifacts — the reconciliation sweep's "an approved mapping whose
   * reaction was lost" derivation (AI-3 criterion 4). A mapping is "instantiated"
   * when it has ≥1 `sync_rule` OR ≥1 `adapter_binding`; a missing one has neither.
   *
   * The variant-aware clause excludes mappings that would legitimately produce
   * zero artifacts (a peer-peer mapping needs a field/operation child to yield a
   * resource pair; a consumer-provider mapping needs an operation child to yield a
   * binding), so a genuinely empty mapping is not re-triggered forever — the same
   * "a recorded outcome is not an absence" discipline the detection reconciler uses.
   */
  public async listActiveMappingIdsWithoutArtifacts(): Promise<string[]> {
    const hasFieldChild = exists(
      this.db
        .select({ one: sql`1` })
        .from(fieldMapping)
        .where(eq(fieldMapping.mappingId, approvedMapping.id)),
    );
    const hasOperationChild = exists(
      this.db
        .select({ one: sql`1` })
        .from(operationMapping)
        .where(eq(operationMapping.mappingId, approvedMapping.id)),
    );
    const rows = await this.db
      .select({ id: approvedMapping.id })
      .from(approvedMapping)
      .where(
        and(
          eq(approvedMapping.status, "active"),
          // SL-7.2 — a **successor** (an approved mapping carrying `predecessorMappingId`)
          // is *adopted* in place (its predecessor's re-pointed rules/bindings take over its
          // slot), never freshly instantiated. So it is deliberately excluded from the
          // fresh-instantiation reconciler: a successor whose adoption has not yet re-pointed
          // its rules must NOT be given brand-new rules here (that would double-instantiate
          // and bypass the re-point). Adoption is re-derived by the `MappingApproved`
          // redelivery (and RC-3's adoption reconciliation later), not by this query.
          sql`${approvedMapping.predecessorMappingId} is null`,
          notExists(
            this.db
              .select({ one: sql`1` })
              .from(syncRule)
              .where(eq(syncRule.approvedMappingId, approvedMapping.id)),
          ),
          notExists(
            this.db
              .select({ one: sql`1` })
              .from(adapterBinding)
              .where(eq(adapterBinding.approvedMappingId, approvedMapping.id)),
          ),
          or(
            and(eq(approvedMapping.variant, "peer-peer"), or(hasFieldChild, hasOperationChild)),
            and(eq(approvedMapping.variant, "consumer-provider"), hasOperationChild),
          ),
        ),
      );
    return rows.map((row) => row.id);
  }

  // ── Read helpers (observability / tests) ───────────────────────────────────

  /** The disabled `SyncRule`s instantiated for one `ApprovedMapping`. */
  public async listSyncRulesByMapping(approvedMappingId: string): Promise<SyncRule[]> {
    const rows = await this.db
      .select()
      .from(syncRule)
      .where(eq(syncRule.approvedMappingId, approvedMappingId));
    return rows.map(mapSyncRuleRow);
  }

  /** The `AdapterEndpoint` for a consumer operation, if one exists. */
  public async getAdapterEndpoint(
    consumerAppId: string,
    consumerOperationId: string,
  ): Promise<AdapterEndpoint | undefined> {
    const [row] = await this.db
      .select()
      .from(adapterEndpoint)
      .where(
        and(
          eq(adapterEndpoint.consumerAppId, consumerAppId),
          eq(adapterEndpoint.consumerOperationId, consumerOperationId),
        ),
      );
    return row === undefined ? undefined : mapAdapterEndpointRow(row);
  }

  /** Every `AdapterEndpoint` for a consumer app. */
  public async listAdapterEndpointsByConsumerApp(
    consumerAppId: string,
  ): Promise<AdapterEndpoint[]> {
    const rows = await this.db
      .select()
      .from(adapterEndpoint)
      .where(eq(adapterEndpoint.consumerAppId, consumerAppId));
    return rows.map(mapAdapterEndpointRow);
  }

  /** The `AdapterBinding`s attached by one `ApprovedMapping`. */
  public async listAdapterBindingsByMapping(approvedMappingId: string): Promise<AdapterBinding[]> {
    const rows = await this.db
      .select()
      .from(adapterBinding)
      .where(eq(adapterBinding.approvedMappingId, approvedMappingId));
    return rows.map(mapAdapterBindingRow);
  }

  /**
   * **AL-1.5 / XI-2.2 — the `AdapterBinding`s an app *backs*.** Every binding whose
   * `backendAppId` is this app, in any status. The app-lifecycle transition reads it to
   * target the by-endpoint cache drop: when the backend app is disabled those bindings
   * start failing `backend-disabled`, so a response cached while they were healthy must
   * not keep being served (XI-2.2). Keyed by the backend app — **not** by the app's own
   * consumer endpoints, which keep serving.
   */
  public async listAdapterBindingsByBackendApp(backendAppId: string): Promise<AdapterBinding[]> {
    const rows = await this.db
      .select()
      .from(adapterBinding)
      .where(eq(adapterBinding.backendAppId, backendAppId));
    return rows.map(mapAdapterBindingRow);
  }

  /**
   * **AL-2.3 — tear down a deregistered consumer app's whole adapter surface.** Deletes
   * every `AdapterEndpoint` the app registered as a `CONSUMER`; its `AdapterBinding`s and
   * `AdapterWriteOutcome` rows follow through their `ON DELETE CASCADE`. Afterwards
   * callers of that surface hit **nothing** — not `not-yet-mapped`: with no endpoint row
   * *and* no mounted (archived) consumer spec, the operation is not routed at all
   * (`docs/architecture/extensibility.md` *App lifecycle*; RT-4.3).
   *
   * Returns the deleted endpoint ids so the caller can drop their cached entries after
   * commit (XI-2 / CH-5.3). Deliberately unfiltered by status: a `disabled` or
   * `composition-required` endpoint of a departing app goes with it too.
   */
  public async deleteAdapterEndpointsByConsumerApp(consumerAppId: string): Promise<string[]> {
    const deleted = await this.db
      .delete(adapterEndpoint)
      .where(eq(adapterEndpoint.consumerAppId, consumerAppId))
      .returning({ id: adapterEndpoint.id });
    return deleted.map((row) => row.id);
  }

  /**
   * **AL-2.2 — delete every `AdapterBinding` a deregistered app *backs*.** The mirror of
   * {@link listAdapterBindingsByBackendApp}: the departing app can no longer serve any
   * consumer operation, so its bindings are deleted rather than left failing
   * `backend-disabled` (that is AL-1's reversible condition, not this destructive one).
   *
   * ## Why this is two statements, not one `DELETE`
   *
   * `adapter_binding_depends_on_same_endpoint_fk` is a composite **self**-foreign key
   * `(depends_on_binding_id, adapter_endpoint_id) → (id, adapter_endpoint_id)` with **no
   * delete action** (AD-6.3). Chaining is same-endpoint but **not** same-backend: under
   * `fanout-merge` a binding may legitimately depend on any active binding of its
   * endpoint, whatever app backs it (`adapter-composition/validate.ts` imposes no
   * same-backend restriction). So a bare `DELETE … WHERE backend_app_id = $1` aborts on
   * the end-of-statement FK check the moment a deleted binding is the **upstream of a
   * surviving** one — which would make the backing app permanently undeletable.
   *
   * The upstream's departure is therefore made explicit first: every **surviving**
   * binding that depended on a doomed one is **unchained** — `depends_on_binding_id` and
   * `chain_inputs` cleared together, because `chainInputs` reads the upstream's response
   * and a survivor keeping them would serve a composition wired to a response nobody
   * will ever produce. Only then are the rows deleted.
   *
   * (The AL-2.3 tear-down needs none of this: `ON DELETE CASCADE` from `adapter_endpoint`
   * removes a chain's upstream and downstream in one operation, and the FK is
   * same-endpoint, so no cross-endpoint orphan is representable.)
   *
   * Returns the **distinct** `adapterEndpointId`s the deleted bindings hung off — other
   * consumers' endpoints the caller re-inspects (one left with **no** bindings serves
   * `not-yet-mapped`, RT-3.1) — plus the surviving bindings it unchained, whose endpoints
   * the caller flags `composition-required`: their composed configuration lost a step and
   * must be re-composed rather than keep serving. Both sets feed the XI-2 cache drop.
   */
  public async deleteAdapterBindingsByBackendApp(
    backendAppId: string,
  ): Promise<AdapterBindingBackendDeletion> {
    const doomed = await this.db
      .select({ id: adapterBinding.id, adapterEndpointId: adapterBinding.adapterEndpointId })
      .from(adapterBinding)
      .where(eq(adapterBinding.backendAppId, backendAppId));
    if (doomed.length === 0) {
      return { endpointIds: [], unchained: [] };
    }

    const doomedIds = doomed.map((row) => row.id);
    // Detach the survivors BEFORE the delete (the self-FK has no delete action). A doomed
    // binding depending on another doomed one is excluded: both go in the same statement,
    // so there is nothing to preserve and nothing to report as a broken composition.
    const unchained = await this.db
      .update(adapterBinding)
      .set({ dependsOnBindingId: null, chainInputs: null })
      .where(
        and(
          inArray(adapterBinding.dependsOnBindingId, doomedIds),
          notInArray(adapterBinding.id, doomedIds),
        ),
      )
      .returning({ id: adapterBinding.id, adapterEndpointId: adapterBinding.adapterEndpointId });

    await this.db.delete(adapterBinding).where(eq(adapterBinding.backendAppId, backendAppId));

    return {
      endpointIds: [...new Set(doomed.map((row) => row.adapterEndpointId))],
      unchained,
    };
  }

  /**
   * **Successor adoption re-point (Phase-5 CO-7.1/7.2).** Point every `AdapterBinding`
   * currently on the `superseded` mapping at its `successor`, changing **only**
   * `approvedMappingId` — the binding's composed serving state (`role`,
   * `executionOrder`, `dependsOnBindingId`, `chainInputs`, `status`) is left untouched,
   * so the successor takes over its predecessor's slot rather than attaching afresh as a
   * `proposed` binding (extensibility.md *Successor adoption*). Returns the re-pointed
   * rows (now on the successor) so the caller can re-validate the affected endpoints.
   *
   * Idempotent by construction: a binding already on the successor no longer matches
   * `superseded`, so re-adopting the same pair re-points nothing and returns `[]` — a
   * clean no-op. Bound to a transaction handle by the service so the re-point, the
   * endpoints' re-validation-driven status transitions, and the OA-3 audit row commit
   * together or not at all.
   */
  public async repointAdapterBindingsToSuccessor(
    supersededMappingId: string,
    successorMappingId: string,
  ): Promise<AdapterBinding[]> {
    const rows = await this.db
      .update(adapterBinding)
      .set({ approvedMappingId: successorMappingId })
      .where(eq(adapterBinding.approvedMappingId, supersededMappingId))
      .returning();
    return rows.map(mapAdapterBindingRow);
  }

  /**
   * **Successor adoption sync re-point (SL-7.1/7.2).** The sync-side mirror of
   * {@link repointAdapterBindingsToSuccessor}: point every `SyncRule` currently on the
   * `superseded` mapping at its `successor`, changing **only** `approvedMappingId`. Every
   * other column — `status`, `cursor`, `lastSnapshotRef`, `backfillStatus`,
   * `pollOperationRef`, `pollIntervalOverride`, and the rest of the rule's operational
   * state — is left byte-identical, so the rule keeps its cursor, snapshot, backfill
   * status, and enablement across the re-point (SL-8.1): the operational state describes
   * the *relationship*, which persisted through re-review; only the correspondence content
   * changed. Returns the re-pointed rows (now on the successor) for the caller to react to
   * (recompute the sync `GraphEdge`).
   *
   * Idempotent by construction: a rule already on the successor no longer matches
   * `superseded`, so re-adopting the same mapping re-points nothing and returns `[]` — a
   * clean no-op. Bound to a transaction handle by the caller so the re-point, the
   * predecessor's supersession, and the counterpart transfer commit together or not at all.
   */
  public async repointSyncRulesToSuccessor(
    supersededMappingId: string,
    successorMappingId: string,
  ): Promise<SyncRule[]> {
    const rows = await this.db
      .update(syncRule)
      .set({ approvedMappingId: successorMappingId })
      .where(eq(syncRule.approvedMappingId, supersededMappingId))
      .returning();
    return rows.map(mapSyncRuleRow);
  }

  /**
   * The `AdapterBinding`s of one `AdapterEndpoint`, in any status. The Adapter
   * Server Runtime's Resolution Planner (Phase-5 RT-3) reads these to decide
   * whether an endpoint has an `active` serving configuration or still answers
   * `not-yet-mapped` — an endpoint row existing is not, by itself, a served
   * endpoint (`docs/architecture/adapter-engine.md` *Binding: decided at
   * composition time*).
   */
  public async listAdapterBindingsByEndpoint(adapterEndpointId: string): Promise<AdapterBinding[]> {
    const rows = await this.db
      .select()
      .from(adapterBinding)
      .where(eq(adapterBinding.adapterEndpointId, adapterEndpointId));
    return rows.map(mapAdapterBindingRow);
  }

  // ── Edge-aggregate readers (GR-2/GR-3 incremental projection) ──────────────

  /**
   * **GR-2.1/GR-2.2 — the sync edge's aggregate.** Every `SyncRule` whose parent
   * peer-peer `ApprovedMapping` runs `sourceAppId → targetAppId`, joined to that
   * mapping's `status` + direction. One row per rule of the direction — the exact
   * set the sync-edge projection reduces to a single `status` (all mappings of the
   * direction, in any lifecycle state, so a `stale`/`suspended` mapping's rules are
   * seen and stale/pause the edge; the caller derives per-member effective health).
   * An empty result means the `(pair, sync)` edge has no backing rules → the caller
   * removes it (GR-2.5). Keyed by app ids, never by a rule/mapping id (GR-1.4).
   */
  public async readSyncEdgeMembers(
    sourceAppId: string,
    targetAppId: string,
  ): Promise<SyncEdgeMemberFact[]> {
    const rows = await this.db
      .select({
        ruleStatus: syncRule.status,
        mappingStatus: approvedMapping.status,
        sourceSpecId: approvedMapping.sourceSpecId,
        targetSpecId: approvedMapping.targetSpecId,
      })
      .from(syncRule)
      .innerJoin(approvedMapping, eq(syncRule.approvedMappingId, approvedMapping.id))
      .where(
        and(
          eq(approvedMapping.sourceAppId, sourceAppId),
          eq(approvedMapping.targetAppId, targetAppId),
          eq(approvedMapping.variant, "peer-peer"),
        ),
      );
    return rows.map((row) => ({
      ruleStatus: row.ruleStatus,
      mappingStatus: row.mappingStatus,
      sourceSpecId: row.sourceSpecId,
      targetSpecId: row.targetSpecId,
    }));
  }

  /**
   * **GR-3.1/GR-3.3 — the adapter-dependency edge's aggregate.** Every
   * `AdapterBinding` whose endpoint's consumer is `consumerAppId` and whose
   * `backendAppId` is `backendAppId`, joined to its `ApprovedMapping`'s `status` +
   * direction — the full set of bindings the `(consumer → backend)` edge aggregates,
   * across **all** of the consumer's adapter endpoints (a binding of any status is
   * a member; a disabled binding still counts, it just contributes `paused`). An
   * empty result means the edge has no backing bindings → the caller removes it
   * (GR-3.5). Keyed by app ids, never by a binding/mapping id (GR-1.4).
   */
  public async readAdapterEdgeMembers(
    consumerAppId: string,
    backendAppId: string,
  ): Promise<AdapterEdgeMemberFact[]> {
    const rows = await this.db
      .select({
        bindingStatus: adapterBinding.status,
        endpointStatus: adapterEndpoint.status,
        mappingStatus: approvedMapping.status,
        sourceSpecId: approvedMapping.sourceSpecId,
        targetSpecId: approvedMapping.targetSpecId,
      })
      .from(adapterBinding)
      .innerJoin(adapterEndpoint, eq(adapterBinding.adapterEndpointId, adapterEndpoint.id))
      .innerJoin(approvedMapping, eq(adapterBinding.approvedMappingId, approvedMapping.id))
      .where(
        and(
          eq(adapterEndpoint.consumerAppId, consumerAppId),
          eq(adapterBinding.backendAppId, backendAppId),
        ),
      );
    return rows.map((row) => ({
      bindingStatus: row.bindingStatus,
      endpointStatus: row.endpointStatus,
      mappingStatus: row.mappingStatus,
      sourceSpecId: row.sourceSpecId,
      targetSpecId: row.targetSpecId,
    }));
  }

  /** The `GraphEdge` for a node pair + type, if one exists. */
  public async getGraphEdge(
    sourceNodeId: string,
    targetNodeId: string,
    type: GraphEdge["type"],
  ): Promise<GraphEdge | undefined> {
    const [row] = await this.db
      .select()
      .from(graphEdge)
      .where(
        and(
          eq(graphEdge.sourceNodeId, sourceNodeId),
          eq(graphEdge.targetNodeId, targetNodeId),
          eq(graphEdge.type, type),
        ),
      );
    return row === undefined ? undefined : mapGraphEdgeRow(row);
  }

  /**
   * **GR-5.1/GR-5.2 — the materialized edge set, optionally filtered.** Every
   * `graph_edge` row (the projection **as materialized** — never recomputed here),
   * assembled by {@link GraphService.getGraph} into `{ nodes, edges }`. Each row carries
   * its full `type`/`status`/`metadata`, so the read needs no second query for edge
   * detail (GR-5.3). The optional {@link GraphEdgeQuery} narrows the set (AND-combined):
   * `appId` to edges incident to that node, `status`/`type` to that value. Returned
   * **unpaginated** (GR-5.6 — small-landscape scale).
   */
  public async listGraphEdges(filter: GraphEdgeQuery = {}): Promise<GraphEdge[]> {
    const conditions: (SQL | undefined)[] = [];
    if (filter.appId !== undefined) {
      conditions.push(
        or(eq(graphEdge.sourceNodeId, filter.appId), eq(graphEdge.targetNodeId, filter.appId)),
      );
    }
    if (filter.status !== undefined) {
      conditions.push(eq(graphEdge.status, filter.status));
    }
    if (filter.type !== undefined) {
      conditions.push(eq(graphEdge.type, filter.type));
    }
    const rows =
      conditions.length === 0
        ? await this.db.select().from(graphEdge)
        : await this.db
            .select()
            .from(graphEdge)
            .where(and(...conditions));
    return rows.map(mapGraphEdgeRow);
  }
}
