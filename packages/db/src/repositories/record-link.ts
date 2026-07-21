import type { RecordLink, RecordLinkScopeRef, TombstoneReason } from "@mediator/domain";
import { and, desc, eq, isNull, or } from "drizzle-orm";

import type { DbHandle } from "../client.js";
import { mapRecordLinkRow, toRecordLinkInsert } from "../mappers/record-link.js";
import { recordLink } from "../schema.js";

/**
 * One side of a `RecordLink` addressed by its own app + native id — the shape the
 * Identity Resolution stage's resolve-by-(app, native id) lookups take. Direction-
 * agnostic: the same record is addressed the same way whether it is side A or B of
 * the canonical `resourcePairRef`.
 */
export interface RecordLinkSideRef {
  readonly appId: string;
  readonly nativeId: string;
}

/**
 * Which side of the canonical `resourcePairRef` a per-side column belongs to — `"A"` is
 * the first `appId:resourceRef` token, `"B"` the second (`derive.ts`
 * `canonicalResourcePairRef`). Used to target the correct `app_{a,b}_record_address`
 * column; addressing only, never identity.
 */
export type RecordLinkSide = "A" | "B";

/**
 * The narrow persistence port the Identity Resolution stage (RL-1..RL-5) depends
 * on, so the stage is unit-testable against a fake that **mirrors** these exact
 * semantics ([[fakes-must-mirror-real-repos]]) — the unique-active-link invariant
 * and tombstone-not-delete especially, because faking them loosely would mask the
 * silent-merge bug RL-4 guards against. The real {@link RecordLinkRepository}
 * implements it over Postgres + the partial-unique-active indexes.
 */
export interface RecordLinkStore {
  /**
   * The **active** link for a record, addressed by (app, native id) on either side
   * of the pair — RL-1's resolve-first lookup. At most one can exist (the
   * partial-unique-active index guarantees it), so this returns 0 or 1.
   */
  findActiveByRecord(
    resourcePairRef: string,
    record: RecordLinkSideRef,
  ): Promise<RecordLink | undefined>;
  /**
   * The most-recent **tombstoned** link for a record (either side) — the RL-5
   * survivor / resurrection check when no active link resolves. A record may have
   * several historical tombstones (deleted, re-created, deleted again); the newest
   * governs.
   */
  findTombstonedByRecord(
    resourcePairRef: string,
    record: RecordLinkSideRef,
  ): Promise<RecordLink | undefined>;
  /**
   * Persist a new link. The partial-unique-active indexes enforce **at most one
   * active link per (resource pair, app, native id)** on each side, so a second
   * concurrent establishment for a record that already has one fails loudly rather
   * than silently merging (RL-4 safety).
   */
  insert(link: RecordLink): Promise<void>;
  /**
   * Tombstone a link (RL-5) — set `status = 'tombstoned'` + the reason + timestamp,
   * **never delete it**: the tombstone is what recognizes a delete echo and prevents
   * resurrection.
   */
  tombstone(id: string, reason: TombstoneReason, tombstonedAt: Date): Promise<void>;
  /**
   * Sever a link by removing it (RL-5 manual **unlink**): a hard delete, cascading
   * its `sync_field_state`. Distinct from a tombstone — an operator correcting a
   * mis-link wants the records re-linkable/re-matchable, not resurrection-blocked.
   */
  unlink(id: string): Promise<void>;
  /**
   * Persist a link's `scopeRef` (SS-10/SS-12) — the record's stored container, captured
   * at establishment on a **scoped** rule, so a later delete / no-captured-scope read
   * routes from stored state instead of a (missing) captured scope. On the port because
   * SS-12 persists it here (a link may be established before its container is resolved),
   * and the fake **mirrors** it ([[fakes-must-mirror-real-repos]]). The `jsonb` union is
   * written whole; reading it back is via {@link getById} (the mapper collapses a NULL
   * column to an absent `scopeRef`).
   */
  setScopeRef(id: string, scopeRef: RecordLinkScopeRef): Promise<void>;
  /**
   * SS-19 — persist one **side's** frozen container-relative address
   * (`app_{a,b}_record_address`), targeted by {@link RecordLinkSide}. **Addressing
   * only** — it never touches the native ids the link correlates by, so the
   * unique-active identity indexes are untouched. Used by the `recordAddressRef`
   * address-repair sweep to stamp a link established **before** the ref was confirmed
   * (which therefore carries no address and would otherwise park on its next scoped
   * write). A no-op on an unknown id; the whole-column overwrite is idempotent, so
   * re-stamping the same value is harmless.
   */
  setRecordAddress(id: string, side: RecordLinkSide, address: string): Promise<void>;
  /**
   * SS-19 — the **active** links for which `appId` is a side that carries **no** stored
   * container-relative address (a NULL `app_{a,b}_record_address` on the side whose
   * `app_{a,b}_id` is `appId`) — the candidate set the address-repair sweep resolves and
   * stamps. Returned across every resource pair the app participates in; the caller
   * narrows to the confirmed binding's `resourceRef` (and picks the addressing side) by
   * parsing each link's canonical `resourcePairRef`. An already-stamped side is excluded
   * here, which is what makes a re-run idempotent (a fully-stamped app yields none).
   */
  listActiveMissingRecordAddress(appId: string): Promise<RecordLink[]>;
  /** One link by id (observability / tests / re-reading after a mutation). */
  getById(id: string): Promise<RecordLink | undefined>;
}

