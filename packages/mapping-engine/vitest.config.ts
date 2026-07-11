import { configDefaults, defineConfig } from "vitest/config";

/**
 * Default (unit) Vitest project for `@mediator/mapping-engine`, picked up by the
 * root `test.projects` glob and therefore by `pnpm verify` / `pnpm test`.
 *
 * Every unit test here is deterministic and network-free: the two-stage detection
 * runs entirely against the `FakeProvider` from `@mediator/llm` and in-memory
 * spec/proposal fakes — no live Ollama, no Postgres. The Postgres-backed
 * persistence test lives in `*.integration.spec.ts`, excluded here so it never
 * runs in the default suite; it has its own `vitest.integration.config.ts` and
 * the `test:integration` script.
 */
export default defineConfig({
  test: {
    name: "mapping-engine",
    environment: "node",
    include: ["src/**/*.spec.ts"],
    exclude: [...configDefaults.exclude, "**/*.integration.spec.ts"],
  },
});
