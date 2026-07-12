import { z } from "zod";

/**
 * `SyncEvent / AuditLog` — the durable, business-level record of every sync
 * execution, adapter request, mapping decision, and credential access
 * (`docs/architecture/data-model.md` `SyncEvent / AuditLog`;
 * `docs/architecture/security.md` *Audit logging*). One entity, two names: the
 * `SyncEvent` name is kept because sync executions dominate the row volume.
 *
 * Phase 3 writes exactly one `type` — `mapping-decision` — to satisfy AS-1
 * criterion 5 (a per-item decision records its actor + item + decision) and the
 * approve action's attribution. The sync-execution/poll-run/etc. rows, with their
 * idempotency/loop-prevention columns, are Phase 4 and deliberately not modeled
 * on this shape yet; the columns they need are added by a later migration to the
 * same table. What is modeled here is exactly what an audit reader needs to
 * reconstruct the incremental-approval history the concept says lives in the
 * audit log rather than on the `ApprovedMapping` (`ApprovedMapping.approvedBy`).
 *
 * **Metadata only, never secrets** — the security invariant: an audit entry
 * carries who/what/when/decision, never credential material or live payload
 * values (`docs/architecture/security.md`).
 */

// ── type (the full data-model vocabulary) ────────────────────────────────────

/**
 * The `type` discriminant of an audit-log row (`docs/architecture/data-model.md`
 * `SyncEvent / AuditLog`). The single naming authority owns **every** value the
 * column can hold — including the sync-focused types only Phase 4 writes — exactly
 * as `mapping-enums.ts` owns every `MappingProposalStatus`.
 */
export const auditLogTypeSchema = z.enum([
  "poll-run",
  "backfill-run",
  "sync-execution",
  "adapter-request",
  "mapping-decision",
  "credential-access",
]);
export type AuditLogType = z.infer<typeof auditLogTypeSchema>;
export const AuditLogType = auditLogTypeSchema.enum;

// ── mapping-decision (the Phase-3 decision vocabulary) ───────────────────────

/**
 * The specific operator action a `mapping-decision` audit entry records — the
 * "decision" AS-1 criterion 5 requires alongside the actor and the item. A
 * per-item review records `accept` / `edit` / `reject`; the assemble-and-approve
 * action records `approve`. This is **not** the `MappingProposalItem.reviewState`
 * enum (a persisted item state, not an action): a per-item `edit` moves the item
 * to `reviewState = edited`, but the *decision* recorded is the act of editing.
 */
export const mappingDecisionSchema = z.enum(["accept", "edit", "reject", "approve"]);
export type MappingDecision = z.infer<typeof mappingDecisionSchema>;
export const MappingDecision = mappingDecisionSchema.enum;

// ── AuditLogEntry ────────────────────────────────────────────────────────────

/**
 * One audit-log row. Field notes:
 *
 * - `actor` — the authenticated operator identity (`Principal.identity`), recorded
 *   on every mutation (`docs/architecture/security.md`).
 * - `decision` — present on `mapping-decision` entries (the four-value vocabulary
 *   above), absent on the sync-focused types a later phase writes.
 * - `relatedProposalId` / `relatedItemId` / `relatedMappingId` — the loose
 *   references the data model calls "whichever the event type concerns": a
 *   per-item decision references its proposal + item, the approve action its
 *   proposal + the resulting mapping. Loose (no foreign key) on purpose — an
 *   audit row is retained for traceability even after its proposal/items are
 *   deleted, so it must not be cascade-removed with them.
 * - `details` — a short, metadata-only note (e.g. the approve outcome); never a
 *   secret value.
 */
export const auditLogEntrySchema = z.object({
  id: z.string(),
  type: auditLogTypeSchema,
  actor: z.string(),
  decision: mappingDecisionSchema.optional(),
  relatedProposalId: z.string().optional(),
  relatedItemId: z.string().optional(),
  relatedMappingId: z.string().optional(),
  details: z.string().optional(),
  timestamp: z.date(),
});
export type AuditLogEntry = z.infer<typeof auditLogEntrySchema>;
