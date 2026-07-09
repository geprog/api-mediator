import { configDefaults, defineConfig } from "vitest/config";

/**
 * Default (unit) Vitest project for `@mediator/db`, picked up by the root
 * `test.projects` glob and therefore by `pnpm verify` / `pnpm test`.
 *
 * These tests must run WITHOUT a live Postgres. Integration tests live in
 * `*.integration.spec.ts` and are explicitly excluded here so they never run as
 * part of the default suite; they have their own `vitest.integration.config.ts`
 * and the `test:integration` script.
 */
export default defineConfig({
  test: {
    name: "db",
    environment: "node",
    include: ["src/**/*.spec.ts"],
    exclude: [...configDefaults.exclude, "**/*.integration.spec.ts"],
  },
});
