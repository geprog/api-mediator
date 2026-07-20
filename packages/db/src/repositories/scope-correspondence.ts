import type { ScopeCorrespondence } from "@mediator/domain";
import { eq, isNull, like, or } from "drizzle-orm";

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

  /**
   * **Propose** a derived correspondence for a pair (SS-18.1/18.6) — the
   * *derivation* half of SS-10.2's derive-then-confirm, as distinct from
   * {@link confirmOrUpdate}'s operator-driven *confirmation* half.
   *
   * Semantics, all three of which SS-18.6 requires:
   *
   * - **never a duplicate** — `ON CONFLICT (resource_pair_ref)`, so the "one per
   *   scoped resource pair" invariant holds under a re-ingested spec, a re-run
   *   instantiation, and a second approval alike;
   * - **never clobbers a confirmed artifact** — the `setWhere` restricts the update
   *   arm to rows that are still **unconfirmed** (`confirmed_by IS NULL`), so an
   *   operator-ratified `scopeIdentityKey` / container pairing survives every later
   *   re-derivation untouched;
   * - **an unconfirmed candidate may be refreshed** — a newer derivation overwrites
   *   the stale candidate's `scopeIdentityKey` + container refs.
   *
   * It never writes `confirmed_by`/`confirmed_at`: a proposal is unconfirmed by
   * construction and the SS-15.4 panel ({@link confirmOrUpdate}) stays the **only**
   * writer of the confirmation pair (SS-18.3/18.8 — nothing is auto-confirmed).
   *
   * Returns the **stored** row: the freshly-inserted or refreshed candidate, or —
   * when the conflicting row was already confirmed and the update arm was therefore
   * skipped — the untouched confirmed row, re-read. So the caller always learns the
   * pair's effective correspondence, never a phantom of what it proposed.
   */
  public async propose(candidate: ScopeCorrespondence): Promise<ScopeCorrespondence> {
    const insert = toScopeCorrespondenceInsert(candidate);
    const [row] = await this.db
      .insert(scopeCorrespondence)
      .values(insert)
      .onConflictDoUpdate({
        target: scopeCorrespondence.resourcePairRef,
        set: {
          scopeIdentityKey: insert.scopeIdentityKey,
          targetContainerRef: insert.targetContainerRef,
          sourceContainerRef: insert.sourceContainerRef,
        },
        // SS-18.6 — refresh an unconfirmed candidate only; a confirmed row is left
        // byte-identical (no row comes back from the update arm, handled below).
        setWhere: isNull(scopeCorrespondence.confirmedBy),
      })
      .returning();
    if (row !== undefined) {
      return mapScopeCorrespondenceRow(row);
    }
    // The conflicting row was confirmed → the update arm matched nothing. The row
    // exists (the conflict proves it), so re-read and return it unchanged.
    const existing = await this.getByResourcePair(candidate.resourcePairRef);
    if (existing === undefined) {
      throw new Error("propose found no row after a resource_pair_ref conflict");
    }
    return existing;
  }

  /**
   * Every correspondence whose `resourcePairRef` names `(appId, resourceRef)` as one
   * of its two sides — the reverse lookup from a **resource** to the scoped pair(s)
   * it participates in, which the SS-18.4 kind selector needs (`scope-link` is
   * selectable for a resource exactly when its pair has a proposed correspondence)
   * and the `scopeKeyRef` candidate derivation reads.
   *
   * `resourcePairRef` is the canonical `"<appId>:<resourceRef>|<appId>:<resourceRef>"`
   * form with the two tokens ordered lexicographically, so a side is either the
   * **first** or the **second** token. The SQL `LIKE` narrows to those two shapes at
   * the database; the token equality is then re-checked exactly in memory, so a
   * `%`/`_` inside an id can never widen the match. Normally 0 or 1 row.
   */
  public async listByResourceSide(
    appId: string,
    resourceRef: string,
  ): Promise<ScopeCorrespondence[]> {
    const token = `${appId}:${resourceRef}`;
    const rows = await this.db
      .select()
      .from(scopeCorrespondence)
      .where(
        or(
          like(scopeCorrespondence.resourcePairRef, `${token}|%`),
          like(scopeCorrespondence.resourcePairRef, `%|${token}`),
        ),
      );
    return rows
      .map(mapScopeCorrespondenceRow)
      .filter((correspondence) =>
        correspondence.resourcePairRef.split("|").some((side) => side === token),
      );
  }
}
