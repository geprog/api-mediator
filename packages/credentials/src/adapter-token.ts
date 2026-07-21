import { randomBytes, randomUUID } from "node:crypto";

import { isCredentialValidAt } from "@mediator/domain";

import { hashSecret, verifySecret } from "./hashing.js";

/**
 * The **adapter token** (Phase-5 AT-1..AT-4): a consumer `RegisteredApp`'s
 * mediator-issued credential for authenticating its calls to its own generated
 * adapter surface. The Auth Gateway validates it per request in front of the
 * Adapter Server Runtime (`docs/architecture/security.md` *Inbound authentication
 * to generated adapter servers*; `docs/architecture/adapter-engine.md` *Request
 * pipeline* step 2).
 *
 * ## The invariants (authoritative), the format (an implementation choice)
 *
 * The raw token is **displayed exactly once** at issuance and never again — only a
 * **salted one-way hash** of its secret part is stored, since validation needs
 * equality and never the original value. The raw token is never persisted, logged,
 * returned, or written to an audit row; validation is a constant-time
 * hash-equality check ({@link verifySecret}, `timingSafeEqual`), never a decrypt.
 *
 * The **format** is this slice's choice (the concept fixes only the invariants):
 *
 *   `amt.<credentialId>.<secretHex>`
 *
 * - `amt` — a scheme tag so a non-adapter-token string is rejected structurally.
 * - `<credentialId>` — the owning `Credential` row's id. **Not a secret** (it is
 *   already recorded in audit rows); it is a public *lookup key* so validation is a
 *   single indexed read + a single hash verification rather than a scan over every
 *   app's stored hash (a salted hash cannot be looked up by value). During a
 *   rotation overlap the two live tokens carry two different credential ids, so the
 *   audit distinguishes which one served a request (AT-4.3) directly from the token.
 * - `<secretHex>` — 32 random bytes as hex (256 bits). This is the **only** part
 *   that is hashed and stored; it is what an attacker would have to forge.
 */

/** The scheme tag prefixing every adapter token; rejects a non-adapter-token string fast. */
export const ADAPTER_TOKEN_SCHEME = "amt";

/** Random secret length in bytes (256 bits of entropy in the token's secret part). */
const SECRET_BYTES = 32;

/** A UUID (the `Credential` row id) — hex groups with hyphens, never a `.`. */
const CREDENTIAL_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** The secret part: exactly {@link SECRET_BYTES} bytes rendered as lowercase hex. */
const SECRET_PATTERN = /^[0-9a-f]{64}$/;

/** A structurally-valid adapter token, split into its lookup key and secret part. */
export interface ParsedAdapterToken {
  readonly credentialId: string;
  readonly secret: string;
}

/** Generate a fresh high-entropy secret part (never persisted in the clear). */
export function generateAdapterTokenSecret(): string {
  return randomBytes(SECRET_BYTES).toString("hex");
}

/** Assemble the raw token shown exactly once at issuance. */
export function formatAdapterToken(credentialId: string, secret: string): string {
  return `${ADAPTER_TOKEN_SCHEME}.${credentialId}.${secret}`;
}

/**
 * Parse a presented raw token into its `credentialId` + `secret`, or `null` for
 * any structurally-invalid value (wrong scheme, wrong shape, extra segments). A
 * `null` is a clean rejection — it never reaches a hash comparison or a backend.
 */
export function parseAdapterToken(raw: string): ParsedAdapterToken | null {
  const parts = raw.split(".");
  if (parts.length !== 3) {
    return null;
  }
  const [scheme, credentialId, secret] = parts;
  if (scheme !== ADAPTER_TOKEN_SCHEME) {
    return null;
  }
  if (credentialId === undefined || !CREDENTIAL_ID_PATTERN.test(credentialId)) {
    return null;
  }
  if (secret === undefined || !SECRET_PATTERN.test(secret)) {
    return null;
  }
  return { credentialId, secret };
}

/**
 * A stored `adapterToken` `Credential` row, as the token store needs it. The
 * `hashedSecret` is the row's `encryptedPayload` — a salted one-way hash, never
 * envelope ciphertext and never the raw token. Read only by this credential-store
 * accessor for an equality check; it is never returned through any API layer.
 */
export interface AdapterTokenRecord {
  readonly credentialId: string;
  readonly appId: string;
  readonly hashedSecret: string;
  readonly lastRotatedAt: Date;
  /** Absent = the unbounded current token; a past value = rotated-out/revoked (AD-3). */
  readonly validUntil?: Date;
}

