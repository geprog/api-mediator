import type { OutboxRecord } from "@mediator/db";
import { SPEC_INGESTED_EVENT_TYPE, type SpecIngested } from "@mediator/domain";
import { describe, expect, it } from "vitest";

import {
  createSpecIngested,
  flattenDeliveredEvent,
  parseSpecIngested,
  reconstructEvent,
  toOutboxInsert,
  type DeliveredEvent,
} from "./event.js";

const occurredAt = new Date("2026-07-10T00:00:00.000Z");

function specIngested(): SpecIngested {
  return {
    id: "evt-1",
    type: SPEC_INGESTED_EVENT_TYPE,
    occurredAt,
    apiSpecId: "spec-1",
    appId: "app-1",
    role: "PROVIDER",
  };
}

describe("toOutboxInsert", () => {
  it("splits the envelope into columns and keeps only type-specific fields in payload", () => {
    expect(toOutboxInsert(specIngested())).toStrictEqual({
      eventId: "evt-1",
      type: SPEC_INGESTED_EVENT_TYPE,
      occurredAt,
      payload: { apiSpecId: "spec-1", appId: "app-1", role: "PROVIDER" },
    });
  });

  it("never leaks envelope fields into the payload", () => {
    const { payload } = toOutboxInsert(specIngested());
    expect(payload).not.toHaveProperty("id");
    expect(payload).not.toHaveProperty("type");
    expect(payload).not.toHaveProperty("occurredAt");
  });
});

describe("reconstructEvent", () => {
  it("rebuilds a delivered event from a row, sourcing the envelope from columns", () => {
    const row: OutboxRecord = {
      id: "row-1",
      eventId: "evt-1",
      type: SPEC_INGESTED_EVENT_TYPE,
      payload: { apiSpecId: "spec-1", appId: "app-1", role: "PROVIDER" },
      occurredAt,
      publishedAt: null,
      attempts: 0,
      lastError: null,
      createdAt: occurredAt,
    };

    expect(reconstructEvent(row)).toStrictEqual({
      id: "evt-1",
      type: SPEC_INGESTED_EVENT_TYPE,
      occurredAt,
      payload: { apiSpecId: "spec-1", appId: "app-1", role: "PROVIDER" },
    });
  });
});

describe("flattenDeliveredEvent + parseSpecIngested", () => {
  const delivered: DeliveredEvent = {
    id: "evt-1",
    type: SPEC_INGESTED_EVENT_TYPE,
    occurredAt,
    payload: { apiSpecId: "spec-1", appId: "app-1", role: "PROVIDER" },
  };

  it("merges the column-sourced envelope back over the payload (Date preserved)", () => {
    expect(flattenDeliveredEvent(delivered)).toStrictEqual({
      id: "evt-1",
      type: SPEC_INGESTED_EVENT_TYPE,
      occurredAt,
      apiSpecId: "spec-1",
      appId: "app-1",
      role: "PROVIDER",
    });
  });

  it("recovers a fully-typed SpecIngested with occurredAt as a Date", () => {
    const parsed = parseSpecIngested(delivered);
    expect(parsed).toStrictEqual(specIngested());
    expect(parsed.occurredAt).toBeInstanceOf(Date);
  });

  it("round-trips emit → reconstruct → parse", () => {
    const original = specIngested();
    const insert = toOutboxInsert(original);
    const row: OutboxRecord = {
      id: "row-1",
      eventId: insert.eventId,
      type: insert.type,
      payload: insert.payload,
      occurredAt: insert.occurredAt,
      publishedAt: null,
      attempts: 0,
      lastError: null,
      createdAt: occurredAt,
    };
    expect(parseSpecIngested(reconstructEvent(row))).toStrictEqual(original);
  });

  it("throws when the delivered event is not a valid SpecIngested", () => {
    const bad: DeliveredEvent = {
      id: "evt-2",
      type: SPEC_INGESTED_EVENT_TYPE,
      occurredAt,
      payload: { appId: "app-1", role: "PROVIDER" }, // missing apiSpecId
    };
    expect(() => parseSpecIngested(bad)).toThrow();
  });
});

describe("createSpecIngested", () => {
  it("stamps a fresh event id + occurredAt and validates against the domain schema", () => {
    const event = createSpecIngested({ apiSpecId: "spec-9", appId: "app-9", role: "CONSUMER" });
    expect(event.type).toBe(SPEC_INGESTED_EVENT_TYPE);
    expect(event.apiSpecId).toBe("spec-9");
    expect(event.appId).toBe("app-9");
    expect(event.role).toBe("CONSUMER");
    expect(event.id).not.toBe("");
    expect(event.occurredAt).toBeInstanceOf(Date);
  });

  it("mints a distinct event id per call", () => {
    const a = createSpecIngested({ apiSpecId: "s", appId: "a", role: "PROVIDER" });
    const b = createSpecIngested({ apiSpecId: "s", appId: "a", role: "PROVIDER" });
    expect(a.id).not.toBe(b.id);
  });
});
