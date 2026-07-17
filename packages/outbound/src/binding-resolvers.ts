import type {
  ApiSpec,
  ApprovedMapping,
  AppCapabilities,
  ConfirmableRef,
  IrOperation,
  IrParameter,
  IrRefTarget,
  IrResourceGroup,
  OperationMapping,
  OutboundLoadLimits,
  RegisteredApp,
  ResourceBinding,
  SyncRule,
} from "@mediator/domain";
import { stripUndefined } from "@mediator/domain";
import type { CapturedScope, JsonValue } from "@mediator/transform";

import { fillScopePathParameters } from "./path-template.js";
import { resolveRecordDerivedScopeValues } from "./record-derived-scope.js";
import type { HttpMethod, ParameterLocation, RestOperationBinding } from "./protocol-client.js";
import type {
  RestDeltaConvention,
  RestPaginationConvention,
  RestSourceBindingResolver,
  RestSourceReadBinding,
} from "./rest-source-reader.js";

/**
 * **Sync-Engine binding resolvers** — the composition seam every Phase-4 sync slice
 * deferred: they turn persisted `ApiSpec.parsedIR` + confirmed `ResourceBinding`
 * refs + `SyncRule`/`OperationMapping` state into the concrete REST **wire shapes**
 * the Poller ({@link RestSourceReadBinding}), the pipeline handler
 * ({@link RestOperationBinding}), and Conflict Detection (the single-record target
 * read) already consume through ports + fakes.
 *
 * The module lives in `@mediator/outbound` (not `@mediator/sync-engine`) because it
 * produces the *outbound* wire shapes and depends on {@link RestSourceReadBinding} /
 * {@link RestOperationBinding} defined here. The IR types it reasons over
 * (`IrResourceGroup`/`IrOperation`/`IrParameter`/`IrRefTarget`) are the shared-kernel
 * shapes from `@mediator/domain` — the source imports **no** new package. (`@mediator/ir`,
 * the OpenAPI→IR builder, is a **test-only** dependency: the spec calls `buildIr` to
 * build fixtures from the vendored scenario specs.)
 *
 * ## The load-bearing invariant: never fabricate a binding from an unconfirmed ref
 *
 * OpenAPI declares none of these conventions, so a `ResourceBinding` ref is a
 * *heuristic guess* until an operator confirms it (`confirmedBy`/`confirmedAt` set).
 * The enablement gate (`enablement-gate.ts`) already blocks a rule from going live
 * with an unconfirmed required ref, but these resolvers are the last line: an
 * **unconfirmed or missing** ref yields `undefined` / an omitted convention, **never**
 * a convention invented from an unratified guess. A `single-page` pagination
 * (absent `paginationRef`) and an omitted `delta.deletion` (absent/unconfirmed
 * `deltaDeletionRef`) are the *confirmed-absence* cases — the ref legitimately does
 * not apply — and are distinct from an unconfirmed *present* ref, which unresolves.
 *
 * ## Detail the IR/domain cannot yet persist ({@link BindingResolverOptions})
 *
 * `resource-binding.ts` notes that "the richer per-ref execution detail some refs
 * eventually need (a pagination ref's page + limit parameters and exhaustion
 * convention, a delta ref's response cursor location) is layered on in Phase 4 where
 * the refs are first consumed" — i.e. here. But a `ConfirmableRef.value` is a fixed
 * single-element `IrRefTarget`, and there is **no DB migration in this slice**, so a
 * few genuinely un-persistable bits are supplied as documented resolver
 * configuration rather than invented:
 *  - the numeric page **size** requested per page (`defaultPageSize`) — no IR field
 *    carries a parameter's default value;
 *  - a page-number convention's **start page** (`defaultStartPage`, 0- vs 1-based);
 *  - a delta response's **next-cursor location** (`deltaNextCursorPath`) — the domain
 *    `deltaCursorRef` is a *request*-parameter ref and carries no response path;
 *  - a marker-field deletion **sentinel** (`deletedWhenEquals`).
 * The *identity* of every convention (which param, which op, which field) still comes
 * only from a **confirmed** ref; only these numeric/sentinel/response-path bits are
 * configuration. See the report for the recommended domain follow-up.
 */

// ── Injected repository ports (the real `@mediator/db` repos satisfy them) ─────

/** Loads an `ApiSpec` (and thus its `parsedIR`) by id — `ApiSpecRepository.getById`. */
export interface ApiSpecReader {
  getById(id: string): Promise<ApiSpec | undefined>;
  /** The app's specs (a single-record reader resolves the app's active PROVIDER spec). */
  listByAppId(appId: string): Promise<ApiSpec[]>;
}

/** Loads a spec's `ResourceBinding`s — `ResourceBindingRepository.listByApiSpecId`. */
export interface ResourceBindingReader {
  listByApiSpecId(apiSpecId: string): Promise<ResourceBinding[]>;
}

/** Loads a `SyncRule` by id — `SyncRuleRepository.getById`. */
export interface SyncRuleReader {
  getById(id: string): Promise<SyncRule | undefined>;
}

/** Loads an `ApprovedMapping` by id — `ApprovedMappingRepository.getById`. */
export interface ApprovedMappingReader {
  getById(id: string): Promise<ApprovedMapping | undefined>;
}

/** Lists a mapping's `OperationMapping`s — `MappingArtifactsRepository.listOperationMappings`. */
export interface OperationMappingReader {
  listOperationMappings(mappingId: string): Promise<OperationMapping[]>;
}

