import { describe, expect, it } from "vitest";

import {
  mapEventOutboxRow,
  toEventOutboxInsert,
  type EventOutboxRow,
  type OutboxInsert,
} from "./event-outbox.js";

describe("event_outbox mappers", () => {
  const occurredAt = new Date("2026-07-10T00:00:00.000Z");
  const createdAt = new Date("2026-07-10T00:00:01.000Z");

  it("maps a stored row to a dispatcher record, keeping Date columns as Dates", () => {
    const row: EventOutboxRow = {
      id: "row-1",
      eventId: "evt-1",
      type: "SpecIngested",
      payload: { apiSpecId: "spec-1", appId: "app-1", role: "PROVIDER" },
      occurredAt,
      publishedAt: null,
      attempts: 0,
      lastError: null,
      createdAt,
    };

    expect(mapEventOutboxRow(row)).toStrictEqual({
      id: "row-1",
      eventId: "evt-1",
      type: "SpecIngested",
      payload: { apiSpecId: "spec-1", appId: "app-1", role: "PROVIDER" },
      occurredAt,
      publishedAt: null,
      attempts: 0,
      lastError: null,
      createdAt,
    });
  });

  it("carries published/error state through when set", () => {
    const publishedAt = new Date("2026-07-10T00:00:02.000Z");
    const row: EventOutboxRow = {
      id: "row-2",
      eventId: "evt-2",
      type: "SpecIngested",
      payload: {},
      occurredAt,
      publishedAt,
      attempts: 3,
      lastError: "boom",
      createdAt,
    };

    const record = mapEventOutboxRow(row);
    expect(record.publishedAt).toBe(publishedAt);
    expect(record.attempts).toBe(3);
    expect(record.lastError).toBe("boom");
  });

  it("projects an insert to only the producer-supplied columns", () => {
    const insert: OutboxInsert = {
      eventId: "evt-3",
      type: "SpecIngested",
      payload: { apiSpecId: "spec-3" },
      occurredAt,
    };

    expect(toEventOutboxInsert(insert)).toStrictEqual({
      eventId: "evt-3",
      type: "SpecIngested",
      payload: { apiSpecId: "spec-3" },
      occurredAt,
    });
  });
});
