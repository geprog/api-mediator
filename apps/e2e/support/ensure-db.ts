import { closeDb, createDb, runMigrations } from "@mediator/db";

import { DATABASE_URL } from "./env.js";

/**
 * Provision the dedicated e2e database, then exit. Run as the first link in the
 * backend web-server command (before the backend boots), because the backend's
 * `/health` probe pings Postgres — so the database must exist and be reachable
 * before Playwright's web-server readiness wait, which happens *before* any
 * `globalSetup`. Provisioning it here (rather than in `globalSetup`) is what makes
 * the suite self-contained on a fresh compose Postgres.
 *
 * `CREATE DATABASE` cannot target the database it creates, so this first connects
 * to the always-present `postgres` maintenance database to create the e2e database
 * if absent (idempotent — additive, never destructive), then connects to it and
 * applies the migrations (advisory-locked + journal-tracked, so a repeat run is a
 * no-op). The dedicated database keeps an e2e run isolated from the primary
 * `api_mediator` dev database.
 */
async function ensureDatabase(): Promise<void> {
  const target = new URL(DATABASE_URL);
  const databaseName = decodeURIComponent(target.pathname.replace(/^\//, ""));

  const maintenanceUrl = new URL(DATABASE_URL);
  maintenanceUrl.pathname = "/postgres";
  const admin = createDb(maintenanceUrl.toString());
  try {
    const existing = await admin.$client.query("SELECT 1 FROM pg_database WHERE datname = $1", [
      databaseName,
    ]);
    if ((existing.rowCount ?? 0) === 0) {
      // The identifier cannot be parameterized; `databaseName` comes from our own
      // config (not user input). Double-quote it so it is a safe SQL identifier.
      await admin.$client.query(`CREATE DATABASE "${databaseName.replace(/"/g, '""')}"`);
    }
  } finally {
    await closeDb(admin);
  }

  const db = createDb(DATABASE_URL);
  try {
    await runMigrations(db);
  } finally {
    await closeDb(db);
  }
}

await ensureDatabase();
