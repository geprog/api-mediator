import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * PHASE-0 PROBE TABLE — throwaway.
 *
 * `schema_probe` exists ONLY to prove the drizzle-kit `generate` -> `migrate`
 * pipeline end to end against the compose Postgres. It is not part of the domain
 * model. The real data model (`registered_app`, `api_spec`, `resource_binding`,
 * `credential`, ...) arrives in Phase 1, at which point this table is
 * dropped/replaced by a real migration. Do not build anything on it.
 */
export const schemaProbe = pgTable("schema_probe", {
  id: uuid("id").primaryKey().defaultRandom(),
  note: text("note").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
