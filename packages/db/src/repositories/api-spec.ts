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

  /**
   * Every `active` `ApiSpec` across the landscape — the eligible counterpart set
   * the Mapping Engine's candidate enumeration runs over (a newly ingested spec vs.
   * every *other* app's active spec; `superseded`/`archived` specs are excluded).
   * The enumeration itself filters out the new spec and same-app specs, so this
   * returns the whole active set unfiltered.
   */
  public async listActive(): Promise<ApiSpec[]> {
    const rows = await this.db.select().from(apiSpec).where(eq(apiSpec.status, "active"));
    return rows.map(mapApiSpecRow);
  }

  /**
   * Replace a spec's `analysisExclusions` list (SI-4). Returns the updated
   * `ApiSpec`, or `undefined` when no spec with `id` exists. The caller is
   * responsible for validating each `resourceRef` against the spec's IR before
   * calling this — the repository persists the given list verbatim.
   */
  public async updateAnalysisExclusions(
    id: string,
    analysisExclusions: string[],
  ): Promise<ApiSpec | undefined> {
    const [row] = await this.db
      .update(apiSpec)
      .set({ analysisExclusions })
      .where(eq(apiSpec.id, id))
      .returning();
    return row === undefined ? undefined : mapApiSpecRow(row);
  }
}
