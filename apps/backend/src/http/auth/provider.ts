import type { FastifyRequest } from "fastify";

import type { Principal } from "./principal.js";

/**
 * The pluggable authentication-provider seam (OA-1). Given an inbound request,
 * it resolves the credentials it carries to an authenticated {@link Principal},
 * or `null` when there is no valid identity (which the authentication hook turns
 * into a 401).
 *
 * Phase 3 ships {@link LocalAccountsAuthProvider}; the concept's typical
 * deployment substitutes the organization's SSO/OIDC here. Because route gating
 * (OA-2) and attribution (OA-3) depend only on the resolved principal — never on
 * how it was authenticated — swapping the provider changes nothing downstream
 * (OA-1 crit 3).
 *
 * A provider MUST NOT log, return, or otherwise expose the submitted secret
 * (`docs/architecture/security.md`).
 */
export interface AuthProvider {
  authenticate(request: FastifyRequest): Promise<Principal | null>;
}
