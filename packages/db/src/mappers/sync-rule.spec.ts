import type { SyncRule } from "@mediator/domain";
import { describe, expect, it } from "vitest";

import { mapSyncRuleRow, toSyncRuleInsert, type SyncRuleRow } from "./sync-rule.js";

/**
 * The `sync_rule` mapper must stay backward-compatible with the Phase-3 AI-1
 * minimal-row instantiation (only the four AM-6 columns; every SD-1 execution column
 * NULL): a NULL execution column collapses to an **absent** domain key, so a disabled
 * rule reads back as exactly the four fields (SD-1 `.optional()` discipline). A rule
 * carrying execution state round-trips faithfully.
 */

const MINIMAL_ROW: SyncRuleRow = {
  id: "rule-1",
  approvedMappingId: "mapping-1",
  resourcePairRef: "pair::customers",
  status: "disabled",
  pollIntervalOverride: null,
  pollOperationRef: null,
  deletePropagation: null,
  targetDriftCheck: null,
  backfillMode: null,
  backfillStatus: null,
  lastRunAt: null,
  lastEventAt: null,
  cursor: null,
  lastSnapshotRef: null,
};

describe("sync-rule mapper", () => {
  it("collapses every NULL execution column to an absent key (Phase-3 minimal row)", () => {
    const rule = mapSyncRuleRow(MINIMAL_ROW);
    expect(rule).toStrictEqual({
      id: "rule-1",
      approvedMappingId: "mapping-1",
      resourcePairRef: "pair::customers",
      status: "disabled",
    });
    // Absent, not present-undefined (exactOptionalPropertyTypes).
    expect(Object.keys(rule).sort()).toStrictEqual([
      "approvedMappingId",
      "id",
      "resourcePairRef",
      "status",
    ]);
  });

  it("round-trips a rule carrying full execution state", () => {
    const lastRunAt = new Date("2026-07-13T12:00:00.000Z");
    const row: SyncRuleRow = {
      ...MINIMAL_ROW,
      status: "enabled",
      pollIntervalOverride: 30_000,
      pollOperationRef: "op.customers.delta",
      deletePropagation: "propagate",
      targetDriftCheck: "read-before-write",
      backfillMode: "link-only",
      backfillStatus: "completed",
      lastRunAt,
      lastEventAt: null,
      cursor: "cursor-abc",
      lastSnapshotRef: "snap-1",
    };
    const rule = mapSyncRuleRow(row);
    expect(rule).toMatchObject({
      status: "enabled",
      pollIntervalOverride: 30_000,
      pollOperationRef: "op.customers.delta",
      deletePropagation: "propagate",
      targetDriftCheck: "read-before-write",
      backfillMode: "link-only",
      backfillStatus: "completed",
      lastRunAt,
      cursor: "cursor-abc",
      lastSnapshotRef: "snap-1",
    });
    // lastEventAt was NULL → absent.
    expect("lastEventAt" in rule).toBe(false);
  });

  it("toSyncRuleInsert writes an absent execution field as NULL (backward-compatible insert)", () => {
    const rule: SyncRule = {
      id: "rule-1",
      approvedMappingId: "mapping-1",
      resourcePairRef: "pair::customers",
      status: "disabled",
    };
    const insert = toSyncRuleInsert(rule);
    expect(insert).toMatchObject({
      id: "rule-1",
      status: "disabled",
      pollIntervalOverride: null,
      deletePropagation: null,
      backfillStatus: null,
      cursor: null,
      lastSnapshotRef: null,
    });
  });
});
