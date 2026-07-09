import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { closeDb, createDb } from "../client.js";
import { resolveDatabaseUrl } from "../env.js";
import { runMigrations } from "../migrate.js";

/**
 * `db:migrate` CLI entrypoint: apply all pending migrations, then close the pool.
 *
 * This is the operator/CLI layer, so — unlike the library core (`createDb`/`tx`)
 * — it is allowed to read the environment. As a convenience it loads the
 * repo-root `.env` when present (an already-exported `DATABASE_URL` still wins;
 * `loadEnvFile` does not overwrite existing variables), so operators can run
 * `pnpm db:migrate` without exporting anything by hand.
 */
async function main(): Promise<void> {
  const repoEnvPath = fileURLToPath(new URL("../../../../.env", import.meta.url));
  if (existsSync(repoEnvPath)) {
    process.loadEnvFile(repoEnvPath);
  }

  const connectionString = resolveDatabaseUrl(process.env);
  const db = createDb(connectionString);
  try {
    await runMigrations(db);
    console.info("[db:migrate] migrations applied");
  } finally {
    await closeDb(db);
  }
}

try {
  await main();
} catch (error) {
  console.error("[db:migrate] failed:", error);
  process.exitCode = 1;
}
