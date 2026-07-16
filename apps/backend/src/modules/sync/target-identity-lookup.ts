import type { IrParameter, OutboundLoadLimits, SyncRule } from "@mediator/domain";
import {
  AppLoadGovernor,
  findUnfilledPathParam,
  resolveSourceReadBinding,
  type CredentialAccess,
  type CredentialApplier,
  type OutboundRequest,
  type OutboundResponse,
  type ProtocolClient,
  type RestPaginationConvention,
  type RestSourceReadBinding,
} from "@mediator/outbound";
import type {
  FetchAllRequest,
  FilteredReadRequest,
  MatchedTargetRecord,
  TargetFetchResult,
  TargetIdentityLookup,
  TargetReadBinding,
} from "@mediator/sync-engine";
import { readPath, type JsonValue } from "@mediator/transform";

import { isRefConfirmed } from "./resolution.js";
import type { RuleArtifactRepos } from "./resolution.js";

/**
 * `RestTargetIdentityLookup` — the REST implementation of Identity Resolution's
 * {@link TargetIdentityLookup} seam (RL-3), the "look the record up in the target
 * before creating it" the pipeline/backfill deferred to the composition slice. There
 * was **no** real implementation before this slice — only the unit-test fake — so this
 * is the seam that makes identity-key matching (and thus link-only backfill baseline
 * seeding, and steady-state match-first-before-create) work against a live target.
 *
 * Like the source reader / single-record reader it reads through the {@link ProtocolClient}
 * inside a {@link CredentialAccess} `withCredential` scope, reserves a slot on the shared
 * {@link AppLoadGovernor} per call (the **same OC-3 per-app ceilings as writes**), and
 * honors a `429`/`Retry-After`. It reuses {@link resolveSourceReadBinding} for the wire
 * shape (method/path/pagination/records/native-id derivation), forcing the collection
 * read (never a delta) so a lookup always enumerates.
 *
 * **Abort-on-partial (SP-4 discipline).** Any transport failure, non-2xx status,
 * governor denial, unparseable body, or a record missing its native id makes
 * {@link fetchAll} return `{ complete: false }` — never a silently-empty result the stage
 * would misread as "no match" and create a duplicate over. {@link filteredRead} returns
 * an empty array only on a *genuine* empty filtered result; any read fault throws so the
 * queued execution retries rather than fabricating a no-match.
 */

/** The resolved collection-read wire shape plus the operation's IR parameters (for filter-location checks). */
export interface ResolvedTargetCollectionRead {
  readonly binding: RestSourceReadBinding;
  /** The collection read operation's IR parameters — a filtered read verifies its filter param is query-located. */
  readonly parameters: readonly IrParameter[];
}

/** Resolves a {@link TargetReadBinding} against a target app into the collection-read wire shape. */
export interface TargetCollectionReadResolver {
  resolve(
    targetAppId: string,
    binding: TargetReadBinding,
  ): Promise<ResolvedTargetCollectionRead | undefined>;
}

/**
 * The repo-backed {@link TargetCollectionReadResolver}: it finds the target app's active
 * PROVIDER spec group whose confirmed `collectionReadRef` is `binding.collectionReadOperationId`,
 * and resolves that group's collection read to a {@link RestSourceReadBinding} — forcing
 * full-fetch (`supportsDeltaQuery = false`) so the lookup always enumerates the collection,
 * never a delta window. Returns `undefined` for any missing/unconfirmed input (never a
 * fabricated binding).
 */
export class RepoTargetCollectionReadResolver implements TargetCollectionReadResolver {
  readonly #repos: Pick<RuleArtifactRepos, "apiSpecs" | "resourceBindings" | "registeredApps">;

  public constructor(
    repos: Pick<RuleArtifactRepos, "apiSpecs" | "resourceBindings" | "registeredApps">,
  ) {
    this.#repos = repos;
  }

  public async resolve(
    targetAppId: string,
    binding: TargetReadBinding,
  ): Promise<ResolvedTargetCollectionRead | undefined> {
    const app = await this.#repos.registeredApps.getById(targetAppId);
    if (app?.baseUrl === undefined) {
      return undefined;
    }
    const specs = await this.#repos.apiSpecs.listByAppId(targetAppId);
    for (const spec of specs) {
      if (spec.role !== "PROVIDER" || spec.status !== "active") {
        continue;
      }
      for (const group of spec.parsedIR) {
        const operation = group.operations.find(
          (op) => op.operationId === binding.collectionReadOperationId,
        );
        if (operation === undefined) {
          continue;
        }
        const bindings = await this.#repos.resourceBindings.listByApiSpecId(spec.id);
        const resourceBinding = bindings.find((b) => b.resourceRef === group.resourceRef);
        if (resourceBinding === undefined || !isRefConfirmed(resourceBinding.collectionReadRef)) {
          continue;
        }
        const resolved = resolveSourceReadBinding({
          rule: SYNTHETIC_LOOKUP_RULE,
          sourceAppId: targetAppId,
          baseUrl: app.baseUrl,
          ...(app.outboundLimits !== undefined ? { limits: app.outboundLimits } : {}),
          // A target identity lookup ALWAYS enumerates the collection (never a delta
          // window), regardless of the target's delta capability.
          sourceCapabilities: { ...app.capabilities, supportsDeltaQuery: false },
          sourceGroup: group,
          sourceBinding: resourceBinding,
        });
        if (resolved !== undefined) {
          return { binding: resolved, parameters: operation.parameters };
        }
      }
    }
    return undefined;
  }
}

