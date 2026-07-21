import type { ServeInput } from "@mediator/adapter-engine";
import {
  ApiSpecRepository,
  ApprovedMappingRepository,
  MappingArtifactsRepository,
  RegisteredAppRepository,
  ResourceBindingRepository,
  type Database,
} from "@mediator/db";
import type {
  AdapterBinding,
  ApiSpec,
  ApprovedMappingStatus,
  FieldMapping,
  Ir,
  IrOperation,
  OperationAction,
  OperationMapping,
  OutboundLoadLimits,
  ParameterMapping,
  RegisteredAppStatus,
  ResourceBinding,
} from "@mediator/domain";

import { fieldMappingsForResourcePair } from "../../../modules/sync/resolution.js";

/**
 * Loads the persisted per-request serving state the {@link AdapterServeHandler} needs:
 * the consumer operation's IR (for RP-2 / AG-7 validation), and per active binding —
 * its `ApprovedMapping` status + backend app status (for the RP-3 re-validation), its
 * `ParameterMapping`s / phase-scoped `FieldMapping`s (for the TE-1/TE-4 transforms),
 * and the resolved backend operation + base URL (for TE-2). All read-only.
 *
 * The mapping/app **statuses** are loaded unconditionally so the planner can report
 * the specific RP-3 cause even for a binding whose backend operation or base URL is
 * unresolvable; those execution bits are loaded best-effort (`undefined` when they do
 * not resolve) and only consulted for a binding the planner keeps.
 */
export interface ServeContextLoader {
  load(input: ServeInput): Promise<ServeContext>;
}

/** One active binding with everything loaded for its re-validation + (possible) execution. */
export interface LoadedBinding {
  readonly binding: AdapterBinding;
  readonly mappingId: string;
  readonly mappingStatus: ApprovedMappingStatus;
  readonly backendStatus: RegisteredAppStatus;
  readonly parameterMappings: readonly ParameterMapping[];
  /**
   * The approved `OperationMapping.action` of this binding's consumer↔backend
   * operation pair — the write signal (`create` | `update` | `delete`) the serve
   * handler branches on (WR-1/WR-2), the same fact CO-2.7 composes on. `undefined`
   * when the pair's `OperationMapping` does not resolve (a config defect): treated as
   * a non-write so it never takes the write path on a broken binding.
   */
  readonly action?: OperationAction;
  readonly requestPhaseFieldMappings: readonly FieldMapping[];
  readonly responsePhaseFieldMappings: readonly FieldMapping[];
  readonly backendBaseUrl: string | undefined;
  readonly backendLimits?: OutboundLoadLimits;
  readonly backendOperation: IrOperation | undefined;
  /**
   * The backend resource's `ResourceBinding` — loaded **only** for a `collection-union`
   * endpoint (AG-3/AG-5 need its confirmed `nativeIdRef` for row provenance/dedup and its
   * `paginationRef` for the bounded paged fetch). Absent for a `single`/`fanout-merge`
   * binding, which never reads a collection, so their loading is unchanged.
   */
  readonly backendResourceBinding?: ResourceBinding;
}

/** The whole serving context for one request. */
export interface ServeContext {
  /** The consumer operation from its own CONSUMER spec IR, or `undefined` if unresolvable. */
  readonly consumerOperation: IrOperation | undefined;
  /** One entry per `active` binding of the endpoint (aligned with `ServeInput.activeBindings`). */
  readonly bindings: readonly LoadedBinding[];
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

/** The `@mediator/db`-backed {@link ServeContextLoader}; all serving state comes from persisted rows. */
export class DbServeContextLoader implements ServeContextLoader {
  public constructor(private readonly db: Database) {}

  public async load(input: ServeInput): Promise<ServeContext> {
    const consumerSpecs = await new ApiSpecRepository(this.db).listByAppId(
      input.request.consumerAppId,
    );
    const consumerOperation = resolveOperation(
      consumerSpecs,
      "CONSUMER",
      input.request.operationKey,
    );

    // The backend resource's `ResourceBinding` is only needed by a `collection-union`
    // endpoint (AG-3/AG-5); a `single`/`fanout-merge` load never reads it, so its extra
    // query is skipped for them.
    const loadResourceBinding = input.endpoint.aggregationStrategy === "collection-union";
    const bindings = await Promise.all(
      input.activeBindings.map((binding) =>
        this.loadBinding(binding, input.endpoint.consumerOperationId, loadResourceBinding),
      ),
    );
    return { consumerOperation, bindings };
  }

