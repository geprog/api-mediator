import { z } from "zod";

/**
 * Canonical domain enumerations for the Phase 3 approved-mapping slice.
 *
 * Same triple-derivation pattern as `enums.ts` / `mapping-enums.ts` (a single
 * tuple of literals yields the Zod validator, the string-union type, and the
 * `as const`-style value object):
 *
 * ```ts
 * export const fooSchema = z.enum(["a", "b"]);   // runtime validator
 * export type Foo = z.infer<typeof fooSchema>;   // "a" | "b"
 * export const Foo = fooSchema.enum;             // { a: "a"; b: "b" }
 * ```
 *
 * Literal spellings are taken **verbatim** from `docs/architecture/data-model.md`
 * and `docs/glossary.md` and must not be renamed. This is the single naming
 * authority, so each enum lists **every** value its column can hold — including
 * values only a later phase ever writes — exactly as `mapping-enums.ts` does for
 * `MappingProposalStatus` (see the Phase-3 requirement AM-1).
 *
 * The Phase-2 enums (`MappingVariant`, `TransformKind`, `MappingPhase`,
 * `ReviewState`, `MappingProposalStatus`) are reused unchanged from
 * `mapping-enums.ts` — no synonym is coined here for an existing term.
 */

// ── OperationMapping.action (AM-1) ───────────────────────────────────────────

/**
 * The CRUD classification on an `OperationMapping` — the verbatim four-value
 * vocabulary of `docs/architecture/data-model.md` `OperationMapping.action` and
 * `docs/glossary.md` `action`. There is deliberately **no** `list` member: the
 * concept's four-value enum is authoritative; a collection read is `read`.
 */
export const operationActionSchema = z.enum(["create", "read", "update", "delete"]);
export type OperationAction = z.infer<typeof operationActionSchema>;
export const OperationAction = operationActionSchema.enum;

// ── ApprovedMapping.status (AM-1) ────────────────────────────────────────────

/**
 * The `ApprovedMapping` lifecycle status (`docs/architecture/data-model.md`
 * `ApprovedMapping.status`). Phase 3 only ever *creates* rows — always at
 * `active`, with non-execution expressed by the disabled downstream *artifacts*
 * rather than a mapping status — but the single naming authority owns every value
 * the column can hold: `suspended` is a manual operator hold (Phase 4/5), `stale`
 * the breaking-change outcome, `superseded` the successor-adoption outcome, and
 * `archived` the app-deregistration outcome (all Phase 6).
 */
export const approvedMappingStatusSchema = z.enum([
  "active",
  "suspended",
  "stale",
  "superseded",
  "archived",
]);
export type ApprovedMappingStatus = z.infer<typeof approvedMappingStatusSchema>;
export const ApprovedMappingStatus = approvedMappingStatusSchema.enum;

// ── FieldMapping.conflictPolicy (AM-3) ───────────────────────────────────────

/**
 * The optional `conflictPolicy` override on a `FieldMapping`
 * (`docs/architecture/data-model.md` `FieldMapping.conflictPolicy`). A single
 * value today (`manual-resolve`); modeled as an enum so further policies can be
 * added without churn. Meaningful only on peer-peer (sync-driving) rows; *setting*
 * it is a Phase-4 concern, so Phase 3 always leaves it absent.
 */
export const conflictPolicySchema = z.enum(["manual-resolve"]);
export type ConflictPolicy = z.infer<typeof conflictPolicySchema>;
export const ConflictPolicy = conflictPolicySchema.enum;

// ── SyncRule.status (AM-6) ───────────────────────────────────────────────────

/**
 * The `SyncRule` enablement status (`docs/architecture/data-model.md`
 * `SyncRule.status`). Phase 3 instantiates every rule `disabled`; enabling is
 * Phase 4.
 */
export const syncRuleStatusSchema = z.enum(["enabled", "disabled"]);
export type SyncRuleStatus = z.infer<typeof syncRuleStatusSchema>;
export const SyncRuleStatus = syncRuleStatusSchema.enum;

// ── AdapterEndpoint.status (AM-6) ────────────────────────────────────────────

/**
 * The `AdapterEndpoint` status (`docs/architecture/data-model.md`
 * `AdapterEndpoint.status`). `composition-required` is set when a newly approved
 * mapping attaches a second candidate binding and a human must choose the
 * aggregation strategy (Phase 5); `disabled` is an explicit operator switch-off.
 * The full set is owned here even though Phase 3 only creates endpoints.
 */
export const adapterEndpointStatusSchema = z.enum(["active", "composition-required", "disabled"]);
export type AdapterEndpointStatus = z.infer<typeof adapterEndpointStatusSchema>;
export const AdapterEndpointStatus = adapterEndpointStatusSchema.enum;

// ── AdapterBinding.role (AM-6) ───────────────────────────────────────────────

/**
 * Which role an `AdapterBinding` plays within its endpoint's aggregation
 * (`docs/architecture/data-model.md` `AdapterBinding.role`). Which roles are
 * *meaningful* depends on the endpoint's `aggregationStrategy` (Phase 5); the
 * enum owns all three values regardless.
 */
export const adapterBindingRoleSchema = z.enum(["primary", "fallback", "supplement"]);
export type AdapterBindingRole = z.infer<typeof adapterBindingRoleSchema>;
export const AdapterBindingRole = adapterBindingRoleSchema.enum;

// ── AdapterBinding.status (AM-6) ─────────────────────────────────────────────

/**
 * The `AdapterBinding` status (`docs/architecture/data-model.md`
 * `AdapterBinding.status`). A freshly-attached binding is persisted `proposed`
 * (Phase 3), composed into `active` at composition, or taken out of service
 * `disabled` — both Phase 5.
 */
export const adapterBindingStatusSchema = z.enum(["active", "proposed", "disabled"]);
export type AdapterBindingStatus = z.infer<typeof adapterBindingStatusSchema>;
export const AdapterBindingStatus = adapterBindingStatusSchema.enum;

// ── GraphEdge.type (AM-6) ────────────────────────────────────────────────────

/**
 * The kind of relationship a `GraphEdge` projects (`docs/architecture/data-model.md`
 * `GraphEdge.type`): a `sync` edge aggregates a direction's `SyncRule`s, an
 * `adapter-dependency` edge a consumer-backend pair's `AdapterBinding`s.
 */
export const graphEdgeTypeSchema = z.enum(["sync", "adapter-dependency"]);
export type GraphEdgeType = z.infer<typeof graphEdgeTypeSchema>;
export const GraphEdgeType = graphEdgeTypeSchema.enum;
