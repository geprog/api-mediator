import type { RegisteredApp } from "@mediator/domain";
import { describe, expect, it } from "vitest";

import {
  mapRegisteredAppRow,
  toRegisteredAppInsert,
  type RegisteredAppRow,
} from "./registered-app.js";

const capabilities = {
  supportsPolling: true,
  supportsDeltaQuery: false,
  supportsChangeTimestamps: true,
  defaultPollInterval: 60000,
};
const createdAt = new Date("2026-07-10T00:00:00.000Z");

const outboundLimits = {
  maxConcurrentRequests: 4,
  maxRequestsPerWindow: 20,
  rateWindowMs: 1000,
};

function baseRow(): RegisteredAppRow {
  return {
    id: "app-1",
    name: "Gitea",
    status: "active",
    baseUrl: "https://gitea.example.test",
    capabilities,
    outboundLimits,
    createdAt,
  };
}

describe("mapRegisteredAppRow", () => {
  it("maps a fully-populated row to a domain RegisteredApp", () => {
    expect(mapRegisteredAppRow(baseRow())).toStrictEqual({
      id: "app-1",
      name: "Gitea",
      status: "active",
      baseUrl: "https://gitea.example.test",
      capabilities,
      outboundLimits,
      createdAt,
    });
  });

  it("drops a NULL base_url to an ABSENT baseUrl key (not baseUrl: undefined)", () => {
    const result = mapRegisteredAppRow({ ...baseRow(), baseUrl: null });

    expect("baseUrl" in result).toBe(false);
    expect(Object.keys(result).sort()).toStrictEqual([
      "capabilities",
      "createdAt",
      "id",
      "name",
      "outboundLimits",
      "status",
    ]);
  });

  it("drops a NULL outbound_limits to an ABSENT outboundLimits key (OC-3 defaults apply)", () => {
    const result = mapRegisteredAppRow({ ...baseRow(), outboundLimits: null });

    expect("outboundLimits" in result).toBe(false);
    expect(Object.keys(result).sort()).toStrictEqual([
      "baseUrl",
      "capabilities",
      "createdAt",
      "id",
      "name",
      "status",
    ]);
  });
});

describe("toRegisteredAppInsert", () => {
  it("writes an absent baseUrl as SQL NULL", () => {
    const app: RegisteredApp = {
      id: "app-2",
      name: "Consumer",
      status: "active",
      capabilities,
      createdAt,
    };

    expect(toRegisteredAppInsert(app)).toStrictEqual({
      id: "app-2",
      name: "Consumer",
      status: "active",
      baseUrl: null,
      capabilities,
      outboundLimits: null,
      createdAt,
    });
  });

  it("passes a present baseUrl through unchanged", () => {
    expect(toRegisteredAppInsert(mapRegisteredAppRow(baseRow())).baseUrl).toBe(
      "https://gitea.example.test",
    );
  });
});
