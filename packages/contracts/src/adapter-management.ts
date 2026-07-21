import {
  adapterBindingRoleSchema,
  adapterBindingStatusSchema,
  adapterEndpointStatusSchema,
  adapterRequestCauseSchema,
  aggregationStrategySchema,
  auditLogStatusSchema,
  endpointStrictnessSchema,
  postMergeDedupSchema,
  postMergeFilterSchema,
  postMergePaginationConventionValueSchema,
  postMergeSortSchema,
} from "@mediator/domain";
import { z } from "zod";

import { isoDateTimeSchema } from "./common.js";

/**
 * Operator-API **read** DTOs for adapter state, request history, and endpoint health
 * (Phase-5 AP-1 / AP-5). Every schema here is metadata only — ids, enum values,
 * statuses, counts, timestamps, and derived health causes. **No** credential material,
 * **no** adapter token, and **no** live request/response payload value appears in any of
 * them (AP-1.5 / AP-5.4, `docs/architecture/security.md` *Audit logging*): the schemas
 * cannot express those fields and the backend mappers never populate them.
 */

// ── Per-binding derived health (AP-1.4 / AP-5.3) ─────────────────────────────

/**
 * The health condition eliminating (or degrading) a binding at request time — exactly
 * the RP-3 planner causes, **derived at read time** from the binding's `ApprovedMapping`
 * status and its backend app status, never stored per binding
 * (`docs/architecture/observability.md` *Alerting*). `mapping-stale` also covers the
 * `superseded`/`archived` mapping statuses, mirroring the planner's own judgment call.
 */
export const adapterBindingHealthCauseSchema = z.enum([
  "mapping-stale",
  "mapping-suspended",
  "backend-disabled",
]);
export type AdapterBindingHealthCause = z.infer<typeof adapterBindingHealthCauseSchema>;

/** One binding's read-time health verdict: healthy, or eliminated by a named cause (AP-1.4). */
export const adapterBindingHealthDtoSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true) }),
  z.object({ ok: z.literal(false), cause: adapterBindingHealthCauseSchema }),
]);
export type AdapterBindingHealthDto = z.infer<typeof adapterBindingHealthDtoSchema>;

// ── AP-1: adapter state ──────────────────────────────────────────────────────

/**
 * One `AdapterBinding` as read state (AP-1.1): backend app/operation, `role`, `status`,
 * `executionOrder`, `dependsOnBindingId`, and the read-time derived `health` (AP-1.4).
 */
export const adapterBindingStateDtoSchema = z.object({
  id: z.string(),
  backendAppId: z.string(),
  backendOperationId: z.string(),
  role: adapterBindingRoleSchema,
  status: adapterBindingStatusSchema,
  executionOrder: z.number().int().optional(),
  dependsOnBindingId: z.string().optional(),
  health: adapterBindingHealthDtoSchema,
});
export type AdapterBindingStateDto = z.infer<typeof adapterBindingStateDtoSchema>;

/**
 * The persisted `collection-union` post-merge configuration, projected for reads (AP-1.1
 * "its union configuration where applicable"). Present only for a `collection-union`
 * endpoint that has been composed; `pagination` carries the convention plus whether it
 * has been operator-confirmed (CO-3.5), never a `confirmedBy` identity.
 */
export const adapterUnionConfigDtoSchema = z.object({
  dedup: postMergeDedupSchema.nullable(),
  filters: z.array(postMergeFilterSchema),
  sorts: z.array(postMergeSortSchema),
  pagination: z
    .object({
      convention: postMergePaginationConventionValueSchema,
      confirmed: z.boolean(),
    })
    .nullable(),
});
export type AdapterUnionConfigDto = z.infer<typeof adapterUnionConfigDtoSchema>;

