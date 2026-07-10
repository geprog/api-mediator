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

function baseRow(): RegisteredAppRow {
  return {
    id: "app-1",
    name: "Gitea",
    status: "active",
    baseUrl: "https://gitea.example.test",
    capabilities,
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
      createdAt,
    });
  });

  it("passes a present baseUrl through unchanged", () => {
    expect(toRegisteredAppInsert(mapRegisteredAppRow(baseRow())).baseUrl).toBe(
      "https://gitea.example.test",
    );
  });
});
