import { randomUUID } from "node:crypto";

import type {
  AppCapabilities,
  ConfirmableRef,
  IrField,
  IrOperation,
  IrParameter,
  Ir,
  IrRefTarget,
  IrResourceGroup,
  ResourceBinding,
  ScopePathBinding,
} from "@mediator/domain";
import { stripUndefined } from "@mediator/domain";

/**
 * Derive one **unconfirmed** {@link ResourceBinding} per IR resource group (RB-1).
 *
 * OpenAPI declares no convention for record ids, collection reads, pagination,
 * delta cursors, deletion reporting, or change timestamps, so each ref is guessed
 * mechanically from the IR and left unconfirmed (`confirmedBy = null`,
 * `confirmedAt = null`) for an operator to ratify (RB-2). Capability-gated refs
 * are only derived when the owning app declares the capability:
 *
 * - `changeTimestampRef` — only when `capabilities.supportsChangeTimestamps`.
 * - `deltaCursorRef` / `deltaDeletionRef` — only when `capabilities.supportsDeltaQuery`
 *   *and* the resource actually offers the corresponding element.
 *
 * A ref is **omitted** (absent key) whenever the heuristic finds no target or the
 * capability is not declared — never emitted as an unconfirmed guess that could
 * not resolve.
 *
 * `apiSpecId` is required because a `ResourceBinding` names its owning spec, which
 * the IR does not carry. Each binding is given a fresh `id`; the persistence layer
 * may keep or reassign it.
 */
export function deriveResourceBindings(
  ir: Ir,
  capabilities: AppCapabilities,
  apiSpecId: string,
): ResourceBinding[] {
  return ir.map((group) => deriveBinding(group, capabilities, apiSpecId));
}

// Heuristic field/parameter name lists, in preference order. Implementation-
// defined (the concept only gives examples); the first present name wins.
const NATIVE_ID_FIELD_NAMES = ["id", "uuid", "uid", "_id", "guid"];
const CHANGE_TIMESTAMP_FIELD_NAMES = [
  "updatedAt",
  "updated_at",
  "updated",
  "modifiedAt",
  "modified_at",
  "modified",
  "lastModified",
  "last_modified",
];
const DELETION_MARKER_FIELD_NAMES = [
  "deletedAt",
  "deleted_at",
  "deleted",
  "isDeleted",
  "is_deleted",
  "removed",
];
const PAGINATION_PARAM_NAMES = [
  "cursor",
  "nextCursor",
  "next_cursor",
  "pageToken",
  "page_token",
  "page",
  "pageNumber",
  "page_number",
  "offset",
  "start",
  "startIndex",
  "start_index",
  "skip",
  "limit",
  "per_page",
  "perPage",
  "pageSize",
  "page_size",
  "size",
];
const DELTA_CURSOR_PARAM_NAMES = [
  "since",
  "updatedSince",
  "updated_since",
  "changedSince",
  "changed_since",
  "modifiedSince",
  "modified_since",
  "sinceId",
  "since_id",
  "updatedAfter",
  "updated_after",
  "cursor",
];

function deriveBinding(
  group: IrResourceGroup,
  capabilities: AppCapabilities,
  apiSpecId: string,
): ResourceBinding {
  const collectionRead = pickCollectionRead(group.operations);
  const representationFields = pickRepresentationFields(group, collectionRead);

  const collectionReadRef = collectionRead
    ? unconfirmed({ kind: "operation", operationId: collectionRead.operationId })
    : undefined;
  const paginationRef = collectionRead
    ? parameterRef(collectionRead, PAGINATION_PARAM_NAMES)
    : undefined;
  const changeTimestampRef = capabilities.supportsChangeTimestamps
    ? fieldRef(representationFields, CHANGE_TIMESTAMP_FIELD_NAMES)
    : undefined;
  // `paginationRef` takes precedence over `deltaCursorRef`: `"cursor"` is a
  // candidate for both (an opaque paging cursor vs. a changed-since delta
  // watermark are different things), so the single parameter already claimed as
  // the pagination cursor is excluded here — a delta watermark must come from a
  // distinct parameter (`since`/`updatedSince`/…). This keeps one parameter from
  // being confusingly assigned to both refs of the same resource.
  const paginationParam = parameterNameOf(paginationRef);
  const deltaCursorRef =
    capabilities.supportsDeltaQuery && collectionRead
      ? parameterRef(
          collectionRead,
          DELTA_CURSOR_PARAM_NAMES,
          paginationParam === undefined ? undefined : new Set([paginationParam]),
        )
      : undefined;
  const deltaDeletionRef = capabilities.supportsDeltaQuery
    ? fieldRef(representationFields, DELETION_MARKER_FIELD_NAMES)
    : undefined;

  return stripUndefined({
    id: randomUUID(),
    apiSpecId,
    resourceRef: group.resourceRef,
    nativeIdRef: fieldRef(representationFields, NATIVE_ID_FIELD_NAMES),
    collectionReadRef,
    paginationRef,
    changeTimestampRef,
    deltaCursorRef,
    deltaDeletionRef,
    scopePathBindings: deriveScopePathBindings(group),
  });
}

