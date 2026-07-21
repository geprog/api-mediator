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
}
