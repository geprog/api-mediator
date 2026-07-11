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
 * A fixed key for the session-level Postgres advisory lock {@link runMigrations}
 * serializes on. Any constant works as long as every caller uses the same one;
 * it is namespaced to migrations alone so it never collides with an application
 * lock (this codebase takes no other advisory locks today).
 */
const MIGRATION_ADVISORY_LOCK_KEY = 8_147_251_063;

/**
 * Apply every pending migration in {@link MIGRATIONS_FOLDER} to `db`. Drizzle
 * tracks applied migrations in its own bookkeeping table, so this is idempotent:
 * running it against an up-to-date database is a no-op.
 *
 * **Concurrency-safe.** Two callers racing on a fresh database (parallel
 * integration-test files, overlapping app boots) would otherwise both try to
 * `CREATE TYPE`/`CREATE TABLE` the same objects, or read a half-created migrations
 * table, and one would crash with `23505`/`42P01`. To prevent that, this acquires
 * a **session-level** `pg_advisory_lock` on a dedicated connection before running
 * `migrate` and releases it after: a second caller blocks on the lock until the
 * first finishes, then runs `migrate` as a no-op. The lock connection is separate
 * from the ones `migrate` uses from the pool, which is fine — the serialization
 * comes from every caller having to acquire the same lock first.
 *
 * The lock is released explicitly before the connection returns to the pool
 * (session advisory locks otherwise outlive a pooled `release()`), and on any
 * unlock failure the connection is destroyed so its session — and thus the lock —
 * ends regardless.
 */
export async function runMigrations(db: Database): Promise<void> {
  const client = await db.$client.connect();
  let locked = false;
  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_ADVISORY_LOCK_KEY]);
    locked = true;
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  } finally {
    try {
      if (locked) {
        await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_ADVISORY_LOCK_KEY]);
      }
      client.release();
    } catch {
      // Unlock failed (e.g. a broken connection): destroy the client so its
      // session ends and the advisory lock is released with it.
      client.release(true);
    }
  }
}
