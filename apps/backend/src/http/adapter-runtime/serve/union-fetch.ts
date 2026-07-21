import type { IrOperation, OutboundLoadLimits } from "@mediator/domain";
import type { RestPaginationConvention } from "@mediator/outbound";
import { readPath, type JsonValue } from "@mediator/transform";

import type { BackendCaller } from "./backend-call.js";
import type { MappedBackendRequest, WireParam } from "./request-mapping.js";

/**
 * **AG-5 — the bounded, paged union collection fetch.** For one contributing binding it
 * pages the backend's collection read through the resource's confirmed
 * `ResourceBinding.paginationRef` convention **up to a per-request row ceiling**, capturing
 * each row's backend-native id (TE-4 provenance, read from the raw response *before* the
 * response-phase transform) for AG-3 dedup.
 *
 * It reuses the adapter's own governed, credentialed TE-2 call primitive — the shared
 * {@link BackendCaller} (the same per-app {@link import("@mediator/outbound").AppLoadGovernor}
 * every backend page reserves a slot on) — rather than a second outbound path, so a union
 * page competes with sync + single/fanout adapter traffic for the one ceiling per backend.
 * The paging discipline mirrors the sync `RestSourceReader`: **exhaustion is an EMPTY page**
 * (never a short one — a server may clamp a full page), and an offset advances by the
 * **actual** received count.
 *
 * **Fail loud, never truncate (AG-5.2).** When the accumulated rows exceed the ceiling the
 * read fails with a distinct `ceiling-exceeded` outcome naming the backend and the ceiling —
 * a truncated union is exactly the plausible-but-wrong answer the concept forbids.
 */

/** One contributing binding's paged read request. */
export interface UnionCollectionReadInput {
  readonly backendAppId: string;
  readonly baseUrl: string;
  /** The backend collection-read operation (the binding's `backendOperationId`). */
  readonly operation: IrOperation;
  /** The TE-1 mapped request — pushed-down filter params (AG-4.1) + any mapped body. */
  readonly baseRequest: MappedBackendRequest;
  /** The confirmed pagination convention (`single-page` when the read returns one response). */
  readonly pagination: RestPaginationConvention;
  /** Where the records array lives in the response, or `undefined` when the body IS the array. */
  readonly recordsPath: string | undefined;
  /** The record-relative native-id field path (confirmed `nativeIdRef`), or `undefined`. */
  readonly nativeIdFieldPath: string | undefined;
  /** The per-request row ceiling (AG-5.1) — the fetch is never unbounded. */
  readonly rowCeiling: number;
  readonly limits?: OutboundLoadLimits;
}

/** A union read's outcome. `ceiling-exceeded` is its own kind so AG-5.5 telemetry stays distinct. */
export type UnionCollectionReadResult =
  | {
      readonly ok: true;
      readonly rows: readonly JsonValue[];
      /** Index-aligned with `rows`; `undefined` per row where the native id is absent/unconfirmed. */
      readonly nativeIds: readonly (string | undefined)[];
    }
  | { readonly ok: false; readonly kind: "upstream-error"; readonly detail: string }
  | { readonly ok: false; readonly kind: "ceiling-exceeded"; readonly detail: string }
  | { readonly ok: false; readonly kind: "defect"; readonly detail: string };

/** The port the serve handler fetches a union contributor through (faked in unit tests). */
export interface UnionCollectionReader {
  read(input: UnionCollectionReadInput): Promise<UnionCollectionReadResult>;
}

/** The default per-request union row ceiling (AG-5.1) — a config-defined bound, overridable. */
export const DEFAULT_UNION_ROW_CEILING = 10_000;

type PageState =
  { readonly kind: "single-page" } | { readonly kind: "numeric"; readonly value: number };

/** The real reader: pages via the shared governed/credentialed {@link BackendCaller} (TE-2). */
export class RestUnionCollectionReader implements UnionCollectionReader {
  readonly #caller: BackendCaller;

  public constructor(caller: BackendCaller) {
    this.#caller = caller;
  }

