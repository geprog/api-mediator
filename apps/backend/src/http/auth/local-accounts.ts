import { randomBytes } from "node:crypto";

import type { OperatorAccount } from "@mediator/config";
import { hashSecret, verifySecret } from "@mediator/credentials";
import type { FastifyRequest } from "fastify";

import type { Principal } from "./principal.js";
import type { AuthProvider } from "./provider.js";

/**
 * The Phase-3 local-accounts authentication provider — the documented fallback
 * when no SSO/OIDC is configured (`docs/architecture/security.md`).
 *
 * Transport: **HTTP Basic** (`Authorization: Basic base64(username:password)`).
 * Storage: each seeded {@link OperatorAccount} holds only a salted scrypt hash
 * of its password (from `@mediator/config`), never plaintext; a submitted
 * password is verified against it in constant time via
 * {@link verifySecret}. The provider never logs or returns the submitted
 * password.
 *
 * A self-hosted deployment terminates TLS in front of this surface, as Basic
 * transmits the password each request; that is a deployment concern, unchanged
 * by the provider seam.
 */
export class LocalAccountsAuthProvider implements AuthProvider {
  readonly #accountsByUsername: Map<string, OperatorAccount>;
  /**
   * A throwaway hash verified when the username is unknown, so an unknown user
   * costs the same scrypt work as a known one — response timing does not reveal
   * whether a username exists. Kicked off (not awaited) at construction.
   */
  readonly #decoyHash: Promise<string>;

  public constructor(accounts: readonly OperatorAccount[]) {
    this.#accountsByUsername = new Map(accounts.map((account) => [account.username, account]));
    this.#decoyHash = hashSecret(randomBytes(32).toString("hex"));
  }

  public async authenticate(request: FastifyRequest): Promise<Principal | null> {
    const credentials = parseBasicAuth(request.headers.authorization);
    if (credentials === null) {
      return null;
    }
    const account = this.#accountsByUsername.get(credentials.username);
    // Always run a verification — against the decoy hash for an unknown user —
    // to keep timing independent of whether the username exists.
    const encoded = account?.passwordHash ?? (await this.#decoyHash);
    const passwordMatches = await verifySecret(credentials.password, encoded);
    if (account === undefined || !passwordMatches) {
      return null;
    }
    return { identity: account.username, role: account.role };
  }
}

/** A parsed HTTP Basic credential pair. */
interface BasicCredentials {
  readonly username: string;
  readonly password: string;
}

/**
 * Parse an HTTP Basic `Authorization` header into a username/password pair, or
 * `null` when it is absent, not the Basic scheme, or malformed. Per RFC 7617 the
 * username contains no colon, so the pair splits on the first `:` — a password
 * may itself contain colons.
 */
function parseBasicAuth(header: string | string[] | undefined): BasicCredentials | null {
  const value = Array.isArray(header) ? header[0] : header;
  if (typeof value !== "string") {
    return null;
  }
  const match = /^Basic\s+(.+)$/i.exec(value.trim());
  if (match === null) {
    return null;
  }
  const decoded = Buffer.from(match[1] ?? "", "base64").toString("utf8");
  const separator = decoded.indexOf(":");
  if (separator === -1) {
    return null;
  }
  return { username: decoded.slice(0, separator), password: decoded.slice(separator + 1) };
}