/** A minimal `SyncRule` for {@link resolveSourceReadBinding}: only `pollOperationRef` (absent) is read. */
const SYNTHETIC_LOOKUP_RULE: SyncRule = {
  id: "target-identity-lookup",
  approvedMappingId: "",
  resourcePairRef: "",
  status: "enabled",
};

export interface RestTargetIdentityLookupOptions {
  /** How a decrypted secret becomes request auth (inside `withCredential`) — required. */
  readonly applyCredential: CredentialApplier;
  /** Config-level default ceilings when an app declares none (OC-3 criterion 2). */
  readonly defaultLimits?: OutboundLoadLimits;
  /** Default `Retry-After` back-off (ms) for a `429` with no header. Default 1s. */
  readonly defaultThrottleMs?: number;
  /** Hard cap on enumeration pages (safety valve against a non-terminating reader). Default 100_000. */
  readonly maxPages?: number;
}

const DEFAULT_THROTTLE_MS = 1_000;
const DEFAULT_MAX_PAGES = 100_000;

export class RestTargetIdentityLookup implements TargetIdentityLookup {
  readonly #resolver: TargetCollectionReadResolver;
  readonly #protocol: ProtocolClient;
  readonly #credentials: CredentialAccess;
  readonly #governor: AppLoadGovernor;
  readonly #applyCredential: CredentialApplier;
  readonly #defaultLimits: OutboundLoadLimits | undefined;
  readonly #defaultThrottleMs: number;
  readonly #maxPages: number;

  public constructor(
    resolver: TargetCollectionReadResolver,
    protocol: ProtocolClient,
    credentials: CredentialAccess,
    governor: AppLoadGovernor,
    options: RestTargetIdentityLookupOptions,
  ) {
    this.#resolver = resolver;
    this.#protocol = protocol;
    this.#credentials = credentials;
    this.#governor = governor;
    this.#applyCredential = options.applyCredential;
    this.#defaultLimits = options.defaultLimits;
    this.#defaultThrottleMs = options.defaultThrottleMs ?? DEFAULT_THROTTLE_MS;
    this.#maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  }

  public async filteredRead(request: FilteredReadRequest): Promise<readonly MatchedTargetRecord[]> {
    const wire = await this.#resolver.resolve(request.targetAppId, request.binding);
    if (wire === undefined) {
      // A config error (the collection read did not resolve) — never a fabricated
      // no-match: throw so the queued execution retries rather than creating a duplicate.
      throw new Error(
        `target identity filtered-read binding did not resolve for app ${request.targetAppId}`,
      );
    }
    // FAIL CLOSED: a filtered read only means anything if the confirmed lookup parameter
    // is actually a QUERY parameter of the collection read. A mis-confirmed path/header/
    // cookie param sent as a query would be silently IGNORED by the target, which would
    // then return its unfiltered first record — a wrong single-record match RL-4 cannot
    // catch (a 1-result "filter" looks unambiguous). Refuse rather than mis-route.
    const filterParam = queryFilterParam(wire.parameters, request.lookupParamRef);
    const filterValue = scalarString(request.value);
    if (filterParam === undefined || filterValue === undefined) {
      throw new Error(
        `target identity filtered-read: lookup parameter '${request.lookupParamRef}' does not resolve to a query parameter (or the identity value is not a scalar) for app ${request.targetAppId} — refusing an unfiltered read`,
      );
    }
    const result = await this.#readAll(request.targetAppId, wire.binding, {
      name: filterParam,
      value: filterValue,
    });
    if (!result.ok) {
      throw new Error(`target identity filtered-read failed: ${result.reason}`);
    }
    return result.records;
  }

  public async fetchAll(request: FetchAllRequest): Promise<TargetFetchResult> {
    const wire = await this.#resolver.resolve(request.targetAppId, request.binding);
    if (wire === undefined) {
      // Abort-on-partial: an unresolved binding is an unsound read, not "no records".
      return { complete: false };
    }
    const result = await this.#readAll(request.targetAppId, wire.binding, undefined);
    return result.ok ? { complete: true, records: result.records } : { complete: false };
  }

  /**
   * Page the target collection to exhaustion (abort-on-partial), extract records by the
   * confirmed native-id path, and optionally append a filter query param to each page.
   * De-dups by native id (a paged collection can re-observe a boundary record).
   */
  async #readAll(
    targetAppId: string,
    binding: RestSourceReadBinding,
    filter: { readonly name: string; readonly value: string } | undefined,
  ): Promise<
    | { readonly ok: true; readonly records: MatchedTargetRecord[] }
    | { readonly ok: false; readonly reason: string }
  > {
    const byNativeId = new Map<string, MatchedTargetRecord>();
    let page = pageStart(binding.pagination);
    for (let count = 0; count < this.#maxPages; count += 1) {
      const query = pageQuery(binding.pagination, page);
      if (filter !== undefined) {
        query.push([filter.name, filter.value]);
      }
      const call = await this.#call(targetAppId, binding, query);
      if (!call.ok) {
        return { ok: false, reason: call.reason };
      }
      const extracted = extractRecords(
        call.response.body,
        binding.recordsPath,
        binding.nativeIdPath,
      );
      if (!extracted.ok) {
        return { ok: false, reason: extracted.reason };
      }
      for (const record of extracted.records) {
        byNativeId.set(record.nativeId, record);
      }
      const next = nextPage(binding.pagination, page, extracted.records.length);
      if (next.done) {
        return { ok: true, records: [...byNativeId.values()] };
      }
      page = next.value;
    }
    return { ok: false, reason: `target lookup exceeded ${String(this.#maxPages)} pages` };
  }

  /** One read under OC-3: reserve a slot, call inside `withCredential`, honor 429/Retry-After, release. */
  async #call(
    targetAppId: string,
    binding: RestSourceReadBinding,
    query: readonly [string, string][],
  ): Promise<
    | { readonly ok: true; readonly response: OutboundResponse }
    | { readonly ok: false; readonly reason: string }
  > {
    // SS-4.5 backstop: this scoped collection read (`GET /repos/{owner}/{repo}/issues` for
    // fetch-and-match) has no record-id path parameter, so a still-templated `{…}` is a
    // genuinely-unfilled SCOPE parameter. Refuse rather than send a literal `{owner}` (an
    // empty filtered read would fabricate a no-match → a duplicate create). Normally
    // `resolveSourceReadBinding` already unresolves an unconfirmed scope; defense-in-depth.
    const unfilled = findUnfilledPathParam(binding.path);
    if (unfilled !== undefined) {
      return {
        ok: false,
        reason: `unfilled scope path parameter ${unfilled} in the target lookup path`,
      };
    }
    const limits = binding.limits ?? this.#defaultLimits;
    const acquired = this.#governor.tryAcquire(targetAppId, limits);
    if (!acquired.granted) {
      return {
        ok: false,
        reason: `target load ceiling: retry after ${String(acquired.retryAfterMs)}ms`,
      };
    }
    try {
      const request = buildRequest(binding, query);
      let response: OutboundResponse;
      try {
        const credResult = await this.#credentials.withCredential(targetAppId, (credential) =>
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
      if (response.status === 429) {
        this.#governor.penalize(targetAppId, this.#defaultThrottleMs);
      }
      return { ok: false, reason: `HTTP ${String(response.status)}` };
    } finally {
      acquired.release();
    }
  }
}

