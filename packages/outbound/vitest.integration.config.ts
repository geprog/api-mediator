import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

/**
 * Integration Vitest project for `@mediator/outbound`. Runs ONLY the
 * `*.integration.spec.ts` files and requires a live Postgres (the compose
 * `postgres` service): the `SyncEvent` writes, the OC-2 bounded idempotency
 * lookback query, and the `0012` migration applying clean are proven against a
 * REAL database. The root `test.projects` glob only matches each package's
 * `vitest.config.ts`, so this config is never part of `pnpm verify` / `pnpm test`.
 * Run it explicitly with `pnpm --filter @mediator/outbound test:integration`.
 *
 * As an operator convenience, load `DATABASE_URL` from the repo-root `.env` when
 * present. An already-exported `DATABASE_URL` still wins (`loadEnvFile` does not
 * overwrite existing variables).
 */
const repoEnvPath = fileURLToPath(new URL("../../.env", import.meta.url));
if (existsSync(repoEnvPath)) {
  process.loadEnvFile(repoEnvPath);
}

export default defineConfig({
  test: {
    name: "outbound-integration",
    environment: "node",
    include: ["src/**/*.integration.spec.ts"],
    // Run the integration spec FILES serially (as the `@mediator/db` integration
    // project does): they share one database and both migrate it in `beforeAll`,
    // and the reconciler-convergence file seeds FK-referenced `registered_app` /
    // `api_spec` rows whose lifetime must not overlap the sibling file's blanket
    // `delete(registered_app)` teardown. Serializing avoids that cross-file race.
    fileParallelism: false,
  },
});
