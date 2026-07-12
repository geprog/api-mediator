import { randomUUID } from "node:crypto";

import { stripUndefined, type AuditLogEntry, type Credential } from "@mediator/domain";
import type { CredentialMetadata } from "@mediator/db";

import { openEnvelope, sealEnvelope } from "./envelope.js";
import type { KeyProvider } from "./key-provider.js";
import {
  parseCredentialMaterial,
  parseDecryptedSecret,
  toUsableSecret,
  type CredentialMaterial,
  type CredentialSecret,
  type StorableCredentialType,
  type UsableCredentialSecret,
} from "./material.js";

/**
 * The persistence the {@link CredentialStore} needs. Three operations,
 * deliberately split by trust level:
 *  - `create` is the public write path (returns metadata only, never a payload).
 *  - `loadEnvelope` is the store's **internal decrypt accessor** — the only read
 *    that touches `encrypted_payload`. It is intentionally *not* part of
 *    `@mediator/db`'s `CredentialRepository`, whose public surface stays
 *    write-only (metadata reads only). This keeps "only the Credential Store's
 *    internal accessor can decrypt a credential" true (security.md).
 *  - `updateEnvelope` re-persists a re-encrypted payload in place — the store's
 *    internal write for an OAuth2 refresh (CD-2). Also store-internal: it never
 *    accepts or returns plaintext, only the already-sealed envelope string.
 *
 * Defined as a narrow port so the store is unit-testable with an in-memory fake;
 * {@link DbCredentialPersistence} is the real Postgres-backed implementation.
 */
export interface CredentialPersistence {
  /** Persist an (already envelope-encrypted) credential; returns metadata only. */
  create(credential: Credential): Promise<CredentialMetadata>;
  /**
   * The envelope ciphertext + metadata for an app's credential, or `null` when
   * the app has none (a valid public/no-auth app — CR-1). Store-internal.
   */
  loadEnvelope(appId: string): Promise<StoredEnvelope | null>;
  /**
   * Replace the stored envelope ciphertext for `credentialId` in place, after an
   * internal OAuth2 refresh re-encrypts updated tokens (CD-2). `lastRotatedAt` is
   * deliberately left untouched (a refresh is not an operator rotation).
   * Store-internal; the argument is opaque ciphertext, never plaintext.
   */
  updateEnvelope(credentialId: string, encryptedPayload: string): Promise<void>;
}

/** The store-internal view of a stored credential, including its ciphertext. */
export interface StoredEnvelope {
  readonly credentialId: string;
  readonly type: StorableCredentialType;
  readonly scopes: readonly string[];
  readonly encryptedPayload: string;
}

/**
 * The decrypted credential handed transiently to a `withCredential` callback.
 * It carries a {@link UsableCredentialSecret} — the currently-valid secret with
 * no refresh material (an `oauth2` credential exposes only its access token). It
 * is created inside the `withCredential` scope, never returned from it, and never
 * cached.
 */
export interface DecryptedCredential {
  readonly credentialId: string;
  readonly type: StorableCredentialType;
  readonly scopes: readonly string[];
  readonly secret: UsableCredentialSecret;
}

/**
 * The outcome of {@link CredentialStore.withCredential}, a discriminated union so
 * the Outbound Call Executor handles each case explicitly rather than via a
 * nullable secret:
 *  - `invoked` — the callback ran; carries its value (never the secret).
 *  - `no-credential` — the app has no stored credential (a valid public/no-auth
 *    app); `fn` was not invoked.
 *  - `credential-refresh-failure` — an `oauth2` access token needed refreshing and
 *    the refresh failed (revoked/provider error); `fn` was not invoked and no
 *    stale token was handed out (CD-2 criterion 4). `reason` is a non-secret note.
 */
export type WithCredentialResult<T> =
  | { readonly outcome: "invoked"; readonly value: T }
  | { readonly outcome: "no-credential" }
  | { readonly outcome: "credential-refresh-failure"; readonly reason: string };

/**
 * The metadata-only logger the store writes through. Fields are constrained to
 * non-secret primitives so no code path can hand it a secret value; the default
 * is a no-op. This is the operational (structured-log) seam; the durable
 * `credential-access` audit trail is written through {@link CredentialAccessAuditor}.
 */
export interface CredentialStoreLogger {
  info(message: string, fields: Readonly<Record<string, string | number | boolean>>): void;
}

const noopLogger: CredentialStoreLogger = {
  info: (): void => {
    /* no-op: the store logs nothing unless a real logger is injected */
  },
};

