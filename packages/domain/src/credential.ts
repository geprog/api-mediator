import { z } from "zod";

import { credentialTypeSchema } from "./enums.js";

/**
 * `Credential` — encrypted per-app auth material (see
 * `docs/architecture/data-model.md` `Credential` and requirement CR-1).
 *
 * `encryptedPayload` holds the material under **envelope encryption** — it is
 * opaque ciphertext, never plaintext. The secrecy invariant (CR-2) is that this
 * value never leaves the Credential Store: it must not appear in any API
 * response, log line, event payload, or test fixture. That enforcement lives in
 * the credential-store, API, and event slices; this types-only package simply
 * models the stored row shape (the field is present because the row has it).
 *
 * This package defines the type only. Envelope encryption and the write-only
 * `CredentialStore.store` are a later slice; `withCredential` decrypt-for-use is
 * Phase 4.
 *
 * ## `type = adapterToken` — a one-way hash, not encrypted material (AD-3)
 *
 * A consumer app's mediator-issued adapter token is a `Credential` row like any
 * other (`docs/architecture/security.md` *Inbound authentication to generated
 * adapter servers*: the token "has a full `Credential` lifecycle rather than being
 * an unmodeled string"), but its payload column is **not** ciphertext: validation
 * needs equality and never the original value, so the row stores a **salted
 * one-way hash** (AD-3.1). Concretely, `encryptedPayload` holds an encoded
 * `@mediator/credentials` `hashSecret` string (`scrypt$N$r$p$keyLen$salt$hash`) —
 * the primitive that package already uses for operator passwords, and which its
 * own header documents as deliberately secret-kind-agnostic for exactly this.
 *
 * The column is therefore best read as *the row's stored secret material*, whose
 * **encoding is decided by `type`**: envelope ciphertext for
 * `apiKey`/`oauth2`/`basicAuth`/`custom`, a salted hash for `adapterToken`. Both
 * are opaque and neither is ever returned. The raw token is **not persisted
 * anywhere** — not here, not in the audit log, not in logs; it exists only in the
 * issuing response, shown exactly once (AD-3.2). Issuing, hashing and validating
 * it are AT-1..AT-4; this shape only says what is stored.
 *
 * ## Rotation overlap — `validUntil` (AD-3.3)
 *
 * `docs/architecture/security.md` requires rotation "with an overlap window — old
 * and new both valid until the consumer confirms cutover", but the data model
 * carried no field bounding that window (README Phase-5 open question 4). The
 * decision taken here, and recorded in `docs/architecture/data-model.md`:
 *
 * > **Two rows, one bound.** Rotation writes a *new* `adapterToken` row and stamps
 * > the *superseded* row's `validUntil`. Both rows are simultaneously valid for
 * > one app until that instant, and "still valid" is the queryable predicate
 * > `valid_until IS NULL OR valid_until > now()`.
 *
 * Why a single nullable bound rather than a richer shape:
 *
 * - **Two rows, not one row with two hashes.** The overlap is two independently
 *   valid credentials, each with its own `scopes` and `lastRotatedAt`; a second
 *   hash column would duplicate the entity instead of reusing it (AD-3.4).
 * - **Absent = unbounded = the current token**, so every credential row written
 *   before this field existed keeps exactly its previous meaning — no backfill
 *   (AD-6.2) — and the common case stores nothing.
 * - **The bound sits on the *superseded* row**, so a cutover can never be
 *   "forgotten into" an indefinitely valid old token: the old row expires on its
 *   own even if the consumer never confirms. Confirming cutover early is just
 *   setting `validUntil` to now (AT-4); the window length is config-defined.
 * - **Revocation reuses the same field** (AD-3.5): an explicitly revoked token is
 *   one whose `validUntil` is in the past, and a disabled or deregistered consumer
 *   app revokes *implicitly* — validation resolves the owning `RegisteredApp` and
 *   a non-`active` app's tokens are rejected whatever their bound. Deliberately no
 *   separate `revokedAt`: a revocation and an elapsed overlap are the same fact
 *   ("this token is no longer accepted"), and two fields could disagree.
 *
 * Meaningful for `adapterToken` rows only — the same conditionally-meaningful
 * shape the concept uses for `RegisteredApp.baseUrl`. An OAuth2 access token's
 * expiry is *not* this field: that lifecycle lives inside the Credential Store,
 * which refreshes internally and never exposes it (`security.md` *Credential
 * storage*).
 */
export const credentialSchema = z.object({
  id: z.string(),
  appId: z.string(),
  type: credentialTypeSchema,
  encryptedPayload: z.string(),
  scopes: z.array(z.string()),
  lastRotatedAt: z.date(),
  /**
   * The end of this credential's validity — see *Rotation overlap* above.
   * **Absent** = no bound: the current token (and every non-`adapterToken` row).
   */
  validUntil: z.date().optional(),
});
export type Credential = z.infer<typeof credentialSchema>;

/**
 * Whether a credential's own validity bound still admits it at `now` — the
 * queryable "still valid" property AD-3.3 requires, expressed as a pure predicate
 * so the same rule holds in SQL (`valid_until IS NULL OR valid_until > now()`) and
 * in memory.
 *
 * This answers the *credential's own* bound only. The implicit revocation of a
 * disabled or deregistered consumer app is a property of the owning
 * `RegisteredApp`, resolved by the validating slice (AT-2), not by this function.
 */
export function isCredentialValidAt(
  credential: Pick<Credential, "validUntil">,
  now: Date,
): boolean {
  return credential.validUntil === undefined || credential.validUntil.getTime() > now.getTime();
}
