import { fileURLToPath } from "node:url";

import { migrate } from "drizzle-orm/node-postgres/migrator";

import type { Database } from "./client.js";

/**
 * Absolute path to this package's generated SQL migrations. Resolved relative to
 * this module so it is correct whether run from `src` (via tsx) or `dist`, and
 * regardless of the process working directory.
 */
export const MIGRATIONS_FOLDER = fileURLToPath(new URL("../migrations", import.meta.url));

/**
 * Apply every pending migration in {@link MIGRATIONS_FOLDER} to `db`. Drizzle
 * tracks applied migrations in its own bookkeeping table, so this is idempotent:
 * running it against an up-to-date database is a no-op.
 */
export function runMigrations(db: Database): Promise<void> {
  return migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
}