// ── Pagination (mirrors the RestSourceReader convention: exhaustion is an EMPTY page) ──

type PageState =
  { readonly kind: "single-page" } | { readonly kind: "numeric"; readonly value: number };

function pageStart(pagination: RestPaginationConvention): PageState {
  if (pagination.kind === "single-page") {
    return { kind: "single-page" };
  }
  return { kind: "numeric", value: pagination.kind === "offset" ? 0 : pagination.startPage };
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
): { readonly done: true } | { readonly done: false; readonly value: PageState } {
  if (pagination.kind === "single-page" || page.kind === "single-page" || received === 0) {
    return { done: true };
  }
  const nextValue = pagination.kind === "offset" ? page.value + received : page.value + 1;
  return { done: false, value: { kind: "numeric", value: nextValue } };
}

// ── Request building + parsing (mirrors the RestSourceReader extraction) ───────

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

function extractRecords(
  body: JsonValue | undefined,
  recordsPath: string | undefined,
  nativeIdPath: string,
): { ok: true; records: MatchedTargetRecord[] } | { ok: false; reason: string } {
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
  const records: MatchedTargetRecord[] = [];
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

function readNativeId(record: JsonValue, nativeIdPath: string): string | undefined {
  const read = readPath(record, nativeIdPath);
  return read.present ? scalarString(read.value) : undefined;
}

/** A native id / filter value is a scalar; an object/array/null is not usable on the wire. */
function scalarString(value: JsonValue): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return undefined;
}

/**
 * The wire query-parameter name for a confirmed `targetLookupParamRef`
 * (`resourceRef/operationId#name` or a bare name), or `undefined` when the collection
 * read has no such parameter OR it is not a **query** parameter. Returning `undefined`
 * makes {@link RestTargetIdentityLookup.filteredRead} fail closed — a path/header/cookie
 * filter param must never be sent as an ignored query param over an unfiltered read.
 */
function queryFilterParam(parameters: readonly IrParameter[], ref: string): string | undefined {
  const hash = ref.lastIndexOf("#");
  const name = hash === -1 ? ref : ref.slice(hash + 1);
  if (name.length === 0) {
    return undefined;
  }
  const match = parameters.find(
    (parameter) => parameter.name === name && parameter.location === "query",
  );
  return match?.name;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