/** The write shape for a fresh `adapterToken` credential row. */
export interface NewAdapterTokenRecord {
  readonly credentialId: string;
  readonly appId: string;
  readonly hashedSecret: string;
  readonly lastRotatedAt: Date;
  /** Omit for the unbounded current token; set to stamp a rotation/overlap bound. */
  readonly validUntil?: Date;
}

/**
 * Persistence for `adapterToken` credential rows, a narrow port so the store is
 * unit-testable against an in-memory fake. The real Postgres-backed implementation
 * ({@link DbAdapterTokenPersistence}) is the sole reader of the salted-hash column
 * for these rows — the same "only a credential-store-internal accessor touches the
 * payload column" discipline the envelope path keeps (`docs/architecture/security.md`).
 */
export interface AdapterTokenPersistence {
  /** Insert a new `adapterToken` row (hash only — never the raw token). */
  create(record: NewAdapterTokenRecord): Promise<void>;
  /** The `adapterToken` row with this id, or `null` — filters out non-token types. */
  findById(credentialId: string): Promise<AdapterTokenRecord | null>;
  /** Every `adapterToken` row for an app (both a current token and any overlap). */
  listByAppId(appId: string): Promise<readonly AdapterTokenRecord[]>;
  /** Stamp a row's `valid_until` (rotation overlap bound, or an early cutover). */
  setValidUntil(credentialId: string, validUntil: Date): Promise<void>;
  /** Delete every `adapterToken` row for an app; returns the count (deregister). */
  deleteByAppId(appId: string): Promise<number>;
}

/**
 * Whether an app may hold/use an adapter token: it must exist, be a **consumer**
 * app (carry a `CONSUMER` `ApiSpec` — AT-1.4/AT-3.4), and be **active** (a disabled
 * app's token is revoked implicitly — AT-4.4). A discriminated result so the
 * operator API can report the specific reason a token cannot be issued.
 */
export type ConsumerAppEligibility =
  | { readonly kind: "eligible" }
  | { readonly kind: "not-found" }
  | { readonly kind: "not-consumer" }
  | { readonly kind: "not-active" };

/** Reads {@link ConsumerAppEligibility} for an app id (backend-provided). */
export interface ConsumerAppEligibilityReader {
  check(appId: string): Promise<ConsumerAppEligibility>;
}

/** The one-time issuance result — the only place the raw token ever exists. */
export interface IssuedAdapterToken {
  /** The raw token, **shown exactly once**; never returned again (AT-1.1/AT-1.2). */
  readonly rawToken: string;
  readonly credentialId: string;
  readonly issuedAt: Date;
}

/**
 * The outcome of {@link AdapterTokenStore.issue}/{@link AdapterTokenStore.rotate}.
 * `rotated` is `true` when a live current token was moved into the overlap window
 * (a re-issue/rotation), `false` for a first issuance (AT-1.5).
 */
export type IssueTokenResult =
  | { readonly outcome: "issued"; readonly token: IssuedAdapterToken; readonly rotated: boolean }
  | { readonly outcome: "app-not-found" }
  | { readonly outcome: "app-not-consumer" }
  | { readonly outcome: "app-not-active" };

/** The outcome of {@link AdapterTokenStore.cutover}. */
export type CutoverResult =
  | { readonly outcome: "cutover"; readonly endedCredentialIds: readonly string[] }
  | { readonly outcome: "nothing-to-cutover" }
  | { readonly outcome: "app-not-found" }
  | { readonly outcome: "app-not-consumer" }
  | { readonly outcome: "app-not-active" };

/** Why a presented token was rejected — non-secret metadata for logs/telemetry. */
export type AdapterTokenRejectionReason =
  "malformed" | "unknown" | "secret-mismatch" | "expired" | "app-ineligible";

/**
 * The outcome of {@link AdapterTokenStore.validate}: either the request binds to a
 * consumer app + the credential id that authenticated it (for the audit — AT-4.3),
 * or it is rejected (every rejection is a single 401 to the caller; the `reason` is
 * for internal telemetry only, never the token value).
 */
export type ValidateTokenResult =
  | { readonly outcome: "resolved"; readonly consumerAppId: string; readonly credentialId: string }
  | { readonly outcome: "rejected"; readonly reason: AdapterTokenRejectionReason };

