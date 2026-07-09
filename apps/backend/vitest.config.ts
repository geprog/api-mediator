import { configDefaults, defineConfig } from "vitest/config";

/**
 * Default (unit) Vitest project for `@mediator/backend`, picked up by the root
 * `test.projects` glob and therefore by `pnpm verify` / `pnpm test`.
 *
 * These tests must run WITHOUT a live Postgres: the `/health` handler is tested
 * with `fastify.inject()` and a fake DB ping. The live-database check lives in
 * `*.integration.spec.ts`, excluded here so it never runs in the default suite;
 * it has its own `vitest.integration.config.ts` and the `test:integration`
 * script.
 */
export default defineConfig({
  test: {
    name: "backend",
    environment: "node",
    include: ["src/**/*.spec.ts"],
    exclude: [...configDefaults.exclude, "**/*.integration.spec.ts"],
  },
});
