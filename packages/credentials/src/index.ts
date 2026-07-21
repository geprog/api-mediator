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

// Salted one-way hashing (equality-verified secrets: operator-account passwords
// now, adapterToken in Phase 5).
export { SECRET_HASH_SCHEME, hashSecret, isEncodedSecretHash, verifySecret } from "./hashing.js";

// Adapter token (Phase-5 AT-1..AT-4): the consumer-app token lifecycle — issue
// (shown once), rotate with an overlap window, cutover, per-request validation, and
// the deregister-cascade deletion. Salted-hash storage, constant-time equality.
export {
  ADAPTER_TOKEN_SCHEME,
  AdapterTokenStore,
  formatAdapterToken,
  generateAdapterTokenSecret,
  parseAdapterToken,
  type AdapterTokenPersistence,
  type AdapterTokenRecord,
  type AdapterTokenRejectionReason,
  type AdapterTokenStoreOptions,
  type ConsumerAppEligibility,
  type ConsumerAppEligibilityReader,
  type CutoverResult,
  type IssuedAdapterToken,
  type IssueTokenResult,
  type NewAdapterTokenRecord,
  type ParsedAdapterToken,
  type ValidateTokenResult,
} from "./adapter-token.js";
export { DbAdapterTokenPersistence } from "./db-adapter-token.js";

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
  toUsableSecret,
  StorableCredentialType,
  type CredentialMaterial,
  type CredentialSecret,
  type UsableCredentialSecret,
} from "./material.js";

// The store service + its persistence port, result types, and Phase-4 seams.
export {
  CredentialStore,
  type CredentialAccessAuditor,
  type CredentialPersistence,
  type CredentialStoreLogger,
  type CredentialStoreOptions,
  type DecryptedCredential,
  type OAuth2Refresher,
  type OAuth2RefreshRequest,
  type OAuth2RefreshedTokens,
  type StoredEnvelope,
  type TraceContext,
  type WithCredentialResult,
} from "./store.js";

// The Postgres-backed persistence + audit adapters.
export {
  DbCredentialAccessAuditor,
  DbCredentialPersistence,
  NonStorableStoredCredentialError,
} from "./db-persistence.js";
