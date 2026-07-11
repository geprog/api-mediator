import { defineConfig } from "vitest/config";

/**
 * Integration Vitest project for `@mediator/mapping-engine` — the Postgres-backed
 * persistence test for `runDetectionForSpec`. It is deliberately excluded from the
 * default suite (and therefore from `pnpm verify`) and runs only via
 * `pnpm --filter @mediator/mapping-engine test:integration`.
 *
 * It requires the compose `postgres` service and a resolvable `DATABASE_URL`; it
 * still uses the `FakeProvider` (no Ollama), so the only external dependency is
 * the database. It self-skips when `DATABASE_URL` is unresolvable, so an
 * environment without Postgres is a skip, never a failure.
 */
export default defineConfig({
  test: {
    name: "mapping-engine-integration",
    environment: "node",
    include: ["src/**/*.integration.spec.ts"],
  },
});
