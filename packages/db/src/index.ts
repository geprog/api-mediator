/**
 * `@mediator/db` — Phase-0 database bootstrap: a typed Drizzle instance over the
 * compose Postgres, a transaction helper, and the migration runner. The real
 * data-model tables and repositories arrive in Phase 1.
 */
export { closeDb, createDb, tx } from "./client.js";
export type { Database, DbTransaction, TransactionScope } from "./client.js";
export { MissingDatabaseUrlError, resolveDatabaseUrl } from "./env.js";
export { MIGRATIONS_FOLDER, runMigrations } from "./migrate.js";
export { schemaProbe } from "./schema.js";