// ── scopePathBindings derivation (SS-2) ──────────────────────────────────────

/**
 * Derive the resource's **scope** path-parameter set (SS-2): enumerate the path
 * parameters across the resource's operations, subtract each operation's
 * record-id parameter, and emit one **unconfirmed** `constant` entry per
 * remaining distinct scope-parameter name (SS-2 criterion 1). A param-free
 * resource yields an empty collection (SS-1 criterion 1).
 *
 * ## Record-id vs. scope classification (per operation, action-aware)
 *
 * A *scope* parameter locates a record's **container**, so it sits **before** the
 * resource in the path hierarchy; the *record-id* parameter identifies a record
 * *of* the resource and sits at/after it. We split each operation's path at its
 * **resource segment** — the last path segment equal to the group's
 * `resourceRef` noun (the same noun the decomposer groups by) — and take the path
 * parameters appearing **before** it as scope parameters:
 *
 * - a **collection read/list** (`GET /repos/{owner}/{repo}/issues`) ends at the
 *   resource segment → every path parameter is before it → all are scope, and it
 *   has no record-id parameter;
 * - a **by-id read/update/delete** (`… /issues/{index}`) has its record-id
 *   (`{index}`) *after* the resource segment → only `{owner}`/`{repo}` are scope;
 * - a **create** (`PUT /projects/{id}/tasks`) ends at the resource segment
 *   (`tasks`) with its container `{id}` before it → `{id}` is a **scope**
 *   parameter, not a record id (SS-2 criterion 4);
 * - a **sub-resource action** merged into the group (`… /issues/{index}/lock`)
 *   still has `{index}` at/after the resource segment → it is treated as the
 *   record id and excluded, so `{index}` is never mis-derived as scope
 *   (SS-2 criterion 3).
 *
 * Because the set is the union of per-operation scope parameters, one resource
 * can scope asymmetrically across its operations (Vikunja `tasks` gets `id`
 * from its create op alone — SS-2 criterion 4). When the group's `resourceRef`
 * is not a path segment (a `tags`/prefix fallback group), we fall back to
 * treating the most-specific trailing path parameter as the record id.
 *
 * Each entry starts unconfirmed (`confirmedBy`/`confirmedAt` null) with an empty
 * `value`, or a **heuristic candidate** pre-filled from a single-value
 * `enum`/`default`/`example` hint — still unconfirmed, so used nowhere (SS-2
 * criteria 2, 5).
 */
function deriveScopePathBindings(group: IrResourceGroup): ScopePathBinding[] {
  return collectScopeParameterNames(group).map((parameterName) => ({
    kind: "constant",
    parameterName,
    value: heuristicConstantCandidate(group, parameterName),
    confirmedBy: null,
    confirmedAt: null,
  }));
}

/** Distinct scope-parameter names across a group's operations, first-seen order. */
function collectScopeParameterNames(group: IrResourceGroup): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const operation of group.operations) {
    for (const name of scopeParameterNamesOf(group.resourceRef, operation)) {
      if (!seen.has(name)) {
        seen.add(name);
        ordered.push(name);
      }
    }
  }
  return ordered;
}

/** One operation's scope path-parameter names (see {@link deriveScopePathBindings}). */
function scopeParameterNamesOf(resourceRef: string, operation: IrOperation): string[] {
  const segments = pathSegments(operation.path);
  const resourceIndex = segments.lastIndexOf(resourceRef);
  // Path parameters strictly before the resource segment are scope. With no
  // resource segment (a fallback group), subtract only the most-specific
  // trailing record-id parameter (a by-id op) — otherwise take all.
  const upperBound =
    resourceIndex >= 0
      ? resourceIndex
      : lastSegmentIsParameter(operation.path)
        ? segments.length - 1
        : segments.length;

  const pathParameterNames = new Set(
    operation.parameters
      .filter((parameter) => parameter.location === "path")
      .map((parameter) => parameter.name),
  );

  const names: string[] = [];
  for (let i = 0; i < upperBound; i++) {
    const segment = segments[i];
    if (segment === undefined || !isParameterSegment(segment)) continue;
    const name = parameterNameOfSegment(segment);
    // Only real path parameters of the operation qualify (defensive: a `{…}`
    // segment always resolves to a declared path parameter in the IR).
    if (pathParameterNames.has(name)) names.push(name);
  }
  return names;
}

