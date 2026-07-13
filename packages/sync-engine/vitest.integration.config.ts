import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

/**
 * Integration Vitest project for `@mediator/sync-engine`. Runs ONLY the
 * `*.integration.spec.ts` files and requires a live Postgres (the compose
 * `postgres` service): the `ordering_queue`'s `FOR UPDATE SKIP LOCKED` +
 * per-key-lease claim discipline cannot be faked, so at-most-one-active-worker-
 * per-key, cross-key parallelism, durable crash recovery (expired-lease re-claim),
 * and enqueue-order-per-key-under-contention are proven against a REAL database +
 * the `0011` migration. The root `test.projects` glob only matches each package's
 * `vitest.config.ts`, so this config is never part of `pnpm verify` / `pnpm test`.
 * Run it explicitly with `pnpm --filter @mediator/sync-engine test:integration`.
 *
 * As an operator convenience, load `DATABASE_URL` from the repo-root `.env` when
 * present, so the suite can run without exporting it by hand. An already-exported
 * `DATABASE_URL` still wins because `loadEnvFile` does not overwrite existing
 * variables. Vitest forwards `process.env` to the workers.
 */
const repoEnvPath = fileURLToPath(new URL("../../.env", import.meta.url));
if (existsSync(repoEnvPath)) {
  process.loadEnvFile(repoEnvPath);
}

export default defineConfig({
  test: {
    name: "sync-engine-integration",
    environment: "node",
    include: ["src/**/*.integration.spec.ts"],
  },
});
