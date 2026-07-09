import { defineConfig } from "drizzle-kit";

/**
 * drizzle-kit configuration for `@mediator/db`.
 *
 * `db:generate` only reads `schema` and diffs it against the snapshots under
 * `out`, so it never needs a database connection. `dbCredentials` is consumed
 * only by connection commands (`db:studio`); those require `DATABASE_URL` to be
 * present in the environment. Migrations are APPLIED with drizzle-orm's
 * `migrate()` (see `src/migrate.ts`), not `drizzle-kit migrate`.
 */
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema.ts",
  out: "./migrations",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "",
  },
});
