import { configDefaults, defineConfig } from "vitest/config";

/**
 * Default (unit) Vitest project for `@mediator/outbound`, picked up by the root
 * `test.projects` glob and therefore by `pnpm verify` / `pnpm test`.
 *
 * These tests run WITHOUT a live Postgres: the Outbound Call Executor is exercised
 * against a fake `ProtocolClient` (no network) and a fake `SyncEventStore` (no
 * database), both of which faithfully mirror their real implementations. The
 * live-database SyncEvent writes + idempotency-lookback proofs + `0012` migration
 * live in `*.integration.spec.ts`, excluded here (own `test:integration` script).
 */
export default defineConfig({
  test: {
    name: "outbound",
    environment: "node",
    include: ["src/**/*.spec.ts"],
    exclude: [...configDefaults.exclude, "**/*.integration.spec.ts"],
  },
});
