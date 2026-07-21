import { CredentialRepository, credential, type DbHandle } from "@mediator/db";
import { stripUndefined, type Credential } from "@mediator/domain";
import { and, eq } from "drizzle-orm";

import type {
  AdapterTokenPersistence,
  AdapterTokenRecord,
  NewAdapterTokenRecord,
} from "./adapter-token.js";

/**
 * The Postgres-backed {@link AdapterTokenPersistence} for the {@link AdapterTokenStore}.
 *
 * `adapterToken` rows live in the same `credential` table as every other credential,
 * but their payload column holds a **salted one-way hash**, not envelope ciphertext
 * (`docs/architecture/data-model.md` `Credential`; AD-3). This adapter is the sole
 * reader of that column for `adapterToken` rows — the equality-check accessor — and
 * that hash never leaves the process through it: it is compared in-memory by
 * {@link verifySecret} and never placed in an API DTO. Every read/write here is
 * filtered to `type = 'adapterToken'` so this path can never touch an
 * envelope-encrypted credential (and the envelope path already excludes these rows).
 *
 * Bound to a {@link DbHandle} so it runs on the pool (per-request validation) or
 * inside a `tx()` (an issue/rotate/cutover that commits atomically with its audit row).
 */
export class DbAdapterTokenPersistence implements AdapterTokenPersistence {
  readonly #db: DbHandle;
  readonly #repository: CredentialRepository;

  public constructor(db: DbHandle) {
    this.#db = db;
    this.#repository = new CredentialRepository(db);
  }

  public async create(record: NewAdapterTokenRecord): Promise<void> {
    const row: Credential = stripUndefined({
      id: record.credentialId,
      appId: record.appId,
      type: "adapterToken" as const,
      // The salted hash of the token's secret part — never the raw token.
      encryptedPayload: record.hashedSecret,
      scopes: [],
      lastRotatedAt: record.lastRotatedAt,
      validUntil: record.validUntil,
    });
    await this.#repository.create(row);
  }

  public async findById(credentialId: string): Promise<AdapterTokenRecord | null> {
    const rows = await this.#db
      .select({
        id: credential.id,
        appId: credential.appId,
        encryptedPayload: credential.encryptedPayload,
        lastRotatedAt: credential.lastRotatedAt,
        validUntil: credential.validUntil,
      })
      .from(credential)
      .where(and(eq(credential.id, credentialId), eq(credential.type, "adapterToken")))
      .limit(1);
    const row = rows[0];
    return row === undefined ? null : toRecord(row);
  }

  public async listByAppId(appId: string): Promise<readonly AdapterTokenRecord[]> {
    const rows = await this.#db
      .select({
        id: credential.id,
        appId: credential.appId,
        encryptedPayload: credential.encryptedPayload,
        lastRotatedAt: credential.lastRotatedAt,
        validUntil: credential.validUntil,
      })
      .from(credential)
      .where(and(eq(credential.appId, appId), eq(credential.type, "adapterToken")));
    return rows.map(toRecord);
  }

  public async setValidUntil(credentialId: string, validUntil: Date): Promise<void> {
    await this.#db
      .update(credential)
      .set({ validUntil })
      .where(and(eq(credential.id, credentialId), eq(credential.type, "adapterToken")));
  }

  public async deleteByAppId(appId: string): Promise<number> {
    const deleted = await this.#db
      .delete(credential)
      .where(and(eq(credential.appId, appId), eq(credential.type, "adapterToken")))
      .returning({ id: credential.id });
    return deleted.length;
  }
}

/** Row → {@link AdapterTokenRecord}; a NULL `valid_until` collapses to an absent key. */
function toRecord(row: {
  id: string;
  appId: string;
  encryptedPayload: string;
  lastRotatedAt: Date;
  validUntil: Date | null;
}): AdapterTokenRecord {
  return stripUndefined({
    credentialId: row.id,
    appId: row.appId,
    hashedSecret: row.encryptedPayload,
    lastRotatedAt: row.lastRotatedAt,
    validUntil: row.validUntil ?? undefined,
  });
}
