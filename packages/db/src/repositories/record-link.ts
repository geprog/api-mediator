import type { RecordLink, TombstoneReason } from "@mediator/domain";
import { and, desc, eq, or } from "drizzle-orm";

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

  public async getById(id: string): Promise<RecordLink | undefined> {
    const [row] = await this.db.select().from(recordLink).where(eq(recordLink.id, id)).limit(1);
    return row === undefined ? undefined : mapRecordLinkRow(row);
  }
}
