import { type Credential, stripUndefined } from "@mediator/domain";
import { eq } from "drizzle-orm";

import type { DbHandle } from "../client.js";
import {
  mapCredentialMetadataRow,
  toCredentialInsert,
  type CredentialMetadata,
} from "../mappers/credential.js";
import { credential } from "../schema.js";

/**
 * Persistence for `Credential` — **write-only** by construction. `create`
 * stores the (already envelope-encrypted) row and returns metadata only; the
 * sole read (`listByAppId`) selects everything *except* `encrypted_payload` and
 * returns {@link CredentialMetadata}, which has no payload field. There is no
 * method that returns the ciphertext or any plaintext — decrypt-for-use is the
 * credentials slice / Phase 4 `withCredential`, not this repository.
 */
export class CredentialRepository {
  public constructor(private readonly db: DbHandle) {}

  /** Store a credential row. Returns metadata only — never the payload. */
  public async create(cred: Credential): Promise<CredentialMetadata> {
    await this.db.insert(credential).values(toCredentialInsert(cred));
    return stripUndefined({
      id: cred.id,
      type: cred.type,
      scopes: cred.scopes,
      lastRotatedAt: cred.lastRotatedAt,
      // AD-3 rotation bound; absent domain key stays absent in the metadata.
      validUntil: cred.validUntil ?? undefined,
    });
  }

  /** Metadata for an app's credentials — `encrypted_payload` is not selected. */
  public async listByAppId(appId: string): Promise<CredentialMetadata[]> {
    const rows = await this.db
      .select({
        id: credential.id,
        type: credential.type,
        scopes: credential.scopes,
        lastRotatedAt: credential.lastRotatedAt,
        validUntil: credential.validUntil,
      })
      .from(credential)
      .where(eq(credential.appId, appId));
    return rows.map(mapCredentialMetadataRow);
  }

  /**
   * **AL-2.6 — delete an app's credentials outright on deregistration.** "Credentials are
   * deleted from the Credential Store outright (not archived); the audit log retains all
   * historical events" (`docs/architecture/extensibility.md` *App lifecycle*) — the one
   * artifact of the cascade that leaves no row behind, because retained ciphertext for a
   * departed app is pure risk with no audit value (`docs/architecture/security.md`).
   *
   * Deliberately **every** `type`, `adapterToken` included: that is exactly how a
   * deregistered consumer's adapter token is revoked (AT-4.5) — the hash it validated
   * against is gone, so the token can never resolve to an app again.
   *
   * Stays on the repository's write-only surface: it neither accepts nor returns any
   * payload, and returns only the number of rows removed (for the cascade summary).
   */
  public async deleteByAppId(appId: string): Promise<number> {
    const deleted = await this.db
      .delete(credential)
      .where(eq(credential.appId, appId))
      .returning({ id: credential.id });
    return deleted.length;
  }
}
