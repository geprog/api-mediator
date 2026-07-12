import { describe, expect, it } from "vitest";

import {
  BackfillMode,
  backfillModeSchema,
  BackfillStatus,
  backfillStatusSchema,
  DeletePropagation,
  deletePropagationSchema,
  RecordLinkEstablishedBy,
  recordLinkEstablishedBySchema,
  RecordLinkStatus,
  recordLinkStatusSchema,
  SyncFieldStateSide,
  syncFieldStateSideSchema,
  SyncFieldStateStatus,
  syncFieldStateStatusSchema,
  TargetDriftCheck,
  targetDriftCheckSchema,
  TombstoneReason,
  tombstoneReasonSchema,
} from "./index.js";

describe("Phase-4 sync-execution enums", () => {
  it("expose glossary-verbatim literals as schema, union type, and const object", () => {
    // SD-1
    expect(deletePropagationSchema.options).toEqual(["ignore", "propagate"]);
    expect(DeletePropagation).toEqual({ ignore: "ignore", propagate: "propagate" });

    expect(targetDriftCheckSchema.options).toEqual(["none", "read-before-write"]);
    expect(TargetDriftCheck).toEqual({ none: "none", "read-before-write": "read-before-write" });

    expect(backfillModeSchema.options).toEqual(["link-only", "push"]);
    expect(BackfillMode).toEqual({ "link-only": "link-only", push: "push" });

    expect(backfillStatusSchema.options).toEqual(["pending", "running", "completed", "skipped"]);
    expect(BackfillStatus).toEqual({
      pending: "pending",
      running: "running",
      completed: "completed",
      skipped: "skipped",
    });

    // SD-2
    expect(recordLinkEstablishedBySchema.options).toEqual([
      "create-propagation",
      "identity-match",
      "manual",
    ]);
    expect(RecordLinkEstablishedBy).toEqual({
      "create-propagation": "create-propagation",
      "identity-match": "identity-match",
      manual: "manual",
    });

    expect(recordLinkStatusSchema.options).toEqual(["active", "tombstoned", "archived"]);
    expect(RecordLinkStatus).toEqual({
      active: "active",
      tombstoned: "tombstoned",
      archived: "archived",
    });

    expect(tombstoneReasonSchema.options).toEqual(["propagated-delete", "observed-delete"]);
    expect(TombstoneReason).toEqual({
      "propagated-delete": "propagated-delete",
      "observed-delete": "observed-delete",
    });

    // SD-3
    expect(syncFieldStateSideSchema.options).toEqual(["A", "B"]);
    expect(SyncFieldStateSide).toEqual({ A: "A", B: "B" });

    expect(syncFieldStateStatusSchema.options).toEqual(["active", "archived"]);
    expect(SyncFieldStateStatus).toEqual({ active: "active", archived: "archived" });
  });

  it("rejects values outside each enum", () => {
    // `direction` is deliberately not a value anywhere — a SyncRule has no direction field.
    expect(deletePropagationSchema.safeParse("delete").success).toBe(false);
    expect(targetDriftCheckSchema.safeParse("read").success).toBe(false);
    expect(backfillModeSchema.safeParse("push-all").success).toBe(false);
    expect(backfillStatusSchema.safeParse("done").success).toBe(false);
    expect(recordLinkEstablishedBySchema.safeParse("auto").success).toBe(false);
    // `deleted` is not a RecordLink status — a link is tombstoned, never deleted.
    expect(recordLinkStatusSchema.safeParse("deleted").success).toBe(false);
    expect(tombstoneReasonSchema.safeParse("manual-delete").success).toBe(false);
    expect(syncFieldStateSideSchema.safeParse("C").success).toBe(false);
    expect(syncFieldStateStatusSchema.safeParse("disabled").success).toBe(false);
  });
});
