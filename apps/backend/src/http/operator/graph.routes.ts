import { graphQuerySchema, graphResponseSchema, type GraphResponse } from "@mediator/contracts";
import type { FastifyInstance } from "fastify";

import type { GraphFilter, LandscapeGraph } from "../../modules/graph/index.js";
import { requireViewer } from "../auth/index.js";
import { toGraphEdgeDto, toRegisteredAppDto } from "../dto-mappers.js";
import { parseInput } from "../validation.js";

/**
 * The GR-5 read port the route drives, structurally satisfied by `GraphService`. Narrow
 * by design (the route owns no persistence), so the route test can drive it with an
 * in-memory double.
 */
export interface GraphReader {
  getGraph(filter: GraphFilter): Promise<LandscapeGraph>;
}

/**
 * The Phase-6 landscape graph read route (GR-5):
 *
 * - `GET /api/graph?appId=&status=&type=` — the whole landscape as `{ nodes, edges }`,
 *   assembled from the materialized projection (never recomputed), optionally filtered.
 *
 * **Viewer-readable** (GR-5.5): the graph is read-only for **both** roles, so this uses
 * {@link requireViewer} — deliberately **not** `requireOperator`, unlike every mutation
 * route. Returned **unpaginated** (GR-5.6, small-landscape scale). Each edge carries its
 * full `type`/`status`/`metadata`, so the UI needs no second call for edge detail
 * (GR-5.3). No response carries credential material or a payload value.
 */
export function registerGraphRoutes(app: FastifyInstance, graph: GraphReader): void {
  app.get("/api/graph", { preHandler: requireViewer }, async (request): Promise<GraphResponse> => {
    const query = parseInput(graphQuerySchema, request.query, "query parameters");
    const filter: GraphFilter = {
      ...(query.appId !== undefined ? { appId: query.appId } : {}),
      ...(query.status !== undefined ? { status: query.status } : {}),
      ...(query.type !== undefined ? { type: query.type } : {}),
    };
    const result = await graph.getGraph(filter);
    const response: GraphResponse = {
      nodes: result.nodes.map(toRegisteredAppDto),
      edges: result.edges.map(toGraphEdgeDto),
    };
    return graphResponseSchema.parse(response);
  });
}
