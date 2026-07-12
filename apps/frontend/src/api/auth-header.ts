/**
 * Transport-level home for the operator's HTTP Basic credential and the auth
 * lifecycle callbacks, kept **out** of the Pinia store so the plain {@link apiRequest}
 * fetch wrapper can read the header without a component/Pinia context.
 *
 * The credential lives here only as the already-encoded `Authorization` header
 * string (base64 of `user:pass`) — the SPA's single in-memory copy, never written
 * to `localStorage`/`sessionStorage` and gone on reload (a dev-SPA session, per
 * `docs/architecture/security.md`: TLS terminates in front, Basic transmits the
 * secret each request). The auth store owns the lifecycle (set on login, clear on
 * logout); this module is just the seam the fetch layer reads.
 *
 * The two callbacks let the fetch wrapper report an auth failure back to the store
 * without importing it (which would couple the transport to Pinia): a `401` means
 * the credential is missing/invalid (→ log out), a `403` means the caller is a
 * `viewer` attempting a mutation (→ read-only).
 */

let authHeader: string | null = null;
let onUnauthenticated: (() => void) | null = null;
let onForbidden: (() => void) | null = null;

/** UTF-8-safe base64 (a password may contain non-Latin-1 characters). */
function toBase64Utf8(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

/** Build the `Authorization: Basic …` header value for a username/password pair. */
export function encodeBasicAuth(username: string, password: string): string {
  return `Basic ${toBase64Utf8(`${username}:${password}`)}`;
}

/** Install the current credential (or clear it with `null`). */
export function setAuthHeader(header: string | null): void {
  authHeader = header;
}

/** The current `Authorization` header value, or `null` when logged out. */
export function getAuthHeader(): string | null {
  return authHeader;
}

/** Register the store's reactions to transport-level auth failures. */
export function registerAuthEventHandlers(handlers: {
  onUnauthenticated: () => void;
  onForbidden: () => void;
}): void {
  onUnauthenticated = handlers.onUnauthenticated;
  onForbidden = handlers.onForbidden;
}

/** Called by the fetch wrapper on a 401 (missing/invalid credential). */
export function notifyUnauthenticated(): void {
  onUnauthenticated?.();
}

/** Called by the fetch wrapper on a 403 (authenticated, but role-forbidden). */
export function notifyForbidden(): void {
  onForbidden?.();
}
