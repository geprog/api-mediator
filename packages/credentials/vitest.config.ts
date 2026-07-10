import { configDefaults, defineConfig } from "vitest/config";

/**
 * Default (unit) Vitest project for `@mediator/credentials`, picked up by the
 * root `test.projects` glob and therefore by `pnpm verify` / `pnpm test`.
 *
 * These tests must run WITHOUT a live Postgres: the envelope crypto and the
 * `CredentialStore` are exercised against fake persistence. The live-database
 * round-trip lives in `*.integration.spec.ts`, excluded here so it never runs in
 * the default suite; it has its own `vitest.integration.config.ts` and the
 * `test:integration` script.
 */
export default defineConfig({
  test: {
    name: "credentials",
    environment: "node",
    include: ["src/**/*.spec.ts"],
    exclude: [...configDefaults.exclude, "**/*.integration.spec.ts"],
  },
});
