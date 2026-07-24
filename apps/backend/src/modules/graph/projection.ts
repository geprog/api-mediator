import { randomUUID } from "node:crypto";

import {
  DownstreamArtifactRepository,
  RegisteredAppRepository,
  tx,
  type AdapterEdgeMemberFact,
  type Database,
  type DbHandle,
  type GraphEdgeStatusUpdate,
  type SyncEdgeMemberFact,
} from "@mediator/db";
import {
  graphEdgeSchema,
  type GraphEdge,
  type GraphEdgeMetadata,
  type RegisteredAppStatus,
} from "@mediator/domain";

import {
  adapterBindingMemberState,
  deriveEdgeStatus,
  syncRuleMemberState,
  type EdgeAppCondition,
  type EdgeMemberState,
} from "./status.js";

/**
 * **The incremental materialized-graph reactor (GR-2 + GR-3).** It keeps a
 * `GraphEdge`'s `status`/`direction` current as its backing `SyncRule`s /
 * `AdapterBinding`s are approved, enabled, paused, recomposed, adopted, and (later)
 * go stale or are deleted — the update/remove half of the projection GR-1's
 * ensure-exists `upsertGraphEdge` deliberately could not do.
 *
 * **The recompute is a single seam per edge type** — {@link recomputeSyncEdge} /
 * {@link recomputeAdapterEdge}, keyed by the stable `(app pair)` (GR-1.4), never by a
 * rule/binding/mapping id since one edge aggregates many of those. Each recompute
 * makes the create-if-absent vs. update vs. remove decision **explicitly** (GR-1.3):
 * it reads the current aggregate, and
 * - **empty** → `removeGraphEdge` (the last rule/binding is gone; GR-2.5/GR-3.5), else
 * - ensure the edge exists (`upsertGraphEdge`, a no-op when it already does) then
 *   rewrite its `status`+`direction` in place (`updateGraphEdge`, preserving
 *   `metadata.lastActivityAt` — GR-4's disjoint field, GR-1.5).
 *
 * It writes **only** `graph_edge` rows and **no audit row**: the graph is a
 * projection, not an audited mutation, and the operator action that triggered it is
 * already audited by its own story (GR-3.6). The whole reaction is cheap DB reads +
 * a projection write with no LLM/network work, so it is safe inside the triggering
 * transaction (the dispatcher-tx constraint) and **idempotent** on redelivery — a
 * repeat recompute over the same state yields the same edge (GR-2.6).
 *
 * **A `SyncEvent` never reaches this reactor.** Activity (`metadata.lastActivityAt`)
 * is GR-4's job and moves through a disjoint updater; a status recompute here never
 * touches it (GR-2.4). There is deliberately no `SyncEvent` trigger.
 *
 * **Triggers wired today**: peer-peer `SyncRule` enable/disable (the Phase-4 sync
 * operator); adapter recompose / endpoint enable-disable / successor adoption (the
 * Phase-5 composition service — resolving the two CO-6 `// TODO(Phase 6 graph)`
 * markers); mapping `stale`/`suspended` (SL-4/SL-10, the spec registry + the suspension
 * service); and **AL-1** app disable/enable (the app-lifecycle service recomputes every
 * edge incident to the app — the aggregate then sees the app-lifecycle condition folded
 * into each member's effective state, and the app itself **stays a node**, GR-5.4). Edge
 * **create** on approval/derivation stays where GR-1 put it
 * (`artifact-instantiation/instantiate.ts`, the ensure-exists upsert at AI-1/CO-1.5).
 *
 * **Triggers exposed as a seam** for later slices to call:
 * - **AL-2** (app deregistered): recompute the affected edges → their aggregate is
 *   now empty → the edge is removed.
 */
export class GraphProjection {
  readonly #db: Database;
  readonly #newId: () => string;

  public constructor(deps: { readonly db: Database; readonly newId?: () => string }) {
    this.#db = deps.db;
    this.#newId = deps.newId ?? ((): string => randomUUID());
  }

