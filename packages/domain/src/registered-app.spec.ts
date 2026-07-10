import { describe, expect, it } from "vitest";

import { type AppCapabilities, type RegisteredApp, registeredAppSchema } from "./index.js";

function baseApp(): RegisteredApp {
  return {
    id: "app-1",
    name: "Gitea",
    status: "active",
    baseUrl: "https://gitea.example.test",
    capabilities: {
      supportsPolling: true,
      supportsDeltaQuery: false,
      supportsChangeTimestamps: true,
      defaultPollInterval: 60000,
    },
    createdAt: new Date("2026-07-10T00:00:00.000Z"),
  };
}

describe("RegisteredApp schema", () => {
  it("accepts a fully-populated app", () => {
    expect(registeredAppSchema.safeParse(baseApp()).success).toBe(true);
  });

  it("accepts a consumer-only app with baseUrl absent, keeping the key omitted", () => {
    const consumerOnly: Partial<RegisteredApp> = { ...baseApp() };
    delete consumerOnly.baseUrl;
    const parsed = registeredAppSchema.parse(consumerOnly);
    expect(parsed.status).toBe("active");
    // Absence stays distinct from an explicit `undefined`: the key is not present.
    expect("baseUrl" in parsed).toBe(false);
  });

  it("rejects an unknown status", () => {
    const result = registeredAppSchema.safeParse({ ...baseApp(), status: "enabled" });
    expect(result.success).toBe(false);
  });

  it("rejects a missing name", () => {
    const withoutName: Partial<RegisteredApp> = { ...baseApp() };
    delete withoutName.name;
    expect(registeredAppSchema.safeParse(withoutName).success).toBe(false);
  });

  it("rejects a createdAt that is a string rather than a Date", () => {
    const result = registeredAppSchema.safeParse({
      ...baseApp(),
      createdAt: "2026-07-10T00:00:00.000Z",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a non-integer or non-positive defaultPollInterval", () => {
    const app = baseApp();
    expect(
      registeredAppSchema.safeParse({
        ...app,
        capabilities: { ...app.capabilities, defaultPollInterval: 0 },
      }).success,
    ).toBe(false);
    expect(
      registeredAppSchema.safeParse({
        ...app,
        capabilities: { ...app.capabilities, defaultPollInterval: 1.5 },
      }).success,
    ).toBe(false);
  });

  it("rejects a capabilities object missing a flag", () => {
    const app = baseApp();
    const partialCaps: Partial<AppCapabilities> = { ...app.capabilities };
    delete partialCaps.supportsPolling;
    expect(registeredAppSchema.safeParse({ ...app, capabilities: partialCaps }).success).toBe(
      false,
    );
  });
});
