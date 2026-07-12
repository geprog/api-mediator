import { z } from "zod";

import { syncFieldStateSideSchema, syncFieldStateStatusSchema } from "./sync-enums.js";

/**
 * `SyncFieldState` — one row per mapped field **on one side** of a linked record,
 * in that side's own canonical representation (`docs/architecture/data-model.md`
 * `SyncFieldState`; `docs/glossary.md` `SyncFieldState`, requirement SD-3). Echo
 * detection and conflict detection compare incoming changes against these durable
 * per-side baselines, which never cross a transform boundary.
 *
 * **Keyed by the `RecordLink` plus a side plus a field path** — deliberately *not*
 * by field *pairing* and *not* by `SyncRule` (SD-3 criterion 1). The two directions
 * of a bidirectional pair are independently reviewed mappings that may pair fields
 * asymmetrically or use multi-input transforms, so "the pairing" is not stable
 * across directions, but *a field on one side* always is — and both directions read
 * and write the same per-side rows. A row exists for every field that participates
 * in *either* direction's mapping — as a transform's primary input, an additional
 * `aggregate`/`expression` input, or an output (SD-3 criterion 5).
 *
 * Types only: seeding baselines (BE), updating observed state (SP/OC), the echo
 * comparison (EP), and the drift check (CF) are later slices.
 */
export const syncFieldStateSchema = z
  .object({
    id: z.string(),
    /** The cross-app record identity this state applies to; the link carries both native ids. */
    recordLinkId: z.string(),
    /** Which side of the `RecordLink` (as it defines A and B) this row tracks. */
    side: syncFieldStateSideSchema,
    /** Which field of this side's representation this row tracks. */
    fieldPath: z.string(),
    /**
     * This field's last-**reconciled** value hash + timestamp, in this side's own
     * canonical stored representation. **Both absent together** when the seeding
     * pass found the sides divergent for this field's pairing (there is no
     * last-reconciled value to record) — the first subsequent change is then a
     * conflict by construction (SD-3 criterion 2). Present-together or
     * absent-together is enforced by the refinement below.
     */
    lastSyncedHash: z.string().optional(),
    lastSyncedAt: z.date().optional(),
    /** The latest value hash observed on this side; updated from every poll/write that touches it. */
    observedHash: z.string(),
    observedAt: z.date(),
    /**
     * The app-reported change timestamp accompanying the latest observation,
     * captured via this side's `ResourceBinding.changeTimestampRef`. Nullable —
     * `null` when the side declares no `supportsChangeTimestamps` or its
     * `changeTimestampRef` is unconfirmed (SD-3 criterion 3).
     */
    observedChangeTimestamp: z.date().nullable(),
    /**
     * The `ApprovedMapping` (direction) that produced the last write to this side,
     * for audit/debugging. Optional — absent until this side has been written
     * (e.g. a `link-only` backfill seed writes nothing).
     */
    lastWrittenByMappingId: z.string().optional(),
    status: syncFieldStateStatusSchema,
  })
  .superRefine((state, ctx) => {
    // `lastSyncedHash`/`lastSyncedAt` are a reconciled-baseline pair: present
    // together, or both absent on a divergent seed — never one without the other.
    const hasHash = state.lastSyncedHash !== undefined;
    const hasAt = state.lastSyncedAt !== undefined;
    if (hasHash !== hasAt) {
      ctx.addIssue({
        code: "custom",
        message:
          "lastSyncedHash and lastSyncedAt are present together or absent together (absent on a divergent seed)",
        path: [hasHash ? "lastSyncedAt" : "lastSyncedHash"],
      });
    }
  });
export type SyncFieldState = z.infer<typeof syncFieldStateSchema>;