  private async loadBinding(
    binding: AdapterBinding,
    consumerOperationId: string,
    loadResourceBinding: boolean,
  ): Promise<LoadedBinding> {
    const mapping = await new ApprovedMappingRepository(this.db).getById(binding.approvedMappingId);
    const backendApp = await new RegisteredAppRepository(this.db).getById(binding.backendAppId);

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
    const operationMappingId = operationMapping?.id;
    const scopedParameterMappings =
      operationMappingId === undefined
        ? []
        : parameterMappings.filter((param) => param.operationMappingId === operationMappingId);

    const backendSpecs = await new ApiSpecRepository(this.db).listByAppId(binding.backendAppId);
    const backendOperation = resolveOperation(backendSpecs, "PROVIDER", binding.backendOperationId);

    // A consumer-provider `ApprovedMapping` covering ≥2 resource pairs (the normal shape
    // of mapping two real specs) yields one `AdapterEndpoint` per consumer operation, each
    // sharing this same `approvedMappingId`. Its `FieldMapping`s must therefore be scoped
    // to THIS binding's resource pair — filtering by `phase` alone would apply a foreign
    // pair's field mappings, either failing the transform (a foreign source is absent →
    // `missing-input`) or, under a field-name collision, writing silently-wrong consumer
    // data. This mirrors the Sync Engine's `fieldMappingsForResourcePair` scoping exactly
    // (and the `operationMappingId` scoping already applied to `parameterMappings` above).
    // The pair is (consumer resource, backend resource); request phase runs consumer →
    // backend, response phase backend → consumer, so the source/target refs swap by phase.
    // An unparseable ref fails closed (empty string over-filters rather than leaks).
    const consumerResourceRef = parseOperationRef(consumerOperationId)?.resourceRef ?? "";
    const backendResourceRef = parseOperationRef(binding.backendOperationId)?.resourceRef ?? "";
    const requestPhase = fieldMappings.filter((field) => field.phase === "request");
    const responsePhase = fieldMappings.filter((field) => field.phase === "response");

    // AG-3/AG-5 — the union needs the backend resource's confirmed `nativeIdRef`/`paginationRef`.
    const backendResourceBinding = loadResourceBinding
      ? await this.loadBackendResourceBinding(
          backendSpecs,
          binding.backendOperationId,
          backendResourceRef,
        )
      : undefined;

    return {
      binding,
      mappingId: binding.approvedMappingId,
      // A missing mapping/app is FK-guaranteed not to happen; if it somehow does, fail
      // loud — an absent mapping reads as `archived` (→ mapping-stale) and an absent app
      // as `disabled` (→ backend-disabled), never as a healthy binding.
      mappingStatus: mapping?.status ?? "archived",
      backendStatus: backendApp?.status ?? "disabled",
      parameterMappings: scopedParameterMappings,
      // The write signal (WR-1/WR-2), read from the pair's approved OperationMapping.
      ...(operationMapping !== undefined ? { action: operationMapping.action } : {}),
      requestPhaseFieldMappings: fieldMappingsForResourcePair(
        requestPhase,
        consumerResourceRef,
        backendResourceRef,
      ),
      responsePhaseFieldMappings: fieldMappingsForResourcePair(
        responsePhase,
        backendResourceRef,
        consumerResourceRef,
      ),
      backendBaseUrl: backendApp?.baseUrl,
      ...(backendApp?.outboundLimits !== undefined
        ? { backendLimits: backendApp.outboundLimits }
        : {}),
      backendOperation,
      ...(backendResourceBinding !== undefined ? { backendResourceBinding } : {}),
    };
  }

  /**
   * The `ResourceBinding` of the backend resource whose active PROVIDER spec declares the
   * binding's `backendOperationId` — the source of the confirmed `nativeIdRef`/`paginationRef`
   * a `collection-union` contributor pages and dedups by. `undefined` when the operation or
   * its resource binding does not resolve (the union then treats it as non-composable).
   */
  private async loadBackendResourceBinding(
    backendSpecs: readonly ApiSpec[],
    backendOperationId: string,
    backendResourceRef: string,
  ): Promise<ResourceBinding | undefined> {
    for (const spec of backendSpecs) {
      if (spec.role !== "PROVIDER" || spec.status !== "active") {
        continue;
      }
      if (findOperationInIr(spec.parsedIR, backendOperationId) === undefined) {
        continue;
      }
      const bindings = await new ResourceBindingRepository(this.db).listByApiSpecId(spec.id);
      const match = bindings.find((entry) => entry.resourceRef === backendResourceRef);
      if (match !== undefined) {
        return match;
      }
    }
    return undefined;
  }
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
