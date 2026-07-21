import { randomUUID } from "node:crypto";

import { MountManager, type ServeHandler } from "@mediator/adapter-engine";
import { AuditLogRepository, type Database } from "@mediator/db";
import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import Fastify from "fastify";

import { AdapterTelemetry } from "./adapter-telemetry.js";
import { DbAdapterStore } from "./db-adapter-store.js";
import type { ConsumerAppResolver } from "./consumer-app-resolver.js";
import { AdapterRequestHandler } from "./request-handler.js";
import { RestProtocolServer } from "./rest-protocol-server.js";

/** The HTTP methods the adapter surface routes; anything else falls through to 404. */
const ROUTED_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const;

export interface AdapterRuntimeDeps {
  readonly db: Database;
  readonly logger: FastifyBaseLogger;
  /**
   * The serving seam (RP/TE/AG). Omitted in this RT slice — a `serve` resolution then
   * renders the `serving-not-implemented` placeholder. A later slice injects the real
   * `ServeHandler`; nothing else about the runtime changes.
   */
  readonly serveHandler?: ServeHandler;
  /**
   * The Auth Gateway resolver that authenticates each caller and derives its consumer
   * app id (AT-2/AT-3). **Required — there is deliberately no default.** An auth
   * surface must never silently fall back to a trusting stand-in (the header resolver
   * trusts `x-mediator-consumer-app-id` and would let any caller impersonate any
   * consumer), so every composition must supply a resolver explicitly and the
   * compiler enforces it. Production wires the token-validating resolver; RT's own
   * tests pass the header stand-in (`headerConsumerAppResolver`) explicitly.
   */
  readonly resolveConsumerApp: ConsumerAppResolver;
  readonly newId?: () => string;
}

export interface AdapterRuntime {
  /** The second Fastify instance — the Adapter Server Runtime listener (RT-1). */
  readonly app: FastifyInstance;
  /** Re-derives the mounted surface from persisted state (RT-4); call at startup and on events. */
  readonly mountManager: MountManager;
  /** The REST Protocol Server holding the live route tables (test/observability seam). */
  readonly protocolServer: RestProtocolServer;
}

/**
 * Build the **Adapter Server Runtime** (RT-1): a second Fastify instance, separate
 * from the operator API, that hosts each active `CONSUMER` spec's operation surface
 * as a virtual provider. The operator surface is deliberately **not** mounted here,
 * and this surface is not reachable on the operator port — a bug on one listener
 * cannot serve the other's routes (RT-1.2/1.3).
 *
 * It registers a single wildcard handler rather than one Fastify route per
 * operation: the mounted surface is an in-memory route table (derived from IR) that
 * the {@link MountManager} replaces atomically, so operations become routable or
 * stop being served **live** without a process restart or a port re-bind
 * (RT-4.1/4.3). A path in no mounted spec falls to the wildcard's own miss (or the
 * not-found handler) as a plain **404**, distinct from `not-yet-mapped`.
 *
 * The caller owns the lifecycle: `app.listen(config.adapterHttp.port)` and
 * `mountManager.reconcile()` at startup, and `app.close()` on shutdown.
 */
export function buildAdapterRuntime(deps: AdapterRuntimeDeps): AdapterRuntime {
  const app = Fastify({ loggerInstance: deps.logger });

  // Capture any request body without a specific parser (RT-2.4: do not narrow the
  // surface). JSON/text keep their built-in parsers; everything else is captured raw
  // rather than rejected with a 415.
  app.addContentTypeParser("*", { parseAs: "string" }, (_request, body, done) => {
    done(null, body);
  });

  const protocolServer = new RestProtocolServer();
  const store = new DbAdapterStore(deps.db);
  const telemetry = new AdapterTelemetry();
  const auditWriter = {
    record: (entry: Parameters<AuditLogRepository["insert"]>[0]) =>
      new AuditLogRepository(deps.db).insert(entry),
  };
  const handler = new AdapterRequestHandler({
    protocolServer,
    store,
    resolveConsumerApp: deps.resolveConsumerApp,
    auditWriter,
    telemetry,
    ...(deps.serveHandler !== undefined ? { serveHandler: deps.serveHandler } : {}),
    newId: deps.newId ?? randomUUID,
  });

  // A single wildcard route for the whole surface; the in-memory route table decides
  // which operation (if any) a request maps to. `/` is registered too so a root
  // request is handled (and answered 404) rather than falling to Fastify's default.
  const route = { method: [...ROUTED_METHODS], handler: handler.handle.bind(handler) };
  app.route({ ...route, url: "/" });
  app.route({ ...route, url: "/*" });

  // A path/method the wildcard did not catch (e.g. an unrouted method) → plain 404,
  // deliberately distinguishable from `not-yet-mapped`.
  app.setNotFoundHandler((_request, reply) => {
    void reply.code(404).send({ error: "Not Found", message: "No such adapter operation." });
  });

  // Never leak internals or a request/response payload through an error body.
  app.setErrorHandler((error, request, reply) => {
    request.log.error({ err: error }, "unhandled adapter runtime error");
    void reply
      .code(500)
      .send({ error: "Internal Server Error", message: "The request could not be processed." });
  });

  const mountManager = new MountManager({ store, protocolServer });
  return { app, mountManager, protocolServer };
}
