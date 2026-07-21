import {
  adapterEndpointStateResponseSchema,
  adapterStateResponseSchema,
  composeAdapterEndpointPreviewResponseSchema,
  composeAdapterEndpointRequestSchema,
  composeAdapterEndpointResponseSchema,
  type AdapterEndpointStateResponse,
  type AdapterStateResponse,
  type ComposeAdapterEndpointPreviewResponse,
  type ComposeAdapterEndpointRequest,
  type ComposeAdapterEndpointResponse,
  type SupplementAnalysisEntryDto,
} from "@mediator/contracts";
import type { AdapterBinding, AdapterEndpoint } from "@mediator/domain";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";

import { NotFoundError } from "../../app-errors.js";
import {
  formatCompositionRejection,
  type ComposeResult,
  type CompositionPreview,
  type CompositionSubmission,
  type SupplementAnalysisEntry,
} from "../../modules/adapter-composition/index.js";
import type { AdapterStateReader } from "../../modules/adapter-state.js";
import { getPrincipal, requireOperator, requireViewer } from "../auth/index.js";
import { parseInput } from "../validation.js";
import { assembleAdapterState, assembleEndpointState } from "./adapter-state-view.js";
import { idParamSchema } from "./deps.js";

/** The `:id`/`:bindingId` path parameters for the binding enable/disable routes (AP-3.2). */
const endpointBindingParamsSchema = z.object({ id: z.uuid(), bindingId: z.uuid() });

/**
 * The narrow composition-mutation capability the AP-2/AP-3 routes delegate to — the CO-2/CO-6
 * methods of `AdapterCompositionService`, which structurally satisfies this port. A local port
 * (like `AdapterTokenIssuer`) so the routes are testable against a fake without a real
 * db/transaction, and so this slice calls the existing service rather than reaching into it.
 */
export interface CompositionMutator {
  compose(
    endpointId: string,
    submission: CompositionSubmission,
    actor: string,
  ): Promise<ComposeResult>;
  recompose(
    endpointId: string,
    submission: CompositionSubmission,
    actor: string,
  ): Promise<ComposeResult>;
  setEndpointEnabled(endpointId: string, enabled: boolean, actor: string): Promise<AdapterEndpoint>;
  previewComposition(
    endpointId: string,
    submission: CompositionSubmission,
  ): Promise<CompositionPreview>;
}

/**
 * Phase-5 adapter endpoint operator routes (AP-1 read state, AP-2 compose/recompose, AP-3
 * enable/disable). Every handler is **thin**: it authenticates/authorizes (OA-1/OA-2),
 * validates the request shape, and delegates every composition invariant to
 * {@link AdapterCompositionService} (CO-2/CO-6) or reads through {@link AdapterStateReader}.
 *
 * - Reads (AP-1) are `viewer`-allowed (OA-2) and carry **no** credential material, adapter
 *   token, or live payload value — only ids, statuses, and composition config (AP-1.5).
 * - Mutations (AP-2/AP-3) require an `operator`; a viewer is rejected `403` before the
 *   handler runs, so nothing changes. The service attributes the action (OA-3), activates
 *   atomically, and drops the endpoint's cache on commit (CH-5) — the routes only surface
 *   the result, and surface a rejected (re)composition's named reasons as `4xx` issues.
 */
