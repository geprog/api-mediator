import { type RegisteredApp, stripUndefined } from "@mediator/domain";

import { registeredApp } from "../schema.js";

/** A selected `registered_app` row, with Drizzle's inferred column types. */
export type RegisteredAppRow = typeof registeredApp.$inferSelect;
/** The insert shape Drizzle expects for `registered_app`. */
export type RegisteredAppInsert = typeof registeredApp.$inferInsert;

/**
 * Row → domain. A NULL `base_url` becomes an **absent** `baseUrl` key (not
 * `baseUrl: undefined`) via {@link stripUndefined}, so the domain object honors
 * `exactOptionalPropertyTypes` — see the note on `RegisteredApp.baseUrl`.
 */
export function mapRegisteredAppRow(row: RegisteredAppRow): RegisteredApp {
  return stripUndefined({
    id: row.id,
    name: row.name,
    status: row.status,
    baseUrl: row.baseUrl ?? undefined,
    capabilities: row.capabilities,
    createdAt: row.createdAt,
  });
}

/**
 * Domain → insert. An absent `baseUrl` is written as SQL NULL (the column is
 * nullable); every other column is provided explicitly by the caller-built
 * domain object.
 */
export function toRegisteredAppInsert(app: RegisteredApp): RegisteredAppInsert {
  return {
    id: app.id,
    name: app.name,
    status: app.status,
    baseUrl: app.baseUrl ?? null,
    capabilities: app.capabilities,
    createdAt: app.createdAt,
  };
}
