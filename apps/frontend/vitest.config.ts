import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vitest/config";

/**
 * Vitest project for `@mediator/frontend`, picked up by the root
 * `test.projects` glob over the per-app Vitest configs and therefore by
 * `pnpm verify` / `pnpm test`.
 *
 * Component tests run in a `happy-dom` environment and mock `fetch`, so they
 * need no backend or database. `@vitejs/plugin-vue` compiles the `.vue` SFCs
 * under test.
 */
export default defineConfig({
  plugins: [vue()],
  test: {
    name: "frontend",
    environment: "happy-dom",
    include: ["src/**/*.spec.ts"],
  },
});
