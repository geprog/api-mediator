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
 * discriminated union it was stored as. `app_{a,b}_record_address` (SS-19) and
 * `scope_ref` (SS-10) collapse NULL → an **absent** domain key (`scopeRef` is absent on a non-scoped rule's link); its
 * `jsonb` union carries no `Date`, so it round-trips verbatim.
 */
export function mapRecordLinkRow(row: RecordLinkRow): RecordLink {
  return stripUndefined({
    id: row.id,
    appAId: row.appAId,
    appANativeId: row.appANativeId,
    appARecordAddress: row.appARecordAddress ?? undefined,
    appBId: row.appBId,
    appBNativeId: row.appBNativeId,
    appBRecordAddress: row.appBRecordAddress ?? undefined,
    resourcePairRef: row.resourcePairRef,
    establishedBy: row.establishedBy,
    status: row.status,
    tombstoneReason: row.tombstoneReason ?? undefined,
    establishingQueueKey: row.establishingQueueKey,
    createdAt: row.createdAt,
    tombstonedAt: row.tombstonedAt,
    scopeRef: row.scopeRef ?? undefined,
  });
}

/**
 * Domain → insert. An absent `tombstoneReason` becomes a NULL column; an absent
 * `scopeRef` (a non-scoped rule's link) becomes a NULL `scope_ref` column; an absent
 * per-side `recordAddress` (that side addresses by its native id) becomes a NULL
 * `app_{a,b}_record_address` column (SS-19).
 */
export function toRecordLinkInsert(link: RecordLink): RecordLinkInsert {
  return {
    id: link.id,
    appAId: link.appAId,
    appANativeId: link.appANativeId,
    appARecordAddress: link.appARecordAddress ?? null,
    appBId: link.appBId,
    appBNativeId: link.appBNativeId,
    appBRecordAddress: link.appBRecordAddress ?? null,
    resourcePairRef: link.resourcePairRef,
    establishedBy: link.establishedBy,
    status: link.status,
    tombstoneReason: link.tombstoneReason ?? null,
    establishingQueueKey: link.establishingQueueKey,
    createdAt: link.createdAt,
    tombstonedAt: link.tombstonedAt,
    scopeRef: link.scopeRef ?? null,
  };
}
