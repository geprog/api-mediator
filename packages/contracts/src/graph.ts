import { graphEdgeTypeSchema } from "@mediator/domain";
import { z } from "zod";

import { registeredAppDtoSchema } from "./apps.js";
import { isoDateTimeSchema } from "./common.js";

/**
 * DTOs for the Phase-6 landscape graph read API (GR-5): `GET /api/graph`, which returns
 * the always-available overview as `{ nodes, edges }` — nodes are `RegisteredApp`s, edges
 * are the materialized `GraphEdge`s. Read-only and **viewer-readable** (GR-5.5); returned
 * **unpaginated** (GR-5.6).
 *
 * The node DTO is the existing {@link registeredAppDtoSchema} verbatim (a graph node *is*
 * a `RegisteredApp`). The only boundary transforms are `Date` → ISO string
 * (`metadata.lastActivityAt`). No response carries credential material or a payload value.
 */

/** GR-5.2 — the optional `GET /api/graph` filter (app / status / connection type). */
export const graphQuerySchema = z.object({
  /** Focus on one node's neighbourhood (its incident edges + their endpoints). */
  appId: z.uuid().optional(),
  /** Restrict edges to one status (`GraphEdge.status` is a free-form projection value). */
  status: z.string().min(1).optional(),
  /** Restrict edges to one connection type. */
  type: graphEdgeTypeSchema.optional(),
});
export type GraphQuery = z.infer<typeof graphQuerySchema>;

/** The aggregated mappings' shared `sourceSpecId → targetSpecId` direction on an edge. */
export const graphEdgeDirectionDtoSchema = z.object({
  sourceSpecId: z.string(),
  targetSpecId: z.string(),
});
export type GraphEdgeDirectionDto = z.infer<typeof graphEdgeDirectionDtoSchema>;

/**
 * A `GraphEdge`'s `metadata` on the wire (GR-5.3): the aggregated `direction` and the
 * nullable `lastActivityAt` (an ISO string, or `null` for an edge whose rules/bindings
 * have never executed — GR-4.3). Per-resource-pair / per-operation detail lives here too
 * as the projection grows it; today the materialized `metadata` carries direction +
 * last-activity, so that is what is serialized (no second call is needed for edge detail).
 */
export const graphEdgeMetadataDtoSchema = z.object({
  direction: graphEdgeDirectionDtoSchema,
  lastActivityAt: isoDateTimeSchema.nullable(),
});
export type GraphEdgeMetadataDto = z.infer<typeof graphEdgeMetadataDtoSchema>;

/** One `GraphEdge` on the wire — `type`, `status`, and full `metadata` (GR-5.3). */
export const graphEdgeDtoSchema = z.object({
  id: z.string(),
  sourceNodeId: z.string(),
  targetNodeId: z.string(),
  type: graphEdgeTypeSchema,
  /** A free-form projection value (the concept does not enumerate `GraphEdge.status`). */
  status: z.string(),
  metadata: graphEdgeMetadataDtoSchema,
});
export type GraphEdgeDto = z.infer<typeof graphEdgeDtoSchema>;

/** `GET /api/graph` response (GR-5.1): the whole landscape as `{ nodes, edges }`. */
export const graphResponseSchema = z.object({
  nodes: z.array(registeredAppDtoSchema),
  edges: z.array(graphEdgeDtoSchema),
});
export type GraphResponse = z.infer<typeof graphResponseSchema>;
