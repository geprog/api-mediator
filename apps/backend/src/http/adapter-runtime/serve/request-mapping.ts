import type { AdapterRequest } from "@mediator/adapter-engine";
import {
  recordRelativePath,
  type ChainInput,
  type FieldMapping,
  type IrOperation,
  type IrParameter,
  type ParameterMapping,
} from "@mediator/domain";
import {
  applyFieldMapping,
  applyFieldMappings,
  isTransformError,
  readPath,
  type JsonRecord,
  type JsonValue,
} from "@mediator/transform";

/**
 * **TE-1 — request phase: consumer request → backend request.** Fills the backend
 * operation's path/query/header parameters from the mapping's `ParameterMapping`s and
 * the backend body from its request-phase `FieldMapping`s, reusing the Phase-4
 * Transformation Executor's vocabulary + sandbox unchanged (a `ParameterMapping`
 * shares `FieldMapping`'s `transform`/`transformConfig`). A backend input is filled
 * only from a reviewed mapping — never guessed. A **required** backend parameter with
 * no mapping makes the operation non-servable: the call is **refused** (TE-1.3), never
 * issued with an unsubstituted or invented value — surfaced as a mediator-side defect.
 */

/** One filled backend parameter, ready for the wire. */
export interface WireParam {
  readonly name: string;
  readonly value: string;
}

/** The backend request inputs produced from the consumer request (protocol-neutral). */
export interface MappedBackendRequest {
  readonly pathParams: Readonly<Record<string, string>>;
  readonly queryParams: readonly WireParam[];
  readonly headerParams: readonly WireParam[];
  /** The backend body from request-phase field mappings, or `undefined` for a bodyless call. */
  readonly body: JsonValue | undefined;
}

/** TE-1 outcome: the mapped request, or a mediator-side defect that refuses the call. */
export type RequestMappingResult =
  | { readonly ok: true; readonly request: MappedBackendRequest }
  | { readonly ok: false; readonly detail: string };

/** The bare parameter name of a `resourceRef/operationId#name` ref (or the segment after the last `/`). */
export function paramRefBareName(ref: string): string {
  const hash = ref.lastIndexOf("#");
  if (hash !== -1 && hash < ref.length - 1) {
    return ref.slice(hash + 1);
  }
  const slash = ref.lastIndexOf("/");
  return slash !== -1 && slash < ref.length - 1 ? ref.slice(slash + 1) : ref;
}

/** Read a consumer parameter's supplied value from the request by its declared location. */
function readConsumerParamValue(
  request: AdapterRequest,
  parameter: IrParameter,
): string | undefined {
  switch (parameter.location) {
    case "path":
      return request.pathParameters[parameter.name];
    case "query":
      return firstString(request.query[parameter.name]);
    case "header": {
      const wanted = parameter.name.toLowerCase();
      for (const [key, value] of Object.entries(request.headers)) {
        if (key.toLowerCase() === wanted) {
          return firstString(value);
        }
      }
      return undefined;
    }
    case "cookie":
      return undefined;
  }
}

function firstString(value: string | readonly string[] | undefined): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (value === undefined) {
    return undefined;
  }
  return value[0];
}

/**
 * The record of supplied consumer parameter values, keyed by **bare** parameter name,
 * that a `ParameterMapping`'s transform reads (`sourceParamRef` → bare name). Only
 * supplied parameters appear, so an optional absent parameter simply is not present.
 */
export function buildConsumerParamSource(
  operation: IrOperation,
  request: AdapterRequest,
): JsonRecord {
  const source: JsonRecord = {};
  for (const parameter of operation.parameters) {
    const value = readConsumerParamValue(request, parameter);
    if (value !== undefined) {
      source[parameter.name] = value;
    }
  }
  return source;
}

/**
 * The bare consumer parameter names the composition honors — every `ParameterMapping`
 * source parameter plus any additional transform inputs. RP-2.4 rejects a *supplied*
 * consumer parameter that is **not** in this set (it would be silently dropped).
 */
export function mappedConsumerParamNames(
  parameterMappings: readonly ParameterMapping[],
): ReadonlySet<string> {
  const names = new Set<string>();
  for (const mapping of parameterMappings) {
    names.add(paramRefBareName(mapping.sourceParamRef));
    for (const additional of mapping.transformConfig?.additionalInputPaths ?? []) {
      names.add(paramRefBareName(additional));
    }
  }
  return names;
}

/** Turn a transformed parameter value into its wire string, or `undefined` when it cannot be one. */
function toWireString(value: JsonValue): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  // null / object / array are not a scalar wire parameter value.
  return undefined;
}

