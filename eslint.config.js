import eslint from "@eslint/js";
import { defineConfigWithVueTs, vueTsConfigs } from "@vue/eslint-config-typescript";
import pluginVue from "eslint-plugin-vue";
import globals from "globals";
import tseslint from "typescript-eslint";

/**
 * Flat ESLint config for the API Mediator monorepo (ESLint 9+ flat style).
 *
 * - First-party TypeScript is linted with typescript-eslint's type-checked
 *   `strictTypeChecked` preset, plus the three non-negotiable rules from
 *   CLAUDE.md promoted to errors.
 * - Vue SFCs (frontend lands in slice 4) get `eslint-plugin-vue`'s
 *   vue3-recommended rules and `@vue/eslint-config-typescript`, scoped to
 *   `apps/frontend/**\/*.vue` so they never touch backend/package code.
 * - Plain JS / config files opt out of type-aware linting.
 */

/**
 * The Vue + TS-in-SFC preset ships several unscoped blocks (global parser and
 * rule sets). Confine every block to frontend SFCs so it cannot interfere with
 * the type-checked backend/package linting above. None of the preset's blocks
 * are `ignores`-only, so overriding `files` on each is safe.
 */
const vueConfigs = defineConfigWithVueTs(
  pluginVue.configs["flat/recommended"],
  vueTsConfigs.recommended,
).map((config) => ({ ...config, files: ["apps/frontend/**/*.vue"] }));

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
);