/**
 * The durable `credential-access` audit sink (CD-3). The store constructs a
 * metadata-only {@link AuditLogEntry} (never a secret) and hands it here; the real
 * implementation ({@link DbCredentialAccessAuditor}) appends it to the
 * `SyncEvent`/`AuditLog`. The default is a no-op so the store runs without an
 * audit backend wired.
 */
export interface CredentialAccessAuditor {
  record(entry: AuditLogEntry): Promise<void>;
}

const noopAuditor: CredentialAccessAuditor = {
  record: (): Promise<void> => Promise.resolve(),
};

/** traceId/spanId of the active outbound-call span, stamped onto audit entries. */
export interface TraceContext {
  readonly traceId: string;
  readonly spanId: string;
}

/** The inputs an {@link OAuth2Refresher} needs to exchange a refresh token. */
export interface OAuth2RefreshRequest {
  readonly appId: string;
  readonly refreshToken: string;
  readonly scopes: readonly string[];
}

/** The tokens an {@link OAuth2Refresher} returns from a successful refresh. */
export interface OAuth2RefreshedTokens {
  readonly accessToken: string;
  /** A rotated refresh token, when the provider issues one; otherwise absent. */
  readonly refreshToken?: string;
  /** The new access-token expiry, when the provider reports one. */
  readonly expiresAt?: Date;
}

/**
 * Performs the OAuth2 refresh-token exchange against the provider. This is the
 * **only** seam that ever sees the refresh token; the store calls it internally
 * and never exposes it to `fn`. The specific grant/endpoints per provider are
 * implementation configuration (out of scope here) — a `refresh` that fails
 * throws, and the store surfaces a `credential-refresh-failure` outcome.
 */
export interface OAuth2Refresher {
  refresh(request: OAuth2RefreshRequest): Promise<OAuth2RefreshedTokens>;
}

/**
 * Optional Phase-4 seams for {@link CredentialStore.withCredential}. All optional
 * so the write-only `store` construction sites are unaffected; the Outbound Call
 * Executor wires them when it drives `fn`.
 */
export interface CredentialStoreOptions {
  /** Where `credential-access` audit entries are recorded (default: no-op). */
  readonly auditor?: CredentialAccessAuditor;
  /** The OAuth2 refresh-token exchange (default: none — refresh is impossible). */
  readonly oauth2Refresher?: OAuth2Refresher;
  /** Reads the active trace context for audit correlation (default: `null`). */
  readonly readTraceContext?: () => TraceContext | null;
  /** Clock seam (default: `() => new Date()`). */
  readonly now?: () => Date;
  /** Refresh an `oauth2` token this many ms *before* it expires (default: 60s). */
  readonly refreshThresholdMs?: number;
  /** The audit `actor` for credential access (default: `"system"`). */
  readonly actor?: string;
}

/** Refresh an `oauth2` token when it expires within this window (CD-2). */
const DEFAULT_REFRESH_THRESHOLD_MS = 60_000;

/**
 * The audit `actor` for a `credential-access` entry: credential access via
 * `withCredential` is always a system action driven by the Sync/Adapter engines,
 * never a direct operator mutation, so it is attributed to the system rather than
 * to an operator identity.
 */
const CREDENTIAL_ACCESS_ACTOR = "system";

/** The internal result of an OAuth2 refresh attempt inside the store. */
type RefreshOutcome =
  | { readonly status: "refreshed"; readonly secret: CredentialSecret }
  | { readonly status: "failure"; readonly reason: string };

/**
 * The Credential Store service: write-only `store` and the mandated
 * `withCredential` decrypt-for-use access pattern (see
 * `docs/architecture/security.md`). Dependencies are constructor-injected so the
 * store is unit-testable with a fake {@link CredentialPersistence}, a throwaway
 * {@link KeyProvider}, and in-memory {@link CredentialStoreOptions} seams.
 */
export class CredentialStore {
  readonly #persistence: CredentialPersistence;
  readonly #keyProvider: KeyProvider;
  readonly #logger: CredentialStoreLogger;
  readonly #auditor: CredentialAccessAuditor;
  readonly #oauth2Refresher: OAuth2Refresher | undefined;
  readonly #readTraceContext: () => TraceContext | null;
  readonly #now: () => Date;
  readonly #refreshThresholdMs: number;
  readonly #actor: string;

  public constructor(
    persistence: CredentialPersistence,
    keyProvider: KeyProvider,
    logger: CredentialStoreLogger = noopLogger,
    options: CredentialStoreOptions = {},
  ) {
    this.#persistence = persistence;
    this.#keyProvider = keyProvider;
    this.#logger = logger;
    this.#auditor = options.auditor ?? noopAuditor;
    this.#oauth2Refresher = options.oauth2Refresher;
    this.#readTraceContext = options.readTraceContext ?? ((): null => null);
    this.#now = options.now ?? ((): Date => new Date());
    this.#refreshThresholdMs = options.refreshThresholdMs ?? DEFAULT_REFRESH_THRESHOLD_MS;
    this.#actor = options.actor ?? CREDENTIAL_ACCESS_ACTOR;
  }

