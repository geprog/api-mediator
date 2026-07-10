/**
 * `@mediator/credentials` — the Credential Store: envelope encryption behind a
 * `KeyProvider`, the write-only `store` path, and the `withCredential`
 * decrypt-for-use access pattern (see `docs/architecture/security.md`).
 *
 * Security invariants realized here: credential material is write-only through
 * `store` (returns metadata only); the decrypted secret is exposed *only*
 * transiently inside `withCredential`'s callback and never returned, logged, or
 * cached; the master key never appears in an envelope, log, or error.
 */

// Envelope encryption.
export {
  DATA_KEY_LENGTH_BYTES,
  ENVELOPE_SCHEME,
  EnvelopeDecryptionError,
  openEnvelope,
  sealEnvelope,
} from "./envelope.js";

// Master-key provider.
export {
  EnvKeyProvider,
  InvalidMasterKeyError,
  MASTER_KEY_LENGTH_BYTES,
  type KeyProvider,
} from "./key-provider.js";

// Credential material (store input) + secret (encrypted payload) shapes.
export {
  CredentialMaterialValidationError,
  CredentialSecretParseError,
  UnsupportedCredentialTypeError,
  credentialMaterialSchema,
  credentialSecretSchema,
  isStorableCredentialType,
  parseCredentialMaterial,
  parseDecryptedSecret,
  storableCredentialTypeSchema,
  StorableCredentialType,
  type CredentialMaterial,
  type CredentialSecret,
} from "./material.js";

// The store service + its persistence port and result types.
export {
  CredentialStore,
  type CredentialPersistence,
  type CredentialStoreLogger,
  type DecryptedCredential,
  type StoredEnvelope,
  type WithCredentialResult,
} from "./store.js";

// The Postgres-backed persistence adapter.
export { DbCredentialPersistence, NonStorableStoredCredentialError } from "./db-persistence.js";
