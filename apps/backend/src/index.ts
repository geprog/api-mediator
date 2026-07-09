/**
 * `@mediator/backend` entrypoint — the operator API surface.
 *
 * Telemetry is started separately by the `otel.ts` preload (`node --import`),
 * which must run before this module so instrumented libraries are patched. Here
 * we load config, create the database pool, wire the server via the composition
 * root, start listening, and install signal handlers for graceful shutdown.
 */
import { loadConfig } from "@mediator/config";
import { createDb } from "@mediator/db";

import { buildServer, createServerLogger } from "./composition-root.js";
import { loadRepoEnv } from "./env.js";

/**
 * Dev binds loopback: the operator API is a host-local surface (the second,
 * token-gated Adapter Server Runtime is a separate Phase-5 surface).
 */
const HOST = "127.0.0.1";

loadRepoEnv();
const config = loadConfig();
const logger = createServerLogger(config);
// Wire the shared logger to the pool's 'error' listener so a dropped idle
// connection (Postgres restart, admin shutdown, network partition) is logged and
// survivable — `/health` then returns 503 instead of the process crashing.
const db = createDb(config.database.url, (error) => {
  logger.error({ error: error.message }, "database pool error (idle client) — swallowed");
});
const { app, shutdown } = buildServer({ config, db, logger });

async function handleSignal(signal: NodeJS.Signals): Promise<void> {
  app.log.info({ signal }, "shutdown signal received");
  try {
    await shutdown();
    process.exit(0);
  } catch (error) {
    app.log.error(
      { error: error instanceof Error ? error.message : String(error) },
      "graceful shutdown failed",
    );
    process.exit(1);
  }
}

process.once("SIGTERM", (signal) => {
  void handleSignal(signal);
});
process.once("SIGINT", (signal) => {
  void handleSignal(signal);
});

try {
  await app.listen({ port: config.http.port, host: HOST });
} catch (error) {
  app.log.error(
    { error: error instanceof Error ? error.message : String(error) },
    "operator API failed to start",
  );
  await shutdown();
  process.exit(1);
}
