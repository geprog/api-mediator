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

  it("accepts an endpoint with only the AM-6 fields, every AD-1 field absent (AD-1.6)", () => {
    // A Phase-3-instantiated composition-required endpoint carries no serving
    // configuration; the AD-1 fields must not be forced present by any default.
    const parsed = adapterEndpointSchema.parse({ ...endpoint(), status: "composition-required" });
    expect(Object.keys(parsed).sort()).toEqual(
      ["consumerAppId", "consumerOperationId", "id", "status"].sort(),
    );
  });

  it("rejects an unknown status", () => {
    expect(adapterEndpointSchema.safeParse({ ...endpoint(), status: "proposed" }).success).toBe(
      false,
    );
  });

  it("accepts an auto-activated single-binding endpoint (AD-1.1/AD-1.2)", () => {
    const result = adapterEndpointSchema.safeParse({
      ...endpoint(),
      aggregationStrategy: "single",
      strictness: "degraded",
    });
    expect(result.success).toBe(true);
  });

  it("accepts every named aggregationStrategy and rejects a list-style invention (AD-1.2)", () => {
    for (const aggregationStrategy of [
      "single",
      "fanout-merge",
      "collection-union",
      "fanout-first-success",
    ]) {
      expect(
        adapterEndpointSchema.safeParse({ ...endpoint(), aggregationStrategy }).success,
        aggregationStrategy,
      ).toBe(true);
    }
    expect(
      adapterEndpointSchema.safeParse({ ...endpoint(), aggregationStrategy: "list" }).success,
    ).toBe(false);
  });

  it("accepts a positive cacheTtl and rejects a non-positive one (AD-1.1)", () => {
    expect(
      adapterEndpointSchema.safeParse({
        ...endpoint(),
        aggregationStrategy: "single",
        cacheTtl: 30_000,
      }).success,
    ).toBe(true);
    expect(adapterEndpointSchema.safeParse({ ...endpoint(), cacheTtl: 0 }).success).toBe(false);
    expect(adapterEndpointSchema.safeParse({ ...endpoint(), cacheTtl: -1 }).success).toBe(false);
  });

  it("accepts a fully-configured collection-union endpoint (AD-1.3/AD-1.4)", () => {
    const result = adapterEndpointSchema.safeParse({
      ...endpoint(),
      aggregationStrategy: "collection-union",
      strictness: "strict",
      postMergeFilters: [
        { consumerParamRef: "status", consumerFieldPath: "state", operator: "eq" },
      ],
      postMergeSorts: [
        {
          consumerParamRef: "sort",
          paramValue: "name",
          consumerFieldPath: "name",
          direction: "asc",
        },
        {
          consumerParamRef: "sort",
          paramValue: "date",
          consumerFieldPath: "createdAt",
          direction: "desc",
        },
      ],
      postMergePagination: {
        convention: {
          convention: "page-number",
          pageParamRef: "page",
          sizeParamRef: "perPage",
          firstPageNumber: 1,
        },
        confirmedBy: "operator@example.test",
        confirmedAt: new Date("2026-07-20T00:00:00.000Z"),
      },
      postMergeDedup: { mode: "dedup-key", dedupKeyFieldPath: "email" },
    });
    expect(result.success).toBe(true);
  });

  it("makes postMerge* fields unrepresentable on a non-union endpoint (AD-1.3)", () => {
    for (const strategy of ["single", "fanout-merge", "fanout-first-success"]) {
      const result = adapterEndpointSchema.safeParse({
        ...endpoint(),
        aggregationStrategy: strategy,
        postMergeFilters: [
          { consumerParamRef: "q", consumerFieldPath: "name", operator: "contains" },
        ],
      });
      expect(result.success, strategy).toBe(false);
    }
  });

  it("makes union config unrepresentable on a not-yet-composed endpoint (AD-1.6)", () => {
    // Union configuration without a strategy is not a state the composer produces.
    const result = adapterEndpointSchema.safeParse({
      ...endpoint(),
      status: "composition-required",
      postMergeDedup: { mode: "none" },
    });
    expect(result.success).toBe(false);
  });

  it("distinguishes an absent postMergeDedup from an explicit mode: none (AD-1.4)", () => {
    const none = adapterEndpointSchema.parse({
      ...endpoint(),
      aggregationStrategy: "collection-union",
      postMergeDedup: { mode: "none" },
    });
    expect(none.postMergeDedup).toEqual({ mode: "none" });

    const uncomposed = adapterEndpointSchema.parse({
      ...endpoint(),
      aggregationStrategy: "collection-union",
    });
    expect(uncomposed).not.toHaveProperty("postMergeDedup");
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

  it("accepts a freshly-attached binding persisted proposed, every AD-2 field absent (AD-2.5)", () => {
    const parsed = adapterBindingSchema.parse(proposedBinding());
    expect(parsed).not.toHaveProperty("executionOrder");
    expect(parsed).not.toHaveProperty("dependsOnBindingId");
    expect(parsed).not.toHaveProperty("chainInputs");
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

  it("accepts a composed chained binding (AD-2.1/AD-2.2)", () => {
    const result = adapterBindingSchema.safeParse({
      ...proposedBinding(),
      status: "active",
      role: "supplement",
      executionOrder: 1,
      dependsOnBindingId: "ab-primary",
      chainInputs: [
        { upstreamFieldPath: "id", targetParamRef: "userId" },
        {
          upstreamFieldPath: "accountRef",
          targetParamRef: "account",
          transform: "rename",
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("forbids non-empty chainInputs without dependsOnBindingId (AD-2.3)", () => {
    const result = adapterBindingSchema.safeParse({
      ...proposedBinding(),
      chainInputs: [{ upstreamFieldPath: "id", targetParamRef: "userId" }],
    });
    expect(result.success).toBe(false);
  });

  it("allows an empty chainInputs without dependsOnBindingId (nothing to wire)", () => {
    const result = adapterBindingSchema.safeParse({ ...proposedBinding(), chainInputs: [] });
    expect(result.success).toBe(true);
  });

  it("rejects a binding depending on itself (AD-2.1: another binding)", () => {
    const result = adapterBindingSchema.safeParse({
      ...proposedBinding(),
      dependsOnBindingId: proposedBinding().id,
    });
    expect(result.success).toBe(false);
  });

  it("accepts executionOrder 0 explicitly (its documented default)", () => {
    expect(
      adapterBindingSchema.safeParse({ ...proposedBinding(), executionOrder: 0 }).success,
    ).toBe(true);
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
