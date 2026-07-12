import { type AuditLogEntry, stripUndefined } from "@mediator/domain";

import { auditLog } from "../schema.js";

/** A selected `audit_log` row, with Drizzle's inferred column types. */
export type AuditLogRow = typeof auditLog.$inferSelect;
/** The insert shape Drizzle expects for `audit_log`. */
export type AuditLogInsert = typeof auditLog.$inferInsert;

/**
 * Row → domain. Every nullable column collapses NULL → an **absent** domain key
 * ({@link stripUndefined}), matching the `AuditLogEntry` `.optional()` fields: a
 * `mapping-decision` row carries `decision` + whichever `related_*` refs it
 * concerns, and NULL elsewhere. `timestamp` comes back as a real `Date`.
 */
export function mapAuditLogRow(row: AuditLogRow): AuditLogEntry {
  return stripUndefined({
    id: row.id,
    type: row.type,
    actor: row.actor,
    decision: row.decision ?? undefined,
    relatedProposalId: row.relatedProposalId ?? undefined,
    relatedItemId: row.relatedItemId ?? undefined,
    relatedMappingId: row.relatedMappingId ?? undefined,
    details: row.details ?? undefined,
    timestamp: row.timestamp,
  });
}

/** Domain → insert. Each absent optional key becomes a NULL column. */
export function toAuditLogInsert(entry: AuditLogEntry): AuditLogInsert {
  return {
    id: entry.id,
    type: entry.type,
    actor: entry.actor,
    decision: entry.decision ?? null,
    relatedProposalId: entry.relatedProposalId ?? null,
    relatedItemId: entry.relatedItemId ?? null,
    relatedMappingId: entry.relatedMappingId ?? null,
    details: entry.details ?? null,
    timestamp: entry.timestamp,
  };
}
