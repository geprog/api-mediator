import { describe, expect, it } from "vitest";

import {
  CredentialMaterialValidationError,
  CredentialSecretParseError,
  isStorableCredentialType,
  parseCredentialMaterial,
  parseDecryptedSecret,
  UnsupportedCredentialTypeError,
  type CredentialSecret,
} from "./material.js";

describe("parseCredentialMaterial", () => {
  it("accepts each storable credential type", () => {
    expect(
      parseCredentialMaterial({ secret: { type: "apiKey", apiKey: "k" } }).secret,
    ).toStrictEqual({ type: "apiKey", apiKey: "k" });
    expect(
      parseCredentialMaterial({
        secret: { type: "basicAuth", username: "u", password: "p" },
      }).secret,
    ).toStrictEqual({ type: "basicAuth", username: "u", password: "p" });
    expect(
      parseCredentialMaterial({ secret: { type: "oauth2", accessToken: "a", refreshToken: "r" } })
        .secret,
    ).toStrictEqual({ type: "oauth2", accessToken: "a", refreshToken: "r" });
    expect(
      parseCredentialMaterial({ secret: { type: "custom", values: { header: "x" } } }).secret,
    ).toStrictEqual({ type: "custom", values: { header: "x" } });
  });

  it("carries optional scopes through", () => {
    const material = parseCredentialMaterial({
      secret: { type: "apiKey", apiKey: "k" },
      scopes: ["read", "write"],
    });

    expect(material.scopes).toStrictEqual(["read", "write"]);
  });

  it("rejects adapterToken with a clear Phase-5 message (CR-1)", () => {
    let caught: unknown;
    try {
      parseCredentialMaterial({ secret: { type: "adapterToken", apiKey: "k" } });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(UnsupportedCredentialTypeError);
    expect(caught).toBeInstanceOf(Error);
    const message = caught instanceof Error ? caught.message : "";
    expect(message).toContain("adapterToken");
    expect(message).toContain("salted hash");
  });

  it("rejects an unknown credential type", () => {
    expect(() => parseCredentialMaterial({ secret: { type: "smoke-signal", value: "x" } })).toThrow(
      UnsupportedCredentialTypeError,
    );
  });

  it("rejects malformed material with a validation error", () => {
    // Missing the required apiKey field.
    expect(() => parseCredentialMaterial({ secret: { type: "apiKey" } })).toThrow(
      CredentialMaterialValidationError,
    );
    // Empty required secret.
    expect(() => parseCredentialMaterial({ secret: { type: "apiKey", apiKey: "" } })).toThrow(
      CredentialMaterialValidationError,
    );
    // Not even an object.
    expect(() => parseCredentialMaterial("nope")).toThrow(CredentialMaterialValidationError);
  });

  it("never echoes a submitted secret value in a validation error", () => {
    let message = "";
    try {
      // Wrong-typed password: a number where a string is required.
      parseCredentialMaterial({
        secret: { type: "basicAuth", username: "u", password: 987654321 },
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain("password");
    expect(message).not.toContain("987654321");
  });
});

describe("isStorableCredentialType", () => {
  it("accepts storable types and rejects adapterToken / unknowns", () => {
    expect(isStorableCredentialType("apiKey")).toBe(true);
    expect(isStorableCredentialType("oauth2")).toBe(true);
    expect(isStorableCredentialType("basicAuth")).toBe(true);
    expect(isStorableCredentialType("custom")).toBe(true);
    expect(isStorableCredentialType("adapterToken")).toBe(false);
    expect(isStorableCredentialType("whatever")).toBe(false);
  });
});

describe("parseDecryptedSecret", () => {
  it("round-trips a secret through its JSON serialization", () => {
    const secret: CredentialSecret = { type: "basicAuth", username: "u", password: "p" };
    const bytes = Buffer.from(JSON.stringify(secret), "utf8");

    expect(parseDecryptedSecret(bytes, "basicAuth")).toStrictEqual(secret);
  });

  it("rejects a secret whose type does not match the row type (tamper signal)", () => {
    const bytes = Buffer.from(JSON.stringify({ type: "apiKey", apiKey: "k" }), "utf8");

    expect(() => parseDecryptedSecret(bytes, "oauth2")).toThrow(CredentialSecretParseError);
  });

  it("rejects non-JSON decrypted bytes", () => {
    expect(() => parseDecryptedSecret(Buffer.from("not json", "utf8"), "apiKey")).toThrow(
      CredentialSecretParseError,
    );
  });
});