/** Match a record on either side of a link for a given resource pair. */
function onEitherSide(resourcePairRef: string, record: RecordLinkSideRef) {
  return and(
    eq(recordLink.resourcePairRef, resourcePairRef),
    or(
      and(eq(recordLink.appAId, record.appId), eq(recordLink.appANativeId, record.nativeId)),
      and(eq(recordLink.appBId, record.appId), eq(recordLink.appBNativeId, record.nativeId)),
    ),
  );
}

/**
 * Persistence for `RecordLink` (RL-1..RL-5). Constructor-bound to a {@link DbHandle}
 * (the pooled db or a `tx()`), matching the repo convention. Implements the narrow
 * {@link RecordLinkStore} port the stage depends on, plus reads for tests.
 */
export class RecordLinkRepository implements RecordLinkStore {
  public constructor(private readonly db: DbHandle) {}

  public async findActiveByRecord(
    resourcePairRef: string,
    record: RecordLinkSideRef,
  ): Promise<RecordLink | undefined> {
    const [row] = await this.db
      .select()
      .from(recordLink)
      .where(and(onEitherSide(resourcePairRef, record), eq(recordLink.status, "active")))
      .limit(1);
    return row === undefined ? undefined : mapRecordLinkRow(row);
  }

  public async findTombstonedByRecord(
    resourcePairRef: string,
    record: RecordLinkSideRef,
  ): Promise<RecordLink | undefined> {
    const [row] = await this.db
      .select()
      .from(recordLink)
      .where(and(onEitherSide(resourcePairRef, record), eq(recordLink.status, "tombstoned")))
      .orderBy(desc(recordLink.tombstonedAt))
      .limit(1);
    return row === undefined ? undefined : mapRecordLinkRow(row);
  }

  public async insert(link: RecordLink): Promise<void> {
    await this.db.insert(recordLink).values(toRecordLinkInsert(link));
  }

  public async tombstone(id: string, reason: TombstoneReason, tombstonedAt: Date): Promise<void> {
    await this.db
      .update(recordLink)
      .set({ status: "tombstoned", tombstoneReason: reason, tombstonedAt })
      .where(eq(recordLink.id, id));
  }

  public async unlink(id: string): Promise<void> {
    await this.db.delete(recordLink).where(eq(recordLink.id, id));
  }

  /**
   * Persist a link's `scopeRef` (SS-10) — the record's stored container, captured at
   * establishment on a scoped rule. Separated from {@link insert} because a link may
   * be established before its container is resolved (the scope is filled in on
   * establishment/harvest); the `jsonb` union is written whole. Reading it back is via
   * {@link getById} (the mapper collapses a NULL column to an absent `scopeRef`).
   */
  public async setScopeRef(id: string, scopeRef: RecordLinkScopeRef): Promise<void> {
    await this.db.update(recordLink).set({ scopeRef }).where(eq(recordLink.id, id));
  }

  /**
   * SS-19 — targeted UPDATE of the one side's `app_{a,b}_record_address` column (the
   * address-repair stamp). Addressing only: the identity columns / unique-active indexes
   * are untouched. No-op on an unknown id; a whole-column overwrite, so re-stamping the
   * same value is idempotent.
   */
  public async setRecordAddress(id: string, side: RecordLinkSide, address: string): Promise<void> {
    await this.db
      .update(recordLink)
      .set(side === "A" ? { appARecordAddress: address } : { appBRecordAddress: address })
      .where(eq(recordLink.id, id));
  }

  /**
   * SS-19 — active links where `appId` is a side whose container-relative address is
   * still NULL. Probed per side (an app can be side A of one pair and side B of another),
   * so a link is returned when it is active **and** the `appId` side's address column is
   * NULL. The caller narrows to a specific `resourceRef` by parsing `resourcePairRef`.
   */
  public async listActiveMissingRecordAddress(appId: string): Promise<RecordLink[]> {
    const rows = await this.db
      .select()
      .from(recordLink)
      .where(
        and(
          eq(recordLink.status, "active"),
          or(
            and(eq(recordLink.appAId, appId), isNull(recordLink.appARecordAddress)),
            and(eq(recordLink.appBId, appId), isNull(recordLink.appBRecordAddress)),
          ),
        ),
      );
    return rows.map(mapRecordLinkRow);
  }

  public async getById(id: string): Promise<RecordLink | undefined> {
    const [row] = await this.db.select().from(recordLink).where(eq(recordLink.id, id)).limit(1);
    return row === undefined ? undefined : mapRecordLinkRow(row);
  }
}
