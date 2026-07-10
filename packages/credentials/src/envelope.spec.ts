import { randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  ENVELOPE_SCHEME,
  EnvelopeDecryptionError,
  openEnvelope,
  sealEnvelope,
} from "./envelope.js";

const KEK = Buffer.alloc(32, 9);

const PLAINTEXT = Buffer.from(
  JSON.stringify({ type: "apiKey", apiKey: "super-secret-token-value-42" }),
  "utf8",
);

/** Typed view of a serialized envelope, for tamper tests (no `as` casts). */
const envelopeShape = z.object({
  scheme: z.string(),
  alg: z.string(),
  dek: z.object({ iv: z.string(), ct: z.string(), tag: z.string() }),
  payload: z.object({ iv: z.string(), ct: z.string(), tag: z.string() }),
});
type EnvelopeShape = z.infer<typeof envelopeShape>;

function decode(serialized: string): EnvelopeShape {
  return envelopeShape.parse(JSON.parse(Buffer.from(serialized, "base64").toString("utf8")));
}

function encode(envelope: EnvelopeShape): string {
  return Buffer.from(JSON.stringify(envelope), "utf8").toString("base64");
}

/** Flip the first byte of a base64-encoded segment, keeping it valid base64. */
function flipFirstByte(base64Segment: string): string {
  const bytes = Buffer.from(base64Segment, "base64");
  bytes[0] = (bytes[0] ?? 0) ^ 0xff;
  return bytes.toString("base64");
}

describe("sealEnvelope / openEnvelope", () => {
  it("round-trips plaintext to the exact original bytes", () => {
    const serialized = sealEnvelope(PLAINTEXT, KEK);
    const recovered = openEnvelope(serialized, KEK);

    expect(recovered.equals(PLAINTEXT)).toBe(true);
  });

  it("produces a fresh envelope (random IVs/DEK) each time for identical input", () => {
    const a = sealEnvelope(PLAINTEXT, KEK);
    const b = sealEnvelope(PLAINTEXT, KEK);

    // Different ciphertext at rest, but both decrypt to the same plaintext.
    expect(a).not.toBe(b);
    expect(openEnvelope(a, KEK).equals(PLAINTEXT)).toBe(true);
    expect(openEnvelope(b, KEK).equals(PLAINTEXT)).toBe(true);
  });

  it("tags the serialized envelope with the current scheme version", () => {
    const envelope = decode(sealEnvelope(PLAINTEXT, KEK));

    expect(envelope.scheme).toBe(ENVELOPE_SCHEME);
    expect(envelope.alg).toBe("aes-256-gcm");
  });

  it("never contains the plaintext anywhere in the serialized envelope", () => {
    const secret = "plaintext-must-not-appear-anywhere";
    const serialized = sealEnvelope(Buffer.from(secret, "utf8"), KEK);

    // Neither the opaque base64 blob nor its decoded JSON leaks the plaintext.
    expect(serialized).not.toContain(secret);
    expect(Buffer.from(serialized, "base64").toString("utf8")).not.toContain(secret);
  });

  it("fails to decrypt with the wrong master key (GCM authentication)", () => {
    const serialized = sealEnvelope(PLAINTEXT, KEK);
    const wrongKek = Buffer.alloc(32, 1);

    expect(() => openEnvelope(serialized, wrongKek)).toThrow(EnvelopeDecryptionError);
  });

  it("fails to decrypt when the payload ciphertext is tampered with", () => {
    const envelope = decode(sealEnvelope(PLAINTEXT, KEK));
    const tampered = encode({
      ...envelope,
      payload: { ...envelope.payload, ct: flipFirstByte(envelope.payload.ct) },
    });

    expect(() => openEnvelope(tampered, KEK)).toThrow(EnvelopeDecryptionError);
  });

  it("fails to decrypt when the payload auth tag is tampered with", () => {
    const envelope = decode(sealEnvelope(PLAINTEXT, KEK));
    const tampered = encode({
      ...envelope,
      payload: { ...envelope.payload, tag: flipFirstByte(envelope.payload.tag) },
    });

    expect(() => openEnvelope(tampered, KEK)).toThrow(EnvelopeDecryptionError);
  });

  it("fails to unwrap when the wrapped DEK is tampered with", () => {
    const envelope = decode(sealEnvelope(PLAINTEXT, KEK));
    const tampered = encode({
      ...envelope,
      dek: { ...envelope.dek, ct: flipFirstByte(envelope.dek.ct) },
    });

    expect(() => openEnvelope(tampered, KEK)).toThrow(EnvelopeDecryptionError);
  });

  it("rejects a malformed / non-envelope serialized string", () => {
    expect(() => openEnvelope("not-a-valid-envelope", KEK)).toThrow(EnvelopeDecryptionError);
  });

  it("rejects a wrong-length key on seal and on open", () => {
    const shortKey = randomBytes(16);
    const serialized = sealEnvelope(PLAINTEXT, KEK);

    expect(() => sealEnvelope(PLAINTEXT, shortKey)).toThrow();
    expect(() => openEnvelope(serialized, shortKey)).toThrow();
  });
});