/** Loads a `RegisteredApp` by id — `RegisteredAppRepository.getById`. */
export interface RegisteredAppReader {
  getById(id: string): Promise<RegisteredApp | undefined>;
}

// ── Options ────────────────────────────────────────────────────────────────────

/** Un-persistable execution detail the resolvers supply as documented configuration. */
export interface BindingResolverOptions {
  /** Records requested per page (offset/page-number `pageSize`); default {@link DEFAULT_PAGE_SIZE}. */
  readonly defaultPageSize?: number;
  /** A page-number convention's first page (0- vs 1-based); default {@link DEFAULT_START_PAGE}. */
  readonly defaultStartPage?: number;
  /** Where a delta response carries the next cursor; default: the cursor request param's own name. */
  readonly deltaNextCursorPath?: string;
  /** The `marker-field` deletion sentinel a record equals when deleted; default {@link DEFAULT_DELETED_WHEN_EQUALS}. */
  readonly deletedWhenEquals?: JsonValue;
}

const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_START_PAGE = 1;
const DEFAULT_DELETED_WHEN_EQUALS: JsonValue = true;

interface ResolvedOptions {
  readonly pageSize: number;
  readonly startPage: number;
  readonly deltaNextCursorPath: string | undefined;
  readonly deletedWhenEquals: JsonValue;
}

function resolveOptions(options: BindingResolverOptions | undefined): ResolvedOptions {
  return {
    pageSize: options?.defaultPageSize ?? DEFAULT_PAGE_SIZE,
    startPage: options?.defaultStartPage ?? DEFAULT_START_PAGE,
    deltaNextCursorPath: options?.deltaNextCursorPath,
    deletedWhenEquals: options?.deletedWhenEquals ?? DEFAULT_DELETED_WHEN_EQUALS,
  };
}

// ── Pagination / delta parameter-name heuristics ───────────────────────────────

const OFFSET_PARAM_NAMES = ["offset", "start", "startIndex", "start_index", "skip"];
const PAGE_NUMBER_PARAM_NAMES = ["page", "pageNumber", "page_number"];
const LIMIT_PARAM_NAMES = [
  "limit",
  "per_page",
  "perPage",
  "pageSize",
  "page_size",
  "size",
  "count",
  "maxResults",
  "max_results",
];

// ── Confirmation + ref parsing ─────────────────────────────────────────────────

/** A ref is confirmed iff it is present with **both** confirmation stamps set (mirrors the gate). */
function isRefConfirmed(ref: ConfirmableRef | undefined): boolean {
  return ref !== undefined && ref.confirmedBy !== null && ref.confirmedAt !== null;
}

/** The confirmed ref's value, or `undefined` when absent/unconfirmed — never a guess. */
function confirmedValue(ref: ConfirmableRef | undefined): IrRefTarget | undefined {
  return isRefConfirmed(ref) ? ref?.value : undefined;
}

/**
 * A serialized IR ref splits into its leading `resourceRef` and the remainder — the
 * same `resourceRef/operationId` / `resourceRef/operationId#parameter` form the
 * approval layer writes (`apps/backend/.../approval/refs.ts`). Split on the **first**
 * `/`: a synthetic `operationId` (Vikunja's `"get /tasks/{id}"`) contains slashes, so
 * only the first separates the (slash-free) `resourceRef`.
 */
interface ParsedOperationRef {
  readonly resourceRef: string;
  readonly operationId: string;
}

function parseOperationRef(ref: string): ParsedOperationRef | undefined {
  const slash = ref.indexOf("/");
  if (slash <= 0 || slash >= ref.length - 1) {
    return undefined;
  }
  return { resourceRef: ref.slice(0, slash), operationId: ref.slice(slash + 1) };
}

/** Serialize an operation-parameter ref exactly as `OperationMapping.targetIdParamRef` stores it. */
function serializeParamRef(resourceRef: string, operationId: string, parameter: string): string {
  return `${resourceRef}/${operationId}#${parameter}`;
}

/** Map a lower-cased IR method to a REST {@link HttpMethod}; `undefined` for a non-REST verb. */
function toHttpMethod(method: IrOperation["method"]): HttpMethod | undefined {
  switch (method) {
    case "get":
      return "GET";
    case "post":
      return "POST";
    case "put":
      return "PUT";
    case "patch":
      return "PATCH";
    case "delete":
      return "DELETE";
    default:
      // head / options / trace are never an executable sync operation.
      return undefined;
  }
}

/** A confirmed `field`-kind ref's path, else `undefined`. */
function confirmedFieldPath(ref: ConfirmableRef | undefined): string | undefined {
  const value = confirmedValue(ref);
  return value?.kind === "field" ? value.path : undefined;
}

// ── recordsPath: where the collection response's array lives ────────────────────

/**
 * Where the records array lives in a collection/delta response (`recordsPath`), or
 * `undefined` when the body **is** the array.
 *
 * `@mediator/ir`'s decomposition unwraps a top-level array body to its *item* schema
 * (so an `IrSchema` always describes an object), erasing the "was it an array?" bit —
 * and the item schema itself often has array-typed **sub-collection** fields (a
 * Vikunja task's `assignees`/`labels`), which must not be mistaken for the records
 * wrapper. The **native-id field** disambiguates: if the response schema carries the
 * record's own native-id field at its top level, the schema *is* the item
 * representation (the top-level array was unwrapped) → the body is the array,
 * `recordsPath = undefined`. Only when the native id is *not* top-level is the schema a
 * wrapper object, and the collection lives in an array-typed field of it — chosen
 * deterministically: a well-known wrapper name first, else the first array field.
 */
