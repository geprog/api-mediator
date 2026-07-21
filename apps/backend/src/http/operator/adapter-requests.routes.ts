import {
  adapterHealthResponseSchema,
  adapterRequestHistoryQuerySchema,
  adapterRequestHistoryResponseSchema,
  type AdapterHealthResponse,
  type AdapterRequestHistoryResponse,
} from "@mediator/contracts";
import type { AdapterRequestQuery } from "@mediator/db";
import type { FastifyInstance } from "fastify";

import type {
  AdapterRequestHistoryReader,
  AdapterStateReader,
} from "../../modules/adapter-state.js";
import { requireViewer } from "../auth/index.js";
import { parseInput } from "../validation.js";
import {
  assembleEndpointStates,
  deriveHealthConditions,
  toAdapterRequestDto,
} from "./adapter-state-view.js";

/**
 * The default/maximum row bound for the AP-5 reads, so history is never an unbounded scan
 * (`docs/requirements/phase-5-adapter-api.md` AP-5.1). The history endpoint honors a smaller
 * `limit` from the query; the health endpoint's `transformErrors` window is fixed.
 */
const DEFAULT_HISTORY_LIMIT = 100;
const TRANSFORM_ERROR_LIMIT = 100;

/**
 * Phase-5 adapter request-history + endpoint-health operator reads (AP-5). Both are
 * `viewer`-allowed (OA-2) and **metadata only** (AP-5.4): every row is projected from the
 * `adapter-request` `SyncEvent`/`AuditLog` — outcome, cause, `degraded`, endpoint/binding
 * ids, actor, a short `details` note, and `traceId`/`spanId` — **never** a request/response
 * payload value, an adapter token, or credential material.
 *
 * - `GET /api/adapter-requests?endpointId=&bindingId=&since=&until=&status=&cause=&limit=`
 *   (AP-5.1/5.2) — the request history, filterable and bounded; each row's `outcome`
 *   distinguishes a clean success from a `degraded` success and from a `failure`.
 * - `GET /api/adapter-requests/health` (AP-5.3) — the operator-actionable conditions the
 *   concept alerts on: endpoints in `composition-required`, `active` bindings whose mapping
 *   is `stale` (derived at read), and recent `mediator-transform-error` occurrences.
 */
export function registerAdapterRequestRoutes(
  app: FastifyInstance,
  adapterState: AdapterStateReader,
  adapterRequestHistory: AdapterRequestHistoryReader,
): void {
  // ── AP-5.3 — endpoint health (viewer) ───────────────────────────────────────
  // Registered before the parameter-free history route below; both paths are literal, so
  // Fastify routes `/health` distinctly regardless of order.
  app.get(
    "/api/adapter-requests/health",
    { preHandler: requireViewer },
    async (): Promise<AdapterHealthResponse> => {
      const endpoints = await assembleEndpointStates(adapterState);
      const conditions = deriveHealthConditions(endpoints);
      const transformErrors = await adapterRequestHistory.query({
        cause: "mediator-transform-error",
        limit: TRANSFORM_ERROR_LIMIT,
      });
      return adapterHealthResponseSchema.parse({
        compositionRequired: conditions.compositionRequired,
        unhealthyBindings: conditions.unhealthyBindings,
        transformErrors: transformErrors.map(toAdapterRequestDto),
      });
    },
  );

  // ── AP-5.1/5.2 — request history (viewer) ───────────────────────────────────
  app.get(
    "/api/adapter-requests",
    { preHandler: requireViewer },
    async (request): Promise<AdapterRequestHistoryResponse> => {
      const query = parseInput(adapterRequestHistoryQuerySchema, request.query, "query parameters");
      const filter: AdapterRequestQuery = {
        ...(query.endpointId !== undefined ? { relatedEndpointId: query.endpointId } : {}),
        ...(query.bindingId !== undefined ? { relatedBindingId: query.bindingId } : {}),
        ...(query.since !== undefined ? { since: query.since } : {}),
        ...(query.until !== undefined ? { until: query.until } : {}),
        ...(query.status !== undefined ? { status: query.status } : {}),
        ...(query.cause !== undefined ? { cause: query.cause } : {}),
        limit: query.limit ?? DEFAULT_HISTORY_LIMIT,
      };
      const rows = await adapterRequestHistory.query(filter);
      return adapterRequestHistoryResponseSchema.parse({
        requests: rows.map(toAdapterRequestDto),
      });
    },
  );
}
