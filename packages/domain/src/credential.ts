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
 */
export const credentialSchema = z.object({
  id: z.string(),
  appId: z.string(),
  type: credentialTypeSchema,
  encryptedPayload: z.string(),
  scopes: z.array(z.string()),
  lastRotatedAt: z.date(),
});
export type Credential = z.infer<typeof credentialSchema>;