const WRAPPER_FIELD_NAMES = ["data", "items", "results", "records", "content", "values", "list"];

function deriveRecordsPath(operation: IrOperation, nativeIdPath: string): string | undefined {
  const fields = operation.responseSchema?.fields ?? [];
  const nativeIdHead = nativeIdPath.split(".")[0];
  if (nativeIdHead !== undefined && fields.some((field) => field.name === nativeIdHead)) {
    // The response schema is the record item itself (unwrapped top-level array).
    return undefined;
  }
  const arrayFields = fields.filter((field) => isArrayType(field.type));
  if (arrayFields.length === 0) {
    return undefined;
  }
  for (const wellKnown of WRAPPER_FIELD_NAMES) {
    if (arrayFields.some((field) => field.name === wellKnown)) {
      return wellKnown;
    }
  }
  return arrayFields[0]?.name;
}

function isArrayType(type: string): boolean {
  return type.endsWith("[]") || type === "array";
}

// ── Pagination convention ──────────────────────────────────────────────────────

/**
 * Build the {@link RestPaginationConvention} from the confirmed `paginationRef`:
 *  - **absent** ref → `single-page` (confirmed-absence: the read returns one response);
 *  - present-but-**unconfirmed** → `"unresolved"` (never fabricate a paging convention);
 *  - confirmed offset/page-number parameter → the matching convention, with a sibling
 *    limit parameter (if the operation exposes one) so a full page is detectable
 *    (the SP `limitParam`/`pageSize` invariant); an unclassifiable confirmed param
 *    (cursor/limit-only — not representable by this union) → `"unresolved"`.
 */
function derivePagination(
  binding: ResourceBinding,
  operation: IrOperation,
  options: ResolvedOptions,
): RestPaginationConvention | "unresolved" {
  const ref = binding.paginationRef;
  if (ref === undefined) {
    return { kind: "single-page" };
  }
  const value = confirmedValue(ref);
  if (value === undefined || value.kind !== "parameter") {
    // Present but unconfirmed (or a non-parameter guess) → do not fabricate.
    return "unresolved";
  }
  const paramName = value.parameter;
  const limitParam = findLimitParam(operation, paramName);
  if (OFFSET_PARAM_NAMES.includes(paramName)) {
    return stripUndefined({
      kind: "offset" as const,
      offsetParam: paramName,
      limitParam,
      pageSize: options.pageSize,
    });
  }
  if (PAGE_NUMBER_PARAM_NAMES.includes(paramName)) {
    return stripUndefined({
      kind: "page-number" as const,
      pageParam: paramName,
      limitParam,
      pageSize: options.pageSize,
      startPage: options.startPage,
    });
  }
  // A confirmed cursor/limit-only param is not representable as offset/page-number.
  return "unresolved";
}

/** A sibling limit-like parameter of the operation (distinct from the paging param), if any. */
function findLimitParam(operation: IrOperation, pagingParam: string): string | undefined {
  const match = operation.parameters.find(
    (parameter) => parameter.name !== pagingParam && LIMIT_PARAM_NAMES.includes(parameter.name),
  );
  return match?.name;
}

// ── Delta convention ───────────────────────────────────────────────────────────

/**
 * Build the {@link RestDeltaConvention} from the confirmed `deltaCursorRef` (+
 * optional confirmed `deltaDeletionRef`), or `undefined` when the cursor ref is
 * absent/unconfirmed (never fabricate). `nextCursorPath` falls back to the cursor
 * parameter's own name (see {@link BindingResolverOptions}); `deletion` is present
 * **only** when `deltaDeletionRef` is confirmed (SP-3.3 — an unconfirmed deletion ref
 * detects no deletions).
 */
function deriveDelta(
  binding: ResourceBinding,
  recordsPath: string | undefined,
  options: ResolvedOptions,
): RestDeltaConvention | undefined {
  const cursor = confirmedValue(binding.deltaCursorRef);
  if (cursor === undefined || cursor.kind !== "parameter") {
    return undefined;
  }
  const cursorParam = cursor.parameter;
  const deletionMarkerPath = confirmedFieldPath(binding.deltaDeletionRef);
  const deletion =
    deletionMarkerPath === undefined
      ? undefined
      : {
          kind: "marker-field" as const,
          markerPath: deletionMarkerPath,
          deletedWhenEquals: options.deletedWhenEquals,
        };
  return stripUndefined({
    cursorParam,
    nextCursorPath: options.deltaNextCursorPath ?? cursorParam,
    recordsPath,
    deletion,
  });
}

// ── Source-read binding (Poller) ───────────────────────────────────────────────

/** The already-loaded artifacts a source-read binding is composed from (direction-scoped). */
export interface SourceReadBindingInput {
  readonly rule: SyncRule;
  readonly sourceAppId: string;
  readonly baseUrl: string;
  readonly limits?: OutboundLoadLimits;
  readonly sourceCapabilities: AppCapabilities;
  readonly sourceGroup: IrResourceGroup;
  readonly sourceBinding: ResourceBinding;
}

/**
 * A rule is **delta-polling** iff the source declares `supportsDeltaQuery` **and** the
 * resource offers a delta operation — evidenced by a *present* `deltaCursorRef`
 * (presence, not confirmation, decides the mode; this mirrors the enablement gate's
 * `isDeltaPolling` exactly). Confirmation of `deltaCursorRef` is then required to
 * actually *build* the delta convention below (an unconfirmed one unresolves).
 */
