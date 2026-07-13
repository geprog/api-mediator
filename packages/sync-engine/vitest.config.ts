import { configDefaults, defineConfig } from "vitest/config";

/**
 * Default (unit) Vitest project for `@mediator/sync-engine`, picked up by the root
 * `test.projects` glob and therefore by `pnpm verify` / `pnpm test`.
 *
 * These tests must run WITHOUT a live Postgres: the ordering-queue dispatcher's
 * per-key serialization, park-moves-on, cross-key parallelism, and handler-seam
 * contract are exercised against the in-memory `FakeOrderingQueue`, which faithfully
 * mirrors the real `SKIP LOCKED` claim semantics. The real-database at-most-one-
 * active-worker-per-key / durability proofs live in `*.integration.spec.ts`,
 * excluded here (they have their own `vitest.integration.config.ts` and the
 * `test:integration` script) because the lock semantics cannot be faked.
 */
export default defineConfig({
  test: {
    name: "sync-engine",
    environment: "node",
    include: ["src/**/*.spec.ts"],
    exclude: [...configDefaults.exclude, "**/*.integration.spec.ts"],
  },
});