interface MappingContext {
  readonly mappingId: string;
  readonly consumerOperation: IrOperation;
  readonly backendOperation: IrOperation;
  readonly parameterMappings: readonly ParameterMapping[];
  readonly requestPhaseFieldMappings: readonly FieldMapping[];
  readonly request: AdapterRequest;
  /**
   * TE-3 — backend parameters already filled from an upstream binding's consumer-shape
   * response (keyed by **bare** target parameter name), resolved by
   * {@link resolveChainInputs} before this call. They fill their `targetParamRef` exactly
   * like a `ParameterMapping` and satisfy the required-parameter check (CO-2.6 treats a
   * `chainInput` as filling a required parameter). Absent for a non-chained binding.
   */
  readonly chainedParams?: ReadonlyMap<string, string>;
}

/**
 * Apply the request-phase mapping (TE-1). Returns the backend request inputs, or a
 * mediator-transform-error detail on a transform failure, an untranslatable value, a
 * target parameter the backend operation does not declare, or a **required** backend
 * parameter left unfilled (TE-1.3).
 */
export function mapRequestToBackend(context: MappingContext): RequestMappingResult {
  const source = buildConsumerParamSource(context.consumerOperation, context.request);
  const backendParams = new Map<string, string>();

  for (const mapping of context.parameterMappings) {
    const targetName = paramRefBareName(mapping.targetParamRef);
    const synthetic: FieldMapping = {
      id: mapping.id,
      mappingId: context.mappingId,
      sourcePath: paramRefBareName(mapping.sourceParamRef),
      targetPath: targetName,
      transform: mapping.transform ?? "rename",
      ...(mapping.transformConfig !== undefined
        ? { transformConfig: mapping.transformConfig }
        : {}),
    };
    let produced: JsonValue;
    try {
      produced = applyFieldMapping(synthetic, source).value;
    } catch (error) {
      if (isTransformError(error) && error.kind === "missing-input") {
        // An optional consumer parameter was not supplied — leave the backend
        // parameter unfilled (RP-2.5). If it is *required*, the check below refuses.
        continue;
      }
      if (isTransformError(error)) {
        return { ok: false, detail: `parameter mapping '${targetName}': ${error.kind}` };
      }
      throw error;
    }
    const wire = toWireString(produced);
    if (wire === undefined) {
      // A null passthrough is an unfilled parameter, not an error by itself.
      continue;
    }
    backendParams.set(targetName, wire);
  }

  // TE-3 — chained inputs fill their target parameters (resolved from the upstream's
  // consumer-shape response). They are applied after the ParameterMappings so a chain
  // wins a (composition-forbidden) overlap deterministically; normally the two sets are
  // disjoint. A chained parameter counts toward the required-parameter check below.
  for (const [name, value] of context.chainedParams ?? new Map<string, string>()) {
    backendParams.set(name, value);
  }

  const placement = placeBackendParams(context.backendOperation, backendParams);
  if (!placement.ok) {
    return placement;
  }

  const missingRequired = findMissingRequiredParam(context.backendOperation, backendParams);
  if (missingRequired !== undefined) {
    return {
      ok: false,
      detail: `missing required backend parameter '${missingRequired}' (no mapping fills it)`,
    };
  }

  const body = buildBackendBody(context);
  if (!body.ok) {
    return body;
  }

  return {
    ok: true,
    request: {
      pathParams: placement.pathParams,
      queryParams: placement.queryParams,
      headerParams: placement.headerParams,
      body: body.value,
    },
  };
}

type PlacementResult =
  | {
      readonly ok: true;
      readonly pathParams: Readonly<Record<string, string>>;
      readonly queryParams: readonly WireParam[];
      readonly headerParams: readonly WireParam[];
    }
  | { readonly ok: false; readonly detail: string };

/** Place each filled backend parameter into its declared wire location (path/query/header). */
function placeBackendParams(
  operation: IrOperation,
  filled: ReadonlyMap<string, string>,
): PlacementResult {
  const pathParams: Record<string, string> = {};
  const queryParams: WireParam[] = [];
  const headerParams: WireParam[] = [];
  for (const [name, value] of filled) {
    const parameter = operation.parameters.find((candidate) => candidate.name === name);
    if (parameter === undefined) {
      return {
        ok: false,
        detail: `backend parameter '${name}' is not declared on the backend operation`,
      };
    }
    switch (parameter.location) {
      case "path":
        pathParams[name] = value;
        break;
      case "query":
        queryParams.push({ name, value });
        break;
      case "header":
        headerParams.push({ name, value });
        break;
      case "cookie":
        return {
          ok: false,
          detail: `backend parameter '${name}' resolves to a cookie (unfillable)`,
        };
    }
  }
  return { ok: true, pathParams, queryParams, headerParams };
}