function isDeltaPolling(input: SourceReadBindingInput): boolean {
  return (
    input.sourceCapabilities.supportsDeltaQuery && input.sourceBinding.deltaCursorRef !== undefined
  );
}

/**
 * Resolve the **source poll operation** (the IR operation the Poller reads each cycle,
 * whose method/path the source-read binding is composed from): the pinned
 * `SyncRule.pollOperationRef` when it resolves in the source group, else the mode's
 * confirmed structured ref — the confirmed `deltaCursorRef`'s operation (the op carrying
 * the cursor param) when the rule is delta-polling, else the confirmed `collectionReadRef`
 * operation for full-fetch. `undefined` when none resolves.
 *
 * Exported so the SS-5 enablement classifier (`docs/requirements/scoped-resource-sync.md`
 * SS-5) resolves the **exact same** operation {@link resolveSourceReadBinding} fills its
 * scope path parameters from — so the gate's required scope set matches the source read
 * the resolver actually composes. A rule is delta-polling iff the source declares
 * `supportsDeltaQuery` **and** the resource offers a delta operation (a *present*
 * `deltaCursorRef`), mirroring {@link isDeltaPolling}.
 */
export function resolveSourcePollOperation(input: {
  readonly rule: SyncRule;
  readonly sourceGroup: IrResourceGroup;
  readonly sourceBinding: ResourceBinding;
  readonly sourceCapabilities: AppCapabilities;
}): IrOperation | undefined {
  const pinned = resolvePinnedPollOperation(input.rule.pollOperationRef, input.sourceGroup);
  if (pinned !== undefined) {
    return pinned;
  }
  const deltaPolling =
    input.sourceCapabilities.supportsDeltaQuery && input.sourceBinding.deltaCursorRef !== undefined;
  if (deltaPolling) {
    const cursor = confirmedValue(input.sourceBinding.deltaCursorRef);
    return cursor?.kind === "parameter"
      ? findOperationById(input.sourceGroup, cursor.operationId)
      : undefined;
  }
  const collection = confirmedValue(input.sourceBinding.collectionReadRef);
  return collection?.kind === "operation"
    ? findOperationById(input.sourceGroup, collection.operationId)
    : undefined;
}

/** Resolve a `pollOperationRef` string (present + non-empty = confirmed) to a group operation. */
function resolvePinnedPollOperation(
  pollOperationRef: string | undefined,
  group: IrResourceGroup,
): IrOperation | undefined {
  if (pollOperationRef === undefined || pollOperationRef.length === 0) {
    return undefined;
  }
  const parsed = parseOperationRef(pollOperationRef);
  const operationId = parsed?.operationId ?? pollOperationRef;
  return findOperationById(group, operationId);
}

function findOperationById(group: IrResourceGroup, operationId: string): IrOperation | undefined {
  return group.operations.find((operation) => operation.operationId === operationId);
}

/**
 * Compose a rule's {@link RestSourceReadBinding} from its already-loaded IR +
 * `ResourceBinding` + capabilities, or `undefined` when a **required** confirmed ref
 * is missing (see the module invariant). Pure — the repo-backed
 * {@link RepoRestSourceBindingResolver} loads the inputs and calls this.
 */
export function resolveSourceReadBinding(
  input: SourceReadBindingInput,
  options?: BindingResolverOptions,
): RestSourceReadBinding | undefined {
  const resolved = resolveOptions(options);

  const nativeIdPath = confirmedFieldPath(input.sourceBinding.nativeIdRef);
  if (nativeIdPath === undefined) {
    // BE-2.1 — native id is required on both sides; an unconfirmed one is used nowhere.
    return undefined;
  }

  const deltaPolling = isDeltaPolling(input);
  const operation = resolveSourcePollOperation(input);
  if (operation === undefined) {
    return undefined;
  }
  const method = toHttpMethod(operation.method);
  if (method === undefined) {
    return undefined;
  }

  // SS-4.1 — a collection/source read has NO record-id path parameter (the record id is
  // a response field), so EVERY path parameter is a scope parameter: fill each from the
  // SOURCE resource's confirmed `constant` bindings. An unconfirmed scope param → the
  // whole binding unresolves (SS-4.4), never a fabricated URL; the composed path then
  // carries no `{…}`.
  const path = fillScopePathParameters(
    operation.path,
    input.sourceBinding.scopePathBindings ?? [],
    undefined,
  );
  if (path === undefined) {
    return undefined;
  }
  const recordsPath = deriveRecordsPath(operation, nativeIdPath);

  let pagination: RestPaginationConvention;
  let delta: RestDeltaConvention | undefined;
  if (deltaPolling) {
    // The steady-state delta read (`readDelta`) does not page; the delta convention is
    // required and must resolve. Pagination is a non-paging placeholder here.
    const built = deriveDelta(input.sourceBinding, recordsPath, resolved);
    if (built === undefined) {
      return undefined; // delta mode but the cursor ref is unconfirmed → never fabricate.
    }
    delta = built;
    pagination = { kind: "single-page" };
  } else {
    const built = derivePagination(input.sourceBinding, operation, resolved);
    if (built === "unresolved") {
      return undefined; // present-but-unconfirmed / unrepresentable paging → never fabricate.
    }
    pagination = built;
  }

  return stripUndefined({
    sourceAppId: input.sourceAppId,
    baseUrl: input.baseUrl,
    limits: input.limits,
    method,
    path,
    nativeIdPath,
    recordsPath,
    pagination,
    delta,
  });
}