  public async read(input: UnionCollectionReadInput): Promise<UnionCollectionReadResult> {
    const rows: JsonValue[] = [];
    const nativeIds: (string | undefined)[] = [];
    let page = initialPage(input.pagination);

    for (;;) {
      const queryParams: WireParam[] = [
        ...input.baseRequest.queryParams,
        ...pageParams(input.pagination, page),
      ];
      const call = await this.#caller.call({
        targetAppId: input.backendAppId,
        baseUrl: input.baseUrl,
        operation: input.operation,
        mapped: { ...input.baseRequest, queryParams },
        ...(input.limits !== undefined ? { limits: input.limits } : {}),
      });
      if (!call.ok) {
        // A live backend failure is droppable (AG-3.2); a non-servable operation is a
        // mediator-side defect. Preserve the distinction the caller drew.
        return call.kind === "upstream-error"
          ? { ok: false, kind: "upstream-error", detail: call.detail }
          : { ok: false, kind: "defect", detail: call.detail };
      }

      const extracted = extractRows(call.body, input.recordsPath, input.nativeIdFieldPath);
      if (!extracted.ok) {
        return { ok: false, kind: "defect", detail: extracted.detail };
      }
      for (const row of extracted.rows) {
        rows.push(row.value);
        nativeIds.push(row.nativeId);
      }

      // AG-5.2 — never truncate: exceeding the ceiling fails loud, naming backend + ceiling.
      if (rows.length > input.rowCeiling) {
        return {
          ok: false,
          kind: "ceiling-exceeded",
          detail: `backend app ${input.backendAppId} exceeded the union row ceiling of ${String(
            input.rowCeiling,
          )}`,
        };
      }

      const next = advancePage(input.pagination, page, extracted.rows.length);
      if (next === undefined) {
        break;
      }
      page = next;
    }

    return { ok: true, rows, nativeIds };
  }
}

function initialPage(pagination: RestPaginationConvention): PageState {
  if (pagination.kind === "single-page") {
    return { kind: "single-page" };
  }
  return { kind: "numeric", value: pagination.kind === "offset" ? 0 : pagination.startPage };
}

function pageParams(pagination: RestPaginationConvention, page: PageState): WireParam[] {
  if (pagination.kind === "single-page" || page.kind === "single-page") {
    return [];
  }
  const params: WireParam[] = [];
  if (pagination.kind === "offset") {
    params.push({ name: pagination.offsetParam, value: String(page.value) });
    if (pagination.limitParam !== undefined) {
      params.push({ name: pagination.limitParam, value: String(pagination.pageSize) });
    }
  } else {
    params.push({ name: pagination.pageParam, value: String(page.value) });
    if (pagination.limitParam !== undefined) {
      params.push({ name: pagination.limitParam, value: String(pagination.pageSize) });
    }
  }
  return params;
}

/** The next page position, or `undefined` when the read is exhausted (an EMPTY page ends it). */
function advancePage(
  pagination: RestPaginationConvention,
  page: PageState,
  received: number,
): PageState | undefined {
  if (pagination.kind === "single-page" || page.kind === "single-page") {
    return undefined;
  }
  if (received === 0) {
    return undefined;
  }
  const nextValue = pagination.kind === "offset" ? page.value + received : page.value + 1;
  return { kind: "numeric", value: nextValue };
}

interface ExtractedRow {
  readonly value: JsonValue;
  readonly nativeId: string | undefined;
}

/**
 * Extract the records array and each row's native id from one page body. Returns a defect
 * (never a silently-empty page) when the records location is not an array — a malformed
 * body must never masquerade as an exhausted collection.
 */
function extractRows(
  body: JsonValue | undefined,
  recordsPath: string | undefined,
  nativeIdFieldPath: string | undefined,
):
  | { readonly ok: true; readonly rows: ExtractedRow[] }
  | { readonly ok: false; readonly detail: string } {
  let array: JsonValue | undefined;
  if (recordsPath === undefined) {
    array = body;
  } else {
    const read = readPath(body ?? null, recordsPath);
    array = read.present ? read.value : undefined;
  }
  if (!Array.isArray(array)) {
    return {
      ok: false,
      detail: `union collection response is not an array at '${recordsPath ?? "<body>"}'`,
    };
  }
  const rows: ExtractedRow[] = array.map((value) => ({
    value,
    nativeId: nativeIdFieldPath === undefined ? undefined : readNativeId(value, nativeIdFieldPath),
  }));
  return { ok: true, rows };
}

/** Read a row's backend-native id (a scalar) via the confirmed field path, else `undefined`. */
function readNativeId(row: JsonValue, nativeIdFieldPath: string): string | undefined {
  const read = readPath(row, nativeIdFieldPath);
  if (!read.present) {
    return undefined;
  }
  const value = read.value;
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return undefined;
}