/**
 * A pre-fill **candidate** for a scope constant, or `""` when the IR carries no
 * single-value hint. Priority: a single-value `enum` pins the value most
 * strongly, then a schema `default`, then an `example`; a multi-value `enum` is
 * not a candidate. Always returned **unconfirmed** by the caller.
 */
function heuristicConstantCandidate(group: IrResourceGroup, parameterName: string): string {
  for (const operation of group.operations) {
    const parameter = operation.parameters.find(
      (candidate) => candidate.location === "path" && candidate.name === parameterName,
    );
    if (parameter === undefined) continue;
    const hint = singleValueHint(parameter);
    if (hint !== undefined) return hint;
  }
  return "";
}

/** A path parameter's single-value hint, if any (see {@link heuristicConstantCandidate}). */
function singleValueHint(parameter: IrParameter): string | undefined {
  const enumValues = parameter.enumValues;
  if (enumValues !== undefined && enumValues.length === 1) {
    const [only] = enumValues;
    if (only !== undefined && only.length > 0) return only;
  }
  if (parameter.default !== undefined && parameter.default.length > 0) return parameter.default;
  if (parameter.example !== undefined && parameter.example.length > 0) return parameter.example;
  return undefined;
}

/**
 * The resource's collection (list) read: the GET operation whose path does *not*
 * end in a path parameter (a list endpoint, not a single-record read), preferring
 * the fewest path parameters (a root/global collection over a nested one), then
 * the shortest path, then lexicographic order for a stable tiebreak. Absent when
 * the group offers no such GET.
 */
function pickCollectionRead(operations: readonly IrOperation[]): IrOperation | undefined {
  const candidates = operations.filter(
    (operation) => operation.method === "get" && !lastSegmentIsParameter(operation.path),
  );
  const sorted = [...candidates].sort(
    (a, b) =>
      pathParameterCount(a.path) - pathParameterCount(b.path) ||
      segmentCount(a.path) - segmentCount(b.path) ||
      a.path.localeCompare(b.path),
  );
  return sorted[0];
}

/**
 * The fields of the resource's element representation, used to guess field-level
 * refs. Prefers the collection read's (item-flattened) response, then any single
 * GET's response, then the first group schema carrying a native-id-like field.
 */
function pickRepresentationFields(
  group: IrResourceGroup,
  collectionRead: IrOperation | undefined,
): readonly IrField[] {
  if (collectionRead?.responseSchema) return collectionRead.responseSchema.fields;
  const singleGet = group.operations.find(
    (operation) => operation.method === "get" && operation.responseSchema !== undefined,
  );
  if (singleGet?.responseSchema) return singleGet.responseSchema.fields;
  for (const schema of group.schemas) {
    if (schema.fields.some((field) => NATIVE_ID_FIELD_NAMES.includes(field.name))) {
      return schema.fields;
    }
  }
  return group.schemas[0]?.fields ?? [];
}

function fieldRef(
  fields: readonly IrField[],
  candidateNames: readonly string[],
): ConfirmableRef | undefined {
  for (const candidate of candidateNames) {
    const match = fields.find((field) => field.name === candidate);
    if (match) return unconfirmed({ kind: "field", path: match.name });
  }
  return undefined;
}

function parameterRef(
  operation: IrOperation,
  candidateNames: readonly string[],
  exclude?: ReadonlySet<string>,
): ConfirmableRef | undefined {
  for (const candidate of candidateNames) {
    if (exclude?.has(candidate)) continue;
    const match = operation.parameters.find((parameter) => parameter.name === candidate);
    if (match) {
      return unconfirmed({
        kind: "parameter",
        operationId: operation.operationId,
        parameter: match.name,
      });
    }
  }
  return undefined;
}

/** The parameter name a parameter ref points at, if any. */
function parameterNameOf(ref: ConfirmableRef | undefined): string | undefined {
  return ref?.value.kind === "parameter" ? ref.value.parameter : undefined;
}

function unconfirmed(value: IrRefTarget): ConfirmableRef {
  return { value, confirmedBy: null, confirmedAt: null };
}

function lastSegmentIsParameter(path: string): boolean {
  const segments = pathSegments(path);
  const last = segments[segments.length - 1];
  return last !== undefined && isParameterSegment(last);
}

/** Whether a path segment is a `{parameter}` placeholder. */
function isParameterSegment(segment: string): boolean {
  return segment.startsWith("{") && segment.endsWith("}");
}

/** The parameter name of a `{name}` path segment (its braces stripped). */
function parameterNameOfSegment(segment: string): string {
  return segment.slice(1, -1);
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
