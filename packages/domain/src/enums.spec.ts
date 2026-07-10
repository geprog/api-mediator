import { describe, expect, it } from "vitest";

import {
  ApiSpecRole,
  apiSpecRoleSchema,
  ApiSpecStatus,
  apiSpecStatusSchema,
  assertNever,
  CredentialType,
  credentialTypeSchema,
  RegisteredAppStatus,
  registeredAppStatusSchema,
  type RegisteredAppStatus as RegisteredAppStatusType,
} from "./index.js";

describe("domain enums", () => {
  it("expose glossary-verbatim literals as schema, union type, and const object", () => {
    expect(registeredAppStatusSchema.options).toEqual(["active", "disabled"]);
    expect(RegisteredAppStatus).toEqual({ active: "active", disabled: "disabled" });

    expect(apiSpecRoleSchema.options).toEqual(["PROVIDER", "CONSUMER"]);
    expect(ApiSpecRole).toEqual({ PROVIDER: "PROVIDER", CONSUMER: "CONSUMER" });

    expect(apiSpecStatusSchema.options).toEqual(["active", "superseded", "archived"]);
    expect(ApiSpecStatus).toEqual({
      active: "active",
      superseded: "superseded",
      archived: "archived",
    });

    expect(credentialTypeSchema.options).toEqual([
      "apiKey",
      "oauth2",
      "basicAuth",
      "adapterToken",
      "custom",
    ]);
    expect(CredentialType).toEqual({
      apiKey: "apiKey",
      oauth2: "oauth2",
      basicAuth: "basicAuth",
      adapterToken: "adapterToken",
      custom: "custom",
    });
  });

  it("accepts valid values and rejects unknown ones", () => {
    expect(registeredAppStatusSchema.safeParse("active").success).toBe(true);
    expect(registeredAppStatusSchema.safeParse("enabled").success).toBe(false);

    expect(apiSpecRoleSchema.safeParse("PROVIDER").success).toBe(true);
    // Roles are case-sensitive and uppercase per the glossary.
    expect(apiSpecRoleSchema.safeParse("provider").success).toBe(false);
  });

  it("includes adapterToken in the CredentialType enum (Phase-1 rejection lives in the store)", () => {
    // The data model's enum includes `adapterToken`; requirement CR-1 rejects it
    // at `CredentialStore.store`, not in this types-only schema.
    expect(credentialTypeSchema.safeParse("adapterToken").success).toBe(true);
  });

  describe("assertNever", () => {
    // A total switch over a domain enum: if a value were added to
    // RegisteredAppStatus without a branch here, this would stop compiling.
    function statusLabel(status: RegisteredAppStatusType): string {
      switch (status) {
        case "active":
          return "Active";
        case "disabled":
          return "Disabled";
        default:
          return assertNever(status);
      }
    }

    it("covers every enum member", () => {
      for (const status of registeredAppStatusSchema.options) {
        expect(statusLabel(status)).toMatch(/^(Active|Disabled)$/);
      }
    });

    it("throws when reached at runtime with an impossible value", () => {
      // Simulate a value that slipped past the type system.
      const smuggled = "unreachable" as unknown as never;
      expect(() => assertNever(smuggled)).toThrow(/Unexpected value: unreachable/);
    });
  });
});
