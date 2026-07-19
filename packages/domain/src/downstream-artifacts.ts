import { z } from "zod";

import {
  adapterBindingRoleSchema,
  adapterBindingStatusSchema,
  adapterEndpointStatusSchema,
  graphEdgeTypeSchema,
  syncRuleStatusSchema,
} from "./approved-mapping-enums.js";
import {
  backfillModeSchema,
  backfillStatusSchema,
  deletePropagationSchema,
  pollScopeModeSchema,
  targetDriftCheckSchema,
} from "./sync-enums.js";

/**
 * The downstream artifacts Phase 3 instantiates from an approved mapping
 * (`docs/architecture/data-model.md` `SyncRule`, `AdapterEndpoint`,
 * `AdapterBinding`, `GraphEdge`, requirement AM-6). A single `ApprovedMapping`
 * instantiates **either** `SyncRule`(s) **or** `AdapterBinding`(s), never both
 * (`Modeling notes`: mutually exclusive outcomes) — that exclusivity is a
 * construction-time invariant of the parent mapping's `variant`, not a
 * within-entity constraint, so it is not re-encoded on these leaf shapes.
 *
 * `SyncRule` now carries its Phase-4 execution fields (SD-1); the
 * `AdapterEndpoint`/`AdapterBinding` composition fields (aggregation strategy
 * specifics, post-merge filters/sorts/pagination, execution order, chaining,
 * cache TTL — Phase 5) remain out of scope of these shapes.
 */

// ── SyncRule (peer-peer outcome) ─────────────────────────────────────────────

/**
 * One `SyncRule` per mapped resource pair of a peer-peer `ApprovedMapping`.
 * `resourcePairRef` is the canonical, direction-agnostic form of the mapped
 * resource pair (the two sides ordered by a stable key, never by this rule's
 * direction), so both directions of a pair name the same links and field state.
 * There is deliberately **no** `direction` field: the mapping it instantiates is
 * one-directional (`sourceSpecId`'s app → `targetSpecId`'s app), so the rule
 * inherits its direction from the parent `ApprovedMapping` (SD-1 criterion 4).
 *
 * The four AM-6 fields (`id`, `approvedMappingId`, `resourcePairRef`, `status`)
 * are reused **unchanged**; SD-1 adds the execution/policy fields the Poller,
 * backfill, and conflict pipeline need. **Every added field is `.optional()`** so
 * a Phase-3 minimal-shape rule (only the four fields, as AI-1 instantiates and the
 * db mapper reconstructs) still validates and typechecks against the extended
 * schema — a `disabled` rule carries no live execution state (SD-1 criterion 5;
 * AM-6 criterion 2). Two consequences of that backward-compatibility choice:
 *
 * - The concept's **defaults** (`deletePropagation = ignore`,
 *   `targetDriftCheck = none`, `backfillStatus = pending`) are **not** encoded as
 *   Zod `.default()`s here — a `.default()` makes the *inferred* field
 *   non-optional, which would break the existing minimal-row mapper that
 *   constructs a `SyncRule` from the four columns alone. The defaults are applied
 *   by the persistence/instantiation layer in a later slice (BE-*).
 * - The nullable live-state fields (`cursor`, `lastSnapshotRef`, `lastRunAt`,
 *   `lastEventAt`) are `.nullable().optional()`: **absent** on a fresh/disabled
 *   rule (and on the minimal Phase-3 row), and `null` once a later slice seeds
 *   them to an explicit "unset" at the transition to live polling.
 */
export const syncRuleSchema = z.object({
  id: z.string(),
  approvedMappingId: z.string(),
  resourcePairRef: z.string(),
  status: syncRuleStatusSchema,
  // ── SD-1 execution/policy fields (all optional for backward compatibility) ──
  /** Per-rule poll cadence override; falls back to `RegisteredApp.defaultPollInterval`. */
  pollIntervalOverride: z.number().optional(),
  /**
   * Which source operation the Poller calls — the resource's delta-query
   * operation when available, otherwise its confirmed collection read. Derived at
   * rule creation, correctable by the operator.
   */
  pollOperationRef: z.string().optional(),
  /** Whether a detected source-side deletion is propagated (concept default `ignore`). */
  deletePropagation: deletePropagationSchema.optional(),
  /** Opt-in read-before-write drift protection (concept default `none`). */
  targetDriftCheck: targetDriftCheckSchema.optional(),
  /** The one-time initial reconciliation mode. */
  backfillMode: backfillModeSchema.optional(),
  /**
   * SS-13 — the operator **override** of the derived poll-enumeration mode for a
   * scoped rule (`docs/requirements/scoped-resource-sync.md` SS-13.5). Absent (NULL
   * column) means "use the mode derived from `pollOperationRef` + the container
   * binding"; a set value pins the operator's correction. Meaningful only for a
   * scoped rule; a non-scoped rule leaves it absent and always polls cross-scope.
   */
  pollScopeMode: pollScopeModeSchema.optional(),
  /** The backfill lifecycle status (concept default `pending`). */
  backfillStatus: backfillStatusSchema.optional(),
  /** Last successful poll-run completion; nullable — unset until first live poll. */
  lastRunAt: z.date().nullable().optional(),
  /** Last processed sync event; nullable — unset until first live event. */
  lastEventAt: z.date().nullable().optional(),
  /** Delta-polling cursor; nullable — only meaningful for delta polling, seeded at go-live. */
  cursor: z.string().nullable().optional(),
  /** Reference to the last complete full-fetch content-hash snapshot; nullable — seeded at go-live. */
  lastSnapshotRef: z.string().nullable().optional(),
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
