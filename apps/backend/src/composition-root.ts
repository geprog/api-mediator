import type { AppConfig } from "@mediator/config";
import { closeDb, type Database } from "@mediator/db";
import { getActiveTraceContext, shutdownTelemetry } from "@mediator/telemetry";
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from "fastify";
import { pino } from "pino";

import { pingDatabase, registerHealthRoute } from "./http/operator/health.js";

/**
 * Explicit composition root for the operator API — no DI framework.
 *
 * `buildServer` receives an already-loaded {@link AppConfig}, a {@link Database},
 * and a {@link Logger} rather than constructing config/db itself, which (a) keeps
 * the wiring in one place and (b) makes the server unit-testable against a fake
 * database. It builds the Fastify instance, registers routes, and returns a
 * `shutdown` that tears the process down in the right order.
 *
 * The logger is built once ({@link createServerLogger}) and shared: Fastify logs
 * through it (`loggerInstance`) and the caller wires the same instance to the db
 * pool's `'error'` handler, so a dropped idle connection is logged rather than
 * fatal, in the same format as every other log line.
 */

export interface ServerDependencies {
  readonly config: AppConfig;
  readonly db: Database;
  readonly logger: FastifyBaseLogger;
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
 * the fields are simply absent — never a crash. camelCase deliberately matches
 * the data model's `SyncEvent.traceId`/`spanId`; the OTel pino instrumentation's
 * own snake_case log-correlation is disabled in `@mediator/telemetry` so records
 * carry exactly this one pair.
 */
function traceContextMixin(): Record<string, string> {
  const traceContext = getActiveTraceContext();
  if (traceContext === null) {
    return {};
  }
  return { traceId: traceContext.traceId, spanId: traceContext.spanId };
}

/**
 * Build the single pino logger for the operator API, typed as the Fastify logger
 * interface it will drive. Shared by Fastify (`loggerInstance`) and the db
 * pool-error handler so all logs share one format and the trace-context mixin.
 */
export function createServerLogger(config: AppConfig): FastifyBaseLogger {
  const serviceName = config.telemetry.enabled ? config.telemetry.serviceName : "api-mediator";
  return pino({ name: serviceName, mixin: traceContextMixin });
}

export function buildServer(deps: ServerDependencies): RunningServer {
  const app = Fastify({ loggerInstance: deps.logger });

  registerHealthRoute(app, { pingDb: () => pingDatabase(deps.db) });

  const shutdown = async (): Promise<void> => {
    await app.close();
    await closeDb(deps.db);
    await shutdownTelemetry();
  };

  return { app, shutdown };
}
