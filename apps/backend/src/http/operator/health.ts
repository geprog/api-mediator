import type { Database } from "@mediator/db";
import type { FastifyInstance } from "fastify";

/**
 * `GET /health` — a real readiness check for the operator API surface, not a
 * static "ok". It pings Postgres so an unreachable database surfaces as HTTP 503
 * (`db: "down"`) rather than a misleading 200. The body deliberately carries no
 * connection details, so it never leaks the database URL or credentials.
 */

/** Whether the database ping succeeded on this request. */
export type DatabaseStatus = "up" | "down";

export interface HealthResponse {
  readonly status: "ok" | "error";
  readonly db: DatabaseStatus;
}

/**
 * What the health route needs from the composition root: a function that
 * resolves when the database answered a probe query and rejects otherwise.
 * Injected so the route is unit-testable with a fake — no live Postgres.
 */
export interface HealthCheckDependencies {
  readonly pingDb: () => Promise<void>;
}

/**
 * Lightweight `SELECT 1` probe through the connection pool. Resolves when the
 * database answers, rejects on any connection/query failure.
 */
export async function pingDatabase(db: Database): Promise<void> {
  await db.$client.query("SELECT 1");
}

/** Register `GET /health` on `app`, backed by `deps.pingDb`. */
export function registerHealthRoute(app: FastifyInstance, deps: HealthCheckDependencies): void {
  app.get("/health", async (request, reply): Promise<HealthResponse> => {
    try {
      await deps.pingDb();
      return { status: "ok", db: "up" };
    } catch (error) {
      request.log.warn(
        { error: error instanceof Error ? error.message : String(error) },
        "health check: database ping failed",
      );
      reply.code(503);
      return { status: "error", db: "down" };
    }
  });
}
