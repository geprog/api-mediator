import type { AppConfig } from "@mediator/config";
import { closeDb, type Database } from "@mediator/db";
import { getActiveTraceContext, shutdownTelemetry } from "@mediator/telemetry";
import Fastify, { type FastifyInstance } from "fastify";

import { pingDatabase, registerHealthRoute } from "./http/operator/health.js";

/**
 * Explicit composition root for the operator API — no DI framework.
 *
 * `buildServer` receives an already-loaded {@link AppConfig} and {@link Database}
 * rather than constructing them, which (a) keeps the wiring in one place and
 * (b) makes the server unit-testable against a fake database. It builds the
 * Fastify instance, registers routes, and returns a `shutdown` that tears the
 * process down in the right order.
 */

export interface ServerDependencies {
  readonly config: AppConfig;
  readonly db: Database;
}

export interface RunningServer {
  readonly app: FastifyInstance;
  /**
   * Graceful teardown: stop accepting/drain HTTP requests, then close the DB
   * pool, then flush and shut down telemetry last (so shutdown itself is still
   * observable).
   */
  readonly shutdown: () => Promise<void>;
}

/**
 * A pino `mixin` that stamps the active span's `traceId`/`spanId` onto every log
 * record, so logs correlate with traces in Grafana. When telemetry is disabled
 * or there is no active span, {@link getActiveTraceContext} returns `null` and
 * the fields are simply absent — never a crash.
 */
function traceContextMixin(): Record<string, string> {
  const traceContext = getActiveTraceContext();
  if (traceContext === null) {
    return {};
  }
  return { traceId: traceContext.traceId, spanId: traceContext.spanId };
}

export function buildServer(deps: ServerDependencies): RunningServer {
  const serviceName = deps.config.telemetry.enabled
    ? deps.config.telemetry.serviceName
    : "api-mediator";

  const app = Fastify({
    logger: {
      name: serviceName,
      mixin: traceContextMixin,
    },
  });

  registerHealthRoute(app, { pingDb: () => pingDatabase(deps.db) });

  const shutdown = async (): Promise<void> => {
    await app.close();
    await closeDb(deps.db);
    await shutdownTelemetry();
  };

  return { app, shutdown };
}
