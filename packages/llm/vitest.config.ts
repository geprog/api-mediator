import { configDefaults, defineConfig } from "vitest/config";

/**
 * Default (unit) Vitest project for `@mediator/llm`, picked up by the root
 * `test.projects` glob and therefore by `pnpm verify` / `pnpm test`.
 *
 * These tests run WITHOUT a live Ollama: the `OllamaProvider` is exercised
 * against a mocked HTTP client and the `FakeProvider` needs no network at all.
 * The optional live-model smoke lives in `*.integration.spec.ts`, excluded here
 * so it never runs in the default suite; it has its own
 * `vitest.integration.config.ts` and the `test:integration` script.
 */
export default defineConfig({
  test: {
    name: "llm",
    environment: "node",
    include: ["src/**/*.spec.ts"],
    exclude: [...configDefaults.exclude, "**/*.integration.spec.ts"],
  },
});
