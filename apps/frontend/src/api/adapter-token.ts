import {
  cutoverAdapterTokenResponseSchema,
  issueAdapterTokenResponseSchema,
  type CutoverAdapterTokenResponse,
  type IssueAdapterTokenResponse,
} from "@mediator/contracts";

import { apiRequest } from "./client.js";

/**
 * The Phase-5 adapter-token operator API client (AP-4). Issue and rotate return
 * the raw token **exactly once** (`IssueAdapterTokenResponse.token`) — the single
 * deliberate exception to "secrets are never returned" (`docs/architecture/
 * security.md`). The caller must treat that value as transient: it is displayed
 * once and never persisted anywhere that survives navigation (AT-1.2 / CU-3.2).
 *
 * There is deliberately **no** token-read function here: only a salted hash is
 * stored, so no endpoint can echo the token back. (There is also currently no
 * operator read for token *metadata* — existence / `lastRotatedAt` / overlap
 * state — nor for the consumer's adapter base URL; those AP-4 reads are not yet
 * exposed by the backend, see the CU-3 notes in the token panel.)
 */

/**
 * `POST /api/apps/:id/adapter-token` (AP-4.1) — issue a consumer app's first
 * adapter token. The raw token is in the response body once; only its hash is
 * stored. A re-issue follows the rotation path server-side (`rotated: true`).
 */
export function issueAdapterToken(appId: string): Promise<IssueAdapterTokenResponse> {
  return apiRequest(
    `/api/apps/${encodeURIComponent(appId)}/adapter-token`,
    { method: "POST" },
    issueAdapterTokenResponseSchema,
  );
}

/**
 * `POST /api/apps/:id/adapter-token/rotate` (AP-4.3) — rotate the token. The new
 * token is shown once; the previous token stays valid through the overlap window
 * until cutover is confirmed or the window elapses.
 */
export function rotateAdapterToken(appId: string): Promise<IssueAdapterTokenResponse> {
  return apiRequest(
    `/api/apps/${encodeURIComponent(appId)}/adapter-token/rotate`,
    { method: "POST" },
    issueAdapterTokenResponseSchema,
  );
}

/**
 * `POST /api/apps/:id/adapter-token/cutover` (AP-4.3) — end a rotation overlap
 * early, invalidating the previous token. Metadata only — no token is returned.
 */
export function cutoverAdapterToken(appId: string): Promise<CutoverAdapterTokenResponse> {
  return apiRequest(
    `/api/apps/${encodeURIComponent(appId)}/adapter-token/cutover`,
    { method: "POST" },
    cutoverAdapterTokenResponseSchema,
  );
}
