import type { OutboundLoadLimits } from "@mediator/domain";
import type {
  DeltaOutcome,
  ObservedRecord,
  PageOutcome,
  SourceReader,
} from "@mediator/sync-engine";
import { readPath, type JsonValue } from "@mediator/transform";

import type { CredentialAccess, CredentialApplier } from "./executor.js";
import { AppLoadGovernor } from "./load-governor.js";
import { findUnfilledPathParam } from "./path-template.js";
import type {
  HttpMethod,
  OutboundRequest,
  OutboundResponse,
  ProtocolClient,
} from "./protocol-client.js";

/**
 * `RestSourceReader` — the REST implementation of the Sync Engine's {@link SourceReader}
 * seam (SP-2). It lives in `@mediator/outbound` because the source reads must obey the
 * **same OC-3 per-app load ceilings as writes** (`docs/architecture/overview.md`
 * *Outbound load discipline*; SP-2 criterion 4): every page/delta call reserves a slot
 * on the shared {@link AppLoadGovernor} and honors a `429`/`Retry-After`, exactly like
 * the {@link OutboundCallExecutor}. It reads through the same {@link ProtocolClient}
 * seam inside a {@link CredentialAccess} `withCredential` scope, so a source credential
 * never leaves that scope and never reaches a log/event.
 *
 * It sits here (not in `@mediator/sync-engine`) to respect the package graph:
 * `@mediator/outbound` already depends on `@mediator/sync-engine` (for the ordering
 * queue's `FailureDisposition`), so the reverse import would be a cycle. The Poller
 * depends only on the `SourceReader` **port**; this is one implementation of it (the
 * `FakeSourceReader` is the other).
 *
 * **Abort-on-partial discipline (SP-4).** Any transport failure, a non-2xx status, a
 * governor denial, an unparseable body (records not where the convention says), or a
 * record missing its native id makes the call return `{ ok: false }` — never a
 * silently-empty page, which the Poller would misread as mass deletion. The Poller
 * turns that into an aborted run: no cursor/snapshot advance, no false delete.
 */

/**
 * How the collection read pages (SP-2). **Exhaustion is an EMPTY page, never a short
 * one:** `pageSize`/`limitParam` are only the *requested* batch size (advisory — larger
 * = fewer requests), NEVER the exhaustion signal. A server may clamp a requested page
 * (return fewer than `pageSize` on a *full* page) or use its own natural page size, so
 * a `received < pageSize` terminator would report a truncated fetch as complete and the
 * Poller would misread the un-fetched tail as mass deletion (SP-4). Paging therefore
 * runs until a page returns **zero** records, with offset advancing by the **actual**
 * received count (never `pageSize` — advancing by a clamped-past size would skip
 * records). The Poller's `maxPages` cap bounds a non-terminating server.
 */
export type RestPaginationConvention =
  | { readonly kind: "single-page" }
  | {
      /** Offset/limit: `offset` grows by the actual page size returned; an EMPTY page ends it. */
      readonly kind: "offset";
      readonly offsetParam: string;
      readonly limitParam?: string;
      /** The requested batch size (advisory — sent via `limitParam`); NOT the exhaustion signal. */
      readonly pageSize: number;
    }
  | {
      /** 0/1-based page number: `page` increments; an EMPTY page ends it. */
      readonly kind: "page-number";
      readonly pageParam: string;
      readonly limitParam?: string;
      /** The requested batch size (advisory — sent via `limitParam`); NOT the exhaustion signal. */
      readonly pageSize: number;
      readonly startPage: number;
    };

/** How a delta response reports deletions — the confirmed `ResourceBinding.deltaDeletionRef` (SP-3.2). */
export type RestDeletionConvention =
  | { readonly kind: "deleted-ids-list"; readonly path: string }
  | {
      readonly kind: "marker-field";
      readonly markerPath: string;
      readonly deletedWhenEquals: JsonValue;
    };

/** The delta-query convention: cursor request param + where the next cursor / records live. */
export interface RestDeltaConvention {
  readonly cursorParam: string;
  readonly nextCursorPath: string;
  /** Where the changed records live in the response; absent = the body is the array. */
  readonly recordsPath?: string;
  /** Present ONLY when `deltaDeletionRef` is confirmed; absent → deletions never detected (SP-3.3). */
  readonly deletion?: RestDeletionConvention;
}

