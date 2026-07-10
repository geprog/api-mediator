/**
 * Ambient type declarations for the frontend.
 *
 * `vue-tsc` understands `.vue` single-file components natively, but the plain
 * TypeScript server that `typescript-eslint`'s type-checked TypeScript rules run
 * against does not. This shim lets a `.ts` file (e.g. the component test) import
 * a `.vue` SFC without a "cannot find module" error, so the type-checked lint
 * pass sees a real component type instead of `any`. `vite/client` types come in
 * via `compilerOptions.types` in `tsconfig.json`, not a triple-slash reference.
 */
declare module "*.vue" {
  import type { DefineComponent } from "vue";

  const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, unknown>;
  export default component;
}
