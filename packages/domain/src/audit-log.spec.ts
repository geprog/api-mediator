import { describe, expect, it } from "vitest";

import {
  auditLogEntrySchema,
  auditLogTypeSchema,
  mappingDecisionSchema,
  type AuditLogEntry,
} from "./index.js";

function mappingDecisionEntry(): AuditLogEntry {
  return {
    id: "audit-1",
    type: "mapping-decision",
    actor: "operator@example.test",
    decision: "accept",
    relatedProposalId: "prop-1",
    relatedItemId: "item-1",
    timestamp: new Date("2026-07-11T00:00:00.000Z"),
  };
}

describe("AuditLogType", () => {
  it("owns the full data-model vocabulary", () => {
    expect([...auditLogTypeSchema.options].sort()).toStrictEqual([
      "adapter-request",
      "backfill-run",
      "credential-access",
      "mapping-decision",
      "poll-run",
      "sync-execution",
    ]);
  });
});

describe("MappingDecision", () => {
  it("is the four-value per-item + approve action vocabulary", () => {
    expect([...mappingDecisionSchema.options].sort()).toStrictEqual([
      "accept",
      "approve",
      "edit",
      "reject",
    ]);
  });
});

describe("AuditLogEntry schema", () => {
  it("accepts a per-item mapping-decision entry", () => {
    expect(auditLogEntrySchema.safeParse(mappingDecisionEntry()).success).toBe(true);
  });

  it("accepts an approve-action entry referencing the resulting mapping", () => {
    const result = auditLogEntrySchema.safeParse({
      id: "audit-2",
      type: "mapping-decision",
      actor: "operator@example.test",
      decision: "approve",
      relatedProposalId: "prop-1",
      relatedMappingId: "am-1",
      details: "approved",
      timestamp: new Date("2026-07-11T00:00:00.000Z"),
    });
    expect(result.success).toBe(true);
  });

  it("accepts a non-mapping-decision entry with no decision", () => {
    const result = auditLogEntrySchema.safeParse({
      id: "audit-3",
      type: "credential-access",
      actor: "sync-engine",
      timestamp: new Date("2026-07-11T00:00:00.000Z"),
    });
    expect(result.success).toBe(true);
  });

  it("rejects an unknown decision", () => {
    const result = auditLogEntrySchema.safeParse({ ...mappingDecisionEntry(), decision: "revoke" });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown type", () => {
    const result = auditLogEntrySchema.safeParse({ ...mappingDecisionEntry(), type: "login" });
    expect(result.success).toBe(false);
  });
});
