import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import * as schema from "./schema.js";

/**
 * The typed Drizzle instance for the mediator database: a `NodePgDatabase` bound
 * to our full schema (so `db.query.*` and the query builders are schema-aware),
 * intersected with the `$client` pool that `drizzle()` exposes — the same shape
 * `drizzle(pool, ...)` returns, named so it can be passed around and closed.
 */
export type Database = NodePgDatabase<typeof schema> & { readonly $client: Pool };

/**
 * The transaction handle passed to a {@link tx} callback — i.e. the first
 * parameter of the callback that {@link Database.transaction} expects. Derived
 * from Drizzle's own type so it always stays in sync with the schema binding.
 */
export type DbTransaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

/**
 * The transactional capability {@link tx} depends on: run a callback inside a
 * transaction, commit when it resolves, roll back when it rejects. A real
 * {@link Database} satisfies this; tests can supply an in-memory fake without a
 * live connection.
 */
export interface TransactionScope<TTx> {
  transaction<T>(fn: (txn: TTx) => Promise<T>): Promise<T>;
}

/**
 * Default pool-error handler: swallow the error so a dropped idle connection
 * cannot crash the process. A block with a comment is intentionally non-empty —
 * callers that want visibility pass their own handler (see {@link createDb}).
 */
const swallowPoolError = (): void => {
  /* no-op: keep the process alive; observability is the caller's choice */
};

/**
 * Create a connection pool + typed Drizzle instance for `connectionString`.
 *
 * The connection string is always injected (the app layer reads it from
 * `@mediator/config`); this package never reads `process.env` for it. Close the
 * underlying pool with {@link closeDb} on shutdown.
 *
 * `onPoolError` is registered as the pool's `'error'` listener. `pg` re-emits
 * errors from *idle pooled* connections whose backend terminated (Postgres
 * restart, `pg_terminate_backend`, admin shutdown, server-side idle timeout,
 * network partition) as an `'error'` event on the pool. With no listener Node
 * treats that as an unhandled `'error'` and **crashes the process** — the
 * documented `pg` idle-client foot-gun. Registering a listener (a swallowing
 * no-op by default) turns that fatal event into a survivable one, so a dropped
 * connection degrades to a failed query (e.g. `/health` → 503) instead of a
 * crash. This package stays logger-agnostic: the app layer passes a handler that
 * logs through its own logger.
 */
export function createDb(
  connectionString: string,
  onPoolError: (error: Error) => void = swallowPoolError,
): Database {
  const pool = new Pool({ connectionString });
  pool.on("error", onPoolError);
  return drizzle(pool, { schema });
}

/** Close the connection pool backing `db` (call once, on graceful shutdown). */
export function closeDb(db: Database): Promise<void> {
  return db.$client.end();
}

/**
 * Run `fn` inside a database transaction: its result is returned when it
 * resolves (the transaction commits), and its error is re-thrown when it rejects
 * (the transaction rolls back). Commit/rollback semantics are provided by the
 * scope — Drizzle for a real {@link Database}, the fake in unit tests.
 */
export function tx<TTx, T>(scope: TransactionScope<TTx>, fn: (txn: TTx) => Promise<T>): Promise<T> {
  return scope.transaction(fn);
}
