import { z } from "zod";

import {
  adapterBindingRoleSchema,
  adapterBindingStatusSchema,
  adapterEndpointStatusSchema,
  graphEdgeTypeSchema,
  syncRuleStatusSchema,
} from "./approved-mapping-enums.js";

/**
 * The **minimal, disabled** downstream artifacts Phase 3 instantiates from an
 * approved mapping (`docs/architecture/data-model.md` `SyncRule`,
 * `AdapterEndpoint`, `AdapterBinding`, `GraphEdge`, requirement AM-6). A single
 * `ApprovedMapping` instantiates **either** `SyncRule`(s) **or**
 * `AdapterBinding`(s), never both (`Modeling notes`: mutually exclusive
 * outcomes) — that exclusivity is a construction-time invariant of the parent
 * mapping's `variant`, not a within-entity constraint, so it is not re-encoded on
 * these leaf shapes.
 *
 * Only the fields AM-6 lists are modeled. All execution fields (poll cursor,
 * snapshot, backfill, delete propagation, drift check, intervals — Phase 4) and
 * all composition fields (aggregation strategy specifics, post-merge
 * filters/sorts/pagination, execution order, chaining, cache TTL — Phase 5) are
 * explicitly out of scope of these shapes.
 */

// ── SyncRule (peer-peer outcome) ─────────────────────────────────────────────

/**
 * One `SyncRule` per mapped resource pair of a peer-peer `ApprovedMapping`,
 * persisted **disabled**. `resourcePairRef` is the canonical, direction-agnostic
 * form of the mapped resource pair (the two sides ordered by a stable key, never
 * by this rule's direction), so both directions of a pair name the same links and
 * field state.
 */
export const syncRuleSchema = z.object({
  id: z.string(),
  approvedMappingId: z.string(),
  resourcePairRef: z.string(),
  status: syncRuleStatusSchema,
});
export type SyncRule = z.infer<typeof syncRuleSchema>;

// ── AdapterEndpoint / AdapterBinding (consumer-provider outcome) ──────────────

/**
 * One `AdapterEndpoint` per `CONSUMER`-spec operation that has at least one
 * approved binding. Created when the first mapping covering that operation is
 * approved, then updated (never duplicated) as further mappings attach bindings.
 */
export const adapterEndpointSchema = z.object({
  id: z.string(),
  consumerAppId: z.string(),
  consumerOperationId: z.string(),
  status: adapterEndpointStatusSchema,
});
export type AdapterEndpoint = z.infer<typeof adapterEndpointSchema>;

/**
 * A binding from an `AdapterEndpoint` to a specific backend app + operation +
 * `ApprovedMapping`. `backendOperationId` is chosen from the approved
 * `OperationMapping`s of `approvedMappingId`, not free-form. A freshly-attached
 * binding is persisted `proposed` (AM-6 criterion 2), pending composition.
 */
export const adapterBindingSchema = z.object({
  id: z.string(),
  adapterEndpointId: z.string(),
  backendAppId: z.string(),
  backendOperationId: z.string(),
  approvedMappingId: z.string(),
  role: adapterBindingRoleSchema,
  status: adapterBindingStatusSchema,
});
export type AdapterBinding = z.infer<typeof adapterBindingSchema>;

// ── GraphEdge (materialized projection) ──────────────────────────────────────

/**
 * The `metadata` of a `GraphEdge`: the aggregated mappings' shared
 * `sourceSpecId → targetSpecId` `direction`, plus the projection's
 * `lastActivityAt` (`docs/architecture/data-model.md` `GraphEdge`: "last activity
 * timestamp, direction"). `lastActivityAt` is nullable: an edge upserted on
 * approval — before its rules/bindings ever execute — has had no activity yet.
 */
export const graphEdgeMetadataSchema = z.object({
  direction: z.object({
    sourceSpecId: z.string(),
    targetSpecId: z.string(),
  }),
  lastActivityAt: z.date().nullable(),
});
export type GraphEdgeMetadata = z.infer<typeof graphEdgeMetadataSchema>;

/**
 * A materialized projection of one mapping/sync/adapter-dependency relationship,
 * upserted on approval — derived from `ApprovedMapping` + `SyncRule`/
 * `AdapterBinding` state, not a source of truth (`Modeling notes`).
 *
 * `status` is modeled as a plain string: unlike the artifact statuses above, the
 * concept does **not** enumerate the value set of `GraphEdge.status` (it is a
 * projection of the underlying rule/binding state), so no fixed enum is coined
 * for it here.
 */
export const graphEdgeSchema = z.object({
  id: z.string(),
  sourceNodeId: z.string(),
  targetNodeId: z.string(),
  type: graphEdgeTypeSchema,
  status: z.string(),
  metadata: graphEdgeMetadataSchema,
});
export type GraphEdge = z.infer<typeof graphEdgeSchema>;
