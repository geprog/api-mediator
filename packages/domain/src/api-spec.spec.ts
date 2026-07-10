import { describe, expect, it } from "vitest";

import { type ApiSpec, apiSpecSchema } from "./index.js";

function baseSpec(): ApiSpec {
  return {
    id: "spec-1",
    appId: "app-1",
    role: "PROVIDER",
    rawDocument: { openapi: "3.0.0", info: { title: "Gitea", version: "1.0" }, paths: {} },
    parsedIR: [
      { resourceRef: "issues", name: "Issues", operations: [], schemas: [], crossResourceRefs: [] },
    ],
    analysisExclusions: [],
    version: 1,
    contentHash: "sha256:deadbeef",
    status: "active",
    createdAt: new Date("2026-07-10T00:00:00.000Z"),
  };
}

describe("ApiSpec schema", () => {
  it("accepts a valid version-1 PROVIDER spec with empty exclusions", () => {
    expect(apiSpecSchema.safeParse(baseSpec()).success).toBe(true);
  });

  it("accepts populated analysisExclusions (resourceRefs)", () => {
    const parsed = apiSpecSchema.parse({
      ...baseSpec(),
      analysisExclusions: ["labels", "webhooks"],
    });
    expect(parsed.analysisExclusions).toEqual(["labels", "webhooks"]);
  });

  it("rejects an unknown role", () => {
    expect(apiSpecSchema.safeParse({ ...baseSpec(), role: "PEER" }).success).toBe(false);
  });

  it("rejects a non-positive or non-integer version", () => {
    expect(apiSpecSchema.safeParse({ ...baseSpec(), version: 0 }).success).toBe(false);
    expect(apiSpecSchema.safeParse({ ...baseSpec(), version: 1.2 }).success).toBe(false);
  });

  it("rejects a missing contentHash", () => {
    const withoutHash: Partial<ApiSpec> = { ...baseSpec() };
    delete withoutHash.contentHash;
    expect(apiSpecSchema.safeParse(withoutHash).success).toBe(false);
  });

  it("rejects a parsedIR that is not a valid Ir", () => {
    expect(
      apiSpecSchema.safeParse({ ...baseSpec(), parsedIR: { resourceGroups: [] } }).success,
    ).toBe(false);
  });
});
