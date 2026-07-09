import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

/**
 * Integration Vitest project for `@mediator/db`. Runs ONLY the
 * `*.integration.spec.ts` files and requires a live Postgres (the compose
 * `postgres` service). The root `test.projects` glob only matches each package's
 * `vitest.config.ts`, so this config is never part of `pnpm verify` / `pnpm test`.
 * Run it explicitly with `pnpm --filter @mediator/db test:integration`.
 *
 * As an operator convenience, load `DATABASE_URL` (and friends) from the
 * repo-root `.env` when present, so the suite can be run without exporting it by
 * hand. An already-exported `DATABASE_URL` still wins because `loadEnvFile` does
 * not overwrite existing variables. Vitest forwards `process.env` to the test
 * workers.
 */
const repoEnvPath = fileURLToPath(new URL("../../.env", import.meta.url));
if (existsSync(repoEnvPath)) {
  process.loadEnvFile(repoEnvPath);
}

export default defineConfig({
  test: {
    name: "db-integration",
    environment: "node",
    include: ["src/**/*.integration.spec.ts"],
  },
});
