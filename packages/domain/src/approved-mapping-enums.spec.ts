import { describe, expect, it } from "vitest";

import {
  AdapterBindingRole,
  adapterBindingRoleSchema,
  AdapterBindingStatus,
  adapterBindingStatusSchema,
  AdapterEndpointStatus,
  adapterEndpointStatusSchema,
  ApprovedMappingStatus,
  approvedMappingStatusSchema,
  ConflictPolicy,
  conflictPolicySchema,
  GraphEdgeType,
  graphEdgeTypeSchema,
  OperationAction,
  operationActionSchema,
  SyncRuleStatus,
  syncRuleStatusSchema,
} from "./index.js";

describe("Phase-3 approved-mapping enums", () => {
  it("expose glossary-verbatim literals as schema, union type, and const object", () => {
    // AM-1: `action` is the four-value CRUD vocabulary — no `list` member.
    expect(operationActionSchema.options).toEqual(["create", "read", "update", "delete"]);
    expect(OperationAction).toEqual({
      create: "create",
      read: "read",
      update: "update",
      delete: "delete",
    });

    // AM-1: the ApprovedMapping lifecycle status — every value the column can hold.
    expect(approvedMappingStatusSchema.options).toEqual([
      "active",
      "suspended",
      "stale",
      "superseded",
      "archived",
    ]);
    expect(ApprovedMappingStatus).toEqual({
      active: "active",
      suspended: "suspended",
      stale: "stale",
      superseded: "superseded",
      archived: "archived",
    });

    expect(conflictPolicySchema.options).toEqual(["manual-resolve"]);
    expect(ConflictPolicy).toEqual({ "manual-resolve": "manual-resolve" });

    // AM-6 artifact enums.
    expect(syncRuleStatusSchema.options).toEqual(["enabled", "disabled"]);
    expect(SyncRuleStatus).toEqual({ enabled: "enabled", disabled: "disabled" });

    expect(adapterEndpointStatusSchema.options).toEqual([
      "active",
      "composition-required",
      "disabled",
    ]);
    expect(AdapterEndpointStatus).toEqual({
      active: "active",
      "composition-required": "composition-required",
      disabled: "disabled",
    });

    expect(adapterBindingRoleSchema.options).toEqual(["primary", "fallback", "supplement"]);
    expect(AdapterBindingRole).toEqual({
      primary: "primary",
      fallback: "fallback",
      supplement: "supplement",
    });

    expect(adapterBindingStatusSchema.options).toEqual(["active", "proposed", "disabled"]);
    expect(AdapterBindingStatus).toEqual({
      active: "active",
      proposed: "proposed",
      disabled: "disabled",
    });

    expect(graphEdgeTypeSchema.options).toEqual(["sync", "adapter-dependency"]);
    expect(GraphEdgeType).toEqual({ sync: "sync", "adapter-dependency": "adapter-dependency" });
  });

  it("accepts valid values and rejects unknown ones", () => {
    expect(operationActionSchema.safeParse("read").success).toBe(true);
    // `list` is the plan's wording — the concept's four-value enum wins.
    expect(operationActionSchema.safeParse("list").success).toBe(false);

    expect(approvedMappingStatusSchema.safeParse("active").success).toBe(true);
    // The status enum has no "disabled"/"pending" value — non-execution lives on
    // the disabled downstream artifacts, not on the mapping status.
    expect(approvedMappingStatusSchema.safeParse("disabled").success).toBe(false);

    expect(adapterBindingStatusSchema.safeParse("proposed").success).toBe(true);
    expect(adapterBindingStatusSchema.safeParse("composition-required").success).toBe(false);

    expect(graphEdgeTypeSchema.safeParse("adapter-dependency").success).toBe(true);
    expect(graphEdgeTypeSchema.safeParse("dependency").success).toBe(false);
  });
});
