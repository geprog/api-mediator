import type { IrOperation, OutboundLoadLimits } from "@mediator/domain";
import {
  AppLoadGovernor,
  type CredentialAccess,
  type CredentialApplier,
  type HttpMethod,
  type OutboundRequest,
  type OutboundResponse,
  type ProtocolClient,
} from "@mediator/outbound";
import type { JsonValue } from "@mediator/transform";

import type { MappedBackendRequest } from "./request-mapping.js";

/**
 * **TE-2 — execute the backend call.** The adapter reads reuse the *same* governed,
 * credentialed outbound primitives the Phase-4 `OutboundCallExecutor` is built on —
 * the {@link ProtocolClient} seam, `CredentialStore.withCredential`, and the shared
 * per-app {@link AppLoadGovernor} — rather than re-implementing any of them. (The
 * executor's own `execute` handles create/update/delete writes; a live read reuses
 * these primitives directly, exactly as `RestSingleRecordTargetReader` /
 * `RestSourceReader` do for the Sync Engine's reads.)
 *
 * Adapter traffic shares the backend app's **one** ceiling with sync (TE-2.4), the
 * credential is applied and the call made **inside** the `withCredential` scope so the
 * secret never leaves it (TE-2.3), and a live inbound read is bounded — a ceiling
 * denial fails the request rather than parking it (TE-2.6): a live caller always gets
 * an answer.
 */

/** The already-mapped inputs a backend call needs, plus the resolved backend operation. */
export interface BackendCallInput {
  readonly targetAppId: string;
  readonly baseUrl: string;
  readonly operation: IrOperation;
  readonly mapped: MappedBackendRequest;
  readonly limits?: OutboundLoadLimits;
}

/**
 * A backend call's outcome: the response body on success, a live `upstream-error`
 * (naming the backend, RP-5.2), or a mediator-side `defect` (a non-servable backend
 * operation — a composition defect surfaced as `mediator-transform-error`).
 *
 * `reachedBackend` on an `upstream-error` records whether an HTTP attempt was actually
 * dispatched to the backend: `false` when the call was refused *before* sending (a load
 * ceiling denial, or a credential refresh that never produced a request), `true`/absent
 * once a request was put on the wire (a transport failure that may have applied, or a
 * non-2xx response). The write path reads it to honor the record-only-after-the-backend-call
 * rule (WR-5.3): a not-reached failure is never recorded in the write-outcome store, so a
 * keyed retry re-evaluates rather than being pinned to a transient pre-call condition. The
 * read path never consults it, so its behavior is unchanged.
 */
export type BackendCallResult =
  | { readonly ok: true; readonly body: JsonValue | undefined }
  | {
      readonly ok: false;
      readonly kind: "upstream-error";
      readonly detail: string;
      readonly reachedBackend?: boolean;
    }
  | { readonly ok: false; readonly kind: "defect"; readonly detail: string };

export interface AdapterBackendCallerOptions {
  readonly applyCredential: CredentialApplier;
  readonly defaultLimits?: OutboundLoadLimits;
}

/**
 * The narrow port the serve handler calls (TE-2). {@link AdapterBackendCaller} is the
 * real, governed/credentialed implementation; a unit test injects a fake so the
 * orchestration is testable without HTTP.
 */
export interface BackendCaller {
  call(input: BackendCallInput): Promise<BackendCallResult>;
}

export class AdapterBackendCaller implements BackendCaller {
  readonly #protocol: ProtocolClient;
  readonly #credentials: CredentialAccess;
  readonly #governor: AppLoadGovernor;
  readonly #applyCredential: CredentialApplier;
  readonly #defaultLimits: OutboundLoadLimits | undefined;

  public constructor(
    protocol: ProtocolClient,
    credentials: CredentialAccess,
    governor: AppLoadGovernor,
    options: AdapterBackendCallerOptions,
  ) {
    this.#protocol = protocol;
    this.#credentials = credentials;
    this.#governor = governor;
    this.#applyCredential = options.applyCredential;
    this.#defaultLimits = options.defaultLimits;
  }