// ── Write-operation binding (pipeline handler / Outbound Call Executor) ─────────

/**
 * Resolve one `OperationMapping`'s target operation to its {@link RestOperationBinding}
 * (method/path template + per-parameter wire locations), or `undefined` when the
 * `targetOperationRef` does not resolve in `targetGroup` (a stale/foreign ref — never
 * a fabricated binding). `parameterLocations` is keyed by each parameter's serialized
 * ref (`resourceRef/operationId#name`) so the executor's lookup of
 * `OperationMapping.targetIdParamRef` finds the id parameter's location.
 *
 * `cookie` parameters are omitted (a `ParameterLocation` models only path/query/header,
 * which the executor fills); an id parameter that resolves to a cookie is therefore
 * absent from the map and the executor reports the config error rather than mis-placing it.
 *
 * SS-4.2 / SS-8.3 — the returned `pathTemplate` has every **scope** (non-record-id) path
 * parameter substituted from the TARGET resource's confirmed `constant` bindings **or**,
 * for a confirmed `record-derived` binding, from `capturedScope` (the change's captured
 * scope) by the binding's `sourceScopeKey` — value-preserving `transform` applied — while
 * the **record-id** parameter (named by `OperationMapping.targetIdParamRef`, present on
 * update/delete, absent on create) stays **templated** for the executor's per-record
 * id-fill from the `RecordLink`. The record-id-vs-scope split is keyed to the operation's
 * **role**, not to a bare name: on a create there is no `targetIdParamRef`, so ALL its
 * path parameters are scope (Vikunja `PUT /projects/{id}/tasks` fills `{id}` from the
 * project scope), whereas the same-named `{id}` on the `POST /tasks/{id}` update is the
 * record id and is never filled from a scope. An unconfirmed scope constant, or a
 * `record-derived` param whose captured component is absent, → `undefined` (the whole
 * binding unresolves; SS-4.4 / SS-8.3), never a fabricated URL.
 *
 * `capturedScope` is omitted for a non-scoped / constant-only rule and on a delete (no
 * source record was captured) — the fill is then constant-only, unchanged from SS-4.
 */
export function resolveWriteOperationBinding(
  operationMapping: OperationMapping,
  targetGroup: IrResourceGroup,
  targetBinding: ResourceBinding,
  capturedScope?: CapturedScope,
): RestOperationBinding | undefined {
  const parsed = parseOperationRef(operationMapping.targetOperationRef);
  if (parsed === undefined || parsed.resourceRef !== targetGroup.resourceRef) {
    return undefined;
  }
  const operation = findOperationById(targetGroup, parsed.operationId);
  if (operation === undefined) {
    return undefined;
  }
  const method = toHttpMethod(operation.method);
  if (method === undefined) {
    return undefined;
  }

  const scopePathBindings = targetBinding.scopePathBindings ?? [];
  const recordDerivedValues =
    capturedScope !== undefined
      ? resolveRecordDerivedScopeValues(scopePathBindings, capturedScope)
      : undefined;
  const pathTemplate = fillScopePathParameters(
    operation.path,
    scopePathBindings,
    writeRecordIdPathParam(operationMapping, operation),
    recordDerivedValues,
  );
  if (pathTemplate === undefined) {
    // SS-4.4 / SS-8.3 — an unconfirmed scope constant or a missing captured component
    // never fabricates a URL; the whole op unresolves and the write is refused upstream.
    return undefined;
  }

  const parameterLocations: Record<string, ParameterLocation> = {};
  for (const parameter of operation.parameters) {
    const location = toParameterLocation(parameter);
    if (location === undefined) {
      continue; // cookie (or unknown) — not fillable on the wire.
    }
    parameterLocations[serializeParamRef(parsed.resourceRef, parsed.operationId, parameter.name)] =
      location;
  }

  return stripUndefined({
    method,
    pathTemplate,
    parameterLocations,
    idempotencyKeyHeader: findIdempotencyKeyHeader(operation),
  });
}

/**
 * The target IR operation an `OperationMapping` names — parse its `targetOperationRef`,
 * guard the leading `resourceRef` against `targetGroup`, and look the operation up by id
 * — or `undefined` when it does not resolve in the group (a stale/foreign ref). Mirrors
 * {@link resolveWriteOperationBinding}'s own operation resolution, exported so the SS-5
 * enablement classifier reasons over the **same** IR operation the write resolver fills.
 */
export function findMappedTargetOperation(
  operationMapping: OperationMapping,
  targetGroup: IrResourceGroup,
): IrOperation | undefined {
  const parsed = parseOperationRef(operationMapping.targetOperationRef);
  if (parsed === undefined || parsed.resourceRef !== targetGroup.resourceRef) {
    return undefined;
  }
  return findOperationById(targetGroup, parsed.operationId);
}

/**
 * The name of this write operation's **record-id path parameter** — the one whose `{…}`
 * must stay templated for the executor's `RecordLink` fill — or `undefined` when the
 * operation has no record-id path parameter to leave templated (an `action = create`
 * carries no `targetIdParamRef`, so all its path params are scope; and an id parameter
 * located in the query/header is not in the path template at all). Keyed to the
 * operation's role via `OperationMapping.targetIdParamRef`, never to a bare name.
 *
 * Exported so the SS-5 enablement classifier keys its write scope set to the **same**
 * record-id determination the resolver leaves templated — the gate's required scope
 * params (path params minus this) then match the resolver's fill exactly.
 */
