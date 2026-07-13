import { z } from "zod";

import { syncFieldStateSideSchema } from "./sync-enums.js";

/**
 * `ParkedConflict` — the **structured** record of a conflict the Sync Engine parked
 * for a human to resolve (`docs/requirements/phase-4-sync-api.md` SA-4;
 * `docs/architecture/sync-engine.md` *Conflict handling*). It closes the gap the CF
 * review flagged: the pipeline records a `conflict` `SyncEvent` per execution with
 * field paths in a prose `details` string and **no** contested value, so SA-4 cannot
 * reliably resolve a specific `(RecordLink, side, field)` from it. One `ParkedConflict`
 * row per parked field conflict, or one per parked drifted-delete, carries exactly the
 * addressable identity + decision context an operator needs.
 *
 * **Data-boundary invariant (load-bearing).** A row carries only ids, enums, field
 * paths, metadata, and the contested sides' **content hashes** (`observedHash` at park
 * time) — **never** a raw contested value, a live payload value, or credential
 * material (`docs/architecture/security.md` *Audit logging* / LLM data boundary). The
 * hashes are enough to tell whether the still-open conflict is the same one (idempotent
 * re-park) without ever holding the data.
 *
 * Types only, no behavior: recording a park is the pipeline handler's job (CF's outcome
 * parks → the handler writes the row), and resolving it is the operator API's (SA-4.2 /
 * SA-4.3, which re-run the resolution through the normal pipeline).
 */

// ── Enums ────────────────────────────────────────────────────────────────────

/**
 * What kind of park this row records (`docs/requirements/phase-4-sync-api.md` SA-4.1):
 * `manual-resolve` — a field forced to a manual park by `FieldMapping.conflictPolicy`
 * (CF-3); `withheld` — a field auto-resolved `target-wins` and withheld under a partial
 * conflict (CF-4/CF-5); `drifted-delete` — a propagated delete parked because the target
 * drifted, the link left `active` (CF-7). A field conflict (`manual-resolve`/`withheld`)
 * addresses one `(side, fieldPath)`; a `drifted-delete` addresses the whole record.
 */
export const parkedConflictKindSchema = z.enum(["manual-resolve", "withheld", "drifted-delete"]);
export type ParkedConflictKind = z.infer<typeof parkedConflictKindSchema>;
export const ParkedConflictKind = parkedConflictKindSchema.enum;

/**
 * A parked conflict's lifecycle status. `open` — awaiting an operator decision;
 * `resolved` — the operator's decision has been honored through the normal pipeline
 * (or, for a sever, applied directly), so the row is superseded and drops off the
 * SA-4.1 queue. A re-run that re-parks the same still-conflicting field opens a **new**
 * row rather than reviving a resolved one.
 */
export const parkedConflictStatusSchema = z.enum(["open", "resolved"]);
export type ParkedConflictStatus = z.infer<typeof parkedConflictStatusSchema>;
export const ParkedConflictStatus = parkedConflictStatusSchema.enum;

/**
 * The operator's chosen resolution (`docs/requirements/phase-4-sync-api.md` SA-4.2/4.3;
 * `docs/architecture/sync-engine.md` *Conflict handling* — *What resolution does* /
 * *Deletes vs. edits*): a **field** conflict resolves `source-wins` (the winning source
 * value propagates via the normal write path) or `target-wins` (withhold + the
 * counterpart direction propagates the target value / the one-way write is skipped —
 * baselines never forged); a **drifted-delete** resolves `propagate` (delete + tombstone
 * `propagated-delete`) or `sever` (keep the survivor, tombstone `observed-delete`,
 * nothing deleted). Which choices are valid depends on the row's {@link ParkedConflictKind}.
 */
export const parkedConflictResolutionChoiceSchema = z.enum([
  "source-wins",
  "target-wins",
  "propagate",
  "sever",
]);
export type ParkedConflictResolutionChoice = z.infer<typeof parkedConflictResolutionChoiceSchema>;
export const ParkedConflictResolutionChoice = parkedConflictResolutionChoiceSchema.enum;

