import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Load the repo-root `.env` into `process.env` when it is present.
 *
 * Mirrors the `@mediator/db` migrate CLI: it is an operator convenience for
 * running the app from the repo without exporting variables by hand. An
 * already-exported variable always wins because `process.loadEnvFile` does not
 * overwrite existing variables. In a real deployment without a `.env`, this is a
 * clean no-op and the process relies purely on the ambient environment.
 *
 * Both entrypoints call this before {@link loadConfig}: `otel.ts` (the `--import`
 * preload) so telemetry variables are visible before the SDK starts, and
 * `index.ts` so the app config resolves the same way when run without the
 * preload.
 */
export function loadRepoEnv(): void {
  const repoEnvPath = fileURLToPath(new URL("../../../.env", import.meta.url));
  if (existsSync(repoEnvPath)) {
    process.loadEnvFile(repoEnvPath);
  }
}