export function writeRecordIdPathParam(
  operationMapping: OperationMapping,
  operation: IrOperation,
): string | undefined {
  const parameterName = paramRefName(operationMapping.targetIdParamRef);
  if (parameterName === undefined) {
    return undefined;
  }
  const parameter = operation.parameters.find(
    (candidate) => candidate.name === parameterName && candidate.location === "path",
  );
  return parameter?.name;
}

/** The bare parameter name of a serialized `resourceRef/operationId#name` ref, else `undefined`. */
function paramRefName(ref: string | undefined): string | undefined {
  if (ref === undefined) {
    return undefined;
  }
  const hash = ref.lastIndexOf("#");
  if (hash === -1 || hash >= ref.length - 1) {
    return undefined;
  }
  return ref.slice(hash + 1);
}

function toParameterLocation(parameter: IrParameter): ParameterLocation | undefined {
  switch (parameter.location) {
    case "path":
      return { name: parameter.name, in: "path" };
    case "query":
      return { name: parameter.name, in: "query" };
    case "header":
      return { name: parameter.name, in: "header" };
    default:
      return undefined; // cookie
  }
}

/** The target API's own idempotency-key header, when it exposes one as a header parameter. */
function findIdempotencyKeyHeader(operation: IrOperation): string | undefined {
  const match = operation.parameters.find(
    (parameter) =>
      parameter.location === "header" && parameter.name.toLowerCase() === "idempotency-key",
  );
  return match?.name;
}

// ── Single-record target read (Conflict Detection: CF-5 / CF-6) ─────────────────

/**
 * The confirmed single-record read descriptor CF's `ConflictDetectionContext.targetReadBinding`
 * carries — the target's own record by its native id. Mirrors
 * `@mediator/sync-engine`'s `SingleRecordReadBinding` (re-declared here to avoid a
 * cross-import; the real `ConflictDetectionContext` consumes that shape).
 */
export interface SingleRecordReadBinding {
  readonly readOperationId: string;
  readonly idParamRef: string;
}

/**
 * Resolve the target resource's **single-record GET** (a GET whose last path segment
 * is a parameter — the by-id read, the complement of the collection read), returning
 * its operation id + the native-id path parameter to fill, or `undefined` when the
 * native id is unconfirmed or no such GET exists. Prefers the fewest path parameters
 * (a top-level `/tasks/{id}` over a nested read), then the shortest path.
 *
 * The chosen id parameter is the operation's **last path parameter** (the record's own
 * id; any leading path params are the constant-parameter-binding open question — see
 * the report). `idParamRef` is the bare parameter name: the reader resolves it within
 * the single known `readOperationId`.
 */
export function resolveSingleRecordReadBinding(
  targetGroup: IrResourceGroup,
  targetBinding: ResourceBinding,
): SingleRecordReadBinding | undefined {
  if (!isRefConfirmed(targetBinding.nativeIdRef)) {
    return undefined;
  }
  const operation = pickSingleRecordRead(targetGroup);
  if (operation === undefined) {
    return undefined;
  }
  const idParam = lastPathParameter(operation);
  if (idParam === undefined) {
    return undefined;
  }
  return { readOperationId: operation.operationId, idParamRef: idParam };
}

function pickSingleRecordRead(group: IrResourceGroup): IrOperation | undefined {
  const candidates = group.operations.filter(
    (operation) => operation.method === "get" && lastSegmentIsParameter(operation.path),
  );
  const sorted = [...candidates].sort(
    (a, b) =>
      pathParameterCount(a.path) - pathParameterCount(b.path) ||
      segmentCount(a.path) - segmentCount(b.path) ||
      a.path.localeCompare(b.path),
  );
  return sorted[0];
}

/** The wire shape of a resolved single-record read (what {@link RestSingleRecordTargetReader} issues). */
export interface ResolvedSingleRecordRead {
  readonly baseUrl: string;
  readonly method: HttpMethod;
  readonly pathTemplate: string;
  readonly idLocation: ParameterLocation;
  readonly limits?: OutboundLoadLimits;
}

/**
 * Resolve a {@link SingleRecordReadBinding} against the target IR + app into the wire
 * shape a read issues, or `undefined` when the operation / id parameter cannot be
 * resolved (never a fabricated call). Pure — the repo-backed
 * {@link RepoSingleRecordReadResolver} loads the IR + app + `ResourceBinding` and calls this.
 *
 * SS-4.3 / SS-8.3 — the returned `pathTemplate` has every **scope** (non-record-id) path
 * parameter substituted from the resource's confirmed `constant` bindings (`targetBinding`)
 * **or**, for a confirmed `record-derived` binding, from `capturedScope` (the change's
 * captured scope) by the binding's `sourceScopeKey`, while the **record-id** parameter
 * (`binding.idParamRef` — the by-id read's own id parameter, the most-specific/last path
 * param) stays **templated** for the reader's per-record id-fill from the `RecordLink`. An
 * unconfirmed scope constant, or a `record-derived` param whose captured component is
 * absent, → `undefined` (SS-4.4 / SS-8.3), never a fabricated URL; the
 * {@link RestSingleRecordTargetReader} backstop then never sees a literal `{owner}`.
 *
 * `capturedScope` is omitted for a non-scoped / constant-only read — the fill is then
 * constant-only, unchanged from SS-4.
 */
