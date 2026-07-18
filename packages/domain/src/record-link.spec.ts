import { describe, expect, it } from "vitest";

import { type RecordLink, recordLinkSchema } from "./index.js";

/** An active link established by an identity-key match. */
function activeLink(): RecordLink {
  return {
    id: "rl-1",
    appAId: "app-a",
    appANativeId: "123",
    appBId: "app-b",
    appBNativeId: "cust_9f3",
    resourcePairRef: "lineage-a:customers|lineage-b:contacts",
    establishedBy: "identity-match",
    status: "active",
    establishingQueueKey: { kind: "identity-value", value: "jane@example.test" },
    createdAt: new Date("2026-07-11T00:00:00.000Z"),
    tombstonedAt: null,
  };
}

describe("RecordLink schema — core shape", () => {
  it("accepts an active identity-match link with an identity-value queue key", () => {
    expect(recordLinkSchema.safeParse(activeLink()).success).toBe(true);
  });

  it("accepts a create-propagation link", () => {
    const result = recordLinkSchema.safeParse({
      ...activeLink(),
      establishedBy: "create-propagation",
    });
    expect(result.success).toBe(true);
  });

  it("references its two apps by id only and carries no credential material", () => {
    const parsed = recordLinkSchema.parse(activeLink());
    expect(Object.keys(parsed).sort()).toEqual(
      [
        "id",
        "appAId",
        "appANativeId",
        "appBId",
        "appBNativeId",
        "resourcePairRef",
        "establishedBy",
        "status",
        "establishingQueueKey",
        "createdAt",
        "tombstonedAt",
      ].sort(),
    );
  });

  it("rejects an unknown status", () => {
    expect(recordLinkSchema.safeParse({ ...activeLink(), status: "deleted" }).success).toBe(false);
  });
});

describe("RecordLink schema — tombstoneReason conditionality (SD-2 crit 3)", () => {
  it("accepts a tombstoned link carrying a tombstoneReason", () => {
    const result = recordLinkSchema.safeParse({
      ...activeLink(),
      status: "tombstoned",
      tombstoneReason: "propagated-delete",
      tombstonedAt: new Date("2026-07-11T01:00:00.000Z"),
    });
    expect(result.success).toBe(true);
  });

  it("rejects a tombstoned link with no tombstoneReason", () => {
    const result = recordLinkSchema.safeParse({ ...activeLink(), status: "tombstoned" });
    expect(result.success).toBe(false);
  });

  it("rejects an active link carrying a tombstoneReason", () => {
    const result = recordLinkSchema.safeParse({
      ...activeLink(),
      tombstoneReason: "observed-delete",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an archived link carrying a tombstoneReason", () => {
    // `archived` is distinct from a tombstone — no reason belongs on it.
    const result = recordLinkSchema.safeParse({
      ...activeLink(),
      status: "archived",
      tombstoneReason: "observed-delete",
    });
    expect(result.success).toBe(false);
  });
});

describe("RecordLink schema — retained ordering-queue key (SD-2 crit 4)", () => {
  it("accepts a manual link recording the pair's identity-key value", () => {
    const result = recordLinkSchema.safeParse({
      ...activeLink(),
      establishedBy: "manual",
      establishingQueueKey: { kind: "identity-value", value: "SKU-42" },
    });
    expect(result.success).toBe(true);
  });

  it("accepts a manual link absent a confirmed identity key (both-native-id-queues marker)", () => {
    const result = recordLinkSchema.safeParse({
      ...activeLink(),
      establishedBy: "manual",
      establishingQueueKey: { kind: "both-native-id-queues" },
    });
    expect(result.success).toBe(true);
  });

  it("rejects the both-native-id-queues marker on a non-manual link", () => {
    // A create-propagation / identity-match link resolves the record by its
    // identity value and so retains that value, never the both-drain marker.
    const result = recordLinkSchema.safeParse({
      ...activeLink(),
      establishedBy: "identity-match",
      establishingQueueKey: { kind: "both-native-id-queues" },
    });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown establishingQueueKey kind", () => {
    const result = recordLinkSchema.safeParse({
      ...activeLink(),
      establishingQueueKey: { kind: "native-id", value: "123" },
    });
    expect(result.success).toBe(false);
  });

  it("rejects an identity-value queue key with no value", () => {
    const result = recordLinkSchema.safeParse({
      ...activeLink(),
      establishingQueueKey: { kind: "identity-value" },
    });
    expect(result.success).toBe(false);
  });
});

describe("RecordLink schema — scopeRef union (SS-10 crit 4)", () => {
  it("is absent on a non-scoped rule's link (absence is not undefined)", () => {
    const parsed = recordLinkSchema.parse(activeLink());
    expect(parsed.scopeRef).toBeUndefined();
    expect("scopeRef" in parsed).toBe(false);
  });

  it("round-trips the L3 scope-link kind (arbitrary value-spaces, a ScopeLink reference)", () => {
    const parsed = recordLinkSchema.parse({
      ...activeLink(),
      scopeRef: { kind: "scope-link", scopeLinkId: "sl-42" },
    });
    expect(parsed.scopeRef).toStrictEqual({ kind: "scope-link", scopeLinkId: "sl-42" });
  });

  it("round-trips the L2 resolved kind (frozen { parameterName → value } map)", () => {
    const parsed = recordLinkSchema.parse({
      ...activeLink(),
      scopeRef: { kind: "resolved", values: { owner: "alice", name: "phoenix" } },
    });
    expect(parsed.scopeRef).toStrictEqual({
      kind: "resolved",
      values: { owner: "alice", name: "phoenix" },
    });
  });

  it("rejects a scope-link scopeRef with an empty scopeLinkId", () => {
    const result = recordLinkSchema.safeParse({
      ...activeLink(),
      scopeRef: { kind: "scope-link", scopeLinkId: "" },
    });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown scopeRef kind", () => {
    const result = recordLinkSchema.safeParse({
      ...activeLink(),
      scopeRef: { kind: "captured", values: { owner: "alice" } },
    });
    expect(result.success).toBe(false);
  });
});
