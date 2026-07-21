import {
  resolveRequest,
  type AdapterRequest,
  type AdapterStore,
  type ResolutionOutcome,
  type ServeHandler,
} from "@mediator/adapter-engine";
import type { AdapterBinding } from "@mediator/domain";
import { getActiveTraceContext } from "@mediator/telemetry";
import { SpanStatusCode } from "@opentelemetry/api";
import type { FastifyReply, FastifyRequest } from "fastify";

import { buildAdapterRequestAudit, type AdapterAuditWriter } from "./adapter-audit.js";
import { AdapterTelemetry } from "./adapter-telemetry.js";
import type { ConsumerAppResolver, ResolvedConsumerApp } from "./consumer-app-resolver.js";
import {
  auditFieldsFor,
  causeTokenOf,
  renderHttpResponse,
  type AdapterResult,
} from "./outcome-http.js";
import type { RestProtocolServer } from "./rest-protocol-server.js";
import type { RouteMatch } from "./rest-routes.js";

export interface AdapterRequestHandlerDeps {
  readonly protocolServer: RestProtocolServer;
  readonly store: AdapterStore;
  readonly resolveConsumerApp: ConsumerAppResolver;
  readonly auditWriter: AdapterAuditWriter;
  readonly telemetry: AdapterTelemetry;
  /**
   * The serving seam (RP/TE/AG). Optional in this RT slice — when absent, a `serve`
   * resolution renders the distinct `serving-not-implemented` placeholder (never
   * `not-yet-mapped`); when present, `serve` outcomes delegate to it.
   */
  readonly serveHandler?: ServeHandler;
  readonly newId: () => string;
}

/**
 * The single Request Router / orchestration for the Adapter Server Runtime: it maps
 * one inbound HTTP request to its consumer app + operation, resolves the RT-3
 * answer, renders the HTTP response, and writes **exactly one** `adapter-request`
 * audit row plus per-endpoint telemetry (RT-5).
 *
 * Two dispositions happen **before** a request becomes an "adapter request" and are
 * deliberately *not* audited: an unattributable caller (`401`, no consumer app) and
 * a path in no mounted spec (plain `404`). Everything that matched a mounted
 * operation is traced, resolved, rendered, and audited once.
 */
export class AdapterRequestHandler {
  public constructor(private readonly deps: AdapterRequestHandlerDeps) {}

  public async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    // The Auth Gateway runs strictly in front (AT-2.1): the token is validated
    // *before* any routing/planning/serving, so nothing outbound happens for an
    // unauthenticated, unrecognized, expired, or foreign token.
    const resolution = await this.deps.resolveConsumerApp(request);
    if (resolution === undefined) {
      // Unattributable → 401, never audited: it never reached a consumer surface.
      // A recognized-but-invalid token lands here too — a clean 401, never a serve,
      // distinct from every serving cause (AT-2.4).
      await reply
        .code(401)
        .send({ cause: "unauthenticated", message: "The adapter caller could not be identified." });
      return;
    }

    const method = request.method;
    const path = request.url.split("?")[0] ?? "/";
    const match = this.deps.protocolServer.resolve(resolution.consumerAppId, method, path);
    if (match === undefined) {
      // Path in no mounted consumer spec → plain 404, never audited (RT-2.2/RT-3):
      // deliberately distinguishable from `not-yet-mapped`.
      await reply.code(404).send({ error: "Not Found", message: "No such adapter operation." });
      return;
    }

