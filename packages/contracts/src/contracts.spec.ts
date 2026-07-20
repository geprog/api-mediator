import { describe, expect, it } from "vitest";

import {
  RESOURCE_BINDING_REF_KINDS,
  credentialMaterialDtoSchema,
  registerAppRequestSchema,
  registeredAppDtoSchema,
} from "./index.js";

describe("registerAppRequestSchema", () => {
  const validSpec = { role: "PROVIDER", document: { openapi: "3.0.0" } };

  it("accepts a minimal valid registration (name + one spec)", () => {
    const result = registerAppRequestSchema.safeParse({
      name: "Gitea",
      specs: [validSpec],
    });
    expect(result.success).toBe(true);
  });

  it("rejects a request with no name", () => {
    const result = registerAppRequestSchema.safeParse({ specs: [validSpec] });
    expect(result.success).toBe(false);
  });

  it("rejects a request with no specs", () => {
    const result = registerAppRequestSchema.safeParse({ name: "x", specs: [] });
    expect(result.success).toBe(false);
  });

  it("rejects an unrecognized spec role", () => {
    const result = registerAppRequestSchema.safeParse({
      name: "x",
      specs: [{ role: "BACKEND", document: {} }],
    });
    expect(result.success).toBe(false);
  });

  it("accepts optional apiKey credential material", () => {
    const result = registerAppRequestSchema.safeParse({
      name: "x",
      specs: [validSpec],
      credential: { secret: { type: "apiKey", apiKey: "k" } },
    });
    expect(result.success).toBe(true);
  });

  it("rejects a credential of type adapterToken at the boundary (CR-1 crit 5)", () => {
    const result = registerAppRequestSchema.safeParse({
      name: "x",
      specs: [validSpec],
      credential: { secret: { type: "adapterToken", token: "t" } },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((issue) => issue.path.join("."));
      expect(paths.some((path) => path.startsWith("credential.secret"))).toBe(true);
    }
  });
});

describe("credentialMaterialDtoSchema", () => {
  it("never accepts adapterToken (Phase-5 salted-hash path, not this one)", () => {
    expect(
      credentialMaterialDtoSchema.safeParse({ secret: { type: "adapterToken", token: "t" } })
        .success,
    ).toBe(false);
  });
});

describe("registeredAppDtoSchema", () => {
  it("carries createdAt as a string (Date -> ISO at the boundary)", () => {
    const result = registeredAppDtoSchema.safeParse({
      id: "a",
      name: "Gitea",
      status: "active",
      capabilities: {
        supportsPolling: false,
        supportsDeltaQuery: false,
        supportsChangeTimestamps: false,
        defaultPollInterval: 300000,
      },
      createdAt: new Date().toISOString(),
    });
    expect(result.success).toBe(true);
  });
});

describe("RESOURCE_BINDING_REF_KINDS", () => {
  it("lists exactly the seven confirmable ref kinds", () => {
    expect(RESOURCE_BINDING_REF_KINDS).toEqual([
      "nativeIdRef",
      // SS-19 — the container-relative addressing ref, beside (never replacing) nativeIdRef.
      "recordAddressRef",
      "collectionReadRef",
      "paginationRef",
      "deltaCursorRef",
      "deltaDeletionRef",
      "changeTimestampRef",
    ]);
  });
});
