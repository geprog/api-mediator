import { type RecordLink, stripUndefined } from "@mediator/domain";

import { recordLink } from "../schema.js";

/** A selected `record_link` row, with Drizzle's inferred column types. */
export type RecordLinkRow = typeof recordLink.$inferSelect;
/** The insert shape Drizzle expects for `record_link`. */
export type RecordLinkInsert = typeof recordLink.$inferInsert;

/**
 * Row → domain. `tombstone_reason` collapses NULL → an **absent** domain key
 * (the `RecordLink` refinement requires it absent on a non-`tombstoned` link);
 * `tombstoned_at` stays nullable (`null` on an active/archived link). The
 * `establishing_queue_key` jsonb round-trips as the `RecordLinkEstablishingQueueKey`
 * discriminated union it was stored as.
 */
export function mapRecordLinkRow(row: RecordLinkRow): RecordLink {
  return stripUndefined({
    id: row.id,
    appAId: row.appAId,
    appANativeId: row.appANativeId,
    appBId: row.appBId,
    appBNativeId: row.appBNativeId,
    resourcePairRef: row.resourcePairRef,
    establishedBy: row.establishedBy,
    status: row.status,
    tombstoneReason: row.tombstoneReason ?? undefined,
    establishingQueueKey: row.establishingQueueKey,
    createdAt: row.createdAt,
    tombstonedAt: row.tombstonedAt,
  });
}

/** Domain → insert. An absent `tombstoneReason` becomes a NULL column. */
export function toRecordLinkInsert(link: RecordLink): RecordLinkInsert {
  return {
    id: link.id,
    appAId: link.appAId,
    appANativeId: link.appANativeId,
    appBId: link.appBId,
    appBNativeId: link.appBNativeId,
    resourcePairRef: link.resourcePairRef,
    establishedBy: link.establishedBy,
    status: link.status,
    tombstoneReason: link.tombstoneReason ?? null,
    establishingQueueKey: link.establishingQueueKey,
    createdAt: link.createdAt,
    tombstonedAt: link.tombstonedAt,
  };
}
