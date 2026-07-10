import { defineConfig } from "vitest/config";

/**
 * Integration Vitest project for `@mediator/llm` — the OPTIONAL live-Ollama
 * smoke. It is deliberately excluded from the default suite (and therefore from
 * `pnpm verify`) and runs only via `pnpm --filter @mediator/llm test:integration`.
 *
 * The single `*.integration.spec.ts` hits a real Ollama at `OLLAMA_BASE_URL`
 * with a tiny two-resource pair and asserts a schema-valid `ResourceShortlist`.
 * It self-skips when Ollama is unreachable, so an environment without the model
 * running is a skip, never a failure.
 */
export default defineConfig({
  test: {
    name: "llm-integration",
    environment: "node",
    include: ["src/**/*.integration.spec.ts"],
    // A live detail call can take minutes on CPU (see DEVELOPMENT.md); give the
    // shortlist smoke generous headroom.
    testTimeout: 120_000,
  },
});
