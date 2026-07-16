import type { OutboundLoadLimits } from "@mediator/domain";
import type {
  SingleRecordReadRequest,
  SingleRecordReadResult,
  SingleRecordTargetReader,
} from "@mediator/sync-engine";
import type { JsonValue } from "@mediator/transform";

import type { ResolvedSingleRecordRead, SingleRecordReadResolver } from "./binding-resolvers.js";
import type { CredentialAccess, CredentialApplier } from "./executor.js";
import { AppLoadGovernor } from "./load-governor.js";
import { findUnfilledPathParam } from "./path-template.js";
import type { OutboundRequest, OutboundResponse, ProtocolClient } from "./protocol-client.js";

/**
 * `RestSingleRecordTargetReader` — the REST implementation of Conflict Detection's
 * {@link SingleRecordTargetReader} seam (CF-5 PUT read-carry / CF-6 read-before-write),
 * the "one extra read per write" the CF review deferred to the composition seam. Like
 * {@link RestSourceReader} it lives in `@mediator/outbound` so the read obeys the
 * **same OC-3 per-app load ceilings as writes** (a slot on the shared
 * {@link AppLoadGovernor}, released after) and reads through the {@link ProtocolClient}
 * inside a {@link CredentialAccess} `withCredential` scope — the credential never
 * leaves the scope, never reaches a log/event. CF memoizes the read, so this makes at
 * most one call per execution.
 *
 * **Representation contract (the load-bearing one).** The reader returns the read
 * response body **verbatim** as the record — no transform, no coercion — so CF's
 * `readPath(record, targetPath)` yields the field in the *same* stored representation
 * the baseline was hashed from. `hashFieldValue(read.value)` therefore matches the
 * persisted `SyncFieldState.lastSyncedHash` (which the write path captured the same
 * way, from the write response / a follow-up read — `docs/architecture/sync-engine.md`
 * *Loop prevention* / *Conflict handling*). Any post-read reshaping here would forge
 * drift.
 *
 * **Never fabricate found/not-found.** A `404` is the record's genuine absence
 * (`{ found: false }`); a `2xx` object body is `{ found: true }`. Anything else — a
 * non-object 2xx body, a 5xx, a transport failure, a load-ceiling denial, or an
 * unresolved read binding — **throws**, so a failed read is never silently misread as
 * "the target is gone" (which would drop drift protection or let a delete through).
 */

export interface RestSingleRecordTargetReaderOptions {
  /** How a decrypted secret becomes request auth (inside `withCredential`) — required. */
  readonly applyCredential: CredentialApplier;
  /** Config-level default ceilings when an app declares none (OC-3 criterion 2). */
  readonly defaultLimits?: OutboundLoadLimits;
}

export class RestSingleRecordTargetReader implements SingleRecordTargetReader {
  readonly #resolver: SingleRecordReadResolver;
  readonly #protocol: ProtocolClient;
  readonly #credentials: CredentialAccess;
  readonly #governor: AppLoadGovernor;
  readonly #applyCredential: CredentialApplier;
  readonly #defaultLimits: OutboundLoadLimits | undefined;

  public constructor(
    resolver: SingleRecordReadResolver,
    protocol: ProtocolClient,
    credentials: CredentialAccess,
    governor: AppLoadGovernor,
    options: RestSingleRecordTargetReaderOptions,
  ) {
    this.#resolver = resolver;
    this.#protocol = protocol;
    this.#credentials = credentials;
    this.#governor = governor;
    this.#applyCredential = options.applyCredential;
    this.#defaultLimits = options.defaultLimits;
  }

  public async readRecord(request: SingleRecordReadRequest): Promise<SingleRecordReadResult> {
    const resolved = await this.#resolver.resolve(request.targetAppId, request.binding);
    if (resolved === undefined) {
      // A config error (the read op / id param does not resolve) — not a "not found".
      throw new Error(
        `single-record read binding did not resolve for app ${request.targetAppId} (operation ${request.binding.readOperationId})`,
      );
    }

    const limits = resolved.limits ?? this.#defaultLimits;
    const acquired = this.#governor.tryAcquire(request.targetAppId, limits);
    if (!acquired.granted) {
      // OC-3 crit 5: a ceiling / back-off must abort the read (and thus the write it
      // guards), never masquerade as a not-found.
      throw new Error(
        `single-record read load ceiling for app ${request.targetAppId}: retry after ${String(acquired.retryAfterMs)}ms`,
      );
    }
    try {
      const outboundRequest = buildReadRequest(resolved, request.nativeId);
      const response = await this.#send(request.targetAppId, outboundRequest);
      return classifyRead(response);
    } finally {
      acquired.release();
    }
  }

  async #send(targetAppId: string, request: OutboundRequest): Promise<OutboundResponse> {
    const credResult = await this.#credentials.withCredential(targetAppId, (credential) =>
      this.#protocol.send({
        ...request,
        headers: this.#applyCredential(request.headers, credential.secret),
      }),
    );
    if (credResult.outcome === "invoked") {
      return credResult.value;
    }
    if (credResult.outcome === "no-credential") {
      return this.#protocol.send(request);
    }
    throw new Error(`credential refresh failed: ${credResult.reason}`);
  }
}

/** Build the by-id read request: fill the id parameter's wire location with the native id. */
function buildReadRequest(resolved: ResolvedSingleRecordRead, nativeId: string): OutboundRequest {
  const headers: Record<string, string> = {};
  let path = resolved.pathTemplate;
  let query = "";
  const location = resolved.idLocation;
  if (location.in === "path") {
    path = path.replace(`{${location.name}}`, encodeURIComponent(nativeId));
  } else if (location.in === "query") {
    query = `?${encodeURIComponent(location.name)}=${encodeURIComponent(nativeId)}`;
  } else {
    headers[location.name] = nativeId;
  }
  // SS-4.5 backstop: after the record-id substitution, a still-templated path param is a
  // genuinely-unfilled SCOPE param (a scoped single-record read whose op has params BEYOND
  // the record id, e.g. Gitea `/repos/{owner}/{repo}/issues/{index}`). Sending `{owner}`
  // literally would 404, which `classifyRead` would turn into a **fabricated not-found**
  // ("target gone"), violating this reader's own contract. Throw instead. The record id is
  // filled above, so it never false-trips this. (`resolveSingleRecordRead` normally fills
  // scope or unresolves upstream — this is defense-in-depth.)
  const unfilled = findUnfilledPathParam(path);
  if (unfilled !== undefined) {
    throw new Error(
      `single-record read path still has an unfilled parameter '${unfilled}' after the id substitution — scope path-parameter binding is not resolved for this operation`,
    );
  }
  return {
    method: resolved.method,
    url: joinUrl(resolved.baseUrl, path) + query,
    headers,
    body: undefined,
  };
}

/** A `404` is genuine absence; a `2xx` object body is the record; anything else throws. */
function classifyRead(response: OutboundResponse): SingleRecordReadResult {
  if (response.status === 404) {
    return { found: false };
  }
  if (response.status >= 200 && response.status < 300) {
    const body = response.body;
    if (isJsonRecord(body)) {
      return { found: true, record: body };
    }
    throw new Error(
      `single-record read returned a non-object body (status ${String(response.status)})`,
    );
  }
  throw new Error(`single-record read failed: HTTP ${String(response.status)}`);
}

function isJsonRecord(value: JsonValue | undefined): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function joinUrl(baseUrl: string, path: string): string {
  const base = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return `${base}${suffix}`;
}
