import { describe, expect, it } from "vitest";

import { SECRET_HASH_SCHEME, hashSecret, isEncodedSecretHash, verifySecret } from "./hashing.js";

describe("hashSecret / verifySecret", () => {
  it("verifies a correct secret against its own hash", async () => {
    const encoded = await hashSecret("correct horse battery staple");
    expect(await verifySecret("correct horse battery staple", encoded)).toBe(true);
  });

  it("rejects a wrong secret", async () => {
    const encoded = await hashSecret("s3cr3t");
    expect(await verifySecret("not-the-secret", encoded)).toBe(false);
  });

  it("never embeds the plaintext in the encoded hash", async () => {
    const secret = "super-distinctive-plaintext-value";
    const encoded = await hashSecret(secret);
    expect(encoded).not.toContain(secret);
  });

  it("produces a self-describing scrypt encoding with a fresh salt each call", async () => {
    const first = await hashSecret("same-input");
    const second = await hashSecret("same-input");
    // Salted: identical inputs produce different encoded hashes.
    expect(first).not.toBe(second);
    for (const encoded of [first, second]) {
      expect(encoded.startsWith(`${SECRET_HASH_SCHEME}$`)).toBe(true);
      expect(encoded.split("$")).toHaveLength(7);
      expect(await verifySecret("same-input", encoded)).toBe(true);
    }
  });

  it("returns false for a malformed / wrong-scheme encoded hash rather than throwing", async () => {
    expect(await verifySecret("anything", "")).toBe(false);
    expect(await verifySecret("anything", "not-an-encoded-hash")).toBe(false);
    expect(await verifySecret("anything", "bcrypt$16384$8$1$64$c2FsdA==$aGFzaA==")).toBe(false);
    // Right shape, but a tampered (truncated) derived-key segment.
    const encoded = await hashSecret("x");
    const tampered = encoded.slice(0, -4);
    expect(await verifySecret("x", tampered)).toBe(false);
  });

  it("recognizes a well-formed encoded hash structurally", async () => {
    const encoded = await hashSecret("y");
    expect(isEncodedSecretHash(encoded)).toBe(true);
    expect(isEncodedSecretHash("plainstring")).toBe(false);
    // N not a power of two is rejected.
    expect(isEncodedSecretHash("scrypt$16383$8$1$64$c2FsdA==$aGFzaA==")).toBe(false);
  });
});
