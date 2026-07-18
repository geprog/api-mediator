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
 * The result of {@link ScopeLinkStore.establish} (SS-11) — a discriminated union so a
 * discovery pass can tell a **new** link from an idempotent re-run (`exists`) and from a
 * **conflict** (one of the two containers is already actively linked to a *different*
 * counterpart), which is never silently overwritten:
 *  - `created` — a fresh active link was written.
 *  - `exists` — an active link already connects **these two** containers (idempotent
 *    re-establish; re-running discovery never duplicates a link — SS-11 invariant).
 *  - `conflict` — a container on one side is already actively linked to a *different*
 *    container; the existing link is returned untouched (fail-loud, never re-point).
 */
export type EstablishScopeLinkResult =
  | { readonly kind: "created"; readonly link: ScopeLink }
  | { readonly kind: "exists"; readonly link: ScopeLink }
  | { readonly kind: "conflict"; readonly existing: ScopeLink };

/**
 * The narrow persistence port the SS-11 scope-discovery stage depends on, so the stage
 * is unit-testable against a fake that **mirrors** these exact semantics
 * ([[fakes-must-mirror-real-repos]]) — the **idempotent, direction-agnostic** establish
 * especially, because a loose fake would let re-running discovery duplicate a link (the
 * one-canonical-link-per-container-pair invariant). The real {@link ScopeLinkRepository}
 * implements it over Postgres. Nothing consumed a port in SS-10, so it lives with this
 * first consuming slice.
 */
export interface ScopeLinkStore {
  /**
   * Idempotently establish a container ↔ container link. The link **must already be in
   * canonical form** (`appAId`/`appBId` assigned by the caller's deterministic ordering,
   * so a link discovered from either direction is the same row). Returns `created` on a
   * fresh insert, `exists` when an active link already connects the same two containers
   * (re-establish is a no-op), or `conflict` when a container is already actively linked
   * to a *different* counterpart (never re-pointed).
   */
  establish(link: ScopeLink): Promise<EstablishScopeLinkResult>;
  /**
   * The **active** link for a container, addressed by (app, scope-key) on either side —
   * the container analog of `RecordLinkStore.findActiveByRecord`. Returns 0 or 1.
   */
  lookupByScopeKey(resourcePairRef: string, side: ScopeLinkSideRef): Promise<ScopeLink | undefined>;
  /**
   * The **archived** link for a container, addressed by (app, scope-key) on either side —
   * an **operator-severed** link (SS-11.6) or a lifecycle-cascade archive (SS-10.5). Used
   * by discovery to detect an **operator override**: automatic identity-match discovery
   * must NOT auto-re-link a container the operator has severed (`ScopeDiscoveryStage`
   * gates auto-establish on this). Returns 0 or 1.
   */
  findArchivedByScopeKey(
    resourcePairRef: string,
    side: ScopeLinkSideRef,
  ): Promise<ScopeLink | undefined>;
  /**
   * Sever a link (SS-11.6 manual **unlink**) — set `status = 'archived'`, **never delete**.
   * A `ScopeLink` is pointed at by many `RecordLink.scopeRef = { kind: "scope-link",
   * scopeLinkId }` rows (a plain jsonb column, **no FK**), so a physical delete would
   * silently orphan them and break the SS-10.5 / SS-12.3 guarantee that a delete/audit
   * still resolves its frozen container key. Archiving keeps the row resolvable by
   * {@link getById} while dropping it out of {@link lookupByScopeKey} (active-only), so a
   * corrected re-link creates a fresh **active** link. The archived row is also the
   * operator-override signal ({@link findArchivedByScopeKey}). Returns `true` when it
   * flipped an active row to archived, `false` when the id was unknown / already archived.
   */
  sever(id: string): Promise<boolean>;
  /** Every link established under one `ScopeCorrespondence`, whatever its status. */
  listByCorrespondence(scopeCorrespondenceId: string): Promise<ScopeLink[]>;
  /** One link by id (observability / tests / re-reading after a mutation). */
  getById(id: string): Promise<ScopeLink | undefined>;
}

/** Two scope-key maps are equal iff they carry the same components with the same values (order-insensitive). */
function scopeKeysEqual(a: ScopeKey, b: ScopeKey): boolean {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) {
    return false;
  }
  return aKeys.every((key) => Object.prototype.hasOwnProperty.call(b, key) && a[key] === b[key]);
}