  public async call(input: BackendCallInput): Promise<BackendCallResult> {
    const built = buildOutboundRequest(input);
    if (!built.ok) {
      return built;
    }

    const limits = input.limits ?? this.#defaultLimits;
    const acquired = this.#governor.tryAcquire(input.targetAppId, limits);
    if (!acquired.granted) {
      // TE-2.6 — a live read is bounded, not parked: a ceiling denial fails the
      // request (naming the backend) so the caller gets an answer. No request was
      // dispatched, so a write refused here is never recorded (WR-5.3): the caller's
      // keyed retry re-evaluates once the ceiling clears.
      return {
        ok: false,
        kind: "upstream-error",
        detail: `backend app ${input.targetAppId} load ceiling reached`,
        reachedBackend: false,
      };
    }
    try {
      const response = await this.#send(input.targetAppId, built.request);
      if (!response.ok) {
        return response;
      }
      return classifyResponse(input.targetAppId, response.value);
    } finally {
      acquired.release();
    }
  }

  async #send(
    targetAppId: string,
    request: OutboundRequest,
  ): Promise<
    | { readonly ok: true; readonly value: OutboundResponse }
    | {
        readonly ok: false;
        readonly kind: "upstream-error";
        readonly detail: string;
        readonly reachedBackend: boolean;
      }
  > {
    try {
      const credResult = await this.#credentials.withCredential(targetAppId, (credential) =>
        this.#protocol.send({
          ...request,
          headers: this.#applyCredential(request.headers, credential.secret),
        }),
      );
      if (credResult.outcome === "invoked") {
        return { ok: true, value: credResult.value };
      }
      if (credResult.outcome === "no-credential") {
        // A valid public/no-auth backend: issue the call unauthenticated.
        return { ok: true, value: await this.#protocol.send(request) };
      }
      // No request was dispatched — a credential refresh failed before sending.
      return {
        ok: false,
        kind: "upstream-error",
        detail: `backend app ${targetAppId} credential refresh failed`,
        reachedBackend: false,
      };
    } catch (error) {
      // No HTTP response — a transport failure (timeout/network/connection refused).
      // The request WAS dispatched, so the side effect of a write may have applied.
      return {
        ok: false,
        kind: "upstream-error",
        detail: `backend app ${targetAppId} transport failure: ${describeError(error)}`,
        reachedBackend: true,
      };
    }
  }
}

/** A 2xx response's body is the result; any other status is a live upstream failure. */
function classifyResponse(targetAppId: string, response: OutboundResponse): BackendCallResult {
  if (response.status >= 200 && response.status < 300) {
    return { ok: true, body: response.body };
  }
  // A non-2xx response means the backend received and processed the request, so a
  // write's side effect may have applied — the failure IS recorded (WR-5.3).
  return {
    ok: false,
    kind: "upstream-error",
    detail: `backend app ${targetAppId} returned HTTP ${String(response.status)}`,
    reachedBackend: true,
  };
}

type BuildResult =
  | { readonly ok: true; readonly request: OutboundRequest }
  | { readonly ok: false; readonly kind: "defect"; readonly detail: string };

/** Assemble the wire request from the backend operation + the mapped inputs. */
function buildOutboundRequest(input: BackendCallInput): BuildResult {
  const method = toHttpMethod(input.operation.method);
  if (method === undefined) {
    return {
      ok: false,
      kind: "defect",
      detail: `backend operation method '${input.operation.method}' is not a REST verb`,
    };
  }

  let path = input.operation.path;
  for (const [name, value] of Object.entries(input.mapped.pathParams)) {
    path = path.replace(`{${name}}`, encodeURIComponent(value));
  }
  const unfilled = findUnfilledPathParam(path);
  if (unfilled !== undefined) {
    // Never issue a call with a literal `{param}` in the URL (the same discipline as
    // the outbound executor's path backstop) — a composition defect, not a call.
    return {
      ok: false,
      kind: "defect",
      detail: `backend path parameter '${unfilled}' is unfilled`,
    };
  }

  const query = input.mapped.queryParams
    .map((param) => `${encodeURIComponent(param.name)}=${encodeURIComponent(param.value)}`)
    .join("&");
  const headers: Record<string, string> = {};
  for (const param of input.mapped.headerParams) {
    headers[param.name] = param.value;
  }

  const url = joinUrl(input.baseUrl, path) + (query.length > 0 ? `?${query}` : "");
  return {
    ok: true,
    request: { method, url, headers, body: input.mapped.body },
  };
}

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
      return undefined;
  }
}

function findUnfilledPathParam(path: string): string | undefined {
  const match = /\{([^}]+)\}/.exec(path);
  return match?.[1];
}

function joinUrl(baseUrl: string, path: string): string {
  const base = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return `${base}${suffix}`;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
