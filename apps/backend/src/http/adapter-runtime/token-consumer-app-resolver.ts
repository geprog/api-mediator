import type { ValidateTokenResult } from "@mediator/credentials";
import type { FastifyRequest } from "fastify";

import type { ConsumerAppResolver, ResolvedConsumerApp } from "./consumer-app-resolver.js";

/**
 * The token-validation seam the {@link createTokenConsumerAppResolver} drives — the
 * `@mediator/credentials` `AdapterTokenStore` satisfies it. Kept as a one-method
 * interface so the resolver is unit-testable with a fake and never imports the
 * store's persistence.
 */
export interface AdapterTokenValidator {
  validate(rawToken: string): Promise<ValidateTokenResult>;
}

/**
 * The **Auth Gateway** resolver (AT-2/AT-3): the real replacement for the RT header
 * stand-in. It extracts the caller's adapter token from
 * `Authorization: Bearer <token>` and validates it (constant-time salted-hash
 * equality, still within its validity bound, owning app an active consumer app).
 * On success the request binds to that consumer app + the credential id that
 * authenticated it; on **any** failure — missing/malformed/unknown/expired/foreign
 * token, or a disabled/non-consumer app — it returns `undefined`, which the runtime
 * answers as a clean `401`, before any routing/planning/backend call and never
 * audited (AT-2.1/AT-2.4).
 *
 * The Bearer scheme is chosen for the adapter surface (the operator API uses Basic);
 * it is deliberately distinct so the two auth models never share a header meaning.
 */
export function createTokenConsumerAppResolver(
  validator: AdapterTokenValidator,
): ConsumerAppResolver {
  return async (request: FastifyRequest): Promise<ResolvedConsumerApp | undefined> => {
    const rawToken = extractBearerToken(request.headers.authorization);
    if (rawToken === null) {
      return undefined;
    }
    const result = await validator.validate(rawToken);
    if (result.outcome !== "resolved") {
      return undefined;
    }
    return { consumerAppId: result.consumerAppId, credentialId: result.credentialId };
  };
}

/** Extract the raw token from an `Authorization: Bearer <token>` header, or `null`. */
function extractBearerToken(header: string | string[] | undefined): string | null {
  const value = Array.isArray(header) ? header[0] : header;
  if (typeof value !== "string") {
    return null;
  }
  const match = /^Bearer\s+(.+)$/i.exec(value.trim());
  if (match === null) {
    return null;
  }
  return match[1] ?? null;
}