export function resolveSingleRecordRead(input: {
  readonly binding: SingleRecordReadBinding;
  readonly targetGroup: IrResourceGroup;
  readonly baseUrl: string;
  readonly limits?: OutboundLoadLimits;
  /** The resource's `ResourceBinding` — its confirmed `constant` scope bindings fill the non-id path params. */
  readonly targetBinding?: ResourceBinding;
  /** The change's captured scope — fills a `record-derived` scope param by its `sourceScopeKey` (SS-8.3). */
  readonly capturedScope?: CapturedScope;
}): ResolvedSingleRecordRead | undefined {
  const operation = findOperationById(input.targetGroup, input.binding.readOperationId);
  if (operation === undefined) {
    return undefined;
  }
  const method = toHttpMethod(operation.method);
  if (method === undefined) {
    return undefined;
  }
  const parameter = operation.parameters.find((param) => param.name === input.binding.idParamRef);
  if (parameter === undefined) {
    return undefined;
  }
  const idLocation = toParameterLocation(parameter);
  if (idLocation === undefined) {
    return undefined; // an id in a cookie is not fillable.
  }
  const scopePathBindings = input.targetBinding?.scopePathBindings ?? [];
  const recordDerivedValues =
    input.capturedScope !== undefined
      ? resolveRecordDerivedScopeValues(scopePathBindings, input.capturedScope)
      : undefined;
  const pathTemplate = fillScopePathParameters(
    operation.path,
    scopePathBindings,
    // The record-id parameter stays templated only when it is IN the path (a query/header
    // id leaves ALL path params as scope); the reader fills the id location downstream.
    idLocation.in === "path" ? input.binding.idParamRef : undefined,
    recordDerivedValues,
  );
  if (pathTemplate === undefined) {
    // SS-4.4 / SS-8.3 — an unconfirmed scope constant or a missing captured component
    // never fabricates a URL.
    return undefined;
  }
  return stripUndefined({
    baseUrl: input.baseUrl,
    method,
    pathTemplate,
    idLocation,
    limits: input.limits,
  });
}

// ── Path helpers (shared with the ir heuristics) ───────────────────────────────

function lastSegmentIsParameter(path: string): boolean {
  const segments = pathSegments(path);
  const last = segments[segments.length - 1];
  return last !== undefined && last.startsWith("{");
}

function lastPathParameter(operation: IrOperation): string | undefined {
  const pathParams = operation.parameters.filter((parameter) => parameter.location === "path");
  const last = pathParams[pathParams.length - 1];
  return last?.name;
}

function pathParameterCount(path: string): number {
  return pathSegments(path).filter((segment) => segment.startsWith("{")).length;
}

function segmentCount(path: string): number {
  return pathSegments(path).length;
}

function pathSegments(path: string): string[] {
  return path.split("/").filter((segment) => segment.length > 0);
}

// ── Direction resolution (which side of the pair the rule polls / writes) ──────

/** One side of a canonical `resourcePairRef` token: `appId:resourceRef`. */
interface ResourcePairSide {
  readonly appId: string;
  readonly resourceRef: string;
}

/**
 * Parse a canonical `resourcePairRef` (`appId:resourceRef|appId:resourceRef`, ordered
 * by a stable key — see `derive.ts` `canonicalResourcePairRef`) into its two sides.
 * `appId` is UUID-shaped (no `:`) and `resourceRef` is a path noun (no `:`/`|`), so the
 * first `:` and the single `|` split unambiguously.
 */
function parseResourcePairRef(
  ref: string,
): readonly [ResourcePairSide, ResourcePairSide] | undefined {
  const tokens = ref.split("|");
  if (tokens.length !== 2) {
    return undefined;
  }
  const a = parseSide(tokens[0]);
  const b = parseSide(tokens[1]);
  return a !== undefined && b !== undefined ? [a, b] : undefined;
}

function parseSide(token: string | undefined): ResourcePairSide | undefined {
  if (token === undefined) {
    return undefined;
  }
  const colon = token.indexOf(":");
  if (colon <= 0 || colon >= token.length - 1) {
    return undefined;
  }
  return { appId: token.slice(0, colon), resourceRef: token.slice(colon + 1) };
}

/** The source/target resource refs of a rule's pair, matched to the mapping's directional app ids. */
function directionalResourceRefs(
  resourcePairRef: string,
  mapping: ApprovedMapping,
): { readonly sourceResourceRef: string; readonly targetResourceRef: string } | undefined {
  const sides = parseResourcePairRef(resourcePairRef);
  if (sides === undefined) {
    return undefined;
  }
  const [first, second] = sides;
  const source = first.appId === mapping.sourceAppId ? first : second;
  const target = first.appId === mapping.targetAppId ? first : second;
  // Guard the degenerate self-pair (same app on both sides): the app id cannot then
  // disambiguate source from target, so refuse rather than pick arbitrarily.
  if (source.appId !== mapping.sourceAppId || target.appId !== mapping.targetAppId) {
    return undefined;
  }
  if (mapping.sourceAppId === mapping.targetAppId && source.resourceRef === target.resourceRef) {
    return undefined;
  }
  return { sourceResourceRef: source.resourceRef, targetResourceRef: target.resourceRef };
}

function findResourceGroup(spec: ApiSpec, resourceRef: string): IrResourceGroup | undefined {
  return spec.parsedIR.find((group) => group.resourceRef === resourceRef);
}

function findBinding(
  bindings: readonly ResourceBinding[],
  resourceRef: string,
): ResourceBinding | undefined {
  return bindings.find((binding) => binding.resourceRef === resourceRef);
}

// ── Repo-backed resolvers (the composition-root wiring) ────────────────────────

