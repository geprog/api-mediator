import { loadConfig } from "@mediator/config";
import { createDb, type Database } from "@mediator/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildServer, type RunningServer } from "./composition-root.js";

/**
 * Live-database integration test for the operator API skeleton. Requires the
 * compose `postgres` service (`docker compose up -d postgres --wait`) and a
 * resolvable environment (the repo-root `.env` is loaded by
 * `vitest.integration.config.ts`). Excluded from the default `pnpm test`; run it
 * with `pnpm --filter @mediator/backend test:integration`.
 *
 * It proves the composition root wires a real DB ping end to end: `/health`
 * answers 200 `db: "up"` only when the `SELECT 1` probe actually reaches Postgres.
 */
describe("operator API /health integration (requires Postgres)", () => {
  let server: RunningServer;
  let db: Database;

  beforeAll(() => {
    const config = loadConfig();
    db = createDb(config.database.url);
    server = buildServer({ config, db });
  });

  afterAll(async () => {
    await server.shutdown();
  });

  it("returns 200 db: up against the live database", async () => {
    const response = await server.app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok", db: "up" });
  });
});