/** The resolved per-rule REST source-read binding (SP assembles it from the IR + `ResourceBinding`s). */
export interface RestSourceReadBinding {
  readonly sourceAppId: string;
  readonly baseUrl: string;
  /** The source app's resolved OC-3 ceilings (`RegisteredApp.outboundLimits`); absent → default. */
  readonly limits?: OutboundLoadLimits;
  readonly method: HttpMethod;
  /** The read operation's path (no template params for a list; e.g. `/customers`). */
  readonly path: string;
  /** Where each record's native id lives (`ResourceBinding.nativeIdRef`). */
  readonly nativeIdPath: string;
  /** Where the records array lives in the collection-read response; absent = the body is the array. */
  readonly recordsPath?: string;
  readonly pagination: RestPaginationConvention;
  /** Delta convention (delta-polling rules only). */
  readonly delta?: RestDeltaConvention;
}

/** Resolves a rule id into its {@link RestSourceReadBinding} (SP/BE composes it; injected here). */
export interface RestSourceBindingResolver {
  resolve(ruleId: string): Promise<RestSourceReadBinding | undefined>;
}

/** Tuning + injection for {@link RestSourceReader}. */
export interface RestSourceReaderOptions {
  /** How a decrypted secret becomes request auth (inside `withCredential`) — required (no default here). */
  readonly applyCredential: CredentialApplier;
  /** Config-level default ceilings when an app declares none (OC-3 criterion 2). */
  readonly defaultLimits?: OutboundLoadLimits;
  /** Default `Retry-After` back-off (ms) for a `429` with no header. Default 1s. */
  readonly defaultThrottleMs?: number;
  /** Clock seam (default `() => new Date()`), for parsing an HTTP-date `Retry-After`. */
  readonly now?: () => Date;
}

const DEFAULT_THROTTLE_MS = 1_000;

export class RestSourceReader implements SourceReader {
  readonly #bindings: RestSourceBindingResolver;
  readonly #protocol: ProtocolClient;
  readonly #credentials: CredentialAccess;
  readonly #governor: AppLoadGovernor;
  readonly #applyCredential: CredentialApplier;
  readonly #defaultLimits: OutboundLoadLimits | undefined;
  readonly #defaultThrottleMs: number;
  readonly #now: () => Date;

  public constructor(
    bindings: RestSourceBindingResolver,
    protocol: ProtocolClient,
    credentials: CredentialAccess,
    governor: AppLoadGovernor,
    options: RestSourceReaderOptions,
  ) {
    this.#bindings = bindings;
    this.#protocol = protocol;
    this.#credentials = credentials;
    this.#governor = governor;
    this.#applyCredential = options.applyCredential;
    this.#defaultLimits = options.defaultLimits;
    this.#defaultThrottleMs = options.defaultThrottleMs ?? DEFAULT_THROTTLE_MS;
    this.#now = options.now ?? ((): Date => new Date());
  }

  public async readCollectionPage(
    ruleId: string,
    continuation: string | undefined,
  ): Promise<PageOutcome> {
    const binding = await this.#bindings.resolve(ruleId);
    if (binding === undefined) {
      return { ok: false, reason: `no source-read binding for ${ruleId}` };
    }
    const page = pageStateFrom(binding.pagination, continuation);
    const query = pageQuery(binding.pagination, page);
    const call = await this.#call(binding, query);
    if (!call.ok) {
      return { ok: false, reason: call.reason };
    }
    const records = extractRecords(call.response.body, binding.recordsPath, binding.nativeIdPath);
    if (!records.ok) {
      // An unparseable/malformed body is UNSOUND — never a silently-empty page (SP-4).
      return { ok: false, reason: records.reason };
    }
    return {
      ok: true,
      records: records.records,
      next: nextPage(binding.pagination, page, records.records.length),
    };
  }

  public async readDelta(ruleId: string, cursor: string | undefined): Promise<DeltaOutcome> {
    const binding = await this.#bindings.resolve(ruleId);
    if (binding === undefined) {
      return { ok: false, reason: `no source-read binding for ${ruleId}` };
    }
    const delta = binding.delta;
    if (delta === undefined) {
      return { ok: false, reason: `rule ${ruleId} has no delta convention` };
    }
    const query: [string, string][] = cursor !== undefined ? [[delta.cursorParam, cursor]] : [];
    const call = await this.#call(binding, query);
    if (!call.ok) {
      return { ok: false, reason: call.reason };
    }
    const body = call.response.body;
    const recordsPath = delta.recordsPath ?? binding.recordsPath;
    const extracted = extractRecords(body, recordsPath, binding.nativeIdPath);
    if (!extracted.ok) {
      return { ok: false, reason: extracted.reason };
    }

    // Split changes vs reported deletions per the confirmed deletion convention (SP-3.2/3.3).
    const changes: ObservedRecord[] = [];
    const deletedNativeIds: string[] = [];
    if (delta.deletion?.kind === "marker-field") {
      const marker = delta.deletion;
      for (const observed of extracted.records) {
        const read = readPath(observed.record, marker.markerPath);
        if (read.present && valuesEqual(read.value, marker.deletedWhenEquals)) {
          deletedNativeIds.push(observed.nativeId);
        } else {
          changes.push(observed);
        }
      }
    } else {
      changes.push(...extracted.records);
      if (delta.deletion?.kind === "deleted-ids-list") {
        const ids = readDeletedIds(body, delta.deletion.path);
        if (!ids.ok) {
          return { ok: false, reason: ids.reason };
        }
        deletedNativeIds.push(...ids.ids);
      }
    }

    const nextCursor = readCursor(body, delta.nextCursorPath);
    return { ok: true, records: changes, deletedNativeIds, nextCursor };
  }

