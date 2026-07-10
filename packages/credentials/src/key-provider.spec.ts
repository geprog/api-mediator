import { describe, expect, it } from "vitest";

import { EnvKeyProvider, InvalidMasterKeyError, MASTER_KEY_LENGTH_BYTES } from "./key-provider.js";

describe("EnvKeyProvider", () => {
  it("requires a 32-byte master key (AES-256)", () => {
    expect(MASTER_KEY_LENGTH_BYTES).toBe(32);
  });

  it("returns the configured 32-byte key", () => {
    const key = Buffer.alloc(32, 5);
    const provider = new EnvKeyProvider(key);

    expect(provider.getMasterKey().equals(key)).toBe(true);
  });

  it("keeps a defensive copy — mutating the caller's buffer cannot swap the key", () => {
    const key = Buffer.alloc(32, 5);
    const provider = new EnvKeyProvider(key);

    key.fill(0);

    expect(provider.getMasterKey().equals(Buffer.alloc(32, 5))).toBe(true);
  });

  it("rejects a too-short key, fail-fast at construction", () => {
    expect(() => new EnvKeyProvider(Buffer.alloc(31, 5))).toThrow(InvalidMasterKeyError);
  });

  it("rejects a too-long key, fail-fast at construction", () => {
    expect(() => new EnvKeyProvider(Buffer.alloc(33, 5))).toThrow(InvalidMasterKeyError);
  });

  it("reports the length but never the key bytes in the error", () => {
    const key = Buffer.alloc(20, 0xab);
    let message = "";
    try {
      new EnvKeyProvider(key);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain("20");
    expect(message).not.toContain(key.toString("base64"));
    expect(message).not.toContain(key.toString("hex"));
  });
});
