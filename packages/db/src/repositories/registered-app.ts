import type { RegisteredApp } from "@mediator/domain";
import { eq } from "drizzle-orm";

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
}
