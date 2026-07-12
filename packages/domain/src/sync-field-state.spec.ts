import { describe, expect, it } from "vitest";

import { type SyncFieldState, syncFieldStateSchema } from "./index.js";

/** A reconciled (agreeing) baseline: last-synced hash + timestamp both present. */
function reconciledState(): SyncFieldState {
  return {
    id: "sfs-1",
    recordLinkId: "rl-1",
    side: "A",
    fieldPath: "customers/email",
    lastSyncedHash: "hash-reconciled",
    lastSyncedAt: new Date("2026-07-11T00:00:00.000Z"),
    observedHash: "hash-reconciled",
    observedAt: new Date("2026-07-11T00:00:00.000Z"),
    observedChangeTimestamp: new Date("2026-07-11T00:00:00.000Z"),
    lastWrittenByMappingId: "am-1",
    status: "active",
  };
}

/** A divergent seed: no reconciled baseline, but the side was observed. */
function divergentSeedState(): SyncFieldState {
  return {
    id: "sfs-2",
    recordLinkId: "rl-1",
    side: "B",
    fieldPath: "contacts/emailAddress",
    observedHash: "hash-b",
    observedAt: new Date("2026-07-11T00:00:00.000Z"),
    observedChangeTimestamp: null,
    status: "active",
  };
}

describe("SyncFieldState schema — core shape", () => {
  it("accepts a reconciled per-side baseline row", () => {
    expect(syncFieldStateSchema.safeParse(reconciledState()).success).toBe(true);
  });

  it("accepts a null observedChangeTimestamp (no supportsChangeTimestamps / unconfirmed ref)", () => {
    const result = syncFieldStateSchema.safeParse({
      ...reconciledState(),
      observedChangeTimestamp: null,
    });
    expect(result.success).toBe(true);
  });

  it("requires an observedHash (a row exists only once its side was observed)", () => {
    const withoutObserved = {
      id: "sfs-3",
      recordLinkId: "rl-1",
      side: "A",
      fieldPath: "customers/email",
      observedAt: new Date("2026-07-11T00:00:00.000Z"),
      observedChangeTimestamp: null,
      status: "active",
    };
    expect(syncFieldStateSchema.safeParse(withoutObserved).success).toBe(false);
  });

  it("rejects an unknown side", () => {
    expect(syncFieldStateSchema.safeParse({ ...reconciledState(), side: "C" }).success).toBe(false);
  });

  it("rejects an unknown status", () => {
    expect(
      syncFieldStateSchema.safeParse({ ...reconciledState(), status: "disabled" }).success,
    ).toBe(false);
  });

  it("accepts a row with no lastWrittenByMappingId (unwritten link-only seed)", () => {
    // A link-only backfill seeds baselines but writes nothing, so no direction has
    // written this side yet — the audit field is legitimately absent.
    const unwritten = divergentSeedState();
    expect(unwritten.lastWrittenByMappingId).toBeUndefined();
    expect(syncFieldStateSchema.safeParse(unwritten).success).toBe(true);
  });
});

describe("SyncFieldState schema — divergent-seed absent baseline (SD-3 crit 2)", () => {
  it("accepts a divergent seed with both lastSyncedHash and lastSyncedAt absent", () => {
    expect(syncFieldStateSchema.safeParse(divergentSeedState()).success).toBe(true);
  });

  it("rejects a row with lastSyncedHash but no lastSyncedAt", () => {
    const result = syncFieldStateSchema.safeParse({
      ...divergentSeedState(),
      lastSyncedHash: "hash-x",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a row with lastSyncedAt but no lastSyncedHash", () => {
    const result = syncFieldStateSchema.safeParse({
      ...divergentSeedState(),
      lastSyncedAt: new Date("2026-07-11T00:00:00.000Z"),
    });
    expect(result.success).toBe(false);
  });
});
