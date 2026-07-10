import { describe, expect, it } from "vitest";

import { type Credential, credentialSchema } from "./index.js";

function baseCredential(): Credential {
  return {
    id: "cred-1",
    appId: "app-1",
    type: "apiKey",
    // Opaque ciphertext placeholder — never real or plaintext secret material.
    encryptedPayload: "enc:v1:opaque-ciphertext",
    scopes: ["read", "write"],
    lastRotatedAt: new Date("2026-07-10T00:00:00.000Z"),
  };
}

describe("Credential schema", () => {
  it("accepts a valid credential row", () => {
    expect(credentialSchema.safeParse(baseCredential()).success).toBe(true);
  });

  it("accepts empty scopes", () => {
    const parsed = credentialSchema.parse({ ...baseCredential(), scopes: [] });
    expect(parsed.scopes).toEqual([]);
  });

  it("rejects a type outside the CredentialType enum", () => {
    expect(credentialSchema.safeParse({ ...baseCredential(), type: "jwt" }).success).toBe(false);
  });

  it("rejects a missing encryptedPayload", () => {
    const withoutPayload: Partial<Credential> = { ...baseCredential() };
    delete withoutPayload.encryptedPayload;
    expect(credentialSchema.safeParse(withoutPayload).success).toBe(false);
  });

  it("rejects a lastRotatedAt that is not a Date", () => {
    expect(
      credentialSchema.safeParse({ ...baseCredential(), lastRotatedAt: 1_720_000_000_000 }).success,
    ).toBe(false);
  });
});
