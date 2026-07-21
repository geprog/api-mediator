import {
  composeAdapterEndpointPreviewResponseSchema,
  composeAdapterEndpointRequestSchema,
  composeAdapterEndpointResponseSchema,
  type ComposeAdapterEndpointPreviewResponse,
  type ComposeAdapterEndpointRequest,
  type ComposeAdapterEndpointResponse,
  type SupplementAnalysisEntryDto,
} from "@mediator/contracts";
import type { AdapterBinding, AdapterEndpoint } from "@mediator/domain";
import type { FastifyInstance } from "fastify";

import {
  formatCompositionRejection,
  type AdapterCompositionService,
  type ComposeResult,
  type CompositionPreview,
  type SupplementAnalysisEntry,
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

  // CO-4 + CO-5 compose-preview — the derive-then-confirm read. It runs the same
  // derivation and validation `compose` runs against the *proposed* submission but
  // activates and persists NOTHING, so the composer sees the load-bearing supplement
  // analysis, the consumer-input coverage, and the blocking findings before confirming.
  app.post(
    "/api/adapter-endpoints/:id/composition/preview",
    { preHandler: requireOperator },
    async (request): Promise<ComposeAdapterEndpointPreviewResponse> => {
      const { id } = parseInput(idParamSchema, request.params, "path parameters");
      const body = parseInput(
        composeAdapterEndpointRequestSchema,
        request.body,
        "endpoint composition preview",
      );
      const preview = await composition.previewComposition(id, toCompositionSubmission(body));
      return composeAdapterEndpointPreviewResponseSchema.parse(toPreviewResponse(preview));
    },
  );
}

/** One CO-4 verdict → its DTO; readonly supplied-fields becomes a mutable array for the schema. */
function toSupplementAnalysisEntryDto(entry: SupplementAnalysisEntry): SupplementAnalysisEntryDto {
  return entry.kind === "supplement"
    ? {
        kind: "supplement",
        bindingId: entry.bindingId,
        suppliedConsumerResponseFields: [...entry.suppliedConsumerResponseFields],
        allSuppliedFieldsOptional: entry.allSuppliedFieldsOptional,
        loadBearing: entry.loadBearing,
      }
    : { kind: "primary-always-fails", bindingId: entry.bindingId, role: entry.role };
}

/** Map the derived composition preview to its response DTO (CO-4 + CO-5). */
function toPreviewResponse(preview: CompositionPreview): ComposeAdapterEndpointPreviewResponse {
  return {
    endpointId: preview.endpointId,
    supplementAnalysis: preview.supplementAnalysis.applicable
      ? {
          applicable: true,
          entries: preview.supplementAnalysis.entries.map(toSupplementAnalysisEntryDto),
        }
      : {
          applicable: false,
          aggregationStrategy: preview.supplementAnalysis.aggregationStrategy,
        },
    coverage: {
      perBinding: preview.coverage.perBinding.map((binding) => ({
        bindingId: binding.bindingId,
        unmappedParameters: [...binding.unmappedParameters],
        unmappedBodyFields: [...binding.unmappedBodyFields],
      })),
      unmappedByAllBackends: preview.coverage.unmappedByAllBackends.map((input) => ({ ...input })),
    },
    validation: preview.validation.ok
      ? { ok: true }
      : { ok: false, issues: preview.validation.reasons.map(formatCompositionRejection) },
  };
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
    ...(body.acknowledgedIgnoredInputs !== undefined
      ? { acknowledgedIgnoredInputs: body.acknowledgedIgnoredInputs }
      : {}),
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
