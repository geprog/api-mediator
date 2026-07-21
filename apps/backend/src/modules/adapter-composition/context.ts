import {
  AdapterCompositionRepository,
  ApiSpecRepository,
  MappingArtifactsRepository,
  ResourceBindingRepository,
  type DbHandle,
} from "@mediator/db";
import type {
  AdapterBinding,
  AdapterEndpoint,
  ApiSpec,
  FieldMapping,
  Ir,
  IrOperation,
  IrParameter,
  OperationMapping,
  ParameterMapping,
} from "@mediator/domain";

import { fieldMappingsForResourcePair, isRefConfirmed } from "../sync/resolution.js";
import { topLevelConsumerFieldName, type ConsumerInputUniverse } from "./analysis.js";
import { bareParamName } from "./refs.js";
import type { UnionBindingFacts } from "./union.js";
import type { ComposableBindingFacts } from "./validate.js";

/**
 * Loads the persisted composition context CO-2 validation needs: the target
 * `AdapterEndpoint`, its composable `AdapterBinding`s (any status), and — per binding —
 * the {@link ComposableBindingFacts} the validator reads (its backend operation's
 * parameters and their required-ness, that mapping's approved `ParameterMapping`
 * coverage, its `phase = response` `FieldMapping`s' consumer-shape output fields, and
 * whether its operation is a write). All read-only; it decides nothing.
 *
 * Mirrors the request-time `DbServeContextLoader` (`http/adapter-runtime/serve/
 * serve-context.ts`) — the same operation-ref resolution and per-binding resource-pair
 * scoping — because composition validates exactly what the runtime will later execute.
 */
export interface CompositionContext {
  readonly endpoint: AdapterEndpoint;
  readonly bindings: readonly AdapterBinding[];
  readonly bindingFacts: readonly ComposableBindingFacts[];
  /**
   * The consumer operation's inputs (parameters + request body fields), the universe the
   * CO-5 coverage report is derived against. Empty when the consumer operation cannot be
   * resolved from its CONSUMER spec IR.
   */
  readonly consumerInputs: ConsumerInputUniverse;
  /**
   * The **required** field names of the consumer operation's response schema (bare,
   * top-level) — the CO-4 required-ness the load-bearing analysis reads. The runtime
   * re-derives this from the same schema at request time, so it is never persisted as
   * authoritative (CO-4.4).
   */
  readonly requiredConsumerResponseFieldNames: ReadonlySet<string>;
  /**
   * CO-3 — one entry per composable binding: the backend resource's `ResourceBinding`
   * ref-confirmation state (native id / collection read / pagination) and the consumer
   * params it pushes down. Aligned with `bindingFacts` by `bindingId`.
   */
  readonly unionBindingFacts: readonly UnionBindingFacts[];
  /** CO-3 — the consumer operation's declared parameters (union ref validity + classification). */
  readonly consumerParameters: readonly IrParameter[];
  /** CO-3 — **all** field names of the consumer response schema (bare, top-level). */
  readonly consumerResponseFieldNames: ReadonlySet<string>;
}

export interface CompositionContextLoader {
  /** Load the endpoint + its composable bindings + per-binding facts, or `undefined` if the endpoint is unknown. */
  load(endpointId: string): Promise<CompositionContext | undefined>;
}

/** Parse a `resourceRef/operationId` operation ref into its two parts (split on the first `/`). */
function parseOperationRef(
  ref: string,
): { readonly resourceRef: string; readonly operationId: string } | undefined {
  const slash = ref.indexOf("/");
  if (slash <= 0 || slash >= ref.length - 1) {
    return undefined;
  }
  return { resourceRef: ref.slice(0, slash), operationId: ref.slice(slash + 1) };
}

/** Find an operation by its `resourceRef/operationId` ref within an IR. */
function findOperationInIr(ir: Ir, operationRef: string): IrOperation | undefined {
  const parsed = parseOperationRef(operationRef);
  if (parsed === undefined) {
    return undefined;
  }
  const group = ir.find((candidate) => candidate.resourceRef === parsed.resourceRef);
  return group?.operations.find((operation) => operation.operationId === parsed.operationId);
}

/** Resolve an operation ref against the first active spec of `role` that declares it. */
function resolveOperation(
  specs: readonly ApiSpec[],
  role: ApiSpec["role"],
  operationRef: string,
): IrOperation | undefined {
  for (const spec of specs) {
    if (spec.role !== role || spec.status !== "active") {
      continue;
    }
    const operation = findOperationInIr(spec.parsedIR, operationRef);
    if (operation !== undefined) {
      return operation;
    }
  }
  return undefined;
}

/** The `OperationMapping` pairing this consumer operation with this backend operation. */
function matchingOperationMapping(
  operationMappings: readonly OperationMapping[],
  consumerOperationId: string,
  backendOperationId: string,
): OperationMapping | undefined {
  return operationMappings.find(
    (operation) =>
      operation.sourceOperationRef === consumerOperationId &&
      operation.targetOperationRef === backendOperationId,
  );
}

const WRITE_ACTIONS: ReadonlySet<OperationMapping["action"]> = new Set([
  "create",
  "update",
  "delete",
]);

