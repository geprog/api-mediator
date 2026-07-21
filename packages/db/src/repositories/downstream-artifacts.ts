import type {
  AdapterBinding,
  AdapterEndpoint,
  ApprovedMapping,
  GraphEdge,
  GraphEdgeMetadata,
  SyncRule,
} from "@mediator/domain";
import { and, eq, exists, notExists, or, sql } from "drizzle-orm";

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
export interface GraphEdgeStatusUpdate {
  readonly sourceNodeId: string;
  readonly targetNodeId: string;
  readonly type: GraphEdge["type"];
  readonly status: string;
  readonly direction: GraphEdgeMetadata["direction"];
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
}
