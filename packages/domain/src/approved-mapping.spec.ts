import { describe, expect, it } from "vitest";

import { type ApprovedMapping, approvedMappingSchema } from "./index.js";

/** A peer-peer approved mapping (both sides PROVIDER), no counterpart yet. */
function peerPeerMapping(): ApprovedMapping {
  return {
    id: "am-1",
    sourceSpecId: "spec-a",
    targetSpecId: "spec-b",
    sourceAppId: "app-a",
    targetAppId: "app-b",
    variant: "peer-peer",
    approvedBy: "user-1",
    approvedAt: new Date("2026-07-11T00:00:00.000Z"),
    status: "active",
  };
}

/** A consumer-provider approved mapping (consumer = source, provider = target). */
function consumerProviderMapping(): ApprovedMapping {
  return {
    id: "am-2",
    sourceSpecId: "spec-consumer",
    targetSpecId: "spec-backend",
    sourceAppId: "app-consumer",
    targetAppId: "app-backend",
    variant: "consumer-provider",
    approvedBy: "user-1",
    approvedAt: new Date("2026-07-11T00:00:00.000Z"),
    status: "active",
  };
}

describe("ApprovedMapping schema", () => {
  it("accepts a peer-peer mapping with no counterpartMappingId", () => {
    expect(approvedMappingSchema.safeParse(peerPeerMapping()).success).toBe(true);
  });

  it("accepts a peer-peer mapping with a string counterpartMappingId", () => {
    const result = approvedMappingSchema.safeParse({
      ...peerPeerMapping(),
      counterpartMappingId: "am-reverse",
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.counterpartMappingId).toBe("am-reverse");
  });

  it("accepts a peer-peer mapping with an explicit null counterpartMappingId", () => {
    // Optional + nullable: absent, null, and a string are all valid on peer-peer.
    const result = approvedMappingSchema.safeParse({
      ...peerPeerMapping(),
      counterpartMappingId: null,
    });
    expect(result.success).toBe(true);
  });

  it("accepts a consumer-provider mapping with no counterpartMappingId", () => {
    expect(approvedMappingSchema.safeParse(consumerProviderMapping()).success).toBe(true);
  });

  it("rejects a counterpartMappingId (string) on a consumer-provider mapping", () => {
    // No reverse direction exists — the mediator never calls the consumer.
    const result = approvedMappingSchema.safeParse({
      ...consumerProviderMapping(),
      counterpartMappingId: "am-reverse",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an explicit null counterpartMappingId on a consumer-provider mapping", () => {
    // Peer-peer only means *absent*, not merely non-string.
    const result = approvedMappingSchema.safeParse({
      ...consumerProviderMapping(),
      counterpartMappingId: null,
    });
    expect(result.success).toBe(false);
  });

  it("carries no direction field — it is stripped by the schema", () => {
    const parsed = approvedMappingSchema.parse({
      ...peerPeerMapping(),
      direction: "forward",
    });
    expect("direction" in parsed).toBe(false);
  });

  it("references the two specs by id and carries no credential-bearing field", () => {
    const parsed = approvedMappingSchema.parse(peerPeerMapping());
    expect(Object.keys(parsed).sort()).toEqual(
      [
        "approvedAt",
        "approvedBy",
        "id",
        "sourceAppId",
        "sourceSpecId",
        "status",
        "targetAppId",
        "targetSpecId",
        "variant",
      ].sort(),
    );
  });

  it("rejects an invalid variant", () => {
    const result = approvedMappingSchema.safeParse({ ...peerPeerMapping(), variant: "peer_peer" });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown status", () => {
    const result = approvedMappingSchema.safeParse({ ...peerPeerMapping(), status: "disabled" });
    expect(result.success).toBe(false);
  });
});
