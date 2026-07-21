import {
  composeAdapterEndpointRequestSchema,
  composeAdapterEndpointResponseSchema,
  type ComposeAdapterEndpointRequest,
  type ComposeAdapterEndpointResponse,
} from "@mediator/contracts";
import type { AdapterBinding, AdapterEndpoint } from "@mediator/domain";
import type { FastifyInstance } from "fastify";

import type {
  AdapterCompositionService,
  ComposeResult,
} from "../../modules/adapter-composition/index.js";
import type { CompositionSubmission } from "../../modules/adapter-composition/index.js";
import { getPrincipal, requireOperator } from "../auth/index.js";
import { parseInput } from "../validation.js";
import { idParamSchema } from "./deps.js";

/**
 * `POST /api/adapter-endpoints/:id/compose` — the CO-2 composition decision. A viewer is
 * rejected `403` before the handler runs (OA-2/CO-2.9), so nothing changes; an operator's
 * submission is validated and, only if activatable, atomically activated by
 * {@link AdapterCompositionService} (which attributes the action, OA-3). A rejected
 * composition returns `400` with each named reason as an `issues` entry — the endpoint
 * keeps serving its previous configuration (CO-2.8). No response carries credential
 * material.
 */
export function registerAdapterEndpointRoutes(
  app: FastifyInstance,
  composition: AdapterCompositionService,
): void {
  app.post(
    "/api/adapter-endpoints/:id/compose",
    { preHandler: requireOperator },
    async (request): Promise<ComposeAdapterEndpointResponse> => {
      const { id } = parseInput(idParamSchema, request.params, "path parameters");
      const body = parseInput(
        composeAdapterEndpointRequestSchema,
        request.body,
        "endpoint composition",
      );
      const actor = getPrincipal(request).identity;
      const result = await composition.compose(id, toCompositionSubmission(body), actor);
      return composeAdapterEndpointResponseSchema.parse(toComposeResponse(result));
    },
  );
}

/**
 * Map the request DTO to the service submission, preserving key **presence** for every
 * optional field (`exactOptionalPropertyTypes`): an absent `executionOrder`/
 * `dependsOnBindingId`/`chainInputs`/`cacheTtl` stays absent rather than being set to
 * `undefined`, so the validator and the persistence layer see "not supplied", not a null.
 */
function toCompositionSubmission(body: ComposeAdapterEndpointRequest): CompositionSubmission {
  return {
    aggregationStrategy: body.aggregationStrategy,
    strictness: body.strictness,
    ...(body.cacheTtl !== undefined ? { cacheTtl: body.cacheTtl } : {}),
    bindings: body.bindings.map((binding) => ({
      bindingId: binding.bindingId,
      role: binding.role,
      ...(binding.executionOrder !== undefined ? { executionOrder: binding.executionOrder } : {}),
      ...(binding.dependsOnBindingId !== undefined
        ? { dependsOnBindingId: binding.dependsOnBindingId }
        : {}),
      ...(binding.chainInputs !== undefined ? { chainInputs: binding.chainInputs } : {}),
    })),
  };
}

/** Map the activated composition to the response DTO. */
function toComposeResponse(result: ComposeResult): ComposeAdapterEndpointResponse {
  return {
    endpoint: toComposedEndpointDto(result.endpoint),
    bindings: result.bindings.map(toComposedBindingDto),
  };
}

/**
 * The composed endpoint DTO. `aggregationStrategy` and `strictness` are always present
 * after activation (the composition set them); the response schema requires them, and a
 * fallback keeps the mapper total without asserting.
 */
function toComposedEndpointDto(
  endpoint: AdapterEndpoint,
): ComposeAdapterEndpointResponse["endpoint"] {
  return {
    id: endpoint.id,
    consumerAppId: endpoint.consumerAppId,
    consumerOperationId: endpoint.consumerOperationId,
    status: endpoint.status,
    aggregationStrategy: endpoint.aggregationStrategy ?? "single",
    strictness: endpoint.strictness ?? "degraded",
    ...(endpoint.cacheTtl !== undefined ? { cacheTtl: endpoint.cacheTtl } : {}),
  };
}

/** One activated binding, as the response DTO. */
function toComposedBindingDto(
  binding: AdapterBinding,
): ComposeAdapterEndpointResponse["bindings"][number] {
  return {
    id: binding.id,
    backendAppId: binding.backendAppId,
    backendOperationId: binding.backendOperationId,
    role: binding.role,
    status: binding.status,
    ...(binding.executionOrder !== undefined ? { executionOrder: binding.executionOrder } : {}),
    ...(binding.dependsOnBindingId !== undefined
      ? { dependsOnBindingId: binding.dependsOnBindingId }
      : {}),
    ...(binding.chainInputs !== undefined ? { chainInputs: binding.chainInputs } : {}),
  };
}
