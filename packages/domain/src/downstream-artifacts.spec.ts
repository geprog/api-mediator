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

  it("accepts a disabled rule with only the AM-6 fields", () => {
    const parsed = syncRuleSchema.parse(disabledRule());
    expect(Object.keys(parsed).sort()).toEqual(
      ["approvedMappingId", "id", "resourcePairRef", "status"].sort(),
    );
  });

  it("rejects an unknown status", () => {
    expect(syncRuleSchema.safeParse({ ...disabledRule(), status: "active" }).success).toBe(false);
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
