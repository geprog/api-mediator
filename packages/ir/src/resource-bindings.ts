import { randomUUID } from "node:crypto";

import type {
  AppCapabilities,
  ConfirmableRef,
  IrField,
  IrOperation,
  Ir,
  IrRefTarget,
  IrResourceGroup,
  ResourceBinding,
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
  });
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
  return last !== undefined && last.startsWith("{");
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
