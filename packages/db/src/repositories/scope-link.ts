import type { ScopeKey, ScopeLink } from "@mediator/domain";
import { and, eq, or, sql } from "drizzle-orm";

import type { DbHandle } from "../client.js";
import { mapScopeLinkRow, toScopeLinkInsert } from "../mappers/scope-link.js";
import { scopeLink } from "../schema.js";

/**
 * A record's captured scope on one side, for {@link ScopeLinkRepository.lookupByScopeKey}:
 * the app whose container is being resolved plus that app's scope-key map. Direction-
 * agnostic — the same container is addressed the same way whether it is side A or B of
 * the canonical `resourcePairRef`.
 */
export interface ScopeLinkSideRef {
  readonly appId: string;
  readonly scopeKey: ScopeKey;
}

/**
 * Persistence for `ScopeLink` (SS-10) — the container ↔ container instances under a
 * `ScopeCorrespondence`. Constructor-bound to a {@link DbHandle} (the pooled db or a
 * `tx()`), matching the repo convention.
 */
export class ScopeLinkRepository {
  public constructor(private readonly db: DbHandle) {}

  /** Persist a new container link. */
  public async create(link: ScopeLink): Promise<void> {
    await this.db.insert(scopeLink).values(toScopeLinkInsert(link));
  }

  /** One link by id (observability / tests / re-reading after a mutation). */
  public async getById(id: string): Promise<ScopeLink | undefined> {
    const [row] = await this.db.select().from(scopeLink).where(eq(scopeLink.id, id)).limit(1);
    return row === undefined ? undefined : mapScopeLinkRow(row);
  }

  /** Every link established under one `ScopeCorrespondence`, whatever its status. */
  public async listByCorrespondence(scopeCorrespondenceId: string): Promise<ScopeLink[]> {
    const rows = await this.db
      .select()
      .from(scopeLink)
      .where(eq(scopeLink.scopeCorrespondenceId, scopeCorrespondenceId));
    return rows.map(mapScopeLinkRow);
  }

  /**
   * The **active** link for a container, addressed by (app, scope-key) on either side
   * of the pair — the container analog of `RecordLinkStore.findActiveByRecord`. The
   * scope key is compared as normalized `jsonb` (key order / whitespace insensitive),
   * so a captured scope matches regardless of how it was serialized. Returns 0 or 1.
   */
  public async lookupByScopeKey(
    resourcePairRef: string,
    side: ScopeLinkSideRef,
  ): Promise<ScopeLink | undefined> {
    const keyJson = JSON.stringify(side.scopeKey);
    const [row] = await this.db
      .select()
      .from(scopeLink)
      .where(
        and(
          eq(scopeLink.resourcePairRef, resourcePairRef),
          eq(scopeLink.status, "active"),
          or(
            and(
              eq(scopeLink.appAId, side.appId),
              sql`${scopeLink.appAScopeKey} = ${keyJson}::jsonb`,
            ),
            and(
              eq(scopeLink.appBId, side.appId),
              sql`${scopeLink.appBScopeKey} = ${keyJson}::jsonb`,
            ),
          ),
        ),
      )
      .limit(1);
    return row === undefined ? undefined : mapScopeLinkRow(row);
  }

  /**
   * Archive **every** `ScopeLink` under a correspondence (SS-10.5): set
   * `status = 'archived'` — **never delete** — so a `RecordLink.scopeRef` pointing at
   * one still resolves its frozen key for a final delete/audit (SS-10 criterion 5).
   * The archive *trigger* (a container/app leaving the landscape) is Phase-6 app
   * lifecycle; this is the capability it will call. Returns the number archived.
   */
  public async archiveByCorrespondence(scopeCorrespondenceId: string): Promise<number> {
    const archived = await this.db
      .update(scopeLink)
      .set({ status: "archived" })
      .where(eq(scopeLink.scopeCorrespondenceId, scopeCorrespondenceId))
      .returning({ id: scopeLink.id });
    return archived.length;
  }
}