  /**
   * Recompute the `sync` edge for `(sourceAppId → targetAppId)` **within a caller's
   * transaction** — used when the trigger already owns a transaction (e.g. a future
   * SL-4 mapping-status transition committing atomically with the projection).
   */
  public async recomputeSyncEdgeWithin(
    handle: DbHandle,
    sourceAppId: string,
    targetAppId: string,
  ): Promise<void> {
    await projectSyncEdge(dbGraphOps(handle), this.#newId, sourceAppId, targetAppId);
  }

  /**
   * Recompute the `adapter-dependency` edge for `(consumerAppId → backendAppId)`
   * **within a caller's transaction** — used by the composition service so the
   * recompute commits atomically with the recompose/enable-disable/adoption it
   * reflects (GR-3.2/GR-3.4).
   */
  public async recomputeAdapterEdgeWithin(
    handle: DbHandle,
    consumerAppId: string,
    backendAppId: string,
  ): Promise<void> {
    await projectAdapterEdge(dbGraphOps(handle), this.#newId, consumerAppId, backendAppId);
  }

  /**
   * Recompute the `sync` edge for `(sourceAppId → targetAppId)` **in its own
   * transaction** — used when the trigger's own state change has already committed
   * (e.g. the Phase-4 sync operator enable/disable, where the engine wrote the rule
   * status). The recompute reads committed state and is idempotent, so running it
   * after the fact converges on the correct edge.
   */
  public async recomputeSyncEdge(sourceAppId: string, targetAppId: string): Promise<void> {
    await tx(this.#db, (handle) => this.recomputeSyncEdgeWithin(handle, sourceAppId, targetAppId));
  }

  /**
   * Recompute the `adapter-dependency` edge for `(consumerAppId → backendAppId)` **in
   * its own transaction** — the own-transaction counterpart of
   * {@link recomputeAdapterEdgeWithin}, for a trigger without an ambient transaction.
   */
  public async recomputeAdapterEdge(consumerAppId: string, backendAppId: string): Promise<void> {
    await tx(this.#db, (handle) =>
      this.recomputeAdapterEdgeWithin(handle, consumerAppId, backendAppId),
    );
  }
}

/**
 * The real {@link GraphProjectionOps} over one handle: the `graph_edge` aggregate reads +
 * writes from {@link DownstreamArtifactRepository}, plus the node's live app status from
 * {@link RegisteredAppRepository} (AL-1.5). Both bound to the SAME handle, so an
 * in-transaction recompute sees the transition it is reacting to.
 */
function dbGraphOps(handle: DbHandle): GraphProjectionOps {
  const artifacts = new DownstreamArtifactRepository(handle);
  const apps = new RegisteredAppRepository(handle);
  return {
    readSyncEdgeMembers: (sourceAppId, targetAppId) =>
      artifacts.readSyncEdgeMembers(sourceAppId, targetAppId),
    readAdapterEdgeMembers: (consumerAppId, backendAppId) =>
      artifacts.readAdapterEdgeMembers(consumerAppId, backendAppId),
    readAppStatus: async (appId) => (await apps.getById(appId))?.status,
    upsertGraphEdge: (edge) => artifacts.upsertGraphEdge(edge),
    updateGraphEdge: (update) => artifacts.updateGraphEdge(update),
    removeGraphEdge: (sourceNodeId, targetNodeId, type) =>
      artifacts.removeGraphEdge(sourceNodeId, targetNodeId, type),
  };
}

/**
 * The narrow ops the recompute core drives, bound to one transaction handle
 * (structurally satisfied by {@link DownstreamArtifactRepository}). Split from the
 * {@link GraphProjection} class so the create/update/remove decision is unit-testable
 * against an in-memory fake that mirrors these exact semantics.
 */
export interface GraphProjectionOps {
  readSyncEdgeMembers(sourceAppId: string, targetAppId: string): Promise<SyncEdgeMemberFact[]>;
  readAdapterEdgeMembers(
    consumerAppId: string,
    backendAppId: string,
  ): Promise<AdapterEdgeMemberFact[]>;
  /**
   * AL-1.5 — one node's live `RegisteredApp.status`, so a recompute reflects the
   * app-lifecycle condition (a disabled app's edges read `paused`, and the app stays a
   * node — disable never removes it, GR-5.4). `undefined` for an app that no longer
   * exists; the caller then treats the pair's condition as absent rather than inventing
   * a status (an edge whose node is gone is removed by the aggregate being empty).
   */
  readAppStatus(appId: string): Promise<RegisteredAppStatus | undefined>;
  upsertGraphEdge(edge: GraphEdge): Promise<void>;
  updateGraphEdge(update: GraphEdgeStatusUpdate): Promise<void>;
  removeGraphEdge(
    sourceNodeId: string,
    targetNodeId: string,
    type: GraphEdge["type"],
  ): Promise<void>;
}

/** A member fact carries its parent mapping's status + direction; both edge types share this shape. */
interface DirectionCandidate {
  readonly mappingStatus: SyncEdgeMemberFact["mappingStatus"];
  readonly sourceSpecId: string;
  readonly targetSpecId: string;
}

/**
 * The edge's `metadata.direction`: the aggregated mappings' shared
 * `sourceSpecId → targetSpecId` (`docs/architecture/data-model.md` `GraphEdge`).
 * Prefer an `active` mapping's direction — it pins the currently-live specs — over a
 * stale/superseded member's older ones; fall back to the first fact otherwise.
 * `facts` is non-empty here (the caller removed the edge on an empty aggregate).
 */
function pickDirection(facts: readonly DirectionCandidate[]): GraphEdgeMetadata["direction"] {
  const active = facts.find((fact) => fact.mappingStatus === "active");
  const chosen = active ?? facts[0];
  if (chosen === undefined) {
    throw new Error("pickDirection requires a non-empty aggregate");
  }
  return { sourceSpecId: chosen.sourceSpecId, targetSpecId: chosen.targetSpecId };
}

/**
 * The shared create-if-absent / update / remove core. `members` and `facts` are the
 * same aggregate viewed two ways: `members` are the derived effective states (→
 * status), `facts` carry the direction. An empty aggregate removes the edge; a
 * non-empty one ensures the edge exists then rewrites its status+direction in place.
 */
async function applyRecompute(
  ops: GraphProjectionOps,
  newId: () => string,
  params: {
    readonly sourceNodeId: string;
    readonly targetNodeId: string;
    readonly type: GraphEdge["type"];
    readonly members: readonly EdgeMemberState[];
    readonly facts: readonly DirectionCandidate[];
  },
): Promise<void> {
  const { sourceNodeId, targetNodeId, type } = params;
  if (params.members.length === 0) {
    // GR-2.5/GR-3.5 — the last backing rule/binding is gone: the graph never shows a
    // dependency backed by nothing. Idempotent: a no-such-edge remove is a safe no-op.
    await ops.removeGraphEdge(sourceNodeId, targetNodeId, type);
    return;
  }
  const status = deriveEdgeStatus(params.members);
  const direction = pickDirection(params.facts);
  // Create-if-absent: a no-op when the edge already exists (the common case — it was
  // created at approval), and the create path for a rebuild/first-recompute. A freshly
  // created edge starts with lastActivityAt = null (GR-4 stamps activity later).
  await ops.upsertGraphEdge(
    graphEdgeSchema.parse({
      id: newId(),
      sourceNodeId,
      targetNodeId,
      type,
      status,
      metadata: { direction, lastActivityAt: null },
    }),
  );
  // Rewrite status + direction on the existing row (GR-1.1), preserving
  // lastActivityAt (GR-1.5). Idempotent: re-running over the same aggregate rewrites
  // the same values.
  await ops.updateGraphEdge({ sourceNodeId, targetNodeId, type, status, direction });
}

/**
 * **GR-2 core.** Recompute the `sync` edge for `(sourceAppId → targetAppId)` from the
 * current aggregate of that direction's `SyncRule`s. Exported (over an injected
 * {@link GraphProjectionOps}) so the create/update/remove decision is unit-testable
 * without a database.
 */
export async function projectSyncEdge(
  ops: GraphProjectionOps,
  newId: () => string,
  sourceAppId: string,
  targetAppId: string,
): Promise<void> {
  const facts = await ops.readSyncEdgeMembers(sourceAppId, targetAppId);
  const apps = await readEdgeAppCondition(ops, sourceAppId, targetAppId);
  await applyRecompute(ops, newId, {
    sourceNodeId: sourceAppId,
    targetNodeId: targetAppId,
    type: "sync",
    members: facts.map((fact) => syncRuleMemberState(fact.ruleStatus, fact.mappingStatus, apps)),
    facts,
  });
}

/**
 * AL-1.5 — the pair's live app statuses, read once per recompute (the pair is fixed, so
 * the condition is per edge, not per member). An app the read cannot resolve is treated
 * as `active`: the condition is then simply absent, never an invented pause.
 */
async function readEdgeAppCondition(
  ops: GraphProjectionOps,
  sourceAppId: string,
  targetAppId: string,
): Promise<EdgeAppCondition> {
  const [sourceAppStatus, targetAppStatus] = await Promise.all([
    ops.readAppStatus(sourceAppId),
    ops.readAppStatus(targetAppId),
  ]);
  return {
    sourceAppStatus: sourceAppStatus ?? "active",
    targetAppStatus: targetAppStatus ?? "active",
  };
}

/**
 * **GR-3 core.** Recompute the `adapter-dependency` edge for
 * `(consumerAppId → backendAppId)` from the current aggregate of that pair's
 * `AdapterBinding`s. Exported over an injected {@link GraphProjectionOps} for the
 * same unit-testability as {@link projectSyncEdge}.
 */
export async function projectAdapterEdge(
  ops: GraphProjectionOps,
  newId: () => string,
  consumerAppId: string,
  backendAppId: string,
): Promise<void> {
  const facts = await ops.readAdapterEdgeMembers(consumerAppId, backendAppId);
  const apps = await readEdgeAppCondition(ops, consumerAppId, backendAppId);
  await applyRecompute(ops, newId, {
    sourceNodeId: consumerAppId,
    targetNodeId: backendAppId,
    type: "adapter-dependency",
    members: facts.map((fact) =>
      adapterBindingMemberState(fact.bindingStatus, fact.endpointStatus, fact.mappingStatus, apps),
    ),
    facts,
  });
}
