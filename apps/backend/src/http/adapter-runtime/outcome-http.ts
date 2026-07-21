import type { AdapterRequestCause, AuditLogStatus } from "@mediator/domain";

/**
 * Maps a **matched** adapter request's disposition to (a) its HTTP response and
 * (b) its `adapter-request` audit fields. This is the REST side of the seam: HTTP
 * status codes live here, never in the `@mediator/adapter-engine` core (RT-1.5,
 * README open question 2 — the machine-readable **cause token** is the contract;
 * status codes are a suggested, implementation-defined mapping).
 */

/**
 * The machine-readable cause token carried in the response body **and** the
 * {@link CAUSE_HEADER} header (RT-3.5) — a stable identifier independent of the
 * chosen HTTP status. The seven taxonomy causes plus `serving-not-implemented`,
 * this RT slice's placeholder for a `serve` outcome whose Resolution Planner (RP)
 * is not built yet; that placeholder disappears when RP wires a `ServeHandler`.
 */
export type CauseToken = AdapterRequestCause | "serving-not-implemented";

/** Response header carrying the {@link CauseToken} (RT-3.5, machine-readable cause). */
export const CAUSE_HEADER = "x-mediator-cause";
/** Response header flagging a degraded (failed-supplement) response (AD-5.3). */
export const DEGRADED_HEADER = "x-mediator-degraded";
/** Out-of-band provenance header naming the contributing backends (never in the body). */
export const CONTRIBUTING_BACKENDS_HEADER = "x-mediator-contributing-backends";

/**
 * The final disposition of a request that **matched a mounted operation** (so a
 * plain 404 — path in no spec — is not represented here; that is decided before
 * resolution). `not-yet-mapped` / `endpoint-disabled` are RT-3's; `served` /
 * `serve-failed` come back across the seam from a `ServeHandler`;
 * `serving-not-implemented` is this slice's placeholder for a `serve` resolution
 * with no handler wired.
 */
export type AdapterResult =
  | { readonly kind: "not-yet-mapped"; readonly endpointId: string | undefined }
  | { readonly kind: "endpoint-disabled"; readonly endpointId: string }
  | {
      readonly kind: "served";
      readonly endpointId: string;
      readonly bindingId: string | undefined;
      readonly body: unknown;
      readonly degraded: boolean;
      readonly contributingBackendAppIds: readonly string[];
    }
  | {
      readonly kind: "serve-failed";
      readonly endpointId: string;
      readonly bindingId: string | undefined;
      readonly cause: AdapterRequestCause;
    }
  | {
      readonly kind: "serving-not-implemented";
      readonly endpointId: string;
      readonly bindingId: string | undefined;
    };

/** The rendered HTTP response for an {@link AdapterResult}. */
export interface HttpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
}

/** A short, payload-free human message per cause (never echoes request data). */
function messageFor(cause: CauseToken): string {
  switch (cause) {
    case "not-yet-mapped":
      return "This consumer operation has no approved backend binding yet.";
    case "endpoint-disabled":
      return "This adapter endpoint is disabled.";
    case "mapping-stale":
      return "The mapping backing this operation is stale and needs re-review.";
    case "mapping-suspended":
      return "The mapping backing this operation is suspended by an operator.";
    case "backend-disabled":
      return "A backend app for this operation is disabled.";
    case "mediator-transform-error":
      return "The mediator produced a response that failed the consumer's schema.";
    case "upstream-error":
      return "A backend app failed to serve this request.";
    case "serving-not-implemented":
      return "This operation is mapped, but the adapter serving pipeline is not implemented yet.";
  }
}

/** The suggested HTTP status for a serve-phase failure cause (README open question 2). */
function statusForCause(cause: AdapterRequestCause): number {
  switch (cause) {
    case "not-yet-mapped":
      return 501;
    case "endpoint-disabled":
    case "mapping-stale":
    case "mapping-suspended":
    case "backend-disabled":
      return 503;
    case "mediator-transform-error":
      return 500;
    case "upstream-error":
      return 502;
  }
}

