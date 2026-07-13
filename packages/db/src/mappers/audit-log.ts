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
 * concerns, a `credential-access` row (CD-3) carries `relatedCredentialId` /
 * `originAppId` / `traceId` / `spanId`, and NULL elsewhere. `timestamp` comes back
 * as a real `Date`.
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
    // SD-4 per-record (`sync-execution`) fields — NULL → absent domain key.
    status: row.status ?? undefined,
    relatedRuleId: row.relatedRuleId ?? undefined,
    recordLinkId: row.recordLinkId ?? undefined,
    sourceNativeId: row.sourceNativeId ?? undefined,
    idempotencyKey: row.idempotencyKey ?? undefined,
    payloadHash: row.payloadHash ?? undefined,
    relatedCredentialId: row.relatedCredentialId ?? undefined,
    originAppId: row.originAppId ?? undefined,
    traceId: row.traceId ?? undefined,
    spanId: row.spanId ?? undefined,
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
    // SD-4 per-record (`sync-execution`) fields — absent domain key → SQL NULL.
    status: entry.status ?? null,
    relatedRuleId: entry.relatedRuleId ?? null,
    recordLinkId: entry.recordLinkId ?? null,
    sourceNativeId: entry.sourceNativeId ?? null,
    idempotencyKey: entry.idempotencyKey ?? null,
    payloadHash: entry.payloadHash ?? null,
    relatedCredentialId: entry.relatedCredentialId ?? null,
    originAppId: entry.originAppId ?? null,
    traceId: entry.traceId ?? null,
    spanId: entry.spanId ?? null,
    timestamp: entry.timestamp,
  };
}
