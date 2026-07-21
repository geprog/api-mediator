import type { ServeInput } from "@mediator/adapter-engine";
import {
  ApiSpecRepository,
  ApprovedMappingRepository,
  MappingArtifactsRepository,
  RegisteredAppRepository,
  type Database,
} from "@mediator/db";
import type {
  AdapterBinding,
  ApiSpec,
  ApprovedMappingStatus,
  FieldMapping,
  Ir,
  IrOperation,
  OperationMapping,
  OutboundLoadLimits,
  ParameterMapping,
  RegisteredAppStatus,
} from "@mediator/domain";

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
  readonly requestPhaseFieldMappings: readonly FieldMapping[];
  readonly responsePhaseFieldMappings: readonly FieldMapping[];
  readonly backendBaseUrl: string | undefined;
  readonly backendLimits?: OutboundLoadLimits;
  readonly backendOperation: IrOperation | undefined;
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

    const bindings = await Promise.all(
      input.activeBindings.map((binding) =>
        this.loadBinding(binding, input.endpoint.consumerOperationId),
      ),
    );
    return { consumerOperation, bindings };
  }

  private async loadBinding(
    binding: AdapterBinding,
    consumerOperationId: string,
  ): Promise<LoadedBinding> {
    const mapping = await new ApprovedMappingRepository(this.db).getById(binding.approvedMappingId);
    const backendApp = await new RegisteredAppRepository(this.db).getById(binding.backendAppId);

    const artifacts = new MappingArtifactsRepository(this.db);
    const [operationMappings, parameterMappings, fieldMappings] = await Promise.all([
      artifacts.listOperationMappings(binding.approvedMappingId),
      artifacts.listParameterMappings(binding.approvedMappingId),
      artifacts.listFieldMappings(binding.approvedMappingId),
    ]);

    const operationMappingId = matchingOperationMappingId(
      operationMappings,
      consumerOperationId,
      binding.backendOperationId,
    );
    const scopedParameterMappings =
      operationMappingId === undefined
        ? []
        : parameterMappings.filter((param) => param.operationMappingId === operationMappingId);

    const backendSpecs = await new ApiSpecRepository(this.db).listByAppId(binding.backendAppId);
    const backendOperation = resolveOperation(backendSpecs, "PROVIDER", binding.backendOperationId);

    return {
      binding,
      mappingId: binding.approvedMappingId,
      // A missing mapping/app is FK-guaranteed not to happen; if it somehow does, fail
      // loud — an absent mapping reads as `archived` (→ mapping-stale) and an absent app
      // as `disabled` (→ backend-disabled), never as a healthy binding.
      mappingStatus: mapping?.status ?? "archived",
      backendStatus: backendApp?.status ?? "disabled",
      parameterMappings: scopedParameterMappings,
      requestPhaseFieldMappings: fieldMappings.filter((field) => field.phase === "request"),
      responsePhaseFieldMappings: fieldMappings.filter((field) => field.phase === "response"),
      backendBaseUrl: backendApp?.baseUrl,
      ...(backendApp?.outboundLimits !== undefined
        ? { backendLimits: backendApp.outboundLimits }
        : {}),
      backendOperation,
    };
  }
}

/** The id of the `OperationMapping` pairing this consumer operation with this backend operation. */
function matchingOperationMappingId(
  operationMappings: readonly OperationMapping[],
  consumerOperationId: string,
  backendOperationId: string,
): string | undefined {
  const match = operationMappings.find(
    (operation) =>
      operation.sourceOperationRef === consumerOperationId &&
      operation.targetOperationRef === backendOperationId,
  );
  return match?.id;
}
