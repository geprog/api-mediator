/**
 * The materialized landscape-graph projection (Phase 6). This slice ships the
 * **incremental reactor** (GR-2 sync edges + GR-3 adapter-dependency edges) that
 * keeps `GraphEdge`s current as rules/bindings change; the read `GraphService`
 * (GR-5) and the Vue Flow UI (GR-6) land in later slices.
 */
export {
  GraphProjection,
  projectAdapterEdge,
  projectSyncEdge,
  type GraphProjectionOps,
} from "./projection.js";
export {
  GraphEdgeStatus,
  adapterBindingMemberState,
  deriveEdgeStatus,
  syncRuleMemberState,
  type EdgeMemberState,
} from "./status.js";
