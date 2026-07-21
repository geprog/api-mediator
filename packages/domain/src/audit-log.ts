import { z } from "zod";

import { adapterRequestCauseSchema } from "./adapter-enums.js";

/**
 * `SyncEvent / AuditLog` — the durable, business-level record of every sync
 * execution, adapter request, mapping decision, and credential access
 * (`docs/architecture/data-model.md` `SyncEvent / AuditLog`;
 * `docs/architecture/security.md` *Audit logging*). One entity, two names: the
 * `SyncEvent` name is kept because sync executions dominate the row volume.
 *
 * Phase 3 modeled only the `mapping-decision` columns (a per-item decision records
 * its actor + item + decision — AS-1 criterion 5 — plus the approve action's
 * attribution). SD-4 now layers on the per-record **sync-execution** columns and
 * the execution `status` enum, so a `sync-execution` row can be written **once per
 * processed change whatever its outcome** — including one that stopped before any
 * outbound call (`skipped-loop`, `skipped-policy`) — and idempotency dedup /
 * parked-event supersession / manual replay can query by it.
 *
 * This is a **types-only** extension: the actual `audit_log` migration adding these
 * columns, and the pipeline code that writes them, are later slices (OC-*, every
 * engine story). Every SD-4 field is `.optional()` so the existing Phase-3
 * `mapping-decision` construction sites (the approval service + its db mapper),
 * which set none of them, still validate and typecheck unchanged — a
 * `mapping-decision` row leaves `status` unset (enforced below).
 *
 * AD-5 layers on the **`adapter-request`** fields for the same reason and under
 * the same discipline: an adapter request becomes a first-class business record,
 * so every served request — including every distinct failure cause and the
 * degraded middle ground — is queryable after the fact. Emitting the rows is
 * RT-5/WR-*; this file only says what a row may hold.
 *
 * **Metadata only, never secrets** — the security invariant: an audit entry
 * carries who/what/when/decision and hashes/ids/status, never credential material
 * or live payload values (`docs/architecture/security.md`).
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

// ── status (the sync-execution outcome vocabulary — SD-4) ────────────────────

/**
 * The execution `status` of a `SyncEvent`/`AuditLog` row
 * (`docs/architecture/data-model.md` `SyncEvent / AuditLog` `status`). The single
 * naming authority owns every value the column can hold. `skipped-policy` records a
 * change observed but not propagated by policy and covers **all four** of its
 * causes — a deletion under `deletePropagation = ignore`, a create with no approved
 * `create` operation, an update on a create-only rule, and a change to a record
 * whose link is tombstoned `observed-delete` — distinguished by the row's per-record
 * context and `details`, not a dedicated sub-enum (the concept coins none). A
 * `mapping-decision` row leaves `status` unset (SD-4 criterion 1).
 */