/**
 * The CO-5 consumer input universe of a consumer operation — its parameters (cookie
 * params excluded, matching the runtime's RP-2 inbound check) and its request body
 * fields. A path parameter is treated as required regardless of its declared flag (it
 * must be filled to form the route), the same rule the runtime and CO-2.6 apply. Empty
 * when the operation is unresolvable.
 */
function consumerInputUniverse(operation: IrOperation | undefined): ConsumerInputUniverse {
  if (operation === undefined) {
    return { parameters: [], bodyFields: [] };
  }
  return {
    parameters: operation.parameters
      .filter((parameter) => parameter.location !== "cookie")
      .map((parameter) => ({
        name: parameter.name,
        required: parameter.location === "path" || parameter.required,
      })),
    bodyFields: (operation.requestSchema?.fields ?? []).map((field) => ({
      name: field.name,
      required: field.required,
    })),
  };
}

/** The bare consumer parameter names a `ParameterMapping` sources (primary + additional inputs). */
function mappedConsumerParamNamesOf(
  parameterMappings: readonly ParameterMapping[],
): ReadonlySet<string> {
  const names = new Set<string>();
  for (const mapping of parameterMappings) {
    names.add(bareParamName(mapping.sourceParamRef));
    for (const additional of mapping.transformConfig?.additionalInputPaths ?? []) {
      names.add(bareParamName(additional));
    }
  }
  return names;
}

/** The top-level consumer body field names a request-phase `FieldMapping` reads (primary + additional). */
function mappedConsumerBodyFieldNamesOf(
  requestPhaseFieldMappings: readonly FieldMapping[],
): ReadonlySet<string> {
  const names = new Set<string>();
  for (const mapping of requestPhaseFieldMappings) {
    names.add(topLevelConsumerFieldName(mapping.sourcePath));
    for (const additional of mapping.transformConfig?.additionalInputPaths ?? []) {
      names.add(topLevelConsumerFieldName(additional));
    }
  }
  return names;
}

/**
 * The `@mediator/db`-backed {@link CompositionContextLoader}. Bound to a {@link DbHandle}
 * (the pooled db **or** a `tx()` transaction), so successor adoption (CO-7) can load an
 * endpoint's context **inside** the same transaction that re-points its bindings — seeing
 * the uncommitted re-point and re-validating against the successor's content.
 */
export class DbCompositionContextLoader implements CompositionContextLoader {
  public constructor(private readonly db: DbHandle) {}

