import { sessionResponseSchema, type SessionResponse } from "@mediator/contracts";

import { apiRequest } from "./client.js";

/**
 * `GET /api/session` — resolve the authenticated principal's identity + role. The
 * auth store calls this once at login (with the Basic header already installed) to
 * learn whether the operator is an `operator` or a `viewer`, so the review screen
 * can render read-only for a viewer up front. A 401 here means the credential was
 * rejected.
 */
export function getSession(): Promise<SessionResponse> {
  return apiRequest("/api/session", { method: "GET" }, sessionResponseSchema);
}
