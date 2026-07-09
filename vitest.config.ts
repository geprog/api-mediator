import { defineConfig } from "vitest/config";

/**
 * Root Vitest configuration.
 *
 * Vitest 4 removed the standalone `vitest.workspace.ts` file; the supported
 * replacement is `test.projects`, which here globs the per-package Vitest
 * configs under `packages/*` and `apps/*`. Each workspace package that ships
 * unit tests owns its own `vitest.config.ts`. The Playwright package
 * (`apps/e2e`) deliberately has no `vitest.config.ts`, so it is excluded from
 * `pnpm test` and runs only via `pnpm test:e2e`.
 */
export default defineConfig({
  test: {
    projects: ["packages/*/vitest.config.ts", "apps/*/vitest.config.ts"],
    coverage: {
      // Coverage is wired via @vitest/coverage-v8 but not gated on a threshold
      // yet; real gates arrive alongside feature code in later slices.
      provider: "v8",
      reporter: ["text", "html"],
    },
  },
});