export const auditLogStatusSchema = z.enum([
  "success",
  "failure",
  "skipped-loop",
  "skipped-policy",
  "conflict",
]);
export type AuditLogStatus = z.infer<typeof auditLogStatusSchema>;
export const AuditLogStatus = auditLogStatusSchema.enum;

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
 *
 * SD-4 per-record execution fields (all optional — see the file header):
 *
 * - `status` — the execution outcome (above); **unset on `mapping-decision`**
 *   rows, enforced by the refinement below.
 * - `relatedRuleId` / `recordLinkId` / `sourceNativeId` / `originAppId` /
 *   `idempotencyKey` / `payloadHash` — the per-record (`sync-execution`) context
 *   that idempotency's per-record lookback, parked-event supersession, and manual
 *   replay query by. All hashes/ids — never a live payload value.
 * - `relatedCredentialId` — the credential a `credential-access` entry concerns
 *   (CD-3), the same loose (no foreign key) "whichever the event type concerns"
 *   reference the data model lists: a `credential-access` row references the
 *   credential decrypted for an outbound call, alongside `originAppId` (the app
 *   whose credential it was). Loose so the audit row survives a later
 *   rotation/deletion of that credential. A metadata id — never the secret.
 * - `traceId` / `spanId` — correlation to the OpenTelemetry trace. The concept says
 *   every row carries them; they are modeled `.optional()` here so the pre-existing
 *   Phase-3 `mapping-decision` construction sites (which predate this slice and set
 *   neither) still compile — a later slice populates them at write time.
 *
 * AD-5 `adapter-request` fields (all optional — same backward-compatibility
 * reason):
 *
 * - `relatedBindingId` / `relatedEndpointId` — the `AdapterBinding` an adapter
 *   request resolved to and the `AdapterEndpoint` it served (AD-5.1). The same
 *   loose "whichever the event type concerns" refs the data model lists
 *   (`relatedBindingId` is named there); loose so the audit row survives a later
 *   deletion of the binding/endpoint, exactly like `relatedRuleId`.
 * - `cause` — on a failed or degraded `adapter-request` row, **which** of the six
 *   named causes applied, or a generic `upstream-error` (AD-5.2). Deliberately a
 *   separate field from `status`, which reuses the Phase-4 enum unchanged — no new
 *   status value is invented for the adapter (AD-5.5).
 * - `degraded` — `true` on a degraded response: a served result that omitted a
 *   failed `supplement`'s optional fields under `degraded` strictness (AD-5.3).
 *   Distinguishable from a clean success (`status = success`, `degraded` absent)
 *   and from a failure (`status = failure`) precisely because it is
 *   `status = success` **with** this flag set — reusing the status enum rather
 *   than coining a `degraded` status value.
 *
 * All three are **metadata only** — ids, an enum cause, a boolean — never a
 * request/response payload value and never credential material (AD-5.4).
 */
export const auditLogEntrySchema = z
  .object({
    id: z.string(),
    type: auditLogTypeSchema,
    actor: z.string(),
    decision: mappingDecisionSchema.optional(),
    relatedProposalId: z.string().optional(),
    relatedItemId: z.string().optional(),
    relatedMappingId: z.string().optional(),
    details: z.string().optional(),
    timestamp: z.date(),
    // ── SD-4 per-record execution fields (all optional for backward compatibility) ──
    status: auditLogStatusSchema.optional(),
    relatedRuleId: z.string().optional(),
    recordLinkId: z.string().optional(),
    sourceNativeId: z.string().optional(),
    originAppId: z.string().optional(),
    idempotencyKey: z.string().optional(),
    payloadHash: z.string().optional(),
    relatedCredentialId: z.string().optional(),
    traceId: z.string().optional(),
    spanId: z.string().optional(),
    // ── AD-5 adapter-request fields (all optional for backward compatibility) ──
    relatedBindingId: z.string().optional(),
    relatedEndpointId: z.string().optional(),
    cause: adapterRequestCauseSchema.optional(),
    degraded: z.boolean().optional(),
  })
  .superRefine((entry, ctx) => {
    // A `mapping-decision` row leaves `status` unset (SD-4 criterion 1): the
    // execution status vocabulary describes a processed sync change, not a review
    // decision.
    if (entry.type === "mapping-decision" && entry.status !== undefined) {
      ctx.addIssue({
        code: "custom",
        message: "a mapping-decision audit row leaves status unset",
        path: ["status"],
      });
    }
    // `cause` and `degraded` describe an adapter request specifically (AD-5.2/3):
    // unrepresentable on any other row type, so a sync-execution row can never
    // carry a spurious adapter cause or degraded flag.
    if (entry.type !== "adapter-request") {
      if (entry.cause !== undefined) {
        ctx.addIssue({
          code: "custom",
          message: "cause is an adapter-request field — absent on other audit row types",
          path: ["cause"],
        });
      }
      if (entry.degraded !== undefined) {
        ctx.addIssue({
          code: "custom",
          message: "degraded is an adapter-request field — absent on other audit row types",
          path: ["degraded"],
        });
      }
    }
  });
export type AuditLogEntry = z.infer<typeof auditLogEntrySchema>;
