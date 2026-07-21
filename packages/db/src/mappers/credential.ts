import { type Credential, type CredentialType, stripUndefined } from "@mediator/domain";

import { credential } from "../schema.js";

/** The insert shape Drizzle expects for `credential`. */
export type CredentialInsert = typeof credential.$inferInsert;

/**
 * The **only** shape a credential read ever returns: metadata, never payload.
 * There is deliberately no field for `encrypted_payload` (nor any plaintext),
 * so no read path can surface credential material — the write-only invariant
 * (CR-2) is enforced in the type system, not just by convention.
 *
 * `lastRotatedAt` is a non-null `Date`: the column is NOT NULL and the domain
 * contract (`Credential.lastRotatedAt: Date`) always sets it at creation.
 *
 * `validUntil` (AD-3) is non-secret rotation metadata — the queryable overlap/
 * revocation bound — so it belongs in the metadata projection alongside
 * `lastRotatedAt`. **Absent** when the column is NULL (the unbounded current
 * token, and every non-`adapterToken` row).
 */
export interface CredentialMetadata {
  id: string;
  type: CredentialType;
  scopes: string[];
  lastRotatedAt: Date;
  validUntil?: Date;
}

/** The column subset a metadata read selects (excludes `encrypted_payload`). */
export interface CredentialMetadataRow {
  id: string;
  type: CredentialType;
  scopes: string[];
  lastRotatedAt: Date;
  validUntil: Date | null;
}

/** Domain → insert. Carries `encryptedPayload` in (write path); never out. */
export function toCredentialInsert(cred: Credential): CredentialInsert {
  return {
    id: cred.id,
    appId: cred.appId,
    type: cred.type,
    encryptedPayload: cred.encryptedPayload,
    scopes: cred.scopes,
    lastRotatedAt: cred.lastRotatedAt,
    // Absent domain key → SQL NULL (the unbounded current token).
    validUntil: cred.validUntil ?? null,
  };
}

/** Metadata row → metadata projection. NULL `valid_until` collapses to an absent key. */
export function mapCredentialMetadataRow(row: CredentialMetadataRow): CredentialMetadata {
  return stripUndefined({
    id: row.id,
    type: row.type,
    scopes: row.scopes,
    lastRotatedAt: row.lastRotatedAt,
    validUntil: row.validUntil ?? undefined,
  });
}