    await this.handleMatched(resolution, match, request, reply);
  }

  private async handleMatched(
    resolution: ResolvedConsumerApp,
    match: RouteMatch,
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const consumerAppId = resolution.consumerAppId;
    const operationKey = match.route.operationKey;
    const startedAt = performance.now();

    await this.deps.telemetry.tracer.startActiveSpan("adapter.request", async (rootSpan) => {
      rootSpan.setAttribute("adapter.consumer_app_id", consumerAppId);
      rootSpan.setAttribute("adapter.operation", operationKey);

      let result: AdapterResult | null = null;
      try {
        const outcome = await this.resolveWithinSpan(consumerAppId, operationKey);
        result = await this.serveOutcome(outcome, consumerAppId, operationKey, match, request);
      } catch (error) {
        rootSpan.recordException(error instanceof Error ? error : new Error(String(error)));
        rootSpan.setStatus({ code: SpanStatusCode.ERROR });
      }

      const durationMs = performance.now() - startedAt;
      if (result === null) {
        // An unexpected internal failure (e.g. the store threw): still exactly one
        // audit row and a generic 500 — never a payload-leaking error body.
        rootSpan.setAttribute("adapter.outcome", "internal-error");
        await this.recordAudit(resolution, {
          status: "failure",
          details: "internal-error",
        });
        this.deps.telemetry.recordRequest({
          operationKey,
          endpointId: undefined,
          consumerAppId,
          outcome: "internal-error",
          cause: undefined,
          degraded: false,
          durationMs,
        });
        await reply
          .code(500)
          .send({ error: "Internal Server Error", message: "The request could not be processed." });
        rootSpan.end();
        return;
      }

      rootSpan.setAttribute("adapter.outcome", result.kind);
      const cause = causeTokenOf(result);
      if (cause !== undefined) {
        rootSpan.setAttribute("adapter.cause", cause);
      }
      const auditFields = auditFieldsFor(result);
      await this.recordAudit(resolution, auditFields);
      this.deps.telemetry.recordRequest({
        operationKey,
        endpointId: auditFields.endpointId,
        consumerAppId,
        outcome: result.kind,
        cause,
        degraded: auditFields.degraded ?? false,
        durationMs,
      });

      const httpResponse = renderHttpResponse(result);
      for (const [name, value] of Object.entries(httpResponse.headers)) {
        void reply.header(name, value);
      }
      await reply.code(httpResponse.status).send(httpResponse.body);
      rootSpan.end();
    });
  }

  /** Load persisted state and decide the RT-3 answer, inside the planning span. */
  private resolveWithinSpan(
    consumerAppId: string,
    operationKey: string,
  ): Promise<ResolutionOutcome> {
    return this.deps.telemetry.tracer.startActiveSpan("adapter.resolve", async (span) => {
      try {
        const state = await this.deps.store.loadEndpointState(consumerAppId, operationKey);
        return resolveRequest(state);
      } finally {
        span.end();
      }
    });
  }

  /** Turn a resolution outcome into the final result, delegating a `serve` to the seam. */
  private async serveOutcome(
    outcome: ResolutionOutcome,
    consumerAppId: string,
    operationKey: string,
    match: RouteMatch,
    request: FastifyRequest,
  ): Promise<AdapterResult> {
    if (outcome.kind === "not-yet-mapped") {
      return { kind: "not-yet-mapped", endpointId: outcome.endpointId };
    }
    if (outcome.kind === "endpoint-disabled") {
      return { kind: "endpoint-disabled", endpointId: outcome.endpointId };
    }

    const bindingId = pickPrimaryBindingId(outcome.activeBindings);
    const serveHandler = this.deps.serveHandler;
    if (serveHandler === undefined) {
      // RT slice: no serving core wired → distinct placeholder, never not-yet-mapped.
      return { kind: "serving-not-implemented", endpointId: outcome.endpoint.id, bindingId };
    }

    const adapterRequest = buildAdapterRequest(consumerAppId, operationKey, match, request);
    return this.deps.telemetry.tracer.startActiveSpan(
      "adapter.serve",
      async (span): Promise<AdapterResult> => {
        try {
          const served = await serveHandler.serve({
            request: adapterRequest,
            endpoint: outcome.endpoint,
            activeBindings: outcome.activeBindings,
          });
          if (served.kind === "served") {
            return {
              kind: "served",
              endpointId: outcome.endpoint.id,
              bindingId,
              body: served.body,
              degraded: served.degraded,
              contributingBackendAppIds: served.contributingBackendAppIds,
              // AG-2.3 — carry the failed backend(s) out of band for the degraded header.
              ...(served.degradedBackendAppIds !== undefined
                ? { degradedBackendAppIds: served.degradedBackendAppIds }
                : {}),
              // WR-5.4 — write audit metadata (absent on a read), for the audit row only.
              ...(served.idempotencyKey !== undefined
                ? { idempotencyKey: served.idempotencyKey }
                : {}),
              ...(served.deduplicated === true ? { deduplicated: true } : {}),
            };
          }
          if (served.kind === "rejected") {
            // RP-2: a consumer-contract violation, answered before any backend ran —
            // a client error distinct from every serving cause.
            return {
              kind: "request-rejected",
              endpointId: outcome.endpoint.id,
              reason: served.reason,
              detail: served.detail,
            };
          }
          return {
            kind: "serve-failed",
            endpointId: outcome.endpoint.id,
            bindingId,
            cause: served.cause,
            // WR-5.4 — write audit metadata (absent on a read failure), for the audit row.
            ...(served.idempotencyKey !== undefined
              ? { idempotencyKey: served.idempotencyKey }
              : {}),
            ...(served.deduplicated === true ? { deduplicated: true } : {}),
          };
        } finally {
          span.end();
        }
      },
    );
  }

  private async recordAudit(
    resolution: ResolvedConsumerApp,
    fields: Parameters<typeof buildAdapterRequestAudit>[0]["fields"],
  ): Promise<void> {
    const entry = buildAdapterRequestAudit({
      consumerAppId: resolution.consumerAppId,
      // AT-4.3: record which adapter token authenticated the request (by id, never
      // by value), so a request served during a rotation overlap is attributable.
      ...(resolution.credentialId !== undefined ? { credentialId: resolution.credentialId } : {}),
      fields,
      newId: this.deps.newId,
      now: new Date(),
      trace: getActiveTraceContext(),
    });
    try {
      await this.deps.auditWriter.record(entry);
    } catch {
      // Best-effort: a failed audit write must never crash the live response. The
      // one-row-per-request invariant holds whenever the store is reachable.
    }
  }
}

/** The primary active binding's id (or the first active one), for `relatedBindingId`. */
function pickPrimaryBindingId(bindings: readonly AdapterBinding[]): string | undefined {
  const primary = bindings.find((binding) => binding.role === "primary");
  return (primary ?? bindings[0])?.id;
}

/** Build the protocol-neutral {@link AdapterRequest} from the HTTP request (RT-2.4). */
function buildAdapterRequest(
  consumerAppId: string,
  operationKey: string,
  match: RouteMatch,
  request: FastifyRequest,
): AdapterRequest {
  return {
    consumerAppId,
    operationKey,
    pathParameters: match.pathParameters,
    query: normalizeQuery(request.query),
    headers: normalizeHeaders(request.headers),
    body: request.body,
  };
}

function normalizeHeaders(
  headers: FastifyRequest["headers"],
): Readonly<Record<string, string | readonly string[]>> {
  const result: Record<string, string | readonly string[]> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value !== undefined) {
      result[key] = value;
    }
  }
  return result;
}

function normalizeQuery(raw: unknown): Readonly<Record<string, string | readonly string[]>> {
  if (raw === null || typeof raw !== "object") {
    return {};
  }
  const result: Record<string, string | readonly string[]> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === "string") {
      result[key] = value;
    } else if (Array.isArray(value)) {
      result[key] = value.filter((item): item is string => typeof item === "string");
    }
  }
  return result;
}
