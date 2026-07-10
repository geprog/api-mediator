import type { FastifyRequest } from "fastify";

/** Dev-only header carrying the acting operator's identity until Phase-3 auth. */
const OPERATOR_IDENTITY_HEADER = "x-operator-id";

/** The marked stub identity used when no dev header is supplied. */
export const STUB_OPERATOR_IDENTITY = "operator";

/**
 * Resolve the acting operator's identity for mutation attribution
 * (e.g. `ResourceBinding.confirmedBy` — RB-2 crit 7).
 *
 * Phase 3: replace this with the authenticated operator identity from the auth
 * layer (`docs/architecture/security.md` *Operator authentication*). This is
 * **not** authentication and gates nothing — the operator/viewer split is not
 * enforced yet; it only stamps an attributed identity so the Phase-3 wiring has a
 * single seam to replace. Until then it honors an optional `x-operator-id` dev
 * header, falling back to a clearly-marked {@link STUB_OPERATOR_IDENTITY}.
 */
export function resolveOperatorIdentity(request: FastifyRequest): string {
  const header = request.headers[OPERATOR_IDENTITY_HEADER];
  const value = Array.isArray(header) ? header[0] : header;
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : STUB_OPERATOR_IDENTITY;
}
