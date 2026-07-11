import type { OperatorRole } from "@mediator/config";
import type { FastifyRequest } from "fastify";

/**
 * The authenticated principal behind an operator-API request: a stable
 * `identity` (who) and an authorization `role` (what they may do). Produced by
 * the {@link AuthProvider} seam (OA-1) and consumed by the role guards (OA-2)
 * and mutation attribution (OA-3) — neither of which cares *how* it was
 * authenticated, so a future SSO/OIDC provider slots in unchanged.
 */
export interface Principal {
  /** Stable identity string recorded on every mutation this principal makes. */
  readonly identity: string;
  /** The single-tenant authorization role — exactly `operator` or `viewer`. */
  readonly role: OperatorRole;
}

// Decorate FastifyRequest with the resolved principal. `null` until the
// authentication hook (OA-1) sets it; on an authenticated route it is always a
// Principal by the time a handler or guard runs, because the hook rejects an
// unauthenticated request before either executes.
declare module "fastify" {
  interface FastifyRequest {
    principal: Principal | null;
  }
}

/**
 * Read the authenticated {@link Principal} off a request — the single accessor
 * handlers and the Phase-3 approval routes use for gating and attribution
 * (OA-1 crit 5, OA-3). Throws if no principal is present, which can only happen
 * as a wiring bug (a route mounted outside the authenticated context): the
 * authentication hook otherwise guarantees one on every operator-API request.
 */
export function getPrincipal(request: FastifyRequest): Principal {
  // `!` (not `=== null`) so the guard also catches `undefined` — the
  // decoration is encapsulated to the authenticated context, so on any other
  // context the property is absent, exactly the wiring bug this net promises to
  // catch.
  if (!request.principal) {
    throw new Error(
      "No authenticated principal on request — the authentication hook is not installed on this route's context.",
    );
  }
  return request.principal;
}
