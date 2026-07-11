import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

/**
 * Salted one-way hashing for secrets that are validated by **equality**, never
 * decrypted — the opposite of the envelope encryption in `envelope.ts`. Its
 * Phase-3 consumer is the local-accounts operator-auth provider, which stores a
 * salted hash of each account's password and verifies a submitted password
 * against it (see `docs/architecture/security.md` *Operator authentication &
 * authorization*). The concept's `adapterToken` (Phase 5) is described the same
 * way — "stored only as a salted hash, since validation needs equality, never
 * the original value" — so this primitive is deliberately secret-kind-agnostic.
 *
 * Algorithm: **scrypt** (memory-hard KDF from `node:crypto`) with a fresh random
 * 16-byte salt per hash. The encoded output is fully self-describing so a hash
 * produced today still verifies after the default parameters are tuned:
 *
 *   `scrypt$<N>$<r>$<p>$<keyLen>$<saltBase64>$<hashBase64>`
 *
 * The plaintext appears nowhere in the output; only the salt and the derived
 * key are stored. Verification is constant-time ({@link timingSafeEqual}) so a
 * comparison never leaks how much of the hash matched.
 */

/** The scheme tag prefixing every encoded hash — bumped if the KDF changes. */
export const SECRET_HASH_SCHEME = "scrypt";

/** scrypt cost parameters. */
interface ScryptParams {
  /** CPU/memory cost (must be a power of two). */
  readonly N: number;
  /** Block size. */
  readonly r: number;
  /** Parallelization. */
  readonly p: number;
}

/**
 * Default scrypt parameters. `N = 16384` keeps a single hash well under 20 MB of
 * memory and a few tens of milliseconds of CPU — appropriate for the low request
 * volume of the operator API while still being memory-hard against offline
 * cracking.
 */
const DEFAULT_PARAMS: ScryptParams = { N: 16384, r: 8, p: 1 };
/** Derived-key length in bytes. */
const KEY_LENGTH_BYTES = 64;
/** Random salt length in bytes. */
const SALT_LENGTH_BYTES = 16;
/**
 * Generous scrypt memory ceiling so a future bump to {@link DEFAULT_PARAMS} does
 * not trip Node's default 32 MB `maxmem` guard. scrypt needs ≈ `128 * N * r`
 * bytes; 64 MB covers well beyond the current 16 MB working set.
 */
const MAX_MEM_BYTES = 64 * 1024 * 1024;
/** Upper bound on a parsed `N` — rejects an absurd cost from a malformed hash. */
const MAX_N = 1 << 20;

/** Derive a key with scrypt, wrapped as a promise so callers stay async. */
function deriveKey(
  password: string,
  salt: Buffer,
  keyLength: number,
  params: ScryptParams,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      password,
      salt,
      keyLength,
      { N: params.N, r: params.r, p: params.p, maxmem: MAX_MEM_BYTES },
      (error, derivedKey) => {
        if (error !== null) {
          reject(error);
        } else {
          resolve(derivedKey);
        }
      },
    );
  });
}

/**
 * Hash `plaintext` into a self-describing, salted scrypt string safe to store at
 * rest. A fresh random salt makes every call's output unique even for identical
 * inputs. The returned string never contains the plaintext.
 */
export async function hashSecret(plaintext: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH_BYTES);
  const derived = await deriveKey(plaintext, salt, KEY_LENGTH_BYTES, DEFAULT_PARAMS);
  return [
    SECRET_HASH_SCHEME,
    String(DEFAULT_PARAMS.N),
    String(DEFAULT_PARAMS.r),
    String(DEFAULT_PARAMS.p),
    String(KEY_LENGTH_BYTES),
    salt.toString("base64"),
    derived.toString("base64"),
  ].join("$");
}

/** A parsed encoded hash: its parameters, salt, and expected derived key. */
interface ParsedHash {
  readonly params: ScryptParams;
  readonly keyLength: number;
  readonly salt: Buffer;
  readonly expected: Buffer;
}

/** Parse `1234` into a positive integer, or `null` if it is not one. */
function parsePositiveInt(value: string): number | null {
  if (!/^\d+$/.test(value)) {
    return null;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Parse an encoded hash produced by {@link hashSecret}, returning `null` for any
 * malformed, wrong-scheme, or out-of-bounds input rather than throwing — a bad
 * stored hash must fail verification, never crash request handling.
 */
function parseEncodedHash(encoded: string): ParsedHash | null {
  const parts = encoded.split("$");
  if (parts.length !== 7) {
    return null;
  }
  const [scheme, rawN, rawR, rawP, rawKeyLen, saltB64, hashB64] = parts;
  if (scheme !== SECRET_HASH_SCHEME) {
    return null;
  }
  const N = parsePositiveInt(rawN ?? "");
  const r = parsePositiveInt(rawR ?? "");
  const p = parsePositiveInt(rawP ?? "");
  const keyLength = parsePositiveInt(rawKeyLen ?? "");
  if (N === null || r === null || p === null || keyLength === null) {
    return null;
  }
  // N must be a power of two within a sane bound; guard against a huge cost.
  if (N > MAX_N || (N & (N - 1)) !== 0) {
    return null;
  }
  const salt = Buffer.from(saltB64 ?? "", "base64");
  const expected = Buffer.from(hashB64 ?? "", "base64");
  if (salt.length === 0 || expected.length !== keyLength) {
    return null;
  }
  return { params: { N, r, p }, keyLength, salt, expected };
}

/**
 * Verify `plaintext` against an `encoded` hash from {@link hashSecret}, in
 * constant time. Returns `false` for a wrong secret and for any malformed or
 * unsupported encoded value (never throws).
 */
export async function verifySecret(plaintext: string, encoded: string): Promise<boolean> {
  const parsed = parseEncodedHash(encoded);
  if (parsed === null) {
    return false;
  }
  const derived = await deriveKey(plaintext, parsed.salt, parsed.keyLength, parsed.params);
  // Lengths are equal by construction (both `keyLength`), so timingSafeEqual is
  // safe to call; it compares without an early-exit timing side channel.
  return timingSafeEqual(derived, parsed.expected);
}

/**
 * Structural sanity check for an encoded hash — the shape {@link parseEncodedHash}
 * accepts. Exposed so a configuration layer can fail fast on an obviously
 * malformed seeded hash without importing the full parser; a `true` result means
 * "well-formed enough to attempt verification", not "matches any secret".
 */
export function isEncodedSecretHash(value: string): boolean {
  return parseEncodedHash(value) !== null;
}
