import { DATA_KEY_LENGTH_BYTES } from "./envelope.js";

/**
 * The master key-encryption key (KEK) length required for AES-256-GCM: 32 bytes.
 * Re-exported from the envelope's key length so the two can never drift.
 */
export const MASTER_KEY_LENGTH_BYTES = DATA_KEY_LENGTH_BYTES;

/**
 * Supplies the master key (KEK) that wraps each credential's data key.
 *
 * An interface, not a concrete class, so the envelope's key-management binding
 * stays swappable: {@link EnvKeyProvider} reads a key from configuration for
 * self-hosted dev/prod, and a future KMS/vault-backed provider slots in behind
 * the same seam (see `docs/architecture/security.md` — the pattern is mandated,
 * the product is not). `docs/architecture/extensibility.md` is the home for that
 * future implementation.
 */
export interface KeyProvider {
  /**
   * The master KEK — exactly {@link MASTER_KEY_LENGTH_BYTES} bytes. The returned
   * buffer is owned by the provider and must be treated as read-only (callers
   * must not mutate or zero it); it is reused for the process lifetime.
   */
  getMasterKey(): Buffer;
}

/** The configured master key was absent or not exactly 32 bytes. */
export class InvalidMasterKeyError extends Error {
  public constructor(actualLength: number) {
    // Length only — never the key bytes.
    super(
      `Master key must be exactly ${String(MASTER_KEY_LENGTH_BYTES)} bytes for AES-256-GCM, got ${String(actualLength)} bytes.`,
    );
    this.name = "InvalidMasterKeyError";
  }
}

/**
 * A {@link KeyProvider} backed by a master key held in memory (sourced from
 * `@mediator/config`'s validated `CREDENTIAL_MASTER_KEY`). Fails fast at
 * construction if the key is the wrong length, so a misconfigured deployment
 * never starts up able to write unrecoverable ciphertext.
 */
export class EnvKeyProvider implements KeyProvider {
  readonly #masterKey: Buffer;

  public constructor(masterKey: Buffer) {
    if (masterKey.length !== MASTER_KEY_LENGTH_BYTES) {
      throw new InvalidMasterKeyError(masterKey.length);
    }
    // Defensive copy: the provider owns its key; an external mutation of the
    // caller's buffer must not swap the key under a live store.
    this.#masterKey = Buffer.from(masterKey);
  }

  public getMasterKey(): Buffer {
    return this.#masterKey;
  }
}