/**
 * Persistence for `ScopeLink` (SS-10 / SS-11) — the container ↔ container instances under
 * a `ScopeCorrespondence`. Constructor-bound to a {@link DbHandle} (the pooled db or a
 * `tx()`), matching the repo convention. Implements the narrow {@link ScopeLinkStore}
 * port the discovery stage depends on, plus reads/archival.
 */
export class ScopeLinkRepository implements ScopeLinkStore {
  public constructor(private readonly db: DbHandle) {}

  /** Persist a new container link. */
  public async create(link: ScopeLink): Promise<void> {
    await this.db.insert(scopeLink).values(toScopeLinkInsert(link));
  }

  /**
   * Idempotently establish a **canonical** container link (SS-11). Fails loud on a
   * conflict and is a no-op on a re-establish, so a discovery pass re-run (enablement /
   * sweep / on-demand) never duplicates a link (the one-canonical-link-per-pair
   * invariant). The check-then-insert is not a single atomic statement — the single-
   * instance discovery pass is serialized (enablement / sweep / on-demand harvest run
   * one at a time), and the `conflict`/`exists` guards make a re-run converge rather than
   * duplicate; a partial-unique index is a future hardening if concurrency is ever added.
   */
  public async establish(link: ScopeLink): Promise<EstablishScopeLinkResult> {
    // A link already covering the source (A) container? Same counterpart → idempotent
    // `exists`; a different counterpart → `conflict` (never re-pointed).
    const onA = await this.lookupByScopeKey(link.resourcePairRef, {
      appId: link.appAId,
      scopeKey: link.appAScopeKey,
    });
    if (onA !== undefined) {
      return onA.appBId === link.appBId && scopeKeysEqual(onA.appBScopeKey, link.appBScopeKey)
        ? { kind: "exists", link: onA }
        : { kind: "conflict", existing: onA };
    }
    // The B container already linked (to some other A) is also a conflict.
    const onB = await this.lookupByScopeKey(link.resourcePairRef, {
      appId: link.appBId,
      scopeKey: link.appBScopeKey,
    });
    if (onB !== undefined) {
      return { kind: "conflict", existing: onB };
    }
    await this.db.insert(scopeLink).values(toScopeLinkInsert(link));
    return { kind: "created", link };
  }

  /**
   * Sever a link (SS-11.6 manual unlink) — **archive it, never delete** (see the port
   * doc): flip an **active** row to `archived` so a `RecordLink.scopeRef` pointing at it
   * still resolves its frozen key via {@link getById} for a final delete/audit, while it
   * drops out of the active {@link lookupByScopeKey} (a corrected re-link then creates a
   * fresh active link). Returns whether an active row was flipped.
   */
  public async sever(id: string): Promise<boolean> {
    const archived = await this.db
      .update(scopeLink)
      .set({ status: "archived" })
      .where(and(eq(scopeLink.id, id), eq(scopeLink.status, "active")))
      .returning({ id: scopeLink.id });
    return archived.length > 0;
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
    return this.#lookupByStatus(resourcePairRef, side, "active");
  }

  /**
   * The **archived** link for a container (an operator-severed link, SS-11.6, or a
   * lifecycle-cascade archive, SS-10.5). Discovery reads this to respect an operator
   * override — never auto-re-link a container the operator severed. Returns 0 or 1.
   */
  public async findArchivedByScopeKey(
    resourcePairRef: string,
    side: ScopeLinkSideRef,
  ): Promise<ScopeLink | undefined> {
    return this.#lookupByStatus(resourcePairRef, side, "archived");
  }

  /** Resolve the link for a container by (app, scope-key) on either side at a given status. */
  async #lookupByStatus(
    resourcePairRef: string,
    side: ScopeLinkSideRef,
    status: "active" | "archived",
  ): Promise<ScopeLink | undefined> {
    const keyJson = JSON.stringify(side.scopeKey);
    const [row] = await this.db
      .select()
      .from(scopeLink)
      .where(
        and(
          eq(scopeLink.resourcePairRef, resourcePairRef),
          eq(scopeLink.status, status),
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
