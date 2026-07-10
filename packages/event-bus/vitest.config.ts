import { configDefaults, defineConfig } from "vitest/config";

/**
 * Default (unit) Vitest project for `@mediator/event-bus`, picked up by the root
 * `test.projects` glob and therefore by `pnpm verify` / `pnpm test`.
 *
 * These tests must run WITHOUT a live Postgres: the dispatcher's routing +
 * idempotent-consumer skip logic, the envelope handling, and the reconciliation
 * framework are exercised against in-memory fakes. The live-database delivery /
 * atomicity / redelivery proofs live in `*.integration.spec.ts`, excluded here so
 * they never run in the default suite; they have their own
 * `vitest.integration.config.ts` and the `test:integration` script.
 */
export default defineConfig({
  test: {
    name: "event-bus",
    environment: "node",
    include: ["src/**/*.spec.ts"],
    exclude: [...configDefaults.exclude, "**/*.integration.spec.ts"],
  },
});
