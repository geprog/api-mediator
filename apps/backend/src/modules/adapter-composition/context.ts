import {
  AdapterCompositionRepository,
  ApiSpecRepository,
  MappingArtifactsRepository,
  type Database,
} from "@mediator/db";
import type {
  AdapterBinding,
  AdapterEndpoint,
  ApiSpec,
  Ir,
  IrOperation,
  OperationMapping,
} from "@mediator/domain";

import { fieldMappingsForResourcePair } from "../sync/resolution.js";
import { bareParamName } from "./refs.js";
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

/** The `@mediator/db`-backed {@link CompositionContextLoader}. */
export class DbCompositionContextLoader implements CompositionContextLoader {
  public constructor(private readonly db: Database) {}

  public async load(endpointId: string): Promise<CompositionContext | undefined> {
    const compositions = new AdapterCompositionRepository(this.db);
    const endpoint = await compositions.getEndpointById(endpointId);
    if (endpoint === undefined) {
      return undefined;
    }
    const bindings = await compositions.listBindings(endpointId);
    const bindingFacts = await Promise.all(
      bindings.map((binding) => this.#factsFor(binding, endpoint.consumerOperationId)),
    );
    return { endpoint, bindings, bindingFacts };
  }

  async #factsFor(
    binding: AdapterBinding,
    consumerOperationId: string,
  ): Promise<ComposableBindingFacts> {
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
    const backendOperation = resolveOperation(backendSpecs, "PROVIDER", binding.backendOperationId);

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

    return {
      bindingId: binding.id,
      isWriteOperation:
        operationMapping !== undefined && WRITE_ACTIONS.has(operationMapping.action),
      backendParameterNames,
      requiredBackendParameterNames,
      parameterMappedTargetNames,
      consumerResponseFieldPaths,
    };
  }
}
