import type { ApiSpec } from "@mediator/domain";
import { eq } from "drizzle-orm";

import type { DbHandle } from "../client.js";
import { mapApiSpecRow, toApiSpecInsert } from "../mappers/api-spec.js";
import { apiSpec } from "../schema.js";

/** Persistence for `ApiSpec`. */
export class ApiSpecRepository {
  public constructor(private readonly db: DbHandle) {}

  public async create(spec: ApiSpec): Promise<ApiSpec> {
    const [row] = await this.db.insert(apiSpec).values(toApiSpecInsert(spec)).returning();
    if (row === undefined) {
      throw new Error("api_spec insert returned no row");
    }
    return mapApiSpecRow(row);
  }

  public async getById(id: string): Promise<ApiSpec | undefined> {
    const [row] = await this.db.select().from(apiSpec).where(eq(apiSpec.id, id));
    return row === undefined ? undefined : mapApiSpecRow(row);
  }

  public async listByAppId(appId: string): Promise<ApiSpec[]> {
    const rows = await this.db.select().from(apiSpec).where(eq(apiSpec.appId, appId));
    return rows.map(mapApiSpecRow);
  }
}