  public async load(endpointId: string): Promise<CompositionContext | undefined> {
    const compositions = new AdapterCompositionRepository(this.db);
    const endpoint = await compositions.getEndpointById(endpointId);
    if (endpoint === undefined) {
      return undefined;
    }
    const bindings = await compositions.listBindings(endpointId);
    const perBinding = await Promise.all(
      bindings.map((binding) => this.#factsFor(binding, endpoint.consumerOperationId)),
    );
    const bindingFacts = perBinding.map((entry) => entry.facts);
    const unionBindingFacts = perBinding.map((entry) => entry.unionFacts);

    // Operation-level consumer facts: the CO-5 input universe (parameters + request body
    // fields), the CO-4 required consumer-response field names, and the CO-3 consumer
    // parameters + response fields — all read from the consumer operation's own
    // CONSUMER-spec IR, the same schema the runtime re-derives required-ness from at
    // request time (CO-4.4), never a persisted snapshot.
    const consumerSpecs = await new ApiSpecRepository(this.db).listByAppId(endpoint.consumerAppId);
    const consumerOperation = resolveOperation(
      consumerSpecs,
      "CONSUMER",
      endpoint.consumerOperationId,
    );
    const consumerInputs = consumerInputUniverse(consumerOperation);
    const responseFields = consumerOperation?.responseSchema?.fields ?? [];
    const requiredConsumerResponseFieldNames = new Set(
      responseFields.filter((field) => field.required).map((field) => field.name),
    );
    const consumerResponseFieldNames = new Set(responseFields.map((field) => field.name));

    return {
      endpoint,
      bindings,
      bindingFacts,
      consumerInputs,
      requiredConsumerResponseFieldNames,
      unionBindingFacts,
      consumerParameters: consumerOperation?.parameters ?? [],
      consumerResponseFieldNames,
    };
  }

  async #factsFor(
    binding: AdapterBinding,
    consumerOperationId: string,
  ): Promise<{ facts: ComposableBindingFacts; unionFacts: UnionBindingFacts }> {
    const artifacts = new MappingArtifactsRepository(this.db);
    const [operationMappings, parameterMappings, fieldMappings] = await Promise.all([
      artifacts.listOperationMappings(binding.approvedMappingId),
      artifacts.listParameterMappings(binding.approvedMappingId),
      artifacts.listFieldMappings(binding.approvedMappingId),
    ]);

    const operationMapping = matchingOperationMapping(
      operationMappings,
      consumerOperationId,
      binding.backendOperationId,
    );
    const scopedParameterMappings =
      operationMapping === undefined
        ? []
        : parameterMappings.filter((param) => param.operationMappingId === operationMapping.id);

    const backendSpecs = await new ApiSpecRepository(this.db).listByAppId(binding.backendAppId);
    const resolvedBackend = resolveOperationWithSpec(
      backendSpecs,
      "PROVIDER",
      binding.backendOperationId,
    );
    const backendOperation = resolvedBackend?.operation;

    const backendParameterNames = new Set<string>();
    const requiredBackendParameterNames = new Set<string>();
    for (const parameter of backendOperation?.parameters ?? []) {
      backendParameterNames.add(parameter.name);
      // A path parameter is inherently required (it must be filled to form the URL),
      // regardless of its declared `required` flag — the same rule the runtime fills
      // parameters by. This is what makes the scenario-4 `{owner}`/`{repo}` case a
      // blocking CO-2.6 finding even when the spec omits `required: true`.
      if (parameter.location === "path" || parameter.required) {
        requiredBackendParameterNames.add(parameter.name);
      }
    }

    const parameterMappedTargetNames = new Set(
      scopedParameterMappings.map((param) => bareParamName(param.targetParamRef)),
    );

    // Consumer-shape response fields = the `targetPath`s of this binding's response-phase
    // FieldMappings, scoped to its (backend resource → consumer resource) pair — the same
    // scoping the runtime applies before the response transform.
    const consumerResourceRef = parseOperationRef(consumerOperationId)?.resourceRef ?? "";
    const backendResourceRef = parseOperationRef(binding.backendOperationId)?.resourceRef ?? "";
    const responsePhase = fieldMappings.filter((field) => field.phase === "response");
    const consumerResponseFieldPaths = new Set(
      fieldMappingsForResourcePair(responsePhase, backendResourceRef, consumerResourceRef).map(
        (field) => field.targetPath,
      ),
    );

    // CO-5 — which consumer inputs THIS binding maps. The request phase runs consumer →
    // backend, so its `FieldMapping`s are scoped (consumer resource → backend resource),
    // the mirror of the response-phase scoping above and the same
    // `fieldMappingsForResourcePair` the runtime applies — never a foreign pair's fields.
    const requestPhase = fieldMappings.filter((field) => field.phase === "request");
    const scopedRequestPhase = fieldMappingsForResourcePair(
      requestPhase,
      consumerResourceRef,
      backendResourceRef,
    );
    const mappedConsumerParamNames = mappedConsumerParamNamesOf(scopedParameterMappings);
    const mappedConsumerBodyFieldNames = mappedConsumerBodyFieldNamesOf(scopedRequestPhase);

    // CO-3 — the backend resource's operational bindings, keyed by (backend spec,
    // backend resource). Its confirmed refs decide link-based dedup (nativeIdRef) and
    // union composability (collectionReadRef + paginationRef-where-paged). Absent =
    // every ref unconfirmed, which fails those preconditions loud rather than silently.
    const backendSpecId = resolvedBackend?.spec.id;
    const backendResourceBinding =
      backendSpecId === undefined
        ? undefined
        : (await new ResourceBindingRepository(this.db).listByApiSpecId(backendSpecId)).find(
            (resource) => resource.resourceRef === backendResourceRef,
          );
    const unionFacts: UnionBindingFacts = {
      bindingId: binding.id,
      backendResourceRef,
      nativeIdRefConfirmed: isRefConfirmed(backendResourceBinding?.nativeIdRef),
      collectionReadRefConfirmed: isRefConfirmed(backendResourceBinding?.collectionReadRef),
      paginationRefPresent: backendResourceBinding?.paginationRef !== undefined,
      paginationRefConfirmed: isRefConfirmed(backendResourceBinding?.paginationRef),
      // Pushdown source = the consumer params a ParameterMapping reads (pair-scoped) —
      // NOT the transform's additional inputs. A filter is pushed down only when every
      // contributing binding maps it (CO-3.4).
      pushdownConsumerParamNames: new Set(
        scopedParameterMappings.map((param) => bareParamName(param.sourceParamRef)),
      ),
    };

    return {
      facts: {
        bindingId: binding.id,
        isWriteOperation:
          operationMapping !== undefined && WRITE_ACTIONS.has(operationMapping.action),
        backendParameterNames,
        requiredBackendParameterNames,
        parameterMappedTargetNames,
        consumerResponseFieldPaths,
        mappedConsumerParamNames,
        mappedConsumerBodyFieldNames,
      },
      unionFacts,
    };
  }
}

/**
 * Resolve an operation ref against the first active spec of `role` that declares it,
 * returning both the operation and the owning spec — the spec id is what keys the
 * resource's `ResourceBinding` (CO-3). A read-only sibling of {@link resolveOperation}.
 */
function resolveOperationWithSpec(
  specs: readonly ApiSpec[],
  role: ApiSpec["role"],
  operationRef: string,
): { readonly operation: IrOperation; readonly spec: ApiSpec } | undefined {
  for (const spec of specs) {
    if (spec.role !== role || spec.status !== "active") {
      continue;
    }
    const operation = findOperationInIr(spec.parsedIR, operationRef);
    if (operation !== undefined) {
      return { operation, spec };
    }
  }
  return undefined;
}
