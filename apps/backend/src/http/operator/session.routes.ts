import { sessionResponseSchema } from "@mediator/contracts";
import type { FastifyInstance } from "fastify";

import { requireViewer } from "../auth/index.js";
import { getPrincipal } from "../auth/principal.js";

/**
 * The operator session probe (`GET /api/session`). A `viewer`-ok read that echoes
 * the authenticated {@link Principal}'s `identity` + authorization `role`, so the
 * SPA can resolve the role once at login and render the review screen read-only
 * for a `viewer` up front (RU-1 crit 4) — the role is otherwise unobservable, as
 * every read endpoint is `viewer`-ok. Mutations stay gated server-side (OA-2)
 * regardless of what the client renders; this only drives affordances. No
 * credential material is returned.
 */
export function registerSessionRoute(app: FastifyInstance): void {
  app.get("/api/session", { preHandler: requireViewer }, (request): unknown => {
    const principal = getPrincipal(request);
    return sessionResponseSchema.parse({ identity: principal.identity, role: principal.role });
  });
}
