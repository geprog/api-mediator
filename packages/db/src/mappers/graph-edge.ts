import type { GraphEdge } from "@mediator/domain";

import { graphEdge } from "../schema.js";

/** A selected `graph_edge` row, with Drizzle's inferred column types. */
export type GraphEdgeRow = typeof graphEdge.$inferSelect;
/** The insert shape Drizzle expects for `graph_edge`. */
export type GraphEdgeInsert = typeof graphEdge.$inferInsert;

/**
 * Row → domain. `metadata` is stored as a single jsonb column; its `lastActivityAt`
 * is a `Date | null` in the domain shape but survives a jsonb round-trip as an ISO
 * **string** (jsonb has no `Date`), so it is reconstructed to a `Date` here — the
 * same "never trust a jsonb `Date`" discipline the schema applies by keeping real
 * timestamps in `timestamptz` columns elsewhere. Phase 3 always writes `null`, so
 * this coercion only matters once a later phase records activity.
 */
export function mapGraphEdgeRow(row: GraphEdgeRow): GraphEdge {
  const { direction, lastActivityAt } = row.metadata;
  return {
    id: row.id,
    sourceNodeId: row.sourceNodeId,
    targetNodeId: row.targetNodeId,
    type: row.type,
    status: row.status,
    metadata: {
      direction: {
        sourceSpecId: direction.sourceSpecId,
        targetSpecId: direction.targetSpecId,
      },
      lastActivityAt: lastActivityAt === null ? null : new Date(lastActivityAt),
    },
  };
}

/** Domain → insert. `metadata` is written verbatim (jsonb serializes the object). */
export function toGraphEdgeInsert(edge: GraphEdge): GraphEdgeInsert {
  return {
    id: edge.id,
    sourceNodeId: edge.sourceNodeId,
    targetNodeId: edge.targetNodeId,
    type: edge.type,
    status: edge.status,
    metadata: edge.metadata,
  };
}
