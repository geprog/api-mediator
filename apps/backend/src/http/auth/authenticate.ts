import type { FastifyInstance } from "fastify";

import { UnauthorizedError } from "../../app-errors.js";
import type { AuthProvider } from "./provider.js";

/**
 * Install operator-API authentication (OA-1) on a Fastify context: decorate the
 * request with a `principal` slot, then register an `onRequest` hook that
 * resolves every request to a {@link Principal} via the {@link AuthProvider}.
 *
 * A request without a valid identity throws {@link UnauthorizedError} from the
 * `onRequest` hook — before validation, the route handler, and any role guard —
 * so it is rejected 401 with **no handler side effect** (OA-1 crit 1). There is
 * deliberately no unauthenticated path.
 *
 * Install this on the *encapsulated* operator-API context only, so unauthenticated
 * operational surfaces (e.g. `GET /health`) stay reachable by orchestration
 * probes.
 */
export function installAuthentication(instance: FastifyInstance, provider: AuthProvider): void {
  // Reference-type default per Fastify guidance; the hook sets it per request.
  instance.decorateRequest("principal", null);

  instance.addHook("onRequest", async (request) => {
    const principal = await provider.authenticate(request);
    if (principal === null) {
      throw new UnauthorizedError();
    }
    request.principal = principal;
  });
}