/** The repository ports the repo-backed resolvers load their inputs through. */
export interface BindingResolverRepositories {
  readonly syncRules: SyncRuleReader;
  readonly approvedMappings: ApprovedMappingReader;
  readonly apiSpecs: ApiSpecReader;
  readonly resourceBindings: ResourceBindingReader;
  readonly registeredApps: RegisteredAppReader;
}

/**
 * The **real** {@link RestSourceBindingResolver} the Poller's `RestSourceReader`
 * consumes (SP deferred it to "the composition seam"): it loads the rule → mapping →
 * source `ApiSpec.parsedIR` + `ResourceBinding` + `RegisteredApp`, resolves the source
 * side of the pair, and composes the {@link RestSourceReadBinding} via
 * {@link resolveSourceReadBinding}. Returns `undefined` for any missing/unconfirmed
 * required input — never a fabricated binding.
 */
export class RepoRestSourceBindingResolver implements RestSourceBindingResolver {
  readonly #repos: BindingResolverRepositories;
  readonly #options: BindingResolverOptions | undefined;

  public constructor(repos: BindingResolverRepositories, options?: BindingResolverOptions) {
    this.#repos = repos;
    this.#options = options;
  }

  public async resolve(ruleId: string): Promise<RestSourceReadBinding | undefined> {
    const rule = await this.#repos.syncRules.getById(ruleId);
    if (rule === undefined) {
      return undefined;
    }
    const mapping = await this.#repos.approvedMappings.getById(rule.approvedMappingId);
    if (mapping === undefined) {
      return undefined;
    }
    const refs = directionalResourceRefs(rule.resourcePairRef, mapping);
    if (refs === undefined) {
      return undefined;
    }
    const sourceApp = await this.#repos.registeredApps.getById(mapping.sourceAppId);
    if (sourceApp?.baseUrl === undefined) {
      // A sync source is a PROVIDER with a reachable base URL; absent → cannot poll.
      return undefined;
    }
    const sourceSpec = await this.#repos.apiSpecs.getById(mapping.sourceSpecId);
    if (sourceSpec === undefined) {
      return undefined;
    }
    const sourceGroup = findResourceGroup(sourceSpec, refs.sourceResourceRef);
    if (sourceGroup === undefined) {
      return undefined;
    }
    const bindings = await this.#repos.resourceBindings.listByApiSpecId(mapping.sourceSpecId);
    const sourceBinding = findBinding(bindings, refs.sourceResourceRef);
    if (sourceBinding === undefined) {
      return undefined;
    }
    return resolveSourceReadBinding(
      stripUndefined({
        rule,
        sourceAppId: mapping.sourceAppId,
        baseUrl: sourceApp.baseUrl,
        limits: sourceApp.outboundLimits,
        sourceCapabilities: sourceApp.capabilities,
        sourceGroup,
        sourceBinding,
      }),
      this.#options,
    );
  }
}

/**
 * Resolves a `SingleRecordReadBinding` for a target app into the wire shape a read
 * issues — the seam {@link RestSingleRecordTargetReader} depends on (injected so the
 * reader is unit-testable without repos). The `binding.readOperationId` is resolved
 * against the target app's **active PROVIDER** spec that contains it.
 */
export interface SingleRecordReadResolver {
  resolve(
    targetAppId: string,
    binding: SingleRecordReadBinding,
    /** The change's captured scope — fills a `record-derived` scope param on a scoped read (SS-8.3). */
    capturedScope?: CapturedScope,
  ): Promise<ResolvedSingleRecordRead | undefined>;
}

/**
 * The real {@link SingleRecordReadResolver}, loading the target app's active PROVIDER spec
 * **and** the containing resource's `ResourceBinding` — the latter's confirmed `constant`
 * scope bindings fill the read's non-record-id path parameters (SS-4.3), keyed to whichever
 * app `resolve` is pointed at (the target for a CF read; the source for an SA-4.2 re-read).
 */
export class RepoSingleRecordReadResolver implements SingleRecordReadResolver {
  readonly #apiSpecs: ApiSpecReader;
  readonly #registeredApps: RegisteredAppReader;
  readonly #resourceBindings: ResourceBindingReader;

  public constructor(
    apiSpecs: ApiSpecReader,
    registeredApps: RegisteredAppReader,
    resourceBindings: ResourceBindingReader,
  ) {
    this.#apiSpecs = apiSpecs;
    this.#registeredApps = registeredApps;
    this.#resourceBindings = resourceBindings;
  }

  public async resolve(
    targetAppId: string,
    binding: SingleRecordReadBinding,
    capturedScope?: CapturedScope,
  ): Promise<ResolvedSingleRecordRead | undefined> {
    const app = await this.#registeredApps.getById(targetAppId);
    if (app?.baseUrl === undefined) {
      return undefined;
    }
    const specs = await this.#apiSpecs.listByAppId(targetAppId);
    for (const spec of specs) {
      if (spec.role !== "PROVIDER" || spec.status !== "active") {
        continue;
      }
      for (const group of spec.parsedIR) {
        if (findOperationById(group, binding.readOperationId) === undefined) {
          continue;
        }
        const bindings = await this.#resourceBindings.listByApiSpecId(spec.id);
        const resourceBinding = findBinding(bindings, group.resourceRef);
        const resolved = resolveSingleRecordRead(
          stripUndefined({
            binding,
            targetGroup: group,
            baseUrl: app.baseUrl,
            limits: app.outboundLimits,
            targetBinding: resourceBinding,
            capturedScope,
          }),
        );
        if (resolved !== undefined) {
          return resolved;
        }
      }
    }
    return undefined;
  }
}
