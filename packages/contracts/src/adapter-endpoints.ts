import {
  adapterBindingRoleSchema,
  adapterBindingStatusSchema,
  adapterEndpointStatusSchema,
  aggregationStrategySchema,
  chainInputSchema,
  endpointStrictnessSchema,
} from "@mediator/domain";
import { z } from "zod";

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
 * A composition submission for a `composition-required` endpoint (CO-2.1): the
 * `aggregationStrategy`, strict-vs-degraded mode, `cacheTtl` (absent = no caching), and
 * one entry per composable binding of the endpoint. `postMerge*` union configuration is
 * deliberately **not** here — that is CO-3.
 */
export const composeAdapterEndpointRequestSchema = z.object({
  aggregationStrategy: aggregationStrategySchema,
  strictness: endpointStrictnessSchema,
  cacheTtl: z.number().int().positive().optional(),
  bindings: z.array(composeBindingRequestSchema).min(1),
});
export type ComposeAdapterEndpointRequest = z.infer<typeof composeAdapterEndpointRequestSchema>;

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
