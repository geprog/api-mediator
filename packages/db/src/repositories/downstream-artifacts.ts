import type { AdapterBinding, AdapterEndpoint, GraphEdge, SyncRule } from "@mediator/domain";
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
   * Attach a `proposed` `AdapterBinding` unless one already exists for its
   * `(adapterEndpointId, backendAppId, backendOperationId, approvedMappingId)`
   * (AI-2 criterion 2).
   */
  insertAdapterBindingIfAbsent(binding: AdapterBinding): Promise<void>;
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

  public async upsertGraphEdge(edge: GraphEdge): Promise<void> {
    await this.db
      .insert(graphEdge)
      .values(toGraphEdgeInsert(edge))
      .onConflictDoNothing({
        target: [graphEdge.sourceNodeId, graphEdge.targetNodeId, graphEdge.type],
      });
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
