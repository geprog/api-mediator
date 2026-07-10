import { randomUUID } from "node:crypto";

import type { Credential } from "@mediator/domain";
import type { CredentialMetadata } from "@mediator/db";

import { openEnvelope, sealEnvelope } from "./envelope.js";
import type { KeyProvider } from "./key-provider.js";
import {
  parseCredentialMaterial,
  parseDecryptedSecret,
  type CredentialMaterial,
  type CredentialSecret,
  type StorableCredentialType,
} from "./material.js";

/**
 * The persistence the {@link CredentialStore} needs. Two operations, deliberately
 * split by trust level:
 *  - `create` is the public write path (returns metadata only, never a payload).
 *  - `loadEnvelope` is the store's **internal decrypt accessor** — the only read
 *    that touches `encrypted_payload`. It is intentionally *not* part of
 *    `@mediator/db`'s `CredentialRepository`, whose public surface stays
 *    write-only (metadata reads only). This keeps "only the Credential Store's
 *    internal accessor can decrypt a credential" true (security.md).
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
 * It carries the plaintext `secret`; it is created inside the `withCredential`
 * scope, never returned from it, and never cached.
 */
export interface DecryptedCredential {
  readonly credentialId: string;
  readonly type: StorableCredentialType;
  readonly scopes: readonly string[];
  readonly secret: CredentialSecret;
}

/**
 * The outcome of {@link CredentialStore.withCredential}: either the callback ran
 * (`invoked`, carrying its value) or the app has no stored credential
 * (`no-credential`). A discriminated union so callers handle the no-auth app
 * explicitly rather than via a nullable secret.
 */
export type WithCredentialResult<T> =
  { readonly outcome: "invoked"; readonly value: T } | { readonly outcome: "no-credential" };

/**
 * The metadata-only logger the store writes through. Fields are constrained to
 * non-secret primitives so no code path can hand it a secret value; the default
 * is a no-op. `docs/architecture/security.md` requires credential access to be
 * audited metadata-only — the durable audit trail arrives in a later slice; this
 * seam keeps Phase-1 logging structured and secret-free in the meantime.
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
 * The Credential Store service: write-only `store` and the mandated
 * `withCredential` decrypt-for-use access pattern (see
 * `docs/architecture/security.md`). Dependencies are constructor-injected so the
 * store is unit-testable with a fake {@link CredentialPersistence} and a
 * throwaway {@link KeyProvider}.
 */
export class CredentialStore {
  readonly #persistence: CredentialPersistence;
  readonly #keyProvider: KeyProvider;
  readonly #logger: CredentialStoreLogger;

  public constructor(
    persistence: CredentialPersistence,
    keyProvider: KeyProvider,
    logger: CredentialStoreLogger = noopLogger,
  ) {
    this.#persistence = persistence;
    this.#keyProvider = keyProvider;
    this.#logger = logger;
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
   * scope, invoke `fn` with the plaintext, and never let the plaintext outlive
   * the call. `fn`'s return value is the only thing propagated out — the secret
   * is neither returned nor retained. When the app has no credential, `fn` is not
   * called and `no-credential` is returned (a public/no-auth app is valid).
   *
   * The decrypted plaintext buffer is zeroed in `finally`; the parsed secret's
   * string fields cannot be zeroed in V8 but are not referenced after this
   * method returns, so they become GC-eligible immediately.
   */
  public async withCredential<T>(
    appId: string,
    fn: (credential: DecryptedCredential) => Promise<T>,
  ): Promise<WithCredentialResult<T>> {
    const envelope = await this.#persistence.loadEnvelope(appId);
    if (envelope === null) {
      this.#logger.info("credential access: none stored", { appId });
      return { outcome: "no-credential" };
    }

    // Phase 4: OAuth2 access-token refresh belongs here — if a stored `oauth2`
    // access token is expired, the store refreshes it (using the encrypted
    // refresh token), persists the re-encrypted tokens, and hands `fn` a
    // currently-valid access token; callers never see or trigger refresh
    // (security.md, "OAuth2 token lifecycle is handled entirely inside the
    // Credential Store").

    const plaintext = openEnvelope(envelope.encryptedPayload, this.#keyProvider.getMasterKey());
    try {
      const secret = parseDecryptedSecret(plaintext, envelope.type);
      const decrypted: DecryptedCredential = {
        credentialId: envelope.credentialId,
        type: envelope.type,
        scopes: envelope.scopes,
        secret,
      };
      this.#logger.info("credential accessed", {
        credentialId: envelope.credentialId,
        appId,
        type: envelope.type,
      });

      // Phase 4: the Outbound Call Executor drives `fn` here with a credential
      // scoped to this single app for this one call — least privilege; the
      // decrypted secret is never cached across calls or reused for another app.
      const value = await fn(decrypted);
      return { outcome: "invoked", value };
    } finally {
      plaintext.fill(0);
    }
  }
}
