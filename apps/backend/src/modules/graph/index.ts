/**
 * The materialized landscape-graph projection (Phase 6): the **incremental reactor**
 * (GR-2 sync edges + GR-3 adapter-dependency edges) that keeps `GraphEdge`s current as
 * rules/bindings change; the **activity updater** (GR-4) that stamps `lastActivityAt`
 * from the durable Audit/Event Log; and the read **`GraphService`** (GR-5) that assembles
 * `{ nodes, edges }` from the projection. The Vue Flow UI (GR-6) lands in a later slice.
 */
export {
  GraphProjection,
  projectAdapterEdge,
  projectSyncEdge,
  type GraphProjectionOps,
} from "./projection.js";
export {
  GraphActivity,
  advanceActivityForAuditEntry,
  advanceAdapterEdgeActivity,
  advanceSyncEdgeActivity,
  type GraphActivityOps,
} from "./activity.js";
export {
  GraphService,
  assembleGraph,
  type GraphFilter,
  type GraphReadOps,
  type LandscapeGraph,
} from "./read.js";
export {
  GraphEdgeStatus,
  adapterBindingMemberState,
  deriveEdgeStatus,
  syncRuleMemberState,
  type EdgeMemberState,
} from "./status.js";
