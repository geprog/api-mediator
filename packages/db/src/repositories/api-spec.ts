import type { ApiSpec, ApiSpecRole, ApiSpecStatus } from "@mediator/domain";
import { and, eq } from "drizzle-orm";

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
   * The single `active` `ApiSpec` for one `(app, role)` **spec lineage** (SL-1.1) —
   * the version a re-ingestion advances from. At most one row is `active` per lineage
   * (the version-advance transition supersedes the prior active in the same
   * transaction), so the first row is returned; `undefined` when the lineage has no
   * active version yet (a first-ever ingestion, which is `ingestSpec`'s v1 path).
   */
  public async findActiveByAppAndRole(
    appId: string,
    role: ApiSpecRole,
  ): Promise<ApiSpec | undefined> {
    const [row] = await this.db
      .select()
      .from(apiSpec)
      .where(and(eq(apiSpec.appId, appId), eq(apiSpec.role, role), eq(apiSpec.status, "active")));
    return row === undefined ? undefined : mapApiSpecRow(row);
  }

  /**
   * Advance a spec's `status` (SL-1.1) — used to mark the prior active version
   * `superseded` when a new version is ingested for its lineage. Returns the updated
   * `ApiSpec`, or `undefined` when no spec with `id` exists.
   */
  public async updateStatus(id: string, status: ApiSpecStatus): Promise<ApiSpec | undefined> {
    const [row] = await this.db
      .update(apiSpec)
      .set({ status })
      .where(eq(apiSpec.id, id))
      .returning();
    return row === undefined ? undefined : mapApiSpecRow(row);
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
