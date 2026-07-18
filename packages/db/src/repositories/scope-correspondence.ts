import type { ScopeCorrespondence } from "@mediator/domain";
import { eq } from "drizzle-orm";

import type { DbHandle } from "../client.js";
import {
  mapScopeCorrespondenceRow,
  toScopeCorrespondenceInsert,
} from "../mappers/scope-correspondence.js";
import { scopeCorrespondence } from "../schema.js";

/**
 * Persistence for `ScopeCorrespondence` (SS-10) — the direction-agnostic container
 * correlation config, **one per scoped resource pair** (the UNIQUE index on
 * `resource_pair_ref` enforces it). Constructor-bound to a {@link DbHandle} (the
 * pooled db or a `tx()`), matching the repo convention.
 */
export class ScopeCorrespondenceRepository {
  public constructor(private readonly db: DbHandle) {}

  /** Persist a new correspondence. Fails loudly if the pair already has one. */
  public async create(correspondence: ScopeCorrespondence): Promise<void> {
    await this.db.insert(scopeCorrespondence).values(toScopeCorrespondenceInsert(correspondence));
  }

  /** One correspondence by id. */
  public async getById(id: string): Promise<ScopeCorrespondence | undefined> {
    const [row] = await this.db
      .select()
      .from(scopeCorrespondence)
      .where(eq(scopeCorrespondence.id, id))
      .limit(1);
    return row === undefined ? undefined : mapScopeCorrespondenceRow(row);
  }

  /**
   * The single correspondence for a scoped resource pair (direction-agnostic
   * `resourcePairRef`), or `undefined` if the pair has none yet. At most one exists
   * (the UNIQUE index), so this returns 0 or 1.
   */
  public async getByResourcePair(
    resourcePairRef: string,
  ): Promise<ScopeCorrespondence | undefined> {
    const [row] = await this.db
      .select()
      .from(scopeCorrespondence)
      .where(eq(scopeCorrespondence.resourcePairRef, resourcePairRef))
      .limit(1);
    return row === undefined ? undefined : mapScopeCorrespondenceRow(row);
  }

  /**
   * Confirm-or-update the pair's correspondence: **insert** it when the pair has
   * none, or **update** the existing one in place (its `scopeIdentityKey`, container
   * refs, and confirmation) when it does — keyed on the direction-agnostic
   * `resource_pair_ref`, so a second confirmation for the same pair never creates a
   * duplicate (the "one per scoped resource pair" invariant). Returns the stored row.
   */
  public async confirmOrUpdate(correspondence: ScopeCorrespondence): Promise<ScopeCorrespondence> {
    const insert = toScopeCorrespondenceInsert(correspondence);
    const [row] = await this.db
      .insert(scopeCorrespondence)
      .values(insert)
      .onConflictDoUpdate({
        target: scopeCorrespondence.resourcePairRef,
        set: {
          scopeIdentityKey: insert.scopeIdentityKey,
          targetContainerRef: insert.targetContainerRef,
          sourceContainerRef: insert.sourceContainerRef,
          confirmedBy: insert.confirmedBy,
          confirmedAt: insert.confirmedAt,
        },
      })
      .returning();
    // The insert-or-update always yields exactly one row.
    if (row === undefined) {
      throw new Error("confirmOrUpdate returned no row");
    }
    return mapScopeCorrespondenceRow(row);
  }
}
