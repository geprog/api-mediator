import type { RegisteredApp } from "@mediator/domain";
import { and, eq } from "drizzle-orm";

import type { DbHandle } from "../client.js";
import { mapRegisteredAppRow, toRegisteredAppInsert } from "../mappers/registered-app.js";
import { registeredApp } from "../schema.js";

/**
 * Persistence for `RegisteredApp`. Accepts and returns `@mediator/domain` types;
 * the row/insert translation lives entirely in the mappers. Constructed with a
 * {@link DbHandle}, so the same instance works inside or outside a `tx()`.
 */
export class RegisteredAppRepository {
  public constructor(private readonly db: DbHandle) {}

  public async create(app: RegisteredApp): Promise<RegisteredApp> {
    const [row] = await this.db
      .insert(registeredApp)
      .values(toRegisteredAppInsert(app))
      .returning();
    if (row === undefined) {
      throw new Error("registered_app insert returned no row");
    }
    return mapRegisteredAppRow(row);
  }

  public async getById(id: string): Promise<RegisteredApp | undefined> {
    const [row] = await this.db.select().from(registeredApp).where(eq(registeredApp.id, id));
    return row === undefined ? undefined : mapRegisteredAppRow(row);
  }

  public async list(): Promise<RegisteredApp[]> {
    const rows = await this.db.select().from(registeredApp);
    return rows.map(mapRegisteredAppRow);
  }

  /**
   * **AL-1.1 — compare-and-set `active → disabled`.** Only `status` moves; every other
   * column (and every derived artifact — no `SyncRule.status`, no cursor, no snapshot,
   * no `AdapterBinding.status`) is untouched, because being disabled is a condition of
   * the *app*, derived at execution time
   * (`docs/architecture/extensibility.md` *App lifecycle: disable & deregister*).
   *
   * Guarded on the current status in the `WHERE`, so a concurrent transition loses
   * rather than silently overwrites: `undefined` means the row was not `active`
   * (already disabled, or gone).
   */
  public async markDisabled(id: string): Promise<RegisteredApp | undefined> {
    const [row] = await this.db
      .update(registeredApp)
      .set({ status: "disabled" })
      .where(and(eq(registeredApp.id, id), eq(registeredApp.status, "active")))
      .returning();
    return row === undefined ? undefined : mapRegisteredAppRow(row);
  }

  /**
   * **AL-1.3 — compare-and-set `disabled → active`.** The exact inverse of
   * {@link markDisabled}: it *lifts* the condition and restores nothing — rules resume
   * under their own stored `status` from their stored cursors/snapshots, so no
   * re-backfill is performed. `undefined` when the row was not `disabled`.
   */
  public async markActive(id: string): Promise<RegisteredApp | undefined> {
    const [row] = await this.db
      .update(registeredApp)
      .set({ status: "active" })
      .where(and(eq(registeredApp.id, id), eq(registeredApp.status, "disabled")))
      .returning();
    return row === undefined ? undefined : mapRegisteredAppRow(row);
  }
}
