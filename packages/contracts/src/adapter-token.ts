import { z } from "zod";

import { isoDateTimeSchema } from "./common.js";

/**
 * Operator-API response DTOs for the adapter-token lifecycle (Phase-5 AT-1/AT-4).
 *
 * The issue/rotate response is the **single deliberate exception** to "secrets are
 * never returned" (`docs/architecture/security.md`): its `token` field carries the
 * raw adapter token, displayed **exactly once**. There is no read DTO that echoes it
 * afterwards — only the salted hash is stored, so nothing is retrievable to return
 * (AT-1.2). The cutover response is metadata only (credential ids, never a token).
 */

/**
 * A freshly issued or rotated adapter token. `token` is the raw value shown once;
 * `credentialId` is its (non-secret) `Credential` id, also recorded in the audit.
 * `rotated` is `true` when a previous token was moved into the overlap window.
 */
export const issueAdapterTokenResponseSchema = z.object({
  credentialId: z.string(),
  token: z.string(),
  rotated: z.boolean(),
  issuedAt: isoDateTimeSchema,
});
export type IssueAdapterTokenResponse = z.infer<typeof issueAdapterTokenResponseSchema>;

/** The result of ending a rotation overlap early — the ended credential ids only. */
export const cutoverAdapterTokenResponseSchema = z.object({
  endedCredentialIds: z.array(z.string()),
});
export type CutoverAdapterTokenResponse = z.infer<typeof cutoverAdapterTokenResponseSchema>;
