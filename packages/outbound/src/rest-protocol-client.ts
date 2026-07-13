import type { JsonValue } from "@mediator/transform";

import type { OutboundRequest, OutboundResponse, ProtocolClient } from "./protocol-client.js";

/**
 * The REST implementation of the {@link ProtocolClient} seam (OC-1 criterion 4) —
 * the first, and in Phase 4 the only, protocol behind the executor. A future
 * non-REST protocol is a different {@link ProtocolClient}; the executor is unchanged.
 *
 * The HTTP client is an injected {@link HttpFetch} (default: the platform `fetch`),
 * so request-building is unit-testable deterministically with a fake fetch and the
 * production path uses the real one. Only metadata reaches this class's surface;
 * request headers (which may carry a credential-derived `Authorization`) and the
 * JSON body are transmitted, never logged (OC-1 criterion 5).
 */

/** The minimal HTTP client surface the REST Protocol Client depends on. */
export type HttpFetch = (url: string, init: HttpFetchInit) => Promise<HttpFetchResponse>;

/** The request init the REST Protocol Client passes to {@link HttpFetch}. */
export interface HttpFetchInit {
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body?: string;
  readonly signal?: AbortSignal;
}

/** The response shape the REST Protocol Client reads back from {@link HttpFetch}. */
export interface HttpFetchResponse {
  readonly status: number;
  readonly headers: {
    get(name: string): string | null;
    forEach(cb: (value: string, key: string) => void): void;
  };
  text(): Promise<string>;
}

/** A transport failure (no HTTP response): DNS/connection/timeout — the executor retries it. */
export class OutboundTransportError extends Error {
  public constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "OutboundTransportError";
  }
}

/** Tuning for {@link FetchRestProtocolClient}. */
export interface FetchRestProtocolClientOptions {
  /** The HTTP client. Default: the platform global `fetch`. */
  readonly fetch?: HttpFetch;
  /** Per-call timeout in ms; a slower call aborts as a transport error. Default 30s. */
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

const platformFetch: HttpFetch = (url, init) => {
  // Build the RequestInit incrementally so an absent body/signal stays *absent*
  // (`exactOptionalPropertyTypes` rejects an explicit `undefined` here).
  const requestInit: RequestInit = { method: init.method, headers: init.headers };
  if (init.body !== undefined) {
    requestInit.body = init.body;
  }
  if (init.signal !== undefined) {
    requestInit.signal = init.signal;
  }
  return fetch(url, requestInit);
};

export class FetchRestProtocolClient implements ProtocolClient {
  readonly #fetch: HttpFetch;
  readonly #timeoutMs: number;

  public constructor(options: FetchRestProtocolClientOptions = {}) {
    this.#fetch = options.fetch ?? platformFetch;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  public async send(request: OutboundRequest): Promise<OutboundResponse> {
    const headers: Record<string, string> = { ...request.headers };
    let body: string | undefined;
    if (request.body !== undefined) {
      body = JSON.stringify(request.body);
      headers["content-type"] ??= "application/json";
    }

    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, this.#timeoutMs);
    // Don't let the timeout timer keep the process alive on its own.
    timer.unref();

    let response: HttpFetchResponse;
    try {
      response = await this.#fetch(request.url, {
        method: request.method,
        headers,
        ...(body === undefined ? {} : { body }),
        signal: controller.signal,
      });
    } catch (error) {
      // No HTTP response — a transport failure the executor treats as retryable.
      // The message carries only the method (never the URL's query or a secret).
      throw new OutboundTransportError(`outbound ${request.method} failed at the transport layer`, {
        cause: error,
      });
    } finally {
      clearTimeout(timer);
    }

    return {
      status: response.status,
      headers: collectHeaders(response.headers),
      body: await parseJsonBody(response),
    };
  }
}

/** Lower-cased header record, so `retry-after` lookups are case-stable. */
function collectHeaders(headers: HttpFetchResponse["headers"]): Record<string, string> {
  const record: Record<string, string> = {};
  headers.forEach((value, key) => {
    record[key.toLowerCase()] = value;
  });
  return record;
}

/** Parse a JSON response body, tolerating an empty body (→ `undefined`). */
async function parseJsonBody(response: HttpFetchResponse): Promise<JsonValue | undefined> {
  const text = await response.text();
  if (text.length === 0) {
    return undefined;
  }
  try {
    return JSON.parse(text) as JsonValue;
  } catch {
    // A non-JSON body is not the executor's concern here — surface it as absent;
    // the status code drives success/failure, not the body's parseability.
    return undefined;
  }
}