/**
 * Why an endpoint is `composition-required` (AP-1.2): which binding(s) are still
 * `proposed` and awaiting a composition decision, and whether a previous configuration
 * is **still serving** (the endpoint has `active` bindings from an earlier composition).
 *
 * The concept asks for "since when", but the `AdapterEndpoint`/`AdapterBinding` entities
 * carry no `createdAt`/`proposedAt` column and no migration is in scope for this slice —
 * so a proposed-since timestamp is not persisted and is therefore not surfaced here. The
 * structural "why" (which bindings, whether the old config still serves) is.
 */
export const adapterCompositionRequiredReasonDtoSchema = z.object({
  proposedBindingIds: z.array(z.string()),
  previousConfigurationServing: z.boolean(),
});
export type AdapterCompositionRequiredReasonDto = z.infer<
  typeof adapterCompositionRequiredReasonDtoSchema
>;

/** One `AdapterEndpoint` with its composition state and bindings (AP-1.1 / AP-1.2). */
export const adapterEndpointStateDtoSchema = z.object({
  id: z.string(),
  consumerAppId: z.string(),
  consumerOperationId: z.string(),
  status: adapterEndpointStatusSchema,
  aggregationStrategy: aggregationStrategySchema.nullable(),
  strictness: endpointStrictnessSchema.nullable(),
  cacheTtl: z.number().int().nullable(),
  union: adapterUnionConfigDtoSchema.nullable(),
  bindings: z.array(adapterBindingStateDtoSchema),
  /** Present only when `status === "composition-required"` (AP-1.2); `null` otherwise. */
  compositionRequired: adapterCompositionRequiredReasonDtoSchema.nullable(),
});
export type AdapterEndpointStateDto = z.infer<typeof adapterEndpointStateDtoSchema>;

/**
 * A consumer operation with **no** `AdapterEndpoint`, or an endpoint with **no** `active`
 * binding — the consumer's unmet needs, enumerated from the CONSUMER specs rather than
 * only from endpoints that exist (AP-1.3).
 */
export const notYetMappedConsumerOperationDtoSchema = z.object({
  consumerAppId: z.string(),
  consumerOperationId: z.string(),
  reason: z.enum(["no-endpoint", "no-active-binding"]),
});
export type NotYetMappedConsumerOperationDto = z.infer<
  typeof notYetMappedConsumerOperationDtoSchema
>;

/** `GET /api/adapter-endpoints` response (AP-1): every endpoint + the not-yet-mapped needs. */
export const adapterStateResponseSchema = z.object({
  endpoints: z.array(adapterEndpointStateDtoSchema),
  notYetMapped: z.array(notYetMappedConsumerOperationDtoSchema),
});
export type AdapterStateResponse = z.infer<typeof adapterStateResponseSchema>;

/** `GET /api/adapter-endpoints/:id` response (AP-1): one endpoint's read state. */
export const adapterEndpointStateResponseSchema = z.object({
  endpoint: adapterEndpointStateDtoSchema,
});
export type AdapterEndpointStateResponse = z.infer<typeof adapterEndpointStateResponseSchema>;

// ── AP-5: request history ────────────────────────────────────────────────────

/**
 * `GET /api/adapter-requests` query (AP-5.1): the `adapter-request` audit log filtered by
 * endpoint, binding, and/or a `[since, until]` time window, plus an optional `status` /
 * `cause`. `limit` bounds the scan so history is never unbounded. Query values arrive as
 * strings, so `since`/`until`/`limit` are coerced.
 */
export const adapterRequestHistoryQuerySchema = z.object({
  endpointId: z.uuid().optional(),
  bindingId: z.uuid().optional(),
  since: z.coerce.date().optional(),
  until: z.coerce.date().optional(),
  status: auditLogStatusSchema.optional(),
  cause: adapterRequestCauseSchema.optional(),
  limit: z.coerce.number().int().positive().max(500).optional(),
});
export type AdapterRequestHistoryQuery = z.infer<typeof adapterRequestHistoryQuerySchema>;