  /**
   * Issue one read under OC-3 (SP-2.4): reserve a governor slot (denial → abort, never a
   * blocking wait), call through the `ProtocolClient` inside `withCredential`, honor a
   * `429`/`Retry-After` by penalizing the app and aborting, and release the slot.
   */
  async #call(
    binding: RestSourceReadBinding,
    query: readonly [string, string][],
  ): Promise<{ ok: true; response: OutboundResponse } | { ok: false; reason: string }> {
    // SS-4.5 backstop: a source read has NO record-id path parameter (the record id is a
    // response field), so a still-templated `{…}` is a genuinely-unfilled SCOPE parameter.
    // Refuse the call rather than send a literal `{owner}` — a silently-empty page would
    // be misread as mass deletion (SP-4). The `resolveSourceReadBinding` fill normally
    // prevents this (it unresolves an unconfirmed scope); this is defense-in-depth.
    const unfilled = findUnfilledPathParam(binding.path);
    if (unfilled !== undefined) {
      return {
        ok: false,
        reason: `unfilled scope path parameter ${unfilled} in the source read path`,
      };
    }
    const limits = binding.limits ?? this.#defaultLimits;
    const acquired = this.#governor.tryAcquire(binding.sourceAppId, limits);
    if (!acquired.granted) {
      // OC-3 crit 5: a ceiling / active back-off aborts this run rather than blocking a
      // worker; the next interval re-attempts (poller lag grows, surfacing as stuck).
      return {
        ok: false,
        reason: `source load ceiling: retry after ${String(acquired.retryAfterMs)}ms`,
      };
    }
    try {
      const request = buildRequest(binding, query);
      let response: OutboundResponse;
      try {
        const credResult = await this.#credentials.withCredential(
          binding.sourceAppId,
          (credential) =>
            this.#protocol.send({
              ...request,
              headers: this.#applyCredential(request.headers, credential.secret),
            }),
        );
        if (credResult.outcome === "invoked") {
          response = credResult.value;
        } else if (credResult.outcome === "no-credential") {
          response = await this.#protocol.send(request);
        } else {
          return { ok: false, reason: `credential refresh failed: ${credResult.reason}` };
        }
      } catch (error) {
        return { ok: false, reason: `transport failure: ${describeError(error)}` };
      }

      if (response.status >= 200 && response.status < 300) {
        return { ok: true, response };
      }
      const retryAfterMs = parseRetryAfter(response.headers["retry-after"], this.#now());
      if (response.status === 429) {
        this.#governor.penalize(binding.sourceAppId, retryAfterMs ?? this.#defaultThrottleMs);
      } else if (response.status >= 500 && retryAfterMs !== undefined) {
        this.#governor.penalize(binding.sourceAppId, retryAfterMs);
      }
      return { ok: false, reason: `HTTP ${String(response.status)}` };
    } finally {
      acquired.release();
    }
  }
}

// ── Pagination ────────────────────────────────────────────────────────────────

/** The current page position, decoded from the opaque continuation the Poller echoed. */
type PageState =
  { readonly kind: "single-page" } | { readonly kind: "numeric"; readonly value: number };

function pageStateFrom(
  pagination: RestPaginationConvention,
  continuation: string | undefined,
): PageState {
  if (pagination.kind === "single-page") {
    return { kind: "single-page" };
  }
  if (continuation === undefined) {
    return { kind: "numeric", value: pagination.kind === "offset" ? 0 : pagination.startPage };
  }
  return { kind: "numeric", value: Number(continuation) };
}

function pageQuery(pagination: RestPaginationConvention, page: PageState): [string, string][] {
  if (pagination.kind === "single-page" || page.kind === "single-page") {
    return [];
  }
  const query: [string, string][] = [];
  if (pagination.kind === "offset") {
    query.push([pagination.offsetParam, String(page.value)]);
    if (pagination.limitParam !== undefined) {
      query.push([pagination.limitParam, String(pagination.pageSize)]);
    }
  } else {
    query.push([pagination.pageParam, String(page.value)]);
    if (pagination.limitParam !== undefined) {
      query.push([pagination.limitParam, String(pagination.pageSize)]);
    }
  }
  return query;
}

