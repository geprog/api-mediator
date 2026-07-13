import type { UsableCredentialSecret } from "@mediator/credentials";
import type { CredentialApplier } from "@mediator/outbound";

/**
 * The composition-root {@link CredentialApplier} — the seam that turns a decrypted
 * {@link UsableCredentialSecret} into request auth **inside** the
 * `CredentialStore.withCredential` scope (OC-1; the source reader / single-record
 * reader use the same applier). It is a pure header transform: it never logs,
 * returns, or persists the secret material — it only writes it onto the outbound
 * request headers that stay in flight (`docs/architecture/security.md`).
 *
 * The per-type mapping (`docs/architecture/data-model.md` `Credential.type`):
 *  - **apiKey** → the configured header (default `Authorization`) carrying the key,
 *    prefixed with the configured scheme when one is set (default `Bearer`). API-key
 *    header conventions differ per app (`Authorization: Bearer`, a bare
 *    `X-API-Key`, …); the header **name** and the optional scheme are the only
 *    configuration — the key value itself is always the stored secret.
 *  - **oauth2** → `Authorization: Bearer <accessToken>` (the store already stripped
 *    the refresh token; only the live access token crosses into the applier).
 *  - **basicAuth** → `Authorization: Basic base64(username:password)`.
 *  - **custom** → each configured header/value pair, applied verbatim (lower-cased
 *    header keys, matching the `OutboundResponse` header convention).
 *
 * Header keys are written lower-cased so a caller-supplied header and an
 * applier-supplied one collide deterministically (the last write wins), mirroring
 * the executor's default applier.
 */

/** Configuration for {@link createCredentialApplier} — only the un-persistable auth-shape bits. */
export interface CredentialApplierOptions {
  /**
   * The header an `apiKey` credential is placed on (case-insensitive; stored
   * lower-cased). Default {@link DEFAULT_API_KEY_HEADER}.
   */
  readonly apiKeyHeader?: string;
  /**
   * The scheme prefix for an `apiKey` value (e.g. `Bearer` → `Authorization: Bearer <key>`).
   * An empty string places the bare key (the `X-API-Key: <key>` convention). Default
   * {@link DEFAULT_API_KEY_SCHEME}.
   */
  readonly apiKeyScheme?: string;
}

/** The default `apiKey` header — `Authorization`, matching the executor's built-in default. */
export const DEFAULT_API_KEY_HEADER = "authorization";
/** The default `apiKey` scheme — `Bearer`, matching the executor's built-in default. */
export const DEFAULT_API_KEY_SCHEME = "Bearer";

/**
 * Build the {@link CredentialApplier} the sync composition passes to the Outbound Call
 * Executor, the REST source reader, and the single-record target reader. Pure — the
 * secret is only ever read here, never captured.
 */
export function createCredentialApplier(options: CredentialApplierOptions = {}): CredentialApplier {
  const apiKeyHeader = (options.apiKeyHeader ?? DEFAULT_API_KEY_HEADER).toLowerCase();
  const apiKeyScheme = options.apiKeyScheme ?? DEFAULT_API_KEY_SCHEME;

  return (
    headers: Readonly<Record<string, string>>,
    secret: UsableCredentialSecret,
  ): Record<string, string> => {
    const out: Record<string, string> = { ...headers };
    switch (secret.type) {
      case "apiKey":
        out[apiKeyHeader] =
          apiKeyScheme.length > 0 ? `${apiKeyScheme} ${secret.apiKey}` : secret.apiKey;
        break;
      case "oauth2":
        out["authorization"] = `Bearer ${secret.accessToken}`;
        break;
      case "basicAuth":
        out["authorization"] =
          `Basic ${Buffer.from(`${secret.username}:${secret.password}`, "utf8").toString("base64")}`;
        break;
      case "custom":
        for (const [key, value] of Object.entries(secret.values)) {
          out[key.toLowerCase()] = value;
        }
        break;
    }
    return out;
  };
}
