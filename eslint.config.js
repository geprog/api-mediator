import eslint from "@eslint/js";
import { defineConfigWithVueTs, vueTsConfigs } from "@vue/eslint-config-typescript";
import prettierConfig from "eslint-config-prettier/flat";
import pluginVue from "eslint-plugin-vue";
import globals from "globals";
import tseslint from "typescript-eslint";

/**
 * Flat ESLint config for the API Mediator monorepo (ESLint 9+ flat style).
 *
 * - First-party TypeScript is linted with typescript-eslint's type-checked
 *   `strictTypeChecked` preset, plus the three non-negotiable rules from
 *   CLAUDE.md promoted to errors.
 * - Vue SFCs get `eslint-plugin-vue`'s vue3-recommended rules and the
 *   **type-checked** `@vue/eslint-config-typescript` preset, scoped to
 *   `apps/frontend/**\/*.vue` so they never touch backend/package code. The
 *   type-checked preset (with type-aware parsing pointed at the frontend
 *   tsconfig) is what lets `no-floating-promises` and
 *   `explicit-module-boundary-types` — both type-information rules — actually
 *   fire inside `<script setup lang="ts">`, matching the backend bar.
 * - Plain JS / config files opt out of type-aware linting.
 * - `eslint-config-prettier` is applied last to switch off every stylistic rule
 *   that would fight Prettier (the repo's formatter of record — `pnpm format`).
 *   This only disables formatting rules; the vue3 correctness rules and the
 *   three mandated type rules are untouched.
 */

/**
 * The Vue + TS-in-SFC preset is designed to own linting for a whole Vue project
 * (`.ts` and `.vue` alike). In this monorepo the root `**\/*.ts` block already
 * owns `.ts`, so every preset block is confined to frontend SFCs — otherwise
 * the preset's `default-project-service-for-ts-files` block would apply its own
 * `projectService` to backend/package `.ts` and break their `allowDefaultProject`
 * wiring.
 *
 * The one block that must NOT be scoped to `.vue` but instead dropped is the
 * `disable-type-checked` block: it exists to switch type-aware rules off for
 * files that can't be type-checked (`**\/*.js`). Forcing it onto `.vue` (which a
 * blanket `.map` does) is exactly what silently turned `no-floating-promises`
 * back *off* for `.vue`. Our own JS is already covered by the `**\/*.js` block
 * below, so filtering it out here is safe.
 *
 * Two extra config objects are folded in before scoping:
 *  - `languageOptions.parserOptions` enables the type-aware program for `.vue`
 *    (projectService + the frontend tsconfig via `tsconfigRootDir`, plus `.vue`
 *    as an extra file extension) — required for the type-checked rules, and a
 *    robust catch-all for SFCs added after this config is authored.
 *  - `rules` promotes the same three CLAUDE.md rules to errors as for `.ts`, so
 *    the mandated bar is identical across `.ts` and `.vue`.
 */
const vueConfigs = defineConfigWithVueTs(
  pluginVue.configs["flat/recommended"],
  vueTsConfigs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
        extraFileExtensions: [".vue"],
      },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/explicit-module-boundary-types": "error",
      "@typescript-eslint/no-floating-promises": "error",
    },
  },
)
  .filter((config) => config.name !== "typescript-eslint/disable-type-checked")
  .map((config) => ({ ...config, files: ["apps/frontend/**/*.vue"] }));

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/coverage/**",
      "**/playwright-report/**",
      "**/blob-report/**",
      "**/test-results/**",
      "**/*.tsbuildinfo",
    ],
  },

  eslint.configs.recommended,

  {
    files: ["**/*.ts", "**/*.mts", "**/*.cts"],
    extends: [tseslint.configs.strictTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ["vitest.config.ts", "packages/*/vitest.config.ts"],
          // Each workspace package owns a `vitest.config.ts` linted via the
          // default project; the type-checked preset caps that at 8 files, which
          // the growing package count exceeds. These are tiny static config
          // files, so the (documented) perf cost of raising the cap is negligible.
          maximumDefaultProjectFileMatchCount_THIS_WILL_SLOW_DOWN_LINTING: 30,
        },
        tsconfigRootDir: import.meta.dirname,
      },
      globals: { ...globals.node },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/explicit-module-boundary-types": "error",
      "@typescript-eslint/no-floating-promises": "error",
    },
  },

  ...vueConfigs,

  {
    files: ["**/*.js", "**/*.cjs", "**/*.mjs"],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: {
      globals: { ...globals.node },
    },
  },

  // Must stay last: turns off every ESLint rule that Prettier already enforces.
  prettierConfig,
);
