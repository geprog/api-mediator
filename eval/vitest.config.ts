import { defineConfig } from "vitest/config";

/**
 * Vitest project for `@mediator/eval`, picked up by the root `test.projects`
 * glob and therefore by `pnpm verify` / `pnpm test`.
 *
 * Every test here is deterministic and network-free: the SCORING logic runs over
 * hand-built (or `FakeProvider`-generated) fixture proposals + fixture ground
 * truth and asserts exact metric numbers, and the ground-truth parser runs over
 * the vendored `scenarios/<name>/ground-truth.yaml`. The **live** eval run (real
 * Ollama over a scenario) is a CLI (`pnpm --filter @mediator/eval run eval`),
 * deliberately OUTSIDE `pnpm verify` — it depends on a model and is slow.
 */
export default defineConfig({
  test: {
    name: "eval",
    environment: "node",
    include: ["src/**/*.spec.ts"],
  },
});
