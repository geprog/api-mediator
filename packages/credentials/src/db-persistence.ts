import {
  CredentialRepository,
  credential,
  type CredentialMetadata,
  type DbHandle,
} from "@mediator/db";
import type { Credential } from "@mediator/domain";
import { and, desc, eq, ne } from "drizzle-orm";

import { isStorableCredentialType } from "./material.js";
import type { CredentialPersistence, StoredEnvelope } from "./store.js";

/** A stored credential row had a non-storable `type` (data-integrity fault). */
export class NonStorableStoredCredentialError extends Error {
  public constructor(appId: string) {
    super(`Stored credential for app ${appId} has a non-storable (non-encrypted) type.`);
    this.name = "NonStorableStoredCredentialError";
  }
}

/**
 * The Postgres-backed {@link CredentialPersistence} for {@link CredentialStore}.
 *
 * Writes go through `@mediator/db`'s write-only {@link CredentialRepository}. The
 * decrypt read (`loadEnvelope`) issues its own private `SELECT` including
 * `encrypted_payload` — the store's internal accessor. That column is
 * deliberately absent from `CredentialRepository`'s public surface, so this is
 * the single place the ciphertext is read, and only for `withCredential`.
 *
 * `adapterToken` rows are excluded from the read: they hold a salted hash, not
 * envelope-encrypted material (Phase 5), and must never be fed to the decrypter.
 */
export class DbCredentialPersistence implements CredentialPersistence {
  readonly #db: DbHandle;
  readonly #repository: CredentialRepository;

  public constructor(db: DbHandle) {
    this.#db = db;
    this.#repository = new CredentialRepository(db);
  }

  public create(cred: Credential): Promise<CredentialMetadata> {
    return this.#repository.create(cred);
  }

  public async loadEnvelope(appId: string): Promise<StoredEnvelope | null> {
    const rows = await this.#db
      .select({
        id: credential.id,
        type: credential.type,
        scopes: credential.scopes,
        encryptedPayload: credential.encryptedPayload,
      })
      .from(credential)
      .where(and(eq(credential.appId, appId), ne(credential.type, "adapterToken")))
      .orderBy(desc(credential.lastRotatedAt))
      .limit(1);

    const row = rows[0];
    if (row === undefined) {
      return null;
    }
    if (!isStorableCredentialType(row.type)) {
      // adapterToken is filtered out in SQL; any other non-storable value here
      // is corrupt data — surfaced, never decrypted.
      throw new NonStorableStoredCredentialError(appId);
    }
    return {
      credentialId: row.id,
      type: row.type,
      scopes: row.scopes,
      encryptedPayload: row.encryptedPayload,
    };
  }
}
