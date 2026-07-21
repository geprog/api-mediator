import {
  adapterEndpointStateResponseSchema,
  adapterHealthResponseSchema,
  adapterRequestHistoryResponseSchema,
  adapterStateResponseSchema,
  composeAdapterEndpointPreviewResponseSchema,
  composeAdapterEndpointResponseSchema,
  type AdapterEndpointStateResponse,
  type AdapterHealthResponse,
  type AdapterRequestHistoryResponse,
  type AdapterStateResponse,
  type ComposeAdapterEndpointPreviewResponse,
  type ComposeAdapterEndpointRequest,
  type ComposeAdapterEndpointResponse,
} from "@mediator/contracts";

import { apiRequest } from "./client.js";

/**
 * The Phase-5 adapter-management HTTP API client (AP-1 read state, AP-2
 * compose/recompose + preview, AP-3 enable/disable, AP-5 request history +
 * health). Each function is a one-liner over {@link apiRequest} that validates the
 * response against its `@mediator/contracts` schema at the boundary. Every
 * composition invariant (role table, order ties, write→single, chain-input
 * provenance, union post-merge semantics) is the **server's** — these are thin
 * calls; a rejected composition comes back as an `ApiError` whose `issues` carry
 * the exact rule violations the server named.
 */

/** `GET /api/adapter-endpoints` (AP-1) — every endpoint's state + the not-yet-mapped needs. */
export function listAdapterEndpoints(): Promise<AdapterStateResponse> {
  return apiRequest("/api/adapter-endpoints", { method: "GET" }, adapterStateResponseSchema);
}

/** `GET /api/adapter-endpoints/:id` (AP-1) — one endpoint's read state. */
export function getAdapterEndpoint(endpointId: string): Promise<AdapterEndpointStateResponse> {
  return apiRequest(
    `/api/adapter-endpoints/${encodeURIComponent(endpointId)}`,
    { method: "GET" },
    adapterEndpointStateResponseSchema,
  );
}

/**
 * `POST /api/adapter-endpoints/:id/composition/preview` (AP-2.4) — the
 * derive-then-confirm read: runs the same derivation/validation `compose` runs
 * against the *proposed* submission but persists **nothing**, returning the CO-4
 * supplement analysis, the CO-5 input-coverage report, the CO-3 union derivations,
 * and whether the composition would validate.
 */
export function previewComposition(
  endpointId: string,
  request: ComposeAdapterEndpointRequest,
): Promise<ComposeAdapterEndpointPreviewResponse> {
  return apiRequest(
    `/api/adapter-endpoints/${encodeURIComponent(endpointId)}/composition/preview`,
    { method: "POST", body: request },
    composeAdapterEndpointPreviewResponseSchema,
  );
}

/**
 * `POST /api/adapter-endpoints/:id/compose` (AP-2.1/2.2) — submit the composition.
 * The server dispatches by endpoint status (compose a `composition-required`
 * endpoint, recompose an `active` one), re-validates, and activates atomically on
 * success; an invalid composition rejects `4xx` with the named rule violations and
 * activates nothing.
 */
export function composeAdapterEndpoint(
  endpointId: string,
  request: ComposeAdapterEndpointRequest,
): Promise<ComposeAdapterEndpointResponse> {
  return apiRequest(
    `/api/adapter-endpoints/${encodeURIComponent(endpointId)}/compose`,
    { method: "POST", body: request },
    composeAdapterEndpointResponseSchema,
  );
}

/** `POST /api/adapter-endpoints/:id/{enable|disable}` (AP-3.1) — endpoint in/out of service. */
export function setAdapterEndpointEnabled(
  endpointId: string,
  enabled: boolean,
): Promise<AdapterEndpointStateResponse> {
  return apiRequest(
    `/api/adapter-endpoints/${encodeURIComponent(endpointId)}/${enabled ? "enable" : "disable"}`,
    { method: "POST" },
    adapterEndpointStateResponseSchema,
  );
}

/**
 * `POST /api/adapter-endpoints/:id/bindings/:bindingId/{enable|disable}` (AP-3.2/3.3)
 * — switch a single binding out of / back into service via a whole-endpoint
 * recompose, so a change that would leave the endpoint unexecutable is rejected
 * with its reason (surfaced as an `ApiError`).
 */
export function setAdapterBindingEnabled(
  endpointId: string,
  bindingId: string,
  enabled: boolean,
): Promise<ComposeAdapterEndpointResponse> {
  return apiRequest(
    `/api/adapter-endpoints/${encodeURIComponent(endpointId)}/bindings/${encodeURIComponent(
      bindingId,
    )}/${enabled ? "enable" : "disable"}`,
    { method: "POST" },
    composeAdapterEndpointResponseSchema,
  );
}

/** A filter for the AP-5.1 adapter-request history read. */
export interface AdapterRequestHistoryFilter {
  readonly endpointId?: string;
  readonly bindingId?: string;
  readonly since?: string;
  readonly until?: string;
  readonly status?: string;
  readonly cause?: string;
  readonly limit?: number;
}

/** `GET /api/adapter-requests?…` (AP-5.1/5.2) — the metadata-only request history. */
export function listAdapterRequests(
  filter: AdapterRequestHistoryFilter = {},
): Promise<AdapterRequestHistoryResponse> {
  const params = new URLSearchParams();
  if (filter.endpointId !== undefined) params.set("endpointId", filter.endpointId);
  if (filter.bindingId !== undefined) params.set("bindingId", filter.bindingId);
  if (filter.since !== undefined) params.set("since", filter.since);
  if (filter.until !== undefined) params.set("until", filter.until);
  if (filter.status !== undefined) params.set("status", filter.status);
  if (filter.cause !== undefined) params.set("cause", filter.cause);
  if (filter.limit !== undefined) params.set("limit", String(filter.limit));
  const query = params.toString();
  return apiRequest(
    `/api/adapter-requests${query === "" ? "" : `?${query}`}`,
    { method: "GET" },
    adapterRequestHistoryResponseSchema,
  );
}

/** `GET /api/adapter-requests/health` (AP-5.3) — operator-actionable adapter health. */
export function getAdapterHealth(): Promise<AdapterHealthResponse> {
  return apiRequest("/api/adapter-requests/health", { method: "GET" }, adapterHealthResponseSchema);
}