/**
 * The read-time outcome discriminator (AP-5.2): a clean `success`, a `degraded` success
 * (a served result that dropped a failed `supplement`'s optional fields), a `failure`, or
 * `other` for an `adapter-request` row that is an operator action (compose/enable/disable)
 * rather than a served request and so carries no execution `status`.
 */
export const adapterRequestOutcomeSchema = z.enum(["success", "degraded", "failure", "other"]);
export type AdapterRequestOutcome = z.infer<typeof adapterRequestOutcomeSchema>;

/**
 * One `adapter-request` audit row on the wire (AP-5.1) — **metadata only** (AP-5.4): the
 * outcome (`status` + the derived `outcome`), the `cause`, `degraded`, the endpoint/binding
 * ids, actor, a short `details` note, and `traceId`/`spanId` for trace correlation. Never a
 * payload value, never a token, never credential material.
 */
export const adapterRequestDtoSchema = z.object({
  id: z.string(),
  outcome: adapterRequestOutcomeSchema,
  status: auditLogStatusSchema.nullable(),
  cause: adapterRequestCauseSchema.nullable(),
  degraded: z.boolean(),
  relatedEndpointId: z.string().nullable(),
  relatedBindingId: z.string().nullable(),
  actor: z.string(),
  details: z.string().nullable(),
  traceId: z.string().nullable(),
  spanId: z.string().nullable(),
  timestamp: isoDateTimeSchema,
});
export type AdapterRequestDto = z.infer<typeof adapterRequestDtoSchema>;

/** `GET /api/adapter-requests` response (AP-5.1). */
export const adapterRequestHistoryResponseSchema = z.object({
  requests: z.array(adapterRequestDtoSchema),
});
export type AdapterRequestHistoryResponse = z.infer<typeof adapterRequestHistoryResponseSchema>;

// ── AP-5: endpoint health ────────────────────────────────────────────────────

/** One endpoint sitting in `composition-required` — an operator-actionable backlog item (AP-5.3). */
export const adapterHealthCompositionRequiredDtoSchema = z.object({
  endpointId: z.string(),
  consumerAppId: z.string(),
  consumerOperationId: z.string(),
  proposedBindingIds: z.array(z.string()),
  previousConfigurationServing: z.boolean(),
});
export type AdapterHealthCompositionRequiredDto = z.infer<
  typeof adapterHealthCompositionRequiredDtoSchema
>;

/**
 * One `active` binding eliminated at read time by an unhealthy mapping/backend (AP-5.3) —
 * the concept alerts specifically on a `mapping-stale` binding (at a tighter threshold than
 * sync staleness); `mapping-suspended`/`backend-disabled` are surfaced alongside it as the
 * same operator-actionable class, each with its derived `cause`.
 */
export const adapterHealthUnhealthyBindingDtoSchema = z.object({
  endpointId: z.string(),
  bindingId: z.string(),
  backendAppId: z.string(),
  cause: adapterBindingHealthCauseSchema,
});
export type AdapterHealthUnhealthyBindingDto = z.infer<
  typeof adapterHealthUnhealthyBindingDtoSchema
>;

/**
 * `GET /api/adapter-requests/health` response (AP-5.3): the operator-actionable conditions
 * the concept alerts on — endpoints in `composition-required`, `active` bindings whose
 * mapping is `stale` (or otherwise unhealthy), and recent `mediator-transform-error`
 * occurrences (an aggregated response that failed consumer-schema validation — a
 * mapping/composition defect, not backend trouble).
 */
export const adapterHealthResponseSchema = z.object({
  compositionRequired: z.array(adapterHealthCompositionRequiredDtoSchema),
  unhealthyBindings: z.array(adapterHealthUnhealthyBindingDtoSchema),
  transformErrors: z.array(adapterRequestDtoSchema),
});
export type AdapterHealthResponse = z.infer<typeof adapterHealthResponseSchema>;
