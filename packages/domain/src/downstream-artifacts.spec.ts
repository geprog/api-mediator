import { describe, expect, it } from "vitest";

import {
  type AdapterBinding,
  adapterBindingSchema,
  type AdapterEndpoint,
  adapterEndpointSchema,
  type GraphEdge,
  graphEdgeSchema,
  type SyncRule,
  syncRuleSchema,
} from "./index.js";

describe("SyncRule schema (peer-peer outcome)", () => {
  function disabledRule(): SyncRule {
    return {
      id: "sr-1",
      approvedMappingId: "am-1",
      resourcePairRef: "lineage-a:issues|lineage-b:tasks",
      status: "disabled",
    };
  }

  it("accepts a disabled rule with only the AM-6 fields (SD-1 backward compat)", () => {
    // The Phase-3 minimal shape — the exact object AI-1 instantiates and the db
    // mapper reconstructs — still validates against the SD-1-extended schema, and
    // the extended fields stay *absent* (no defaults forced onto the type).
    const parsed = syncRuleSchema.parse(disabledRule());
    expect(Object.keys(parsed).sort()).toEqual(
      ["approvedMappingId", "id", "resourcePairRef", "status"].sort(),
    );
  });

  it("rejects an unknown status", () => {
    expect(syncRuleSchema.safeParse({ ...disabledRule(), status: "active" }).success).toBe(false);
  });

  it("accepts an enabled rule carrying its full SD-1 execution/policy state", () => {
    const result = syncRuleSchema.safeParse({
      ...disabledRule(),
      status: "enabled",
      pollIntervalOverride: 300,
      pollOperationRef: "issues#list",
      deletePropagation: "propagate",
      targetDriftCheck: "read-before-write",
      backfillMode: "link-only",
      backfillStatus: "completed",
      lastRunAt: new Date("2026-07-11T00:00:00.000Z"),
      lastEventAt: new Date("2026-07-11T00:05:00.000Z"),
      cursor: "cursor-42",
      lastSnapshotRef: "snap-1",
    });
    expect(result.success).toBe(true);
  });

  it("accepts explicit-null live-state fields (unset at go-live)", () => {
    const result = syncRuleSchema.safeParse({
      ...disabledRule(),
      status: "enabled",
      backfillStatus: "running",
      lastRunAt: null,
      lastEventAt: null,
      cursor: null,
      lastSnapshotRef: null,
    });
    expect(result.success).toBe(true);
  });

  it("rejects an unknown deletePropagation / backfillStatus value", () => {
    expect(
      syncRuleSchema.safeParse({ ...disabledRule(), deletePropagation: "delete" }).success,
    ).toBe(false);
    expect(syncRuleSchema.safeParse({ ...disabledRule(), backfillStatus: "done" }).success).toBe(
      false,
    );
  });
});

describe("AdapterEndpoint schema (consumer-provider outcome)", () => {
  function endpoint(): AdapterEndpoint {
    return {
      id: "ae-1",
      consumerAppId: "app-consumer",
      consumerOperationId: "getCombinedProfile",
      status: "active",
    };
  }

  it("accepts an endpoint with only the AM-6 fields", () => {
    expect(adapterEndpointSchema.safeParse(endpoint()).success).toBe(true);
  });

  it("rejects an unknown status", () => {
    expect(adapterEndpointSchema.safeParse({ ...endpoint(), status: "proposed" }).success).toBe(
      false,
    );
  });
});

describe("AdapterBinding schema", () => {
  function proposedBinding(): AdapterBinding {
    return {
      id: "ab-1",
      adapterEndpointId: "ae-1",
      backendAppId: "app-backend",
      backendOperationId: "getUser",
      approvedMappingId: "am-2",
      role: "primary",
      status: "proposed",
    };
  }

  it("accepts a freshly-attached binding persisted proposed", () => {
    expect(adapterBindingSchema.safeParse(proposedBinding()).success).toBe(true);
  });

  it("rejects an unknown role", () => {
    expect(adapterBindingSchema.safeParse({ ...proposedBinding(), role: "backup" }).success).toBe(
      false,
    );
  });

  it("rejects an unknown status", () => {
    expect(
      adapterBindingSchema.safeParse({ ...proposedBinding(), status: "composition-required" })
        .success,
    ).toBe(false);
  });
});

describe("GraphEdge schema (materialized projection)", () => {
  function edge(): GraphEdge {
    return {
      id: "ge-1",
      sourceNodeId: "app-a",
      targetNodeId: "app-b",
      type: "sync",
      status: "disabled",
      metadata: {
        direction: { sourceSpecId: "spec-a", targetSpecId: "spec-b" },
        lastActivityAt: null,
      },
    };
  }

  it("accepts an edge upserted with a null lastActivityAt", () => {
    expect(graphEdgeSchema.safeParse(edge()).success).toBe(true);
  });

  it("accepts an edge with a lastActivityAt timestamp", () => {
    const result = graphEdgeSchema.safeParse({
      ...edge(),
      metadata: {
        direction: { sourceSpecId: "spec-a", targetSpecId: "spec-b" },
        lastActivityAt: new Date("2026-07-11T00:00:00.000Z"),
      },
    });
    expect(result.success).toBe(true);
  });

  it("accepts an adapter-dependency edge type", () => {
    expect(graphEdgeSchema.safeParse({ ...edge(), type: "adapter-dependency" }).success).toBe(true);
  });

  it("rejects an unknown type", () => {
    expect(graphEdgeSchema.safeParse({ ...edge(), type: "dependency" }).success).toBe(false);
  });

  it("rejects metadata missing its direction", () => {
    const result = graphEdgeSchema.safeParse({
      ...edge(),
      metadata: { lastActivityAt: null },
    });
    expect(result.success).toBe(false);
  });
});