/** Construction seams for {@link AdapterTokenStore} (clock/id/secret injectable for tests). */
export interface AdapterTokenStoreOptions {
  /** The rotation overlap window in ms (config-defined — AT-4.2). */
  readonly rotationOverlapMs: number;
  readonly now?: () => Date;
  readonly newCredentialId?: () => string;
  readonly newSecret?: () => string;
}

/**
 * The adapter-token lifecycle service: **issue** (shown once), **rotate** (mint a
 * new token, keep the previous one valid through the overlap window), **cutover**
 * (end the overlap early), **validate** (per-request hash-equality), and
 * **deleteForApp** (the deregister-cascade step). It reuses AD-3's two-row rotation
 * model — a new `Credential` row plus a stamped `validUntil` on the superseded row —
 * so it never re-models rotation.
 *
 * Dependencies are injected so it is unit-testable with an in-memory persistence
 * fake and a fake eligibility reader.
 */
export class AdapterTokenStore {
  readonly #persistence: AdapterTokenPersistence;
  readonly #eligibility: ConsumerAppEligibilityReader;
  readonly #now: () => Date;
  readonly #newCredentialId: () => string;
  readonly #newSecret: () => string;
  readonly #rotationOverlapMs: number;
  /**
   * A throwaway hash verified when the presented credential id is unknown, so an
   * unknown token costs the same scrypt work as a known one — request timing does
   * not reveal whether a credential id exists. Computed lazily and once.
   */
  #decoyHash: Promise<string> | undefined;

  public constructor(
    persistence: AdapterTokenPersistence,
    eligibility: ConsumerAppEligibilityReader,
    options: AdapterTokenStoreOptions,
  ) {
    this.#persistence = persistence;
    this.#eligibility = eligibility;
    this.#rotationOverlapMs = options.rotationOverlapMs;
    this.#now = options.now ?? ((): Date => new Date());
    this.#newCredentialId = options.newCredentialId ?? ((): string => randomUUID());
    this.#newSecret = options.newSecret ?? generateAdapterTokenSecret;
  }

  /**
   * Issue an adapter token for a consumer app, returning the raw token **once**. If
   * the app already has a live current token, this follows the rotation path — the
   * previous token is moved into the overlap window rather than silently
   * invalidated (AT-1.5), so `issue` never breaks a live consumer.
   */
  public issue(appId: string): Promise<IssueTokenResult> {
    return this.#mint(appId);
  }

  /**
   * Rotate a consumer app's token: mint a new one (shown once) and keep the
   * previous token valid for the overlap window, stamping its `validUntil` (AT-4.1).
   * Behaviourally identical to {@link issue} — the two-row overlap model is the same;
   * the distinct operation exists so the operator API and audit label it a rotation.
   */
  public rotate(appId: string): Promise<IssueTokenResult> {
    return this.#mint(appId);
  }

  async #mint(appId: string): Promise<IssueTokenResult> {
    const eligibility = await this.#eligibility.check(appId);
    if (eligibility.kind === "not-found") {
      return { outcome: "app-not-found" };
    }
    if (eligibility.kind === "not-consumer") {
      return { outcome: "app-not-consumer" };
    }
    if (eligibility.kind === "not-active") {
      return { outcome: "app-not-active" };
    }

    const now = this.#now();
    // Move any live *current* (unbounded) token into the overlap window — old and new
    // both valid until the bound elapses or an operator confirms cutover (AT-4.1/4.2).
    const existing = await this.#persistence.listByAppId(appId);
    const currentTokens = existing.filter(
      (record) => record.validUntil === undefined && isCredentialValidAt(record, now),
    );
    const overlapUntil = new Date(now.getTime() + this.#rotationOverlapMs);
    for (const record of currentTokens) {
      await this.#persistence.setValidUntil(record.credentialId, overlapUntil);
    }

    const credentialId = this.#newCredentialId();
    const secret = this.#newSecret();
    const hashedSecret = await hashSecret(secret);
    await this.#persistence.create({ credentialId, appId, hashedSecret, lastRotatedAt: now });

    return {
      outcome: "issued",
      token: { rawToken: formatAdapterToken(credentialId, secret), credentialId, issuedAt: now },
      rotated: currentTokens.length > 0,
    };
  }