  /**
   * Write-only store: validate `material`, envelope-encrypt its secret, persist,
   * and return metadata (id/type/scopes/lastRotatedAt) — **never** the payload.
   * Rejects `adapterToken` (and any non-storable type) up front (CR-1). Sets
   * `lastRotatedAt` to creation time.
   */
  public async store(appId: string, material: CredentialMaterial): Promise<CredentialMetadata> {
    const parsed = parseCredentialMaterial(material);
    const credentialId = randomUUID();
    const lastRotatedAt = new Date();
    const scopes = [...(parsed.scopes ?? [])];

    const plaintext = Buffer.from(JSON.stringify(parsed.secret), "utf8");
    let encryptedPayload: string;
    try {
      encryptedPayload = sealEnvelope(plaintext, this.#keyProvider.getMasterKey());
    } finally {
      // The plaintext buffer is wiped whether encryption succeeds or throws.
      plaintext.fill(0);
    }

    const credential: Credential = {
      id: credentialId,
      appId,
      type: parsed.secret.type,
      encryptedPayload,
      scopes,
      lastRotatedAt,
    };
    const metadata = await this.#persistence.create(credential);

    this.#logger.info("credential stored", {
      credentialId,
      appId,
      type: parsed.secret.type,
      scopeCount: scopes.length,
    });
    return metadata;
  }

  /**
   * The mandated access pattern: load the app's credential, decrypt inside this
   * scope, hand `fn` a currently-valid secret, and never let the plaintext outlive
   * the call. `fn`'s return value is the only thing propagated out — the secret is
   * neither returned nor retained.
   *
   * Outcomes (a discriminated {@link WithCredentialResult} the caller branches on):
   *  - the app has no credential → `fn` is not called, `no-credential` (CD-1);
   *  - an `oauth2` token needs refreshing and the refresh fails → `fn` is not
   *    called, `credential-refresh-failure` (CD-2) — never a stale-token call;
   *  - otherwise `fn` runs and its value is returned as `invoked`.
   *
   * No-retention: the decrypted plaintext buffer is zeroed in `finally`; the parsed
   * secret's string fields cannot be zeroed in V8 but are unreferenced once this
   * method returns, so they become GC-eligible immediately. Every successful
   * decrypt (and every no-credential access) is recorded as a metadata-only
   * `credential-access` audit entry (CD-3).
   */
  public async withCredential<T>(
    appId: string,
    fn: (credential: DecryptedCredential) => Promise<T>,
  ): Promise<WithCredentialResult<T>> {
    const envelope = await this.#persistence.loadEnvelope(appId);
    if (envelope === null) {
      this.#logger.info("credential access: none stored", { appId });
      // CD-3 criterion 3: audit the public-app case as "no credential used" — a
      // distinguishable record, not a silent gap.
      await this.#recordNoCredential(appId);
      return { outcome: "no-credential" };
    }

    const plaintext = openEnvelope(envelope.encryptedPayload, this.#keyProvider.getMasterKey());
    let refreshed = false;
    try {
      let secret = parseDecryptedSecret(plaintext, envelope.type);

      // CD-2: OAuth2 access-token refresh, entirely inside the store. The caller
      // never sees the refresh token and never triggers the refresh.
      if (secret.type === "oauth2" && this.#oauth2NeedsRefresh(secret)) {
        const result = await this.#refreshOAuth2(
          appId,
          envelope.credentialId,
          envelope.scopes,
          secret,
        );
        if (result.status === "failure") {
          // No currently-valid token to hand `fn`: the outbound call cannot proceed
          // with a stale token masquerading as valid (CD-2 criterion 4). The failed
          // call itself is recorded by OC-4, not here; log metadata only.
          this.#logger.info("credential access: oauth2 refresh failed", {
            credentialId: envelope.credentialId,
            appId,
            type: envelope.type,
          });
          return { outcome: "credential-refresh-failure", reason: result.reason };
        }
        secret = result.secret;
        refreshed = true;
      }

      const decrypted: DecryptedCredential = {
        credentialId: envelope.credentialId,
        type: envelope.type,
        scopes: envelope.scopes,
        // CD-2 criterion 1: `oauth2` hands only the live access token — never the
        // refresh token.
        secret: toUsableSecret(secret),
      };
      this.#logger.info("credential accessed", {
        credentialId: envelope.credentialId,
        appId,
        type: envelope.type,
        refreshed,
      });
      // CD-3 criterion 1/2: record the decrypt (noting a refresh) before handing the
      // secret to `fn`, so the access is on the record even if the outbound call
      // throws.
      await this.#recordAccess(appId, envelope.credentialId, refreshed);

      // CD-1 least privilege: `fn` runs with a credential scoped to this one app for
      // this one call; the decrypted secret is never cached or reused for another app.
      const value = await fn(decrypted);
      return { outcome: "invoked", value };
    } finally {
      plaintext.fill(0);
    }
  }

  /** True when an `oauth2` access token is expired or within the refresh window. */
  #oauth2NeedsRefresh(secret: Extract<CredentialSecret, { type: "oauth2" }>): boolean {
    if (secret.expiresAt === undefined) {
      // No known expiry: the store cannot prove the token stale, so it hands it
      // as-is rather than speculatively refreshing (CD-2 criterion 2 spirit).
      return false;
    }
    const expiresAtMs = Date.parse(secret.expiresAt);
    if (Number.isNaN(expiresAtMs)) {
      return false;
    }
    return expiresAtMs <= this.#now().getTime() + this.#refreshThresholdMs;
  }

  /**
   * Refresh an expiring `oauth2` credential inside the store: exchange the refresh
   * token, re-envelope-encrypt the updated tokens exactly as at `store` time, and
   * persist them in place. Returns the new secret to hand `fn`, or a failure the
   * caller surfaces as `credential-refresh-failure` (never a stale-token call).
   */
  async #refreshOAuth2(
    appId: string,
    credentialId: string,
    scopes: readonly string[],
    secret: Extract<CredentialSecret, { type: "oauth2" }>,
  ): Promise<RefreshOutcome> {
    const refresher = this.#oauth2Refresher;
    if (refresher === undefined) {
      return {
        status: "failure",
        reason: "oauth2 access token expired but no refresher is configured",
      };
    }
    if (secret.refreshToken === undefined) {
      return {
        status: "failure",
        reason: "oauth2 access token expired and no refresh token is stored",
      };
    }

    let refreshed: OAuth2RefreshedTokens;
    try {
      refreshed = await refresher.refresh({ appId, refreshToken: secret.refreshToken, scopes });
    } catch {
      // Generic reason only — never surface a provider error that could carry token
      // material into logs/results.
      return { status: "failure", reason: "oauth2 token refresh failed" };
    }

    const newSecret: CredentialSecret = stripUndefined({
      type: "oauth2" as const,
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken ?? secret.refreshToken,
      expiresAt: refreshed.expiresAt?.toISOString(),
    });

    // CD-2 criterion 3: re-envelope-encrypt (exactly as at `store` time) and persist
    // in place; refreshed material is never persisted in plaintext, and the
    // re-encrypt plaintext buffer is zeroed whether sealing/persisting succeeds or
    // throws.
    const newPlaintext = Buffer.from(JSON.stringify(newSecret), "utf8");
    try {
      const encryptedPayload = sealEnvelope(newPlaintext, this.#keyProvider.getMasterKey());
      await this.#persistence.updateEnvelope(credentialId, encryptedPayload);
    } finally {
      newPlaintext.fill(0);
    }
    return { status: "refreshed", secret: newSecret };
  }

  /** Record a successful decrypt as a `credential-access` audit entry (CD-3). */
  async #recordAccess(appId: string, credentialId: string, refreshed: boolean): Promise<void> {
    await this.#auditor.record(
      this.#credentialAccessEntry({
        appId,
        credentialId,
        details: refreshed
          ? "credential accessed (oauth2 access token refreshed)"
          : "credential accessed",
      }),
    );
  }

  /** Record the no-credential (public-app) access as a distinguishable entry (CD-3). */
  async #recordNoCredential(appId: string): Promise<void> {
    await this.#auditor.record(
      this.#credentialAccessEntry({ appId, details: "no credential used" }),
    );
  }

  /**
   * Build a metadata-only `credential-access` {@link AuditLogEntry}: the credential
   * id (absent for the no-credential case, which is what makes it distinguishable),
   * the app, a short note, and the active trace context — **never** a secret value.
   */
  #credentialAccessEntry(fields: {
    readonly appId: string;
    readonly credentialId?: string;
    readonly details: string;
  }): AuditLogEntry {
    const trace = this.#readTraceContext();
    return stripUndefined({
      id: randomUUID(),
      type: "credential-access" as const,
      actor: this.#actor,
      relatedCredentialId: fields.credentialId,
      originAppId: fields.appId,
      details: fields.details,
      traceId: trace?.traceId,
      spanId: trace?.spanId,
      timestamp: this.#now(),
    });
  }
}
