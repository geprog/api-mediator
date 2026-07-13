import type { ParkedConflict, ParkedConflictResolutionChoice } from "@mediator/domain";
import { and, desc, eq, sql } from "drizzle-orm";

import type { DbHandle } from "../client.js";
import { mapParkedConflictRow, toParkedConflictInsert } from "../mappers/parked-conflict.js";
import { parkedConflict } from "../schema.js";

/**
 * The operator's resolution decision recorded onto a `parked_conflict` row (OA-3): the
 * chosen resolution + the authenticated identity + when. Applied only to an **open**
 * row (a resolved row is never re-resolved).
 */
export interface ParkedConflictResolution {
  readonly choice: ParkedConflictResolutionChoice;
  readonly resolvedBy: string;
  readonly resolvedAt: Date;
}

/**
 * The narrow persistence port the SA-4 pipeline/handler + operator API depend on, so
 * both are unit-testable against a fake that **mirrors** these exact semantics
 * ([[fakes-must-mirror-real-repos]]) — the idempotent-open upsert especially, because a
 * loose fake would let a re-park duplicate the queue.
 *
 * The upserts are **idempotent by the open key**: re-processing a still-conflicting
 * field updates the existing open row's contested hashes rather than inserting a
 * duplicate (the partial-unique-open indexes on `parked_conflict` enforce it). A
 * `resolved` row leaves the open set, so a later re-park opens a fresh row.
 */
export interface ParkedConflictStore {
  /** Idempotently open/refresh a **field** conflict park (`manual-resolve`/`withheld`). */
  upsertOpenFieldConflict(conflict: ParkedConflict): Promise<void>;
  /** Idempotently open/refresh a **drifted-delete** park (one open row per link). */
  upsertOpenDriftedDelete(conflict: ParkedConflict): Promise<void>;
  /**
   * Mark an **open** row `resolved` (OA-3). Returns the updated row, or `undefined`
   * when the id is unknown or already resolved (so a double-resolve is a safe no-op).
   */
  resolve(id: string, resolution: ParkedConflictResolution): Promise<ParkedConflict | undefined>;
  /** One row by id (the resolve endpoint's load; observability/tests). */
  getById(id: string): Promise<ParkedConflict | undefined>;
  /** The SA-4.1 queue: `open` rows, newest first, bounded by `limit`. */
  listOpen(limit: number): Promise<ParkedConflict[]>;
}

/**
 * Persistence for `parked_conflict` (SA-4). Constructor-bound to a {@link DbHandle}
 * (the pooled db or a `tx()`), matching the repo convention. Implements the narrow
 * {@link ParkedConflictStore} the handler + operator service depend on, plus reads.
 *
 * **Metadata only** — a row carries ids/enums/paths/hashes, never a raw contested value
 * or credential material (`docs/architecture/security.md`; enforced by the absence of
 * any value column on the table).
 */
export class ParkedConflictRepository implements ParkedConflictStore {
  public constructor(private readonly db: DbHandle) {}

  public async upsertOpenFieldConflict(conflict: ParkedConflict): Promise<void> {
    await this.db
      .insert(parkedConflict)
      .values(toParkedConflictInsert(conflict))
      // Idempotent re-park: match the `parked_conflict_open_field_uq` partial index and
      // refresh only the contested hashes/timestamps on the existing open row.
      .onConflictDoUpdate({
        target: [
          parkedConflict.recordLinkId,
          parkedConflict.side,
          parkedConflict.kind,
          parkedConflict.fieldPath,
        ],
        targetWhere: sql`${parkedConflict.status} = 'open' AND ${parkedConflict.fieldPath} IS NOT NULL`,
        set: {
          sourceObservedHash: conflict.sourceObservedHash ?? null,
          targetObservedHash: conflict.targetObservedHash ?? null,
          sourceNativeId: conflict.sourceNativeId ?? null,
          details: conflict.details ?? null,
          updatedAt: conflict.updatedAt,
        },
      });
  }

  public async upsertOpenDriftedDelete(conflict: ParkedConflict): Promise<void> {
    await this.db
      .insert(parkedConflict)
      .values(toParkedConflictInsert(conflict))
      // Idempotent re-park: match the `parked_conflict_open_delete_uq` partial index
      // (one open drifted-delete per link) and refresh only the metadata note.
      .onConflictDoUpdate({
        target: [parkedConflict.recordLinkId],
        targetWhere: sql`${parkedConflict.status} = 'open' AND ${parkedConflict.kind} = 'drifted-delete'`,
        set: {
          targetObservedHash: conflict.targetObservedHash ?? null,
          sourceNativeId: conflict.sourceNativeId ?? null,
          details: conflict.details ?? null,
          updatedAt: conflict.updatedAt,
        },
      });
  }

  public async resolve(
    id: string,
    resolution: ParkedConflictResolution,
  ): Promise<ParkedConflict | undefined> {
    const [row] = await this.db
      .update(parkedConflict)
      .set({
        status: "resolved",
        resolutionChoice: resolution.choice,
        resolvedBy: resolution.resolvedBy,
        resolvedAt: resolution.resolvedAt,
        updatedAt: resolution.resolvedAt,
      })
      // Only an OPEN row is resolvable — a double-resolve matches zero rows (safe no-op).
      .where(and(eq(parkedConflict.id, id), eq(parkedConflict.status, "open")))
      .returning();
    return row === undefined ? undefined : mapParkedConflictRow(row);
  }

  public async getById(id: string): Promise<ParkedConflict | undefined> {
    const [row] = await this.db
      .select()
      .from(parkedConflict)
      .where(eq(parkedConflict.id, id))
      .limit(1);
    return row === undefined ? undefined : mapParkedConflictRow(row);
  }

  public async listOpen(limit: number): Promise<ParkedConflict[]> {
    const rows = await this.db
      .select()
      .from(parkedConflict)
      .where(eq(parkedConflict.status, "open"))
      .orderBy(desc(parkedConflict.createdAt))
      .limit(limit);
    return rows.map(mapParkedConflictRow);
  }
}