  /**
   * End a rotation overlap early (an explicit operator cutover — AT-4.2): stamp
   * `validUntil = now` on every currently-valid token **except** the app's current
   * one, so only the current token keeps validating. A no-op (`nothing-to-cutover`)
   * when there is no overlap in progress.
   */
  public async cutover(appId: string): Promise<CutoverResult> {
    const eligibility = await this.#eligibility.check(appId);
    if (eligibility.kind === "not-found") {
      return { outcome: "app-not-found" };
    }
    if (eligibility.kind === "not-consumer") {
      return { outcome: "app-not-consumer" };
    }
    if (eligibility.kind === "not-active") {
      return { outcome: "app-not-active" };
    }

    const now = this.#now();
    const valid = (await this.#persistence.listByAppId(appId)).filter((record) =>
      isCredentialValidAt(record, now),
    );
    const current = pickCurrentToken(valid);
    const toEnd = valid.filter((record) => record.credentialId !== current?.credentialId);
    if (toEnd.length === 0) {
      return { outcome: "nothing-to-cutover" };
    }
    for (const record of toEnd) {
      await this.#persistence.setValidUntil(record.credentialId, now);
    }
    return { outcome: "cutover", endedCredentialIds: toEnd.map((record) => record.credentialId) };
  }

  /**
   * Validate a presented raw token (AT-2): parse it, look the credential up by its
   * embedded id, verify the secret against the stored salted hash in **constant
   * time** ({@link verifySecret}), and confirm the credential is still within its
   * validity bound (AD-3) and its owning app is an active consumer app (AT-4.4).
   * Returns the bound `consumerAppId` + the matched `credentialId`, or a rejection.
   *
   * The stored hash is never decrypted (it is one-way) and the raw token is never
   * persisted or logged here. A verification runs even for an unknown credential id
   * (against a decoy hash) so timing does not reveal whether the id exists.
   */
  public async validate(rawToken: string): Promise<ValidateTokenResult> {
    const parsed = parseAdapterToken(rawToken);
    if (parsed === null) {
      // Structurally not an adapter token — no hash work, a clean rejection.
      return { outcome: "rejected", reason: "malformed" };
    }

    const candidate = await this.#persistence.findById(parsed.credentialId);
    const encoded = candidate?.hashedSecret ?? (await this.#decoy());
    // Constant-time hash equality (timingSafeEqual inside verifySecret): a naive
    // `===` on the hash would leak how much of it matched. Run unconditionally so an
    // unknown id costs the same as a known one.
    const secretMatches = await verifySecret(parsed.secret, encoded);
    if (candidate === null || !secretMatches) {
      return { outcome: "rejected", reason: candidate === null ? "unknown" : "secret-mismatch" };
    }

    if (!isCredentialValidAt(candidate, this.#now())) {
      // Rotated-out (overlap elapsed) or explicitly revoked — a recognized token that
      // no longer validates (AT-4.2), still a clean 401 to the caller.
      return { outcome: "rejected", reason: "expired" };
    }

    const eligibility = await this.#eligibility.check(candidate.appId);
    if (eligibility.kind !== "eligible") {
      // App disabled or no longer a consumer app — revocation is implicit in status
      // (AT-4.4); a provider-only app's token authorizes nothing (AT-3.4).
      return { outcome: "rejected", reason: "app-ineligible" };
    }

    return {
      outcome: "resolved",
      consumerAppId: candidate.appId,
      credentialId: candidate.credentialId,
    };
  }

  /**
   * Delete every `adapterToken` credential for an app outright — the
   * deregister-cascade step (AT-4.5): the tokens are **deleted, not archived**, so a
   * live token dies with its app. Returns the number of rows removed.
   */
  public deleteForApp(appId: string): Promise<number> {
    return this.#persistence.deleteByAppId(appId);
  }

  #decoy(): Promise<string> {
    if (this.#decoyHash === undefined) {
      // A construction-time scrypt rejection (practically unreachable) yields an
      // unparseable sentinel, so verifySecret returns false and the caller still 401s.
      this.#decoyHash = hashSecret(this.#newSecret()).catch(() => "decoy-unavailable");
    }
    return this.#decoyHash;
  }
}

/**
 * The app's *current* token among its currently-valid rows: the unbounded one
 * (`validUntil` absent), newest-rotated first; falling back to the newest-rotated
 * row if — unexpectedly — none is unbounded. Everything else valid is an overlap
 * token a cutover ends.
 */
function pickCurrentToken(valid: readonly AdapterTokenRecord[]): AdapterTokenRecord | undefined {
  const byNewest = [...valid].sort((a, b) => b.lastRotatedAt.getTime() - a.lastRotatedAt.getTime());
  return byNewest.find((record) => record.validUntil === undefined) ?? byNewest[0];
}
