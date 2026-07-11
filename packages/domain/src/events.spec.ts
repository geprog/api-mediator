import { describe, expect, it } from "vitest";

import {
  domainEventEnvelopeSchema,
  MAPPING_APPROVED_EVENT_TYPE,
  type MappingApproved,
  mappingApprovedSchema,
  SPEC_INGESTED_EVENT_TYPE,
  type SpecIngested,
  specIngestedSchema,
} from "./index.js";

function baseEvent(): SpecIngested {
  return {
    id: "evt-1",
    type: SPEC_INGESTED_EVENT_TYPE,
    occurredAt: new Date("2026-07-10T00:00:00.000Z"),
    apiSpecId: "spec-1",
    appId: "app-1",
    role: "PROVIDER",
  };
}

describe("SpecIngested event", () => {
  it("uses the glossary-verbatim discriminant value", () => {
    expect(SPEC_INGESTED_EVENT_TYPE).toBe("SpecIngested");
  });

  it("accepts a valid event and fits the base envelope", () => {
    expect(specIngestedSchema.safeParse(baseEvent()).success).toBe(true);
    // A SpecIngested is a DomainEventEnvelope with a payload.
    expect(domainEventEnvelopeSchema.safeParse(baseEvent()).success).toBe(true);
  });

  it("carries only identifiers and role — no credential-bearing fields", () => {
    const parsed = specIngestedSchema.parse(baseEvent());
    expect(Object.keys(parsed).sort()).toEqual(
      ["apiSpecId", "appId", "id", "occurredAt", "role", "type"].sort(),
    );
  });

  it("rejects a wrong type discriminant", () => {
    expect(specIngestedSchema.safeParse({ ...baseEvent(), type: "MappingApproved" }).success).toBe(
      false,
    );
  });

  it("rejects an invalid role", () => {
    expect(specIngestedSchema.safeParse({ ...baseEvent(), role: "PEER" }).success).toBe(false);
  });

  it("rejects a missing apiSpecId", () => {
    const withoutSpecId: Partial<SpecIngested> = { ...baseEvent() };
    delete withoutSpecId.apiSpecId;
    expect(specIngestedSchema.safeParse(withoutSpecId).success).toBe(false);
  });
});

function approvedEvent(): MappingApproved {
  return {
    id: "evt-2",
    type: MAPPING_APPROVED_EVENT_TYPE,
    occurredAt: new Date("2026-07-11T00:00:00.000Z"),
    approvedMappingId: "am-1",
    variant: "peer-peer",
  };
}

describe("MappingApproved event", () => {
  it("uses the glossary-verbatim discriminant value", () => {
    expect(MAPPING_APPROVED_EVENT_TYPE).toBe("MappingApproved");
  });

  it("accepts a valid event and fits the base envelope", () => {
    expect(mappingApprovedSchema.safeParse(approvedEvent()).success).toBe(true);
    expect(domainEventEnvelopeSchema.safeParse(approvedEvent()).success).toBe(true);
  });

  it("carries only the mapping id and variant — no credential-bearing fields", () => {
    const parsed = mappingApprovedSchema.parse(approvedEvent());
    expect(Object.keys(parsed).sort()).toEqual(
      ["approvedMappingId", "id", "occurredAt", "type", "variant"].sort(),
    );
  });

  it("has an identical shape for a first and an incremental approval", () => {
    // A consumer-provider incremental approval carries the same keys as a first
    // peer-peer approval — the consumer's idempotent upsert absorbs the difference.
    const first = mappingApprovedSchema.parse(approvedEvent());
    const incremental = mappingApprovedSchema.parse({
      ...approvedEvent(),
      variant: "consumer-provider",
    });
    expect(Object.keys(incremental).sort()).toEqual(Object.keys(first).sort());
  });

  it("rejects a wrong type discriminant", () => {
    expect(
      mappingApprovedSchema.safeParse({ ...approvedEvent(), type: "SpecIngested" }).success,
    ).toBe(false);
  });

  it("rejects an invalid variant", () => {
    expect(
      mappingApprovedSchema.safeParse({ ...approvedEvent(), variant: "peer_peer" }).success,
    ).toBe(false);
  });

  it("rejects a missing approvedMappingId", () => {
    const withoutId: Partial<MappingApproved> = { ...approvedEvent() };
    delete withoutId.approvedMappingId;
    expect(mappingApprovedSchema.safeParse(withoutId).success).toBe(false);
  });
});