/**
 * Render an {@link AdapterResult} to its HTTP response. A non-served result carries
 * its {@link CauseToken} in both the body (`{ cause, message }`) and the
 * {@link CAUSE_HEADER}; a served result returns the consumer-shape body with the
 * degradation/provenance signalled out-of-band via headers (never in the body).
 */
export function renderHttpResponse(result: AdapterResult): HttpResponse {
  switch (result.kind) {
    case "not-yet-mapped":
      return causeResponse(501, "not-yet-mapped");
    case "endpoint-disabled":
      return causeResponse(503, "endpoint-disabled");
    case "serving-not-implemented":
      return causeResponse(501, "serving-not-implemented");
    case "serve-failed":
      return causeResponse(statusForCause(result.cause), result.cause);
    case "served": {
      const headers: Record<string, string> = {};
      if (result.degraded) {
        headers[DEGRADED_HEADER] = "true";
      }
      if (result.contributingBackendAppIds.length > 0) {
        headers[CONTRIBUTING_BACKENDS_HEADER] = result.contributingBackendAppIds.join(",");
      }
      return { status: 200, headers, body: result.body };
    }
  }
}

/**
 * The {@link CauseToken} of a result, for span/metric attributes — `undefined` for
 * a clean `served` response (there is no cause). Independent of the HTTP status
 * (RT-3.5): the token is the stable contract.
 */
export function causeTokenOf(result: AdapterResult): CauseToken | undefined {
  switch (result.kind) {
    case "not-yet-mapped":
      return "not-yet-mapped";
    case "endpoint-disabled":
      return "endpoint-disabled";
    case "serving-not-implemented":
      return "serving-not-implemented";
    case "serve-failed":
      return result.cause;
    case "served":
      return undefined;
  }
}

function causeResponse(status: number, cause: CauseToken): HttpResponse {
  return {
    status,
    headers: { [CAUSE_HEADER]: cause },
    body: { cause, message: messageFor(cause) },
  };
}

/** The `adapter-request` audit fields for a result (metadata only — AD-5, RT-5.5). */
export interface AdapterAuditFields {
  readonly status: AuditLogStatus;
  readonly cause?: AdapterRequestCause;
  readonly degraded?: boolean;
  readonly endpointId?: string;
  readonly bindingId?: string;
  readonly details?: string;
}

/**
 * Derive the `adapter-request` audit fields for a result. `status` reuses the
 * Phase-4 enum unchanged; `cause`/`degraded` are the AD-5 adapter columns. Ids and
 * enums only — never a request/response payload, a token, or credential material
 * (RT-5.5). The `serving-not-implemented` placeholder carries **no** taxonomy
 * `cause` (none of the seven applies) — only a `details` note.
 */
export function auditFieldsFor(result: AdapterResult): AdapterAuditFields {
  switch (result.kind) {
    case "not-yet-mapped":
      return {
        status: "failure",
        cause: "not-yet-mapped",
        ...(result.endpointId !== undefined ? { endpointId: result.endpointId } : {}),
      };
    case "endpoint-disabled":
      return { status: "failure", cause: "endpoint-disabled", endpointId: result.endpointId };
    case "served":
      return {
        status: "success",
        endpointId: result.endpointId,
        ...(result.bindingId !== undefined ? { bindingId: result.bindingId } : {}),
        ...(result.degraded ? { degraded: true } : {}),
      };
    case "serve-failed":
      return {
        status: "failure",
        cause: result.cause,
        endpointId: result.endpointId,
        ...(result.bindingId !== undefined ? { bindingId: result.bindingId } : {}),
      };
    case "serving-not-implemented":
      return {
        status: "failure",
        endpointId: result.endpointId,
        ...(result.bindingId !== undefined ? { bindingId: result.bindingId } : {}),
        details: "serving-not-implemented (RT slice; Resolution Planner is RP)",
      };
  }
}
