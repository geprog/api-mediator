import {
  acknowledgedIgnoredInputSchema,
  adapterBindingRoleSchema,
  adapterBindingStatusSchema,
  adapterEndpointStatusSchema,
  aggregationStrategySchema,
  chainInputSchema,
  endpointStrictnessSchema,
  postMergeDedupSchema,
  postMergeFilterSchema,
  postMergePaginationConventionValueSchema,
  postMergeSortSchema,
} from "@mediator/domain";
import { z } from "zod";

import { validationIssueSchema } from "./common.js";

/**
 * Operator-API request/response DTOs for **endpoint composition** (Phase-5 CO-2). The
 * composer resolves a `composition-required` `AdapterEndpoint` by choosing how its
 * multiple approved backends combine; the mediator validates the choice and, only if it
 * is activatable, atomically activates it (`docs/flows/adapter-endpoint-composition.md`
 * steps 4-6). No secret material appears here — the DTO carries ids, roles, enum values,
 * and composition config only.
 */

/**
 * One binding's composition choices (CO-2.1). `role` is constrained by the role-validity
 * table (CO-2.2), `executionOrder`/`dependsOnBindingId` by the strategy-scoped rules
 * (CO-2.3/2.4), and `chainInputs` — only meaningful with `dependsOnBindingId` — reuses
 * the domain {@link chainInputSchema}. The structural shape is validated here; every
 * cross-binding/semantic rule is the composition validator's (so rejections are named).
 */
export const composeBindingRequestSchema = z.object({
  bindingId: z.uuid(),
  role: adapterBindingRoleSchema,
  executionOrder: z.number().int().optional(),
  dependsOnBindingId: z.uuid().optional(),
  chainInputs: z.array(chainInputSchema).optional(),
});
export type ComposeBindingRequest = z.infer<typeof composeBindingRequestSchema>;

/**
 * A composition submission for a `composition-required` endpoint (CO-2.1 + CO-3): the
 * `aggregationStrategy`, strict-vs-degraded mode, `cacheTtl` (absent = no caching), one
 * entry per composable binding of the endpoint, and — for a `collection-union` — the
 * CO-3 `postMerge*` configuration. The union fields are rejected by validation on any
 * other strategy (they are unrepresentable off a union), so they stay optional here.
 */
export const composeAdapterEndpointRequestSchema = z.object({
  aggregationStrategy: aggregationStrategySchema,
  strictness: endpointStrictnessSchema,
  cacheTtl: z.number().int().positive().optional(),
  bindings: z.array(composeBindingRequestSchema).min(1),
  /**
   * The consumer inputs the composer explicitly acknowledges as ignored (CO-5.4). Each
   * must reference an **optional** consumer input that reaches no backend; a required one
   * is a blocking finding (CO-5.3). Absent = none — every unmapped input then rejects at
   * request validation (RP-2.4), the fail-loud default.
   */
  acknowledgedIgnoredInputs: z.array(acknowledgedIgnoredInputSchema).optional(),
  // ── CO-3 collection-union configuration ─────────────────────────────────────
  /** How duplicate rows collapse (none / record-link / dedup-key) — a union must choose (CO-3.1). */
  postMergeDedup: postMergeDedupSchema.optional(),
  /** Post-merge semantics per non-pushdown filter parameter (CO-3.4). */
  postMergeFilters: z.array(postMergeFilterSchema).optional(),
  /** Post-merge semantics per accepted sort parameter value (CO-3.5). */
  postMergeSorts: z.array(postMergeSortSchema).optional(),
  /**
   * The pagination **convention** the composer proposes (CO-3.5). Its confirmation is
   * stamped server-side to the authenticated operator via {@link confirmPostMergePagination}
   * — never a client-supplied `confirmedBy`, so an unconfirmed convention stays honest.
   */
  postMergePagination: postMergePaginationConventionValueSchema.optional(),
  /** Whether the composer confirms the proposed pagination convention (CO-3.5 derive-then-confirm). */
  confirmPostMergePagination: z.boolean().optional(),
});
export type ComposeAdapterEndpointRequest = z.infer<typeof composeAdapterEndpointRequestSchema>;

// ── compose-preview (CO-4 + CO-5 derive-then-confirm) ────────────────────────

/**
 * One binding's CO-4 verdict (`docs/architecture/adapter-engine.md` *Error and
 * partial-failure semantics*): a `primary` whose failure always fails the request, or a
 * `supplement` with the fields it supplies, whether they are all optional, and the
 * resulting load-bearing verdict.
 */
export const supplementAnalysisEntryDtoSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("primary-always-fails"),
    bindingId: z.string(),
    role: adapterBindingRoleSchema,
  }),
  z.object({
    kind: z.literal("supplement"),
    bindingId: z.string(),
    suppliedConsumerResponseFields: z.array(z.string()),
    allSuppliedFieldsOptional: z.boolean(),
    loadBearing: z.boolean(),
  }),
]);
export type SupplementAnalysisEntryDto = z.infer<typeof supplementAnalysisEntryDtoSchema>;