/** A backend path parameter is always required; a query/header parameter iff `required`. */
function findMissingRequiredParam(
  operation: IrOperation,
  filled: ReadonlyMap<string, string>,
): string | undefined {
  for (const parameter of operation.parameters) {
    if (parameter.location === "cookie") {
      continue;
    }
    const required = parameter.location === "path" || parameter.required;
    if (required && !filled.has(parameter.name)) {
      return parameter.name;
    }
  }
  return undefined;
}

function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Build the backend body from request-phase field mappings, or `undefined` when there are none. */
function buildBackendBody(
  context: MappingContext,
):
  | { readonly ok: true; readonly value: JsonValue | undefined }
  | { readonly ok: false; readonly detail: string } {
  if (context.requestPhaseFieldMappings.length === 0) {
    return { ok: true, value: undefined };
  }
  const bodySource = isJsonRecord(context.request.body) ? context.request.body : {};
  try {
    const applied = applyFieldMappings(context.requestPhaseFieldMappings, bodySource);
    return { ok: true, value: applied.output };
  } catch (error) {
    if (isTransformError(error)) {
      return { ok: false, detail: `request body transform: ${error.kind}` };
    }
    throw error;
  }
}

// ── TE-3: chained-binding input resolution ───────────────────────────────────

/**
 * TE-3 outcome: the chained backend parameters, or a loud failure that refuses the call.
 * `missing-chain-input` is the upstream-value-absent refusal (TE-3.4); `defect` is a
 * transform failure or an untranslatable value — both surfaced as `mediator-transform-error`
 * by the executor, never a call issued with an unfilled or guessed parameter.
 */
export type ChainInputResolution =
  | { readonly ok: true; readonly params: ReadonlyMap<string, string> }
  | { readonly ok: false; readonly kind: "missing-chain-input"; readonly detail: string }
  | { readonly ok: false; readonly kind: "defect"; readonly detail: string };

/**
 * **TE-3 — resolve a chained binding's `chainInputs` against the upstream binding's
 * consumer-shape response.** Each input reads `upstreamFieldPath` from that **already
 * response-phase-transformed** payload (TE-3.2) — never the upstream backend's native
 * shape — and fills exactly its named `targetParamRef` (TE-3.3), applying its optional
 * transform in the **same sandbox** the request phase uses (reusing {@link applyFieldMapping}).
 *
 * A value **absent or null** in the upstream response refuses the call as a
 * `missing-chain-input` naming the input (TE-3.4), never dispatched with the parameter
 * unfilled or guessed — the same discipline as TE-1.3. A transform failure, or a value
 * that cannot become a scalar wire parameter, is a mediator-side `defect`. The detail is
 * payload-free: it names the field path/ref only, never the value read.
 */
export function resolveChainInputs(
  mappingId: string,
  chainInputs: readonly ChainInput[],
  upstreamConsumerShape: JsonValue,
): ChainInputResolution {
  const params = new Map<string, string>();
  for (const chainInput of chainInputs) {
    const relativeSource = recordRelativePath(chainInput.upstreamFieldPath);
    const read = readPath(upstreamConsumerShape, relativeSource);
    if (!read.present || read.value === null) {
      return {
        ok: false,
        kind: "missing-chain-input",
        detail: `chain input '${chainInput.upstreamFieldPath}' is absent or null in the upstream consumer-shape response`,
      };
    }
    const leaf = leafSegment(relativeSource);
    if (leaf === undefined) {
      return {
        ok: false,
        kind: "defect",
        detail: `chain input source path '${chainInput.upstreamFieldPath}' is empty`,
      };
    }
    const targetName = paramRefBareName(chainInput.targetParamRef);
    const synthetic: FieldMapping = {
      id: `chain:${targetName}`,
      mappingId,
      sourcePath: leaf,
      targetPath: targetName,
      transform: chainInput.transform ?? "rename",
      ...(chainInput.transformConfig !== undefined
        ? { transformConfig: chainInput.transformConfig }
        : {}),
    };
    let produced: JsonValue;
    try {
      produced = applyFieldMapping(synthetic, { [leaf]: read.value }).value;
    } catch (error) {
      if (isTransformError(error)) {
        return {
          ok: false,
          kind: "defect",
          detail: `chain input '${chainInput.targetParamRef}': ${error.kind}`,
        };
      }
      throw error;
    }
    const wire = toWireString(produced);
    if (wire === undefined) {
      return {
        ok: false,
        kind: "defect",
        detail: `chain input '${chainInput.targetParamRef}' did not produce a scalar parameter value`,
      };
    }
    params.set(targetName, wire);
  }
  return { ok: true, params };
}

/** The last dot-separated segment of a record-relative path — the sandbox binding name. */
function leafSegment(recordRelative: string): string | undefined {
  const segments = recordRelative.split(".").filter((segment) => segment.length > 0);
  return segments[segments.length - 1];
}
