import { describe, expect, it } from "vitest";

import { type Credential, credentialSchema, isCredentialValidAt } from "./index.js";

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

describe("Credential.validUntil — rotation overlap (AD-3.3)", () => {
  function adapterToken(): Credential {
    return {
      id: "cred-tok-1",
      appId: "app-consumer",
      type: "adapterToken",
      // A salted-hash placeholder — never a raw token (AD-3.1/AD-3.2).
      encryptedPayload: "scrypt$16384$8$1$64$c2FsdA==$aGFzaA==",
      scopes: [],
      lastRotatedAt: new Date("2026-07-20T00:00:00.000Z"),
    };
  }

  it("accepts an adapterToken with no validUntil (the current, unbounded token)", () => {
    const parsed = credentialSchema.parse(adapterToken());
    expect(parsed).not.toHaveProperty("validUntil");
  });

  it("accepts a superseded token carrying a bounded validity end", () => {
    const result = credentialSchema.safeParse({
      ...adapterToken(),
      validUntil: new Date("2026-07-21T00:00:00.000Z"),
    });
    expect(result.success).toBe(true);
  });

  it("rejects a validUntil that is not a Date", () => {
    expect(
      credentialSchema.safeParse({ ...adapterToken(), validUntil: "2026-07-21" }).success,
    ).toBe(false);
  });
});

describe("isCredentialValidAt (AD-3.3 — queryable still-valid predicate)", () => {
  const now = new Date("2026-07-20T12:00:00.000Z");

  it("treats an absent bound as unbounded (the current token)", () => {
    expect(isCredentialValidAt({}, now)).toBe(true);
  });

  it("accepts a token still inside its overlap window", () => {
    expect(isCredentialValidAt({ validUntil: new Date("2026-07-20T13:00:00.000Z") }, now)).toBe(
      true,
    );
  });

  it("rejects a token past its bound (elapsed overlap or explicit revocation, AD-3.5)", () => {
    expect(isCredentialValidAt({ validUntil: new Date("2026-07-20T11:00:00.000Z") }, now)).toBe(
      false,
    );
  });

  it("rejects a token whose bound is exactly now (window is strict)", () => {
    expect(isCredentialValidAt({ validUntil: now }, now)).toBe(false);
  });
});
