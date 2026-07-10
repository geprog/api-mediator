import { z } from "zod";

/**
 * The credential *material* the {@link CredentialStore} accepts through its
 * write-only `store` path, and the *secret* portion of it that is
 * envelope-encrypted at rest.
 *
 * Modeled as a discriminated union on `type` (not an optional-field bag): each
 * credential kind carries exactly the secret fields it needs, so an `apiKey`
 * can never accidentally omit its key or an `basicAuth` its password. The union
 * deliberately excludes `adapterToken` — that is a consumer app's
 * mediator-issued token, stored as a *salted hash* (Phase 5), never
 * envelope-encrypted material (see `docs/architecture/security.md` and CR-1
 * criterion 5).
 */

// ── Storable credential types (envelope-encrypted; NOT adapterToken) ─────────

/**
 * The `Credential.type` values `CredentialStore.store` accepts. A strict subset
 * of the domain `CredentialType` union: `adapterToken` is excluded here because
 * it is not envelope-encrypted material (see the module docstring).
 */
export const storableCredentialTypeSchema = z.enum(["apiKey", "oauth2", "basicAuth", "custom"]);
export type StorableCredentialType = z.infer<typeof storableCredentialTypeSchema>;
export const StorableCredentialType = storableCredentialTypeSchema.enum;

/** True when `value` is a storable (envelope-encrypted) credential type. */
export function isStorableCredentialType(value: string): value is StorableCredentialType {
  return storableCredentialTypeSchema.safeParse(value).success;
}

// ── Secret material (the part that is encrypted) ─────────────────────────────

/**
 * The secret-bearing content of a credential — the *only* part written to
 * `Credential.encryptedPayload`. Self-describing via `type`, so a decrypted
 * envelope can be validated back into the exact shape it was sealed from. The
 * metadata (`scopes`, `lastRotatedAt`, the row `type`) lives in plaintext
 * columns and is the only thing a read ever returns.
 */
export const credentialSecretSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("apiKey"), apiKey: z.string().min(1) }),
  z.object({
    type: z.literal("basicAuth"),
    username: z.string().min(1),
    password: z.string().min(1),
  }),
  z.object({
    type: z.literal("oauth2"),
    accessToken: z.string().min(1),
    refreshToken: z.string().min(1).optional(),
  }),
  z.object({ type: z.literal("custom"), values: z.record(z.string(), z.string()) }),
]);
export type CredentialSecret = z.infer<typeof credentialSecretSchema>;

/**
 * The full input to `CredentialStore.store`: the secret plus optional `scopes`.
 * The row's `type` is taken from `secret.type` — there is no separate top-level
 * `type` to keep in sync.
 */
export const credentialMaterialSchema = z.object({
  secret: credentialSecretSchema,
  scopes: z.array(z.string()).optional(),
});
export type CredentialMaterial = z.infer<typeof credentialMaterialSchema>;

// ── Errors ───────────────────────────────────────────────────────────────────

/**
 * A `type` outside the storable set was submitted to `store`. The message names
 * the offending type (never a secret value); `adapterToken` gets a dedicated
 * message pointing at its Phase-5 salted-hash path.
 */
export class UnsupportedCredentialTypeError extends Error {
  public readonly credentialType: string;

  public constructor(credentialType: string) {
    super(
      credentialType === "adapterToken"
        ? "adapterToken credentials are not stored via CredentialStore.store: an adapter token is a consumer app's mediator-issued token, stored as a salted hash (Phase 5), not envelope-encrypted material."
        : `Unsupported credential type "${credentialType}": CredentialStore.store accepts only apiKey, oauth2, basicAuth, or custom.`,
    );
    this.name = "UnsupportedCredentialTypeError";
    this.credentialType = credentialType;
  }
}

/**
 * Submitted credential material failed schema validation (a missing/empty
 * secret field, wrong shape, …). The message reports only field paths and
 * reasons — never any submitted secret value.
 */
export class CredentialMaterialValidationError extends Error {
  public constructor(message: string) {
    super(`Invalid credential material: ${message}`);
    this.name = "CredentialMaterialValidationError";
  }
}

/**
 * Format Zod issues into a single-line, **secret-safe** message: field path plus
 * Zod's reason (e.g. "Required", "Expected string"). These default reasons never
 * embed the received value, so no secret material reaches the error string.
 */
function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
      return `${path}: ${issue.message}`;
    })
    .join("; ");
}

/**
 * Validate arbitrary input into {@link CredentialMaterial}, rejecting a
 * non-storable `type` (notably `adapterToken`) with a clear
 * {@link UnsupportedCredentialTypeError} and any other malformed input with a
 * {@link CredentialMaterialValidationError}.
 *
 * Takes `unknown` so it validates untyped input crossing the API boundary as
 * well as it type-checks statically-typed callers.
 */
export function parseCredentialMaterial(input: unknown): CredentialMaterial {
  // Surface a non-storable `type` (esp. adapterToken) with a targeted error
  // before the generic discriminated-union failure obscures it.
  const discriminant = z.object({ secret: z.object({ type: z.string() }) }).safeParse(input);
  if (discriminant.success && !isStorableCredentialType(discriminant.data.secret.type)) {
    throw new UnsupportedCredentialTypeError(discriminant.data.secret.type);
  }

  const result = credentialMaterialSchema.safeParse(input);
  if (!result.success) {
    throw new CredentialMaterialValidationError(formatIssues(result.error));
  }
  return result.data;
}

/**
 * Parse decrypted envelope bytes back into a {@link CredentialSecret}, checking
 * it matches the row's `type`. A mismatch or malformed JSON means the envelope
 * was corrupted or tampered with — surfaced as {@link CredentialSecretParseError}
 * with no secret material in the message.
 */
export function parseDecryptedSecret(
  plaintext: Buffer,
  expectedType: StorableCredentialType,
): CredentialSecret {
  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext.toString("utf8"));
  } catch {
    throw new CredentialSecretParseError();
  }
  const result = credentialSecretSchema.safeParse(parsed);
  if (!result.success || result.data.type !== expectedType) {
    throw new CredentialSecretParseError();
  }
  return result.data;
}

/** Decrypted envelope bytes did not parse into the expected secret shape. */
export class CredentialSecretParseError extends Error {
  public constructor() {
    super("Decrypted credential material did not match the expected secret shape.");
    this.name = "CredentialSecretParseError";
  }
}
