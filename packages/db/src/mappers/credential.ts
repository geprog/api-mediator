import type { Credential, CredentialType } from "@mediator/domain";

import { credential } from "../schema.js";

/** The insert shape Drizzle expects for `credential`. */
export type CredentialInsert = typeof credential.$inferInsert;

/**
 * The **only** shape a credential read ever returns: metadata, never payload.
 * There is deliberately no field for `encrypted_payload` (nor any plaintext),
 * so no read path can surface credential material — the write-only invariant
 * (CR-2) is enforced in the type system, not just by convention.
 *
 * `lastRotatedAt` is `Date | null` because the column is nullable; the Phase-1
 * store path always sets it to creation time, so in practice it is a `Date`.
 */
export interface CredentialMetadata {
  id: string;
  type: CredentialType;
  scopes: string[];
  lastRotatedAt: Date | null;
}

/** The column subset a metadata read selects (excludes `encrypted_payload`). */
export interface CredentialMetadataRow {
  id: string;
  type: CredentialType;
  scopes: string[];
  lastRotatedAt: Date | null;
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
  };
}

/** Metadata row → metadata projection. */
export function mapCredentialMetadataRow(row: CredentialMetadataRow): CredentialMetadata {
  return {
    id: row.id,
    type: row.type,
    scopes: row.scopes,
    lastRotatedAt: row.lastRotatedAt,
  };
}
