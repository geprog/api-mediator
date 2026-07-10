import { describe, expect, it } from "vitest";

import {
  domainEventEnvelopeSchema,
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
