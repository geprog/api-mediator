import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

/**
 * Integration Vitest project for `@mediator/credentials`. Runs ONLY the
 * `*.integration.spec.ts` files and requires a live Postgres (the compose
 * `postgres` service): it proves ciphertext at rest, the decrypt round-trip, and
 * metadata secrecy against a real database. The root `test.projects` glob only
 * matches each package's `vitest.config.ts`, so this config is never part of
 * `pnpm verify` / `pnpm test`. Run it explicitly with
 * `pnpm --filter @mediator/credentials test:integration`.
 *
 * As an operator convenience, load `DATABASE_URL` from the repo-root `.env` when
 * present, so the suite can be run without exporting it by hand. An
 * already-exported `DATABASE_URL` still wins because `loadEnvFile` does not
 * overwrite existing variables. Vitest forwards `process.env` to the workers.
 */
const repoEnvPath = fileURLToPath(new URL("../../.env", import.meta.url));
if (existsSync(repoEnvPath)) {
  process.loadEnvFile(repoEnvPath);
}

export default defineConfig({
  test: {
    name: "credentials-integration",
    environment: "node",
    include: ["src/**/*.integration.spec.ts"],
  },
});