/** The CO-4 supplement analysis — `applicable` only for `fanout-merge`. */
export const supplementLoadBearingAnalysisDtoSchema = z.discriminatedUnion("applicable", [
  z.object({ applicable: z.literal(false), aggregationStrategy: aggregationStrategySchema }),
  z.object({ applicable: z.literal(true), entries: z.array(supplementAnalysisEntryDtoSchema) }),
]);
export type SupplementLoadBearingAnalysisDto = z.infer<
  typeof supplementLoadBearingAnalysisDtoSchema
>;

/** One consumer input reaching no backend (CO-5.1 endpoint-level). */
export const unmappedConsumerInputDtoSchema = z.object({
  kind: z.enum(["parameter", "body-field"]),
  name: z.string(),
  required: z.boolean(),
});
export type UnmappedConsumerInputDto = z.infer<typeof unmappedConsumerInputDtoSchema>;

/** One binding's unmapped consumer inputs (CO-5.1 per-binding). */
export const bindingInputCoverageDtoSchema = z.object({
  bindingId: z.string(),
  unmappedParameters: z.array(z.string()),
  unmappedBodyFields: z.array(z.string()),
});
export type BindingInputCoverageDto = z.infer<typeof bindingInputCoverageDtoSchema>;

/** The CO-5 consumer-input coverage report. */
export const consumerInputCoverageDtoSchema = z.object({
  perBinding: z.array(bindingInputCoverageDtoSchema),
  unmappedByAllBackends: z.array(unmappedConsumerInputDtoSchema),
});
export type ConsumerInputCoverageDto = z.infer<typeof consumerInputCoverageDtoSchema>;

/** Whether the previewed composition would activate, with the blocking findings if not. */
export const compositionValidationDtoSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true) }),
  z.object({ ok: z.literal(false), issues: z.array(validationIssueSchema) }),
]);
export type CompositionValidationDto = z.infer<typeof compositionValidationDtoSchema>;

/**
 * The CO-3 union derivations the composer confirms before activating (present only for a
 * proposed `collection-union`): filters that would be unserviceable (CO-3.4), sort /
 * pagination parameters still needing a decision (CO-3.5), the dedup conflict-precedence
 * rule (CO-3.3), and the large-collection size flag naming `cacheTtl` as the mitigation
 * (CO-3.8). None of it is applied — the composer must confirm.
 */
export const unionCompositionAnalysisDtoSchema = z.object({
  unserviceableFilters: z.array(z.string()),
  unconfiguredSortParameters: z.array(z.string()),
  unconfiguredPaginationParameters: z.array(z.string()),
  dedupConflictPrecedence: z.literal("executionOrder-then-bindingId"),
  largeCollectionRisk: z.object({
    flagged: z.literal(true),
    mitigation: z.literal("cacheTtl"),
    cacheTtlConfigured: z.boolean(),
  }),
});
export type UnionCompositionAnalysisDto = z.infer<typeof unionCompositionAnalysisDtoSchema>;

/**
 * The compose-preview response (CO-3 + CO-4 + CO-5). A **derivation** the composer reviews
 * before confirming — nothing is activated or persisted (derive-then-confirm): the
 * load-bearing supplement analysis, the consumer-input coverage report, the union
 * derivations (union proposals only), and whether the proposed composition would validate.
 */
export const composeAdapterEndpointPreviewResponseSchema = z.object({
  endpointId: z.string(),
  supplementAnalysis: supplementLoadBearingAnalysisDtoSchema,
  coverage: consumerInputCoverageDtoSchema,
  validation: compositionValidationDtoSchema,
  /** CO-3 — present only for a proposed `collection-union`. */
  union: unionCompositionAnalysisDtoSchema.optional(),
});
export type ComposeAdapterEndpointPreviewResponse = z.infer<
  typeof composeAdapterEndpointPreviewResponseSchema
>;

/** One binding in the composed-endpoint response — the activated serving configuration. */
export const composedBindingDtoSchema = z.object({
  id: z.string(),
  backendAppId: z.string(),
  backendOperationId: z.string(),
  role: adapterBindingRoleSchema,
  status: adapterBindingStatusSchema,
  executionOrder: z.number().int().optional(),
  dependsOnBindingId: z.string().optional(),
  chainInputs: z.array(chainInputSchema).optional(),
});
export type ComposedBindingDto = z.infer<typeof composedBindingDtoSchema>;

/** The composed endpoint's activated serving state (CO-2.8). */
export const composedEndpointDtoSchema = z.object({
  id: z.string(),
  consumerAppId: z.string(),
  consumerOperationId: z.string(),
  status: adapterEndpointStatusSchema,
  aggregationStrategy: aggregationStrategySchema,
  strictness: endpointStrictnessSchema,
  cacheTtl: z.number().int().optional(),
});
export type ComposedEndpointDto = z.infer<typeof composedEndpointDtoSchema>;

/** The successful-composition response: the now-`active` endpoint + its `active` bindings. */
export const composeAdapterEndpointResponseSchema = z.object({
  endpoint: composedEndpointDtoSchema,
  bindings: z.array(composedBindingDtoSchema),
});
export type ComposeAdapterEndpointResponse = z.infer<typeof composeAdapterEndpointResponseSchema>;