function nextPage(
  pagination: RestPaginationConvention,
  page: PageState,
  received: number,
): { readonly done: true } | { readonly done: false; readonly continuation: string } {
  if (pagination.kind === "single-page" || page.kind === "single-page") {
    return { done: true };
  }
  // Exhaustion convention: ONLY an empty page ends the read (never `received < pageSize`
  // — a server may clamp a full page or use its own page size, and treating a short-but-
  // non-empty page as the end would truncate the fetch → the Poller would misread the
  // tail as mass deletion, SP-4). The Poller's `maxPages` cap bounds a non-terminating
  // server.
  if (received === 0) {
    return { done: true };
  }
  // Offset advances by the ACTUAL received count (never `pageSize`): if the server
  // clamped (returned fewer than requested on a full page), advancing by `pageSize`
  // would skip the un-returned records — they would then look deleted too. Page-number
  // simply increments; it cannot skip, it only must not stop early.
  const nextValue = pagination.kind === "offset" ? page.value + received : page.value + 1;
  return { done: false, continuation: String(nextValue) };
}

// ── Request building + parsing ─────────────────────────────────────────────────

function buildRequest(
  binding: RestSourceReadBinding,
  query: readonly [string, string][],
): OutboundRequest {
  const base = binding.baseUrl.endsWith("/") ? binding.baseUrl.slice(0, -1) : binding.baseUrl;
  const path = binding.path.startsWith("/") ? binding.path : `/${binding.path}`;
  const qs = query
    .map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(value)}`)
    .join("&");
  return {
    method: binding.method,
    url: `${base}${path}${qs.length > 0 ? `?${qs}` : ""}`,
    headers: {},
    body: undefined,
  };
}

/**
 * Extract the records array from a response body and each record's native id. Returns a
 * failure (never an empty list) when the records location is not an array, an element is
 * not an object, or a native id cannot be read — an unsound read the Poller must abort
 * (SP-4), so a malformed response can never masquerade as an empty collection.
 */
function extractRecords(
  body: JsonValue | undefined,
  recordsPath: string | undefined,
  nativeIdPath: string,
): { ok: true; records: ObservedRecord[] } | { ok: false; reason: string } {
  let array: JsonValue | undefined;
  if (recordsPath === undefined) {
    array = body;
  } else if (body === undefined) {
    return { ok: false, reason: "empty response body" };
  } else {
    const read = readPath(body, recordsPath);
    array = read.present ? read.value : undefined;
  }
  if (!Array.isArray(array)) {
    return { ok: false, reason: `records not an array at '${recordsPath ?? "<body>"}'` };
  }
  const records: ObservedRecord[] = [];
  for (const element of array) {
    if (element === null || typeof element !== "object" || Array.isArray(element)) {
      return { ok: false, reason: "record is not an object" };
    }
    const nativeId = readNativeId(element, nativeIdPath);
    if (nativeId === undefined) {
      return { ok: false, reason: `record missing native id at '${nativeIdPath}'` };
    }
    records.push({ nativeId, record: element });
  }
  return { ok: true, records };
}

function readDeletedIds(
  body: JsonValue | undefined,
  path: string,
): { ok: true; ids: string[] } | { ok: false; reason: string } {
  if (body === undefined) {
    return { ok: false, reason: "empty response body for deleted ids" };
  }
  const read = readPath(body, path);
  const value = read.present ? read.value : undefined;
  if (!Array.isArray(value)) {
    return { ok: false, reason: `deleted ids not an array at '${path}'` };
  }
  const ids: string[] = [];
  for (const element of value) {
    const id = stringifyId(element);
    if (id === undefined) {
      return { ok: false, reason: "deleted id is not a scalar" };
    }
    ids.push(id);
  }
  return { ok: true, ids };
}

function readNativeId(record: JsonValue, nativeIdPath: string): string | undefined {
  const read = readPath(record, nativeIdPath);
  return read.present ? stringifyId(read.value) : undefined;
}

function readCursor(body: JsonValue | undefined, path: string): string | undefined {
  if (body === undefined) {
    return undefined;
  }
  const read = readPath(body, path);
  return read.present ? stringifyId(read.value) : undefined;
}

/** A native id / cursor is a scalar; an object/array/null is not usable as one. */
function stringifyId(value: JsonValue): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return undefined;
}

function valuesEqual(a: JsonValue, b: JsonValue): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function parseRetryAfter(headerValue: string | undefined, now: Date): number | undefined {
  if (headerValue === undefined) {
    return undefined;
  }
  const trimmed = headerValue.trim();
  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed) * 1000;
  }
  const dateMs = Date.parse(trimmed);
  if (Number.isNaN(dateMs)) {
    return undefined;
  }
  return Math.max(0, dateMs - now.getTime());
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
