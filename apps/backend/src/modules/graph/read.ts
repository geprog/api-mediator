import {
  DownstreamArtifactRepository,
  RegisteredAppRepository,
  type Database,
  type DbHandle,
} from "@mediator/db";
import type { GraphEdge, RegisteredApp } from "@mediator/domain";

/**
 * The optional graph filter (GR-5.2). Each field narrows the result (AND-combined):
 * `appId` focuses on one node's neighbourhood, `status`/`type` restrict the edge set.
 * All absent = the whole landscape.
 */
export interface GraphFilter {
  readonly appId?: string;
  readonly status?: string;
  readonly type?: GraphEdge["type"];
}

/** The assembled landscape graph (GR-5.1): domain `RegisteredApp` nodes + `GraphEdge`s. */
export interface LandscapeGraph {
  readonly nodes: readonly RegisteredApp[];
  readonly edges: readonly GraphEdge[];
}

/**
 * The narrow read ops {@link assembleGraph} drives (structurally satisfied by the
 * pooled {@link DownstreamArtifactRepository} + {@link RegisteredAppRepository}). Split
 * out so the node-membership + filter-assembly logic is unit-testable against an
 * in-memory fake that mirrors the exact repo semantics (the `active`-spec node predicate,
 * the incident/status/type edge filters).
 */
export interface GraphReadOps {
  /** GR-5.1/GR-5.4 — the node set: every app with ≥1 `active` `ApiSpec`. */
  listNodeApps(): Promise<RegisteredApp[]>;
  /** GR-5.1/GR-5.2 — the materialized edge set, optionally filtered. */
  listGraphEdges(filter: {
    readonly appId?: string;
    readonly status?: string;
    readonly type?: GraphEdge["type"];
  }): Promise<GraphEdge[]>;
}

/**
 * **The GR-5 read `GraphService`.** Serves the always-available landscape overview as
 * `{ nodes, edges }` **from the materialized projection** — never recomputed from
 * `ApprovedMapping`/`SyncRule`/`AdapterBinding` state (GR-5.1). Read-only and returned
 * **unpaginated** (GR-5.6, small-landscape scale). The route in front is viewer-readable
 * (GR-5.5 — both roles read the graph; there is no operator-only gate).
 */
export class GraphService {
  readonly #db: Database;

  public constructor(deps: { readonly db: Database }) {
    this.#db = deps.db;
  }

  public getGraph(filter: GraphFilter = {}): Promise<LandscapeGraph> {
    return assembleGraph(dbGraphReadOps(this.#db), filter);
  }
}

/** The real {@link GraphReadOps} over the pooled db / a handle. */
function dbGraphReadOps(handle: DbHandle): GraphReadOps {
  const artifacts = new DownstreamArtifactRepository(handle);
  const apps = new RegisteredAppRepository(handle);
  return {
    listNodeApps: () => apps.listGraphNodeApps(),
    listGraphEdges: (filter) => artifacts.listGraphEdges(filter),
  };
}

/**
 * **GR-5 core — assemble `{ nodes, edges }` from the projection.** Exported over an
 * injected {@link GraphReadOps} for unit-testability without a database.
 *
 * - **Nodes** are the `active`-spec member apps (GR-5.1/GR-5.4): consumer-only apps
 *   included, disabled apps included (rendering their paused/`backend-disabled` edges),
 *   deregistered apps excluded (their specs archived, their edges already removed).
 * - **Edges** are the materialized `GraphEdge`s carrying full `type`/`status`/`metadata`
 *   (GR-5.3), narrowed by the filter.
 * - **The `appId` filter is a focus (GR-5.2):** its edges are those incident to the app,
 *   and its nodes are that app (when a member) plus the member apps at the other end of
 *   those edges — a coherent neighbourhood subgraph. `status`/`type` narrow only the edge
 *   set; every member app stays a node (an app with no matching edge is still part of the
 *   landscape, and hiding it would misrepresent the landscape).
 */
export async function assembleGraph(
  ops: GraphReadOps,
  filter: GraphFilter = {},
): Promise<LandscapeGraph> {
  const edgeFilter = {
    ...(filter.appId !== undefined ? { appId: filter.appId } : {}),
    ...(filter.status !== undefined ? { status: filter.status } : {}),
    ...(filter.type !== undefined ? { type: filter.type } : {}),
  };
  const [allNodes, edges] = await Promise.all([ops.listNodeApps(), ops.listGraphEdges(edgeFilter)]);

  if (filter.appId === undefined) {
    return { nodes: allNodes, edges };
  }

  // App focus: keep the focused app (when a member) + the member endpoints of its edges.
  const memberById = new Map(allNodes.map((app) => [app.id, app]));
  const focusIds = new Set<string>();
  if (memberById.has(filter.appId)) {
    focusIds.add(filter.appId);
  }
  for (const edge of edges) {
    focusIds.add(edge.sourceNodeId);
    focusIds.add(edge.targetNodeId);
  }
  const nodes = allNodes.filter((app) => focusIds.has(app.id));
  return { nodes, edges };
}