// ── Entity ───────────────────────────────────────────────────────────────────

/**
 * Field notes:
 *
 * - `recordLinkId` / `syncRuleId` / `mappingId` — loose refs (no FK), so the row
 *   survives a later tombstone/deletion of the link/rule it references, exactly like an
 *   `AuditLog` `related_*` ref.
 * - `side` / `fieldPath` — the contested **target** side (as the `RecordLink` defines A
 *   and B) and target field path of a field conflict; `fieldPath` is **absent** on a
 *   `drifted-delete` (the whole record is contested — the drifted field paths, if any,
 *   go in `details` as metadata).
 * - `sourceObservedHash` / `targetObservedHash` — the two contested sides'
 *   `SyncFieldState.observedHash` **at park time** (content hashes only, never the raw
 *   value); absent on a `drifted-delete` (the source record is gone — there is no source
 *   value to hash).
 * - `resolutionChoice` / `resolvedBy` / `resolvedAt` — present **iff** `status =
 *   'resolved'`, attributing the decision to the authenticated identity (OA-3).
 * - `sourceNativeId` — the contested source record's native id (context for the queue).
 */
export const parkedConflictSchema = z
  .object({
    id: z.string(),
    recordLinkId: z.string(),
    syncRuleId: z.string(),
    mappingId: z.string(),
    kind: parkedConflictKindSchema,
    side: syncFieldStateSideSchema,
    fieldPath: z.string().optional(),
    sourceObservedHash: z.string().optional(),
    targetObservedHash: z.string().optional(),
    status: parkedConflictStatusSchema,
    resolutionChoice: parkedConflictResolutionChoiceSchema.optional(),
    resolvedBy: z.string().optional(),
    resolvedAt: z.date().optional(),
    sourceNativeId: z.string().optional(),
    details: z.string().optional(),
    createdAt: z.date(),
    updatedAt: z.date(),
  })
  .superRefine((row, ctx) => {
    // A field conflict addresses one field; a drifted-delete addresses the record.
    if (row.kind === "drifted-delete") {
      if (row.fieldPath !== undefined) {
        ctx.addIssue({
          code: "custom",
          message: "a drifted-delete ParkedConflict addresses the whole record — no fieldPath",
          path: ["fieldPath"],
        });
      }
    } else if (row.fieldPath === undefined) {
      ctx.addIssue({
        code: "custom",
        message: "a manual-resolve/withheld ParkedConflict must carry the contested fieldPath",
        path: ["fieldPath"],
      });
    }

    // The resolution triple is present exactly on a resolved row.
    const resolutionKeys = [row.resolutionChoice, row.resolvedBy, row.resolvedAt];
    if (row.status === "resolved") {
      if (resolutionKeys.some((value) => value === undefined)) {
        ctx.addIssue({
          code: "custom",
          message:
            "a resolved ParkedConflict must carry resolutionChoice + resolvedBy + resolvedAt",
          path: ["status"],
        });
      }
    } else if (resolutionKeys.some((value) => value !== undefined)) {
      ctx.addIssue({
        code: "custom",
        message:
          "resolutionChoice/resolvedBy/resolvedAt are present only on a resolved ParkedConflict",
        path: ["status"],
      });
    }

    // The choice must match the kind (field choices vs. delete choices).
    if (row.resolutionChoice !== undefined) {
      const fieldChoice =
        row.resolutionChoice === "source-wins" || row.resolutionChoice === "target-wins";
      const isFieldKind = row.kind !== "drifted-delete";
      if (fieldChoice !== isFieldKind) {
        ctx.addIssue({
          code: "custom",
          message: "resolutionChoice must match the ParkedConflict kind (field vs. delete)",
          path: ["resolutionChoice"],
        });
      }
    }
  });
export type ParkedConflict = z.infer<typeof parkedConflictSchema>;
