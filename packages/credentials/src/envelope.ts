import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import { z } from "zod";

/**
 * Envelope encryption for `Credential.encryptedPayload` (see
 * `docs/architecture/security.md` *Credential storage*).
 *
 * Scheme **v1**:
 *   - A fresh per-credential **data key (DEK)** — 32 random bytes — encrypts the
 *     credential material with AES-256-GCM.
 *   - The DEK is then **wrapped** by the **master key (KEK)**, also with
 *     AES-256-GCM.
 *   - Both encryptions use a fresh random 12-byte IV and produce a 16-byte GCM
 *     authentication tag, so tampering (with either the wrapped DEK or the
 *     ciphertext) fails authentication on decrypt rather than yielding garbage.
 *
 * Serialization: a small JSON structure (base64 fields + a `scheme` tag for
 * future rotation) is itself base64-encoded into the single `encryptedPayload`
 * string column — fully opaque at rest, and the `scheme` tag lets a future v2
 * be introduced without ambiguity. The KEK never appears in the envelope; the
 * plaintext appears nowhere in it.
 */

const ALGORITHM = "aes-256-gcm";
/** AES-256 key length, for both the DEK and the KEK. */
export const DATA_KEY_LENGTH_BYTES = 32;
/** GCM standard IV length. */
const IV_LENGTH_BYTES = 12;
/** GCM authentication tag length. */
const AUTH_TAG_LENGTH_BYTES = 16;
/** The current envelope scheme tag. */
export const ENVELOPE_SCHEME = "v1";

/** One AES-256-GCM ciphertext segment: IV, ciphertext, and auth tag (base64). */
const segmentSchema = z.object({
  iv: z.string(),
  ct: z.string(),
  tag: z.string(),
});

/** The parsed v1 envelope structure. */
const envelopeV1Schema = z.object({
  scheme: z.literal(ENVELOPE_SCHEME),
  alg: z.literal(ALGORITHM),
  /** The DEK, wrapped (encrypted) by the KEK. */
  dek: segmentSchema,
  /** The credential material, encrypted by the DEK. */
  payload: segmentSchema,
});

interface Segment {
  readonly iv: string;
  readonly ct: string;
  readonly tag: string;
}

/** Decryption failed: authentication failure, wrong key, or corrupt envelope. */
export class EnvelopeDecryptionError extends Error {
  public constructor() {
    // Deliberately generic: no key, ciphertext, or plaintext detail is exposed.
    super("Failed to decrypt credential envelope (authentication failed or data corrupt).");
    this.name = "EnvelopeDecryptionError";
  }
}

function assertKeyLength(key: Buffer): void {
  if (key.length !== DATA_KEY_LENGTH_BYTES) {
    // Length only — never the key bytes.
    throw new Error(
      `Envelope key must be ${String(DATA_KEY_LENGTH_BYTES)} bytes, got ${String(key.length)}.`,
    );
  }
}

/** AES-256-GCM encrypt `plaintext` under `key`, returning a base64 segment. */
function encryptSegment(plaintext: Buffer, key: Buffer): Segment {
  const iv = randomBytes(IV_LENGTH_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { iv: iv.toString("base64"), ct: ct.toString("base64"), tag: tag.toString("base64") };
}

/** AES-256-GCM decrypt a base64 segment under `key`. Throws on auth failure. */
function decryptSegment(segment: Segment, key: Buffer): Buffer {
  const iv = Buffer.from(segment.iv, "base64");
  const ct = Buffer.from(segment.ct, "base64");
  const tag = Buffer.from(segment.tag, "base64");
  if (iv.length !== IV_LENGTH_BYTES || tag.length !== AUTH_TAG_LENGTH_BYTES) {
    throw new EnvelopeDecryptionError();
  }
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ct), decipher.final()]);
  } catch {
    // GCM authentication failure (tampering / wrong key) throws here.
    throw new EnvelopeDecryptionError();
  }
}

/**
 * Seal `plaintext` into a serialized v1 envelope under the master key `kek`.
 *
 * A fresh DEK is generated, used to encrypt the plaintext, then wrapped by the
 * KEK. The DEK buffer is zeroed before returning so it does not linger in
 * memory. `plaintext` is the caller's to zero.
 */
export function sealEnvelope(plaintext: Buffer, kek: Buffer): string {
  assertKeyLength(kek);
  const dek = randomBytes(DATA_KEY_LENGTH_BYTES);
  try {
    const payload = encryptSegment(plaintext, dek);
    const wrappedDek = encryptSegment(dek, kek);
    const envelope = {
      scheme: ENVELOPE_SCHEME,
      alg: ALGORITHM,
      dek: wrappedDek,
      payload,
    };
    return Buffer.from(JSON.stringify(envelope), "utf8").toString("base64");
  } finally {
    dek.fill(0);
  }
}

/**
 * Open a serialized v1 envelope with the master key `kek`, returning the
 * plaintext bytes. Throws {@link EnvelopeDecryptionError} on a wrong key,
 * tampering, or a malformed/unknown-scheme envelope. The unwrapped DEK is zeroed
 * before returning; the returned plaintext is the caller's to zero.
 */
export function openEnvelope(serialized: string, kek: Buffer): Buffer {
  assertKeyLength(kek);

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(Buffer.from(serialized, "base64").toString("utf8"));
  } catch {
    throw new EnvelopeDecryptionError();
  }

  const envelope = envelopeV1Schema.safeParse(parsedJson);
  if (!envelope.success) {
    throw new EnvelopeDecryptionError();
  }

  const dek = decryptSegment(envelope.data.dek, kek);
  try {
    return decryptSegment(envelope.data.payload, dek);
  } finally {
    dek.fill(0);
  }
}
