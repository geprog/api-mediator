import type { JsonValue } from "@mediator/transform";

/**
 * The **Protocol Client** seam (`docs/glossary.md` *Protocol Client/Server
 * interface pair*; OC-1 criterion 4). The named extensibility point a future
 * non-REST protocol plugs into: the Outbound Call Executor issues every call
 * through this interface, so swapping REST for another protocol is a new
 * implementation of {@link ProtocolClient} — the executor and its callers are
 * unchanged. Phase 4 ships the REST implementation only
 * ({@link ../rest-protocol-client.js FetchRestProtocolClient}).
 *
 * The contract is deliberately transport-shaped-but-generic: an {@link OutboundRequest}
 * is an already-built, self-contained call (absolute URL, headers, JSON body); an
 * {@link OutboundResponse} is the resolved reply (status + headers + parsed body).
 * A transport that never produced an HTTP response — a DNS/connection/timeout
 * failure — **throws**; any HTTP status (including 4xx/5xx) is **returned** so the
 * executor owns the retryable-vs-permanent classification centrally.
 */
export interface ProtocolClient {
  /** Issue one outbound call. Throws only on a transport error (no response). */
  send(request: OutboundRequest): Promise<OutboundResponse>;
}

/** The HTTP methods the REST Protocol Client issues. */
export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/**
 * A fully-built outbound call. Everything is already resolved — the executor
 * builds the URL (base + path + query), the headers (including any auth applied
 * **inside** the `withCredential` scope and the idempotency-key header), and the
 * JSON body — so the {@link ProtocolClient} only transmits it.
 *
 * **Security:** `headers` may carry a credential-derived `Authorization` value
 * while the call is in flight; it is never logged and never written to a
 * `SyncEvent` (OC-1 criterion 5). `body` holds the live transformed payload — also
 * never logged/audited/sent to an LLM.
 */
export interface OutboundRequest {
  readonly method: HttpMethod;
  /** The absolute request URL (base URL + filled path template + query). */
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  /** The JSON request body, or `undefined` for a bodyless call (GET/DELETE). */
  readonly body: JsonValue | undefined;
}

/** The resolved reply to an {@link OutboundRequest}. */
export interface OutboundResponse {
  /** The HTTP status code (any value; the executor classifies it). */
  readonly status: number;
  /** Response headers, lower-cased keys (so `retry-after` lookups are stable). */
  readonly headers: Readonly<Record<string, string>>;
  /** The parsed JSON response body, or `undefined` when the reply carried none. */
  readonly body: JsonValue | undefined;
}

/**
 * How to fill one target-operation parameter on the wire — the resolved location
 * of an IR parameter ref (as named by `OperationMapping.targetIdParamRef`). Which
 * IR parameter is the id parameter is OC's input (OC-1 criterion 2); resolving it
 * to a wire name + location comes from the target operation's IR, done by the
 * pipeline (SP), not re-derived here.
 */
export interface ParameterLocation {
  /** The on-the-wire parameter name. */
  readonly name: string;
  /** Where the parameter is placed. */
  readonly in: "path" | "query" | "header";
}

/**
 * The resolved REST binding of the target operation the change's action selected
 * (SP-3 picks *which* `OperationMapping`; OC executes it). Resolving
 * `OperationMapping.targetOperationRef` (an IR operation) into this wire shape is
 * the pipeline's job — OC consumes it plus `OperationMapping.targetIdParamRef`
 * (which parameter is the id) and `ResourceBinding.nativeIdRef` (which response
 * field is the created native id).
 */
export interface RestOperationBinding {
  readonly method: HttpMethod;
  /** The path template, e.g. `"/customers/{customerId}"`. */
  readonly pathTemplate: string;
  /**
   * Wire location for each IR parameter ref the operation exposes, keyed by the
   * ref string used in `OperationMapping.targetIdParamRef`. The executor fills the
   * id parameter by looking its ref up here (OC-1 criterion 2).
   */
  readonly parameterLocations: Readonly<Record<string, ParameterLocation>>;
  /**
   * The target API's own idempotency-key header, when it exposes one — the
   * executor **also** passes the deterministic key through it (OC-2 criterion 6).
   * Absent when the API has no such mechanism.
   */
  readonly idempotencyKeyHeader?: string;
}