export function registerAdapterEndpointRoutes(
  app: FastifyInstance,
  composition: CompositionMutator,
  adapterState: AdapterStateReader,
): void {
  // ── AP-1 — read adapter state (viewer) ──────────────────────────────────────
  app.get(
    "/api/adapter-endpoints",
    { preHandler: requireViewer },
    async (): Promise<AdapterStateResponse> => {
      const view = await assembleAdapterState(adapterState);
      return adapterStateResponseSchema.parse({
        endpoints: view.endpoints,
        notYetMapped: view.notYetMapped,
      });
    },
  );

  app.get(
    "/api/adapter-endpoints/:id",
    { preHandler: requireViewer },
    async (request): Promise<AdapterEndpointStateResponse> => {
      const { id } = parseInput(idParamSchema, request.params, "path parameters");
      const endpoint = await adapterState.getEndpointById(id);
      if (endpoint === undefined) {
        throw new NotFoundError(`Adapter endpoint ${id} not found.`);
      }
      const dto = await assembleEndpointState(adapterState, endpoint);
      return adapterEndpointStateResponseSchema.parse({ endpoint: dto });
    },
  );

  // ── AP-2 — compose / recompose decision (operator), dispatched by status ─────
  // A `composition-required` endpoint is composed (CO-2, "composed"); an already-`active`
  // endpoint is **recomposed** (CO-6, "recomposed") — an operator editing a live endpoint.
  // Both run the same validation and activate atomically on success; a rejection throws a
  // `BadRequestError` whose named rule violations become the `4xx` `issues`, and activates
  // nothing (a rejected recompose leaves the prior configuration serving). A viewer is `403`
  // before the handler (OA-2/CO-2.9).
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
      const submission = toCompositionSubmission(body);
      const endpoint = await adapterState.getEndpointById(id);
      if (endpoint === undefined) {
        throw new NotFoundError(`Adapter endpoint ${id} not found.`);
      }
      const result =
        endpoint.status === "composition-required"
          ? await composition.compose(id, submission, actor)
          : await composition.recompose(id, submission, actor);
      return composeAdapterEndpointResponseSchema.parse(toComposeResponse(result));
    },
  );

  // CO-4 + CO-5 compose-preview — the derive-then-confirm read (AP-2.4). It runs the same
  // derivation and validation `compose` runs against the *proposed* submission but activates
  // and persists NOTHING, so the composer sees the load-bearing supplement analysis, the
  // consumer-input coverage, and the blocking findings before confirming.
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

  // ── AP-3 — enable / disable an endpoint (operator) ──────────────────────────
  // Disabling sets `status = disabled` (the resolver then answers `endpoint-disabled`,
  // RT-3.2); re-enabling serves the stored configuration again. The service retains every
  // config column + binding row, attributes the action (OA-3), and drops the endpoint's
  // cache on commit (CH-5). NB (known, out-of-scope here): re-enabling an endpoint that was
  // `composition-required` when disabled returns it `active` — it loses only the
  // pending-compose prompt and is serving-safe; the fix needs a `service.ts` change owned by
  // another slice.
  app.post(
    "/api/adapter-endpoints/:id/disable",
    { preHandler: requireOperator },
    (request): Promise<AdapterEndpointStateResponse> =>
      setEndpointEnabled(request, composition, adapterState, false),
  );

  app.post(
    "/api/adapter-endpoints/:id/enable",
    { preHandler: requireOperator },
    (request): Promise<AdapterEndpointStateResponse> =>
      setEndpointEnabled(request, composition, adapterState, true),
  );

  // ── AP-3.2/3.3 — enable / disable a single binding (operator), via recompose ─
  // A binding is switched out of / back into service by **recomposing** the endpoint's
  // current configuration with that one binding's `disabled` flag flipped — reusing CO-6, so
  // the whole endpoint is re-validated: if disabling the binding would leave a write endpoint
  // with zero/several active bindings, or leave any config invalid under its strategy, the
  // recompose is rejected with that reason (AP-3.3) and nothing changes. The binding row is
  // retained (`disabled`, not deleted).
  app.post(
    "/api/adapter-endpoints/:id/bindings/:bindingId/disable",
    { preHandler: requireOperator },
    (request): Promise<ComposeAdapterEndpointResponse> =>
      flipBinding(request, composition, adapterState, true),
  );

  app.post(
    "/api/adapter-endpoints/:id/bindings/:bindingId/enable",
    { preHandler: requireOperator },
    (request): Promise<ComposeAdapterEndpointResponse> =>
      flipBinding(request, composition, adapterState, false),
  );
}

/** Shared AP-3.1 endpoint enable/disable handler → the AP-1 endpoint state response. */
async function setEndpointEnabled(
  request: FastifyRequest,
  composition: CompositionMutator,
  adapterState: AdapterStateReader,
  enabled: boolean,
): Promise<AdapterEndpointStateResponse> {
  const { id } = parseInput(idParamSchema, request.params, "path parameters");
  const actor = getPrincipal(request).identity;
  const endpoint = await composition.setEndpointEnabled(id, enabled, actor);
  const dto = await assembleEndpointState(adapterState, endpoint);
  return adapterEndpointStateResponseSchema.parse({ endpoint: dto });
}

/**
 * Shared AP-3.2/3.3 binding enable/disable handler: read the endpoint's current bindings,
 * flip the target binding's `disabled` flag, and recompose (CO-6). The reconstruction keeps
 * the current **served** configuration exactly — every `active` binding stays active, every
 * non-active (`proposed`/`disabled`) binding stays out of service — with only the target
 * binding flipped, so the recompose validates the same endpoint minus/plus that one binding.
 */
