import { z } from "zod";

/**
 * DTOs for the operator session probe (`GET /api/session`).
 *
 * The frontend authenticates with HTTP Basic (see `docs/architecture/security.md`
 * *Operator authentication & authorization*), but the authenticated {@link Principal}'s
 * authorization `role` (`operator` vs `viewer`) is not otherwise observable from a
 * read response — every read endpoint is `viewer`-ok, so no non-mutating probe
 * distinguishes the two roles. This endpoint echoes the resolved principal so the
 * SPA can render the review screen **read-only for a `viewer` up front** (RU-1
 * criterion 4) rather than only discovering the role reactively on a 403.
 *
 * The role literals are duplicated here (rather than imported from `@mediator/config`)
 * to keep `@mediator/contracts` dependent only on `@mediator/domain` + `zod`; they
 * are validated against the same two values the config's `operatorRoleSchema` uses.
 * No credential material appears in this response.
 */

export const sessionRoleSchema = z.enum(["operator", "viewer"]);
export type SessionRole = z.infer<typeof sessionRoleSchema>;

/** `GET /api/session` response: the authenticated principal's identity + role. */
export const sessionResponseSchema = z.object({
  identity: z.string(),
  role: sessionRoleSchema,
});
export type SessionResponse = z.infer<typeof sessionResponseSchema>;
