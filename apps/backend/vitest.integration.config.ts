import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

/**
 * Integration Vitest project for `@mediator/backend`. Runs ONLY the
 * `*.integration.spec.ts` files and requires a live Postgres (the compose
 * `postgres` service). The root `test.projects` glob only matches each package's
 * `vitest.config.ts`, so this config is never part of `pnpm verify` / `pnpm test`.
 * Run it explicitly with `pnpm --filter @mediator/backend test:integration`.
 *
 * As an operator convenience, load the repo-root `.env` when present so the suite
 * can be run without exporting variables by hand (mirroring the `@mediator/db`
 * integration config). An already-exported variable still wins because
 * `loadEnvFile` does not overwrite existing variables.
 */
const repoEnvPath = fileURLToPath(new URL("../../.env", import.meta.url));
if (existsSync(repoEnvPath)) {
  process.loadEnvFile(repoEnvPath);
}

export default defineConfig({
  test: {
    name: "backend-integration",
    environment: "node",
    include: ["src/**/*.integration.spec.ts"],
    // Serialize integration spec FILES (defense-in-depth alongside the
    // `runMigrations` advisory lock): every file migrates the same database.
    fileParallelism: false,
  },
});