async function flipBinding(
  request: FastifyRequest,
  composition: CompositionMutator,
  adapterState: AdapterStateReader,
  disabled: boolean,
): Promise<ComposeAdapterEndpointResponse> {
  const { id, bindingId } = parseInput(
    endpointBindingParamsSchema,
    request.params,
    "path parameters",
  );
  const actor = getPrincipal(request).identity;
  const endpoint = await adapterState.getEndpointById(id);
  if (endpoint === undefined) {
    throw new NotFoundError(`Adapter endpoint ${id} not found.`);
  }
  const bindings = await adapterState.listBindings(id);
  if (!bindings.some((binding) => binding.id === bindingId)) {
    throw new NotFoundError(`Binding ${bindingId} is not a binding of adapter endpoint ${id}.`);
  }
  const submission = toBindingFlipSubmission(endpoint, bindings, bindingId, disabled);
  const result = await composition.recompose(id, submission, actor);
  return composeAdapterEndpointResponseSchema.parse(toComposeResponse(result));
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
    // CO-3 — present only for a proposed collection-union (derive-then-confirm).
    ...(preview.union !== undefined
      ? {
          union: {
            unserviceableFilters: [...preview.union.unserviceableFilters],
            unconfiguredSortParameters: [...preview.union.unconfiguredSortParameters],
            unconfiguredPaginationParameters: [...preview.union.unconfiguredPaginationParameters],
            dedupConflictPrecedence: preview.union.dedupConflictPrecedence,
            largeCollectionRisk: { ...preview.union.largeCollectionRisk },
          },
        }
      : {}),
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
    // CO-3 union config — presence-preserving (exactOptionalPropertyTypes), so the
    // validator/persistence see "not supplied" rather than a null on a non-union submit.
    ...(body.postMergeDedup !== undefined ? { postMergeDedup: body.postMergeDedup } : {}),
    ...(body.postMergeFilters !== undefined ? { postMergeFilters: body.postMergeFilters } : {}),
    ...(body.postMergeSorts !== undefined ? { postMergeSorts: body.postMergeSorts } : {}),
    ...(body.postMergePagination !== undefined
      ? { postMergePagination: body.postMergePagination }
      : {}),
    ...(body.confirmPostMergePagination !== undefined
      ? { confirmPostMergePagination: body.confirmPostMergePagination }
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

/**
 * Reconstruct the endpoint's **current** composition as a submission, then flip the target
 * binding's `disabled` flag (AP-3.2). Every persisted config column is carried through
 * presence-preserving (`exactOptionalPropertyTypes`); a persisted `collection-union`
 * pagination convention is re-submitted with its confirmation state (never a client-supplied
 * `confirmedBy`). Each binding's `disabled` flag is `status !== "active"` (so a `proposed`
 * binding stays out of the served set) except the target, which is set to `disabled`.
 */
function toBindingFlipSubmission(
  endpoint: AdapterEndpoint,
  bindings: readonly AdapterBinding[],
  targetBindingId: string,
  disabled: boolean,
): CompositionSubmission {
  const pagination = endpoint.postMergePagination;
  return {
    // A composed endpoint always carries these; the fallbacks keep the reconstruction total
    // for an as-yet-uncomposed endpoint (whose recompose would fail validation anyway).
    aggregationStrategy: endpoint.aggregationStrategy ?? "single",
    strictness: endpoint.strictness ?? "degraded",
    ...(endpoint.cacheTtl !== undefined ? { cacheTtl: endpoint.cacheTtl } : {}),
    ...(endpoint.acknowledgedIgnoredInputs !== undefined
      ? { acknowledgedIgnoredInputs: endpoint.acknowledgedIgnoredInputs }
      : {}),
    ...(endpoint.postMergeDedup !== undefined ? { postMergeDedup: endpoint.postMergeDedup } : {}),
    ...(endpoint.postMergeFilters !== undefined
      ? { postMergeFilters: endpoint.postMergeFilters }
      : {}),
    ...(endpoint.postMergeSorts !== undefined ? { postMergeSorts: endpoint.postMergeSorts } : {}),
    ...(pagination !== undefined
      ? {
          postMergePagination: pagination.convention,
          confirmPostMergePagination: pagination.confirmedBy !== null,
        }
      : {}),
    bindings: bindings.map((binding) => ({
      bindingId: binding.id,
      role: binding.role,
      ...(binding.executionOrder !== undefined ? { executionOrder: binding.executionOrder } : {}),
      ...(binding.dependsOnBindingId !== undefined
        ? { dependsOnBindingId: binding.dependsOnBindingId }
        : {}),
      ...(binding.chainInputs !== undefined ? { chainInputs: binding.chainInputs } : {}),
      disabled: binding.id === targetBindingId ? disabled : binding.status !== "active",
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
