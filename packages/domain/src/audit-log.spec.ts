import { describe, expect, it } from "vitest";

import {
  auditLogEntrySchema,
  auditLogStatusSchema,
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

describe("AuditLogStatus", () => {
  it("is the five-value sync-execution outcome vocabulary (SD-4 crit 1)", () => {
    expect([...auditLogStatusSchema.options].sort()).toStrictEqual([
      "conflict",
      "failure",
      "skipped-loop",
      "skipped-policy",
      "success",
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

describe("AuditLogEntry schema — SD-4 sync-execution row", () => {
  /** A per-record sync-execution row carrying its full SD-4 context. */
  function syncExecutionEntry(): AuditLogEntry {
    return {
      id: "audit-4",
      type: "sync-execution",
      actor: "sync-engine",
      status: "success",
      relatedRuleId: "sr-1",
      relatedMappingId: "am-1",
      recordLinkId: "rl-1",
      sourceNativeId: "123",
      originAppId: "app-a",
      idempotencyKey: "idem-abc",
      payloadHash: "hash-xyz",
      traceId: "trace-1",
      spanId: "span-1",
      timestamp: new Date("2026-07-11T00:00:00.000Z"),
    };
  }

  it("accepts a fully-populated success sync-execution row", () => {
    expect(auditLogEntrySchema.safeParse(syncExecutionEntry()).success).toBe(true);
  });

  it("is written once per processed change whatever the outcome (SD-4 crit 3)", () => {
    for (const status of ["success", "failure", "skipped-loop", "skipped-policy", "conflict"]) {
      const result = auditLogEntrySchema.safeParse({ ...syncExecutionEntry(), status });
      expect(result.success, status).toBe(true);
    }
  });

  it("represents a skipped-policy ignored-deletion cause (SD-4 crit 4)", () => {
    // The four skipped-policy causes are distinguished by per-record context +
    // details, not a dedicated sub-enum: here, a deletion under deletePropagation = ignore.
    const result = auditLogEntrySchema.safeParse({
      ...syncExecutionEntry(),
      status: "skipped-policy",
      details: "deletion ignored (deletePropagation = ignore)",
    });
    expect(result.success).toBe(true);
  });

  it("represents a skipped-policy counterpart-deleted cause (SD-4 crit 4)", () => {
    const result = auditLogEntrySchema.safeParse({
      ...syncExecutionEntry(),
      status: "skipped-policy",
      details: "record link tombstoned observed-delete (counterpart deleted)",
    });
    expect(result.success).toBe(true);
  });

  it("rejects an unknown status", () => {
    expect(
      auditLogEntrySchema.safeParse({ ...syncExecutionEntry(), status: "skipped" }).success,
    ).toBe(false);
  });
});

describe("AuditLogEntry schema — mapping-decision leaves status unset (SD-4 crit 1)", () => {
  it("still accepts the Phase-3 minimal mapping-decision row (no status)", () => {
    // The backward-compat guarantee: an existing mapping-decision entry, which
    // sets none of the SD-4 fields, validates unchanged against the extended shape.
    expect(auditLogEntrySchema.safeParse(mappingDecisionEntry()).success).toBe(true);
  });

  it("rejects a mapping-decision row carrying an execution status", () => {
    const result = auditLogEntrySchema.safeParse({ ...mappingDecisionEntry(), status: "success" });
    expect(result.success).toBe(false);
  });
});

describe("AuditLogEntry schema — credential-access row (CD-3)", () => {
  it("accepts a credential-access row referencing relatedCredentialId + app + trace", () => {
    const result = auditLogEntrySchema.safeParse({
      id: "audit-cred-1",
      type: "credential-access",
      actor: "system",
      relatedCredentialId: "cred-1",
      originAppId: "app-a",
      details: "credential accessed",
      traceId: "trace-1",
      spanId: "span-1",
      timestamp: new Date("2026-07-11T00:00:00.000Z"),
    });
    expect(result.success).toBe(true);
  });

  it("accepts the no-credential row (distinguishable: no relatedCredentialId)", () => {
    // CD-3 crit 3: a public app's call is auditable as "no credential used".
    const result = auditLogEntrySchema.safeParse({
      id: "audit-cred-2",
      type: "credential-access",
      actor: "system",
      originAppId: "public-app",
      details: "no credential used",
      timestamp: new Date("2026-07-11T00:00:00.000Z"),
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).not.toHaveProperty("relatedCredentialId");
    }
  });
});

describe("AuditLogEntry schema — adapter-request row (AD-5)", () => {
  function adapterRequestEntry(): AuditLogEntry {
    return {
      id: "audit-adapter-1",
      type: "adapter-request",
      actor: "adapter-runtime",
      status: "success",
      relatedEndpointId: "ae-1",
      relatedBindingId: "ab-1",
      idempotencyKey: "idem-abc",
      payloadHash: "hash-xyz",
      traceId: "trace-1",
      spanId: "span-1",
      timestamp: new Date("2026-07-20T00:00:00.000Z"),
    };
  }

  it("accepts a clean-success adapter-request row (AD-5.1, AD-5.5)", () => {
    const parsed = auditLogEntrySchema.parse(adapterRequestEntry());
    // A clean success carries no cause and is not degraded.
    expect(parsed).not.toHaveProperty("cause");
    expect(parsed).not.toHaveProperty("degraded");
  });

  it("reuses the Phase-4 status enum, inventing no adapter status value (AD-5.5)", () => {
    expect(
      auditLogEntrySchema.safeParse({ ...adapterRequestEntry(), status: "failure" }).success,
    ).toBe(true);
    expect(
      auditLogEntrySchema.safeParse({ ...adapterRequestEntry(), status: "not-yet-mapped" }).success,
    ).toBe(false);
  });

  it("records each of the six named causes plus a generic upstream error, distinguishably (AD-5.2)", () => {
    for (const cause of [
      "not-yet-mapped",
      "endpoint-disabled",
      "mapping-stale",
      "mapping-suspended",
      "backend-disabled",
      "mediator-transform-error",
      "upstream-error",
    ]) {
      const result = auditLogEntrySchema.safeParse({
        ...adapterRequestEntry(),
        status: "failure",
        cause,
      });
      expect(result.success, cause).toBe(true);
    }
  });

  it("rejects a cause outside the named set", () => {
    expect(
      auditLogEntrySchema.safeParse({
        ...adapterRequestEntry(),
        status: "failure",
        cause: "timeout",
      }).success,
    ).toBe(false);
  });

  it("represents a degraded response, distinct from a clean success and a failure (AD-5.3)", () => {
    const degraded = auditLogEntrySchema.parse({
      ...adapterRequestEntry(),
      status: "success",
      degraded: true,
    });
    expect(degraded.status).toBe("success");
    expect(degraded.degraded).toBe(true);
    // A clean success is status=success with no degraded flag; a failure is
    // status=failure — all three are mutually distinguishable.
    const clean = auditLogEntrySchema.parse(adapterRequestEntry());
    expect(clean).not.toHaveProperty("degraded");
  });

  it("forbids cause/degraded on a non-adapter row (AD-5.2/AD-5.3)", () => {
    expect(
      auditLogEntrySchema.safeParse({
        id: "audit-x",
        type: "sync-execution",
        actor: "sync-engine",
        status: "failure",
        cause: "upstream-error",
        timestamp: new Date("2026-07-20T00:00:00.000Z"),
      }).success,
    ).toBe(false);
    expect(
      auditLogEntrySchema.safeParse({
        id: "audit-y",
        type: "sync-execution",
        actor: "sync-engine",
        status: "success",
        degraded: true,
        timestamp: new Date("2026-07-20T00:00:00.000Z"),
      }).success,
    ).toBe(false);
  });
});
