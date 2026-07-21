import { z } from "zod";

import {
  chainInputSchema,
  postMergeDedupSchema,
  postMergeFilterSchema,
  postMergePaginationSchema,
  postMergeSortSchema,
} from "./adapter-composition.js";
import { aggregationStrategySchema, endpointStrictnessSchema } from "./adapter-enums.js";
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
 * `SyncRule` now carries its Phase-4 execution fields (SD-1), and
 * `AdapterEndpoint`/`AdapterBinding` their Phase-5 composition/serving fields
 * (AD-1/AD-2). In all three cases **every added field is `.optional()`**, for the
 * same reason: a Phase-3-instantiated row carries only the minimal AM-6 columns,
 * and it must keep loading with every later-phase field **absent**.
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
 *
 * The four AM-6 fields (`id`, `consumerAppId`, `consumerOperationId`, `status`)
 * and the `adapterEndpointStatus` enum are reused **unchanged**; AD-1 adds the
 * composition/serving state the Request Router, Resolution Planner, Response
 * Aggregator, and response cache read at request time. **Every added field is
 * `.optional()`**, so a Phase-3-instantiated `composition-required` endpoint —
 * which was composed with nothing — still validates with all of them absent
 * (AD-1.6). Two consequences of that, both deliberate:
 *
 * - **No `.default()` anywhere**, not even for the concept's documented defaults
 *   (`single` + non-strict + no caching for an auto-activated single-binding
 *   endpoint). A Zod default makes the inferred field non-optional and would make
 *   an *uncomposed* endpoint read back as if a human had composed it. Those
 *   defaults are applied by the auto-activation slice (CO-1), not by this type —
 *   the same discipline SD-1 used for `deletePropagation`/`targetDriftCheck`.
 * - **`cacheTtl` absent means no caching**, which is also the documented default
 *   ("no caching until composed otherwise"). It is therefore modeled `.optional()`
 *   rather than `.nullable().optional()`: "not composed" and "composed to no
 *   caching" have identical serving semantics, so a second null-ish state would
 *   be a distinction the runtime could not act on.
 *
 * The `postMerge*` fields are **`collection-union` only** (AD-1.3) and the
 * refinement below makes them unrepresentable on any other strategy — and on an
 * endpoint with no strategy at all, since union configuration without a union is
 * not a state the composer can produce.
 */
export const adapterEndpointSchema = z
  .object({
    id: z.string(),
    consumerAppId: z.string(),
    consumerOperationId: z.string(),
    status: adapterEndpointStatusSchema,
    // ── AD-1 composition / serving fields (all optional; see the note above) ──
    /** How this endpoint combines its bindings' results. */
    aggregationStrategy: aggregationStrategySchema.optional(),
    /**
     * Response-cache lifetime in **milliseconds** (the unit `RegisteredApp`
     * capabilities and `SyncRule.pollIntervalOverride` already use). Absent = no
     * caching, the documented default.
     */
    cacheTtl: z.number().int().positive().optional(),
    /** The partial-failure mode; a decision at composition, never inferred (CO-4.3). */
    strictness: endpointStrictnessSchema.optional(),
    /** `collection-union` only — post-merge semantics per non-pushdown filter parameter. */
    postMergeFilters: z.array(postMergeFilterSchema).optional(),
    /** `collection-union` only — post-merge semantics per accepted sort parameter value. */
    postMergeSorts: z.array(postMergeSortSchema).optional(),
    /** `collection-union` only — the pagination convention, derived then confirmed. */
    postMergePagination: postMergePaginationSchema.optional(),
    /** `collection-union` only — how duplicate rows are collapsed. */
    postMergeDedup: postMergeDedupSchema.optional(),
  })
  .superRefine((endpoint, ctx) => {
    const unionOnly = [
      ["postMergeFilters", endpoint.postMergeFilters],
      ["postMergeSorts", endpoint.postMergeSorts],
      ["postMergePagination", endpoint.postMergePagination],
      ["postMergeDedup", endpoint.postMergeDedup],
    ] as const;
    if (endpoint.aggregationStrategy === "collection-union") {
      return;
    }
    for (const [field, value] of unionOnly) {
      if (value !== undefined) {
        ctx.addIssue({
          code: "custom",
          message: `${field} is collection-union only — absent on a ${
            endpoint.aggregationStrategy ?? "not-yet-composed"
          } AdapterEndpoint`,
          path: [field],
        });
      }
    }
  });
export type AdapterEndpoint = z.infer<typeof adapterEndpointSchema>;

/**
 * A binding from an `AdapterEndpoint` to a specific backend app + operation +
 * `ApprovedMapping`. `backendOperationId` is chosen from the approved
 * `OperationMapping`s of `approvedMappingId`, not free-form. A freshly-attached
 * binding is persisted `proposed` (AM-6 criterion 2), pending composition.
 *
 * AD-2 adds the **execution/chaining** state that decides parallel-vs-sequential
 * execution at request time. Like the endpoint's composition fields, all three are
 * `.optional()`, so a Phase-3-attached `proposed` binding loads with
 * `dependsOnBindingId`/`chainInputs` absent and no `executionOrder` — attachment
 * composes nothing (AD-2.5). {@link resolveExecutionOrder} is what turns an absent
 * `executionOrder` into the documented default of `0`, rather than a `.default()`
 * that would fabricate a present value on an uncomposed row (AD-6.2).
 *
 * Chain wiring lives **here**, not under the mapping's `OperationMapping`s
 * (AD-2.4): it is serving composition state, so successor adoption carries it over
 * mechanically when the underlying mapping is superseded.
 */
export const adapterBindingSchema = z
  .object({
    id: z.string(),
    adapterEndpointId: z.string(),
    backendAppId: z.string(),
    backendOperationId: z.string(),
    approvedMappingId: z.string(),
    role: adapterBindingRoleSchema,
    status: adapterBindingStatusSchema,
    // ── AD-2 execution / chaining fields (all optional; see the note above) ──
    /**
     * Bindings sharing an `executionOrder` run in parallel. Absent = the
     * documented default `0` ({@link resolveExecutionOrder}). Which values are
     * *legal* is strategy-scoped (a tie is invalid under `fanout-first-success`)
     * and validated at composition (CO-2), not here.
     */
    executionOrder: z.number().int().optional(),
    /**
     * The binding of the **same** endpoint whose response this one consumes; it
     * runs only after that binding completes. The same-endpoint constraint is a
     * cross-row property, enforced by the schema's composite foreign key
     * (`packages/db/src/schema.ts`, AD-6.3), not by this shape.
     */
    dependsOnBindingId: z.string().optional(),
    /** How the upstream binding's consumer-shape response fills this binding's inputs. */
    chainInputs: z.array(chainInputSchema).optional(),
  })
  .superRefine((binding, ctx) => {
    // `chainInputs` is only meaningful with `dependsOnBindingId` (AD-2.3): inputs
    // fed from an upstream response are unrepresentable without an upstream.
    if (
      binding.chainInputs !== undefined &&
      binding.chainInputs.length > 0 &&
      binding.dependsOnBindingId === undefined
    ) {
      ctx.addIssue({
        code: "custom",
        message: "chainInputs requires dependsOnBindingId — there is no upstream response to read",
        path: ["chainInputs"],
      });
    }
    // "another binding of the same endpoint" (data-model.md) — a binding waiting
    // on itself is a deadlock, not a configuration.
    if (binding.dependsOnBindingId === binding.id) {
      ctx.addIssue({
        code: "custom",
        message: "dependsOnBindingId must reference another binding, never the binding itself",
        path: ["dependsOnBindingId"],
      });
    }
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
