import type { ConfirmableRef, IrOperation } from "@mediator/domain";
import type { RestPaginationConvention } from "@mediator/outbound";

/**
 * **Pure derivation of a union contributor's backend read conventions from its confirmed
 * `ResourceBinding` refs** (AG-5.1 / TE-4.3). Kept local to the adapter serve pipeline —
 * rather than widening the `@mediator/outbound` binding-resolver surface — and deliberately
 * **mirrors** the sync `RestSourceReader`'s pagination/records-path heuristic (the same
 * offset-vs-page-number param spellings, the same "the native-id field decides whether the
 * body IS the array" rule) so the two never diverge on what a paginationRef means. (A shared
 * extraction is a reasonable follow-up; see the report.)
 *
 * **Never fabricate from an unconfirmed ref** (the `ResourceBinding` invariant): an absent
 * `paginationRef` is the *confirmed-absence* `single-page` case (one response is the whole
 * collection), while a present-but-**unconfirmed** ref is `"unresolved"` — a composition
 * defect CO-3.7 blocks, surfaced loudly at request time if it somehow slips through.
 */

// The same conservative param-name spellings the sync binding resolver classifies by.
const OFFSET_PARAM_NAMES: ReadonlySet<string> = new Set([
  "offset",
  "start",
  "startindex",
  "start_index",
  "skip",
]);
const PAGE_NUMBER_PARAM_NAMES: ReadonlySet<string> = new Set(["page", "pagenumber", "page_number"]);
const LIMIT_PARAM_NAMES: ReadonlySet<string> = new Set([
  "limit",
  "per_page",
  "perpage",
  "pagesize",
  "page_size",
  "size",
  "count",
  "maxresults",
  "max_results",
]);

/** The default requested page size / first page — the un-persistable execution detail. */
const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_START_PAGE = 1;

function normalize(name: string): string {
  return name.toLowerCase();
}

/** A ref is confirmed iff present with **both** confirmation stamps set (mirrors the gate). */
function isConfirmed(ref: ConfirmableRef | undefined): boolean {
  return ref !== undefined && ref.confirmedBy !== null && ref.confirmedAt !== null;
}

/** The confirmed `field`-kind ref's path (record-relative), else `undefined`. */
export function confirmedNativeIdFieldPath(ref: ConfirmableRef | undefined): string | undefined {
  if (!isConfirmed(ref) || ref === undefined) {
    return undefined;
  }
  return ref.value.kind === "field" ? ref.value.path : undefined;
}

/**
 * The confirmed pagination convention for a union contributor's collection read:
 *  - **absent** `paginationRef` → `single-page` (the read returns one response, AG-5.3);
 *  - present-but-**unconfirmed** (or a non-parameter / unclassifiable guess) → `"unresolved"`
 *    (never fabricate a paging convention from an unratified ref);
 *  - a confirmed offset / page-number parameter → the matching convention, with a sibling
 *    limit parameter (if the operation exposes one) as the requested batch size.
 */
export function deriveUnionPagination(
  paginationRef: ConfirmableRef | undefined,
  operation: IrOperation,
): RestPaginationConvention | "unresolved" {
  if (paginationRef === undefined) {
    return { kind: "single-page" };
  }
  if (!isConfirmed(paginationRef) || paginationRef.value.kind !== "parameter") {
    return "unresolved";
  }
  const paramName = paginationRef.value.parameter;
  const limitParam = findLimitParam(operation, paramName);
  const normalized = normalize(paramName);
  if (OFFSET_PARAM_NAMES.has(normalized)) {
    return limitParam === undefined
      ? { kind: "offset", offsetParam: paramName, pageSize: DEFAULT_PAGE_SIZE }
      : { kind: "offset", offsetParam: paramName, limitParam, pageSize: DEFAULT_PAGE_SIZE };
  }
  if (PAGE_NUMBER_PARAM_NAMES.has(normalized)) {
    return limitParam === undefined
      ? {
          kind: "page-number",
          pageParam: paramName,
          pageSize: DEFAULT_PAGE_SIZE,
          startPage: DEFAULT_START_PAGE,
        }
      : {
          kind: "page-number",
          pageParam: paramName,
          limitParam,
          pageSize: DEFAULT_PAGE_SIZE,
          startPage: DEFAULT_START_PAGE,
        };
  }
  return "unresolved";
}

/** A sibling limit-like parameter of the operation (distinct from the paging param), if any. */
function findLimitParam(operation: IrOperation, pagingParam: string): string | undefined {
  const match = operation.parameters.find(
    (parameter) =>
      parameter.name !== pagingParam && LIMIT_PARAM_NAMES.has(normalize(parameter.name)),
  );
  return match?.name;
}

const WRAPPER_FIELD_NAMES = ["data", "items", "results", "records", "content", "values", "list"];

/**
 * Where the records array lives in the collection response, or `undefined` when the body IS
 * the array. When the response schema carries the record's own native-id field at top level
 * the schema is the item representation (a top-level array the IR unwrapped) → the body is
 * the array; otherwise the collection lives in a well-known wrapper array field, else the
 * first array-typed field. With no confirmed native-id field this cannot be decided from the
 * schema, so it returns `undefined` and the reader falls back to "the body is the array".
 */
export function deriveUnionRecordsPath(
  operation: IrOperation,
  nativeIdFieldPath: string | undefined,
): string | undefined {
  const fields = operation.responseSchema?.fields ?? [];
  if (nativeIdFieldPath !== undefined) {
    const head = nativeIdFieldPath.split(".")[0];
    if (head !== undefined && fields.some((field) => field.name === head)) {
      return undefined; // the response schema is the record item itself (unwrapped array).
    }
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

function isArrayType(type: string | undefined): boolean {
  return type !== undefined && (type.endsWith("[]") || type === "array");
}
