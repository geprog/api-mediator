import type { FastifyInstance } from "fastify";

import { installAuthentication, type AuthProvider } from "../auth/index.js";
import { registerAppRoutes } from "./apps.routes.js";
import type { OperatorApiDeps } from "./deps.js";
import { registerMappingProposalRoutes } from "./mapping-proposals.routes.js";
import { registerResourceBindingRoutes } from "./resource-bindings.routes.js";
import { registerSessionRoute } from "./session.routes.js";
import { registerSpecRoutes } from "./specs.routes.js";

export type { OperatorApiDeps } from "./deps.js";

/**
 * Mount the whole operator API surface under `/api` (AR-1/AR-2/AR-3, SI-3/SI-4,
 * RB-2/RB-3). Every route declares its minimum role via a guard (OA-2); the
 * error taxonomy (400/401/403/404) is installed separately by
 * `registerErrorHandler` at the composition root.
 *
 * This registers routes on whatever instance it is given; authentication (OA-1)
 * is layered on by {@link registerAuthenticatedOperatorApi}, which is what the
 * composition root and the test kit call.
 */
export function registerOperatorApi(app: FastifyInstance, deps: OperatorApiDeps): void {
  registerSessionRoute(app);
  registerAppRoutes(app, deps);
  registerSpecRoutes(app, deps);
  registerResourceBindingRoutes(app, deps);
  registerMappingProposalRoutes(app, deps);
}

/**
 * Mount the operator API inside an **encapsulated** context that first installs
 * authentication (OA-1) via the given {@link AuthProvider}. Encapsulation is what
 * keeps the auth hook off sibling surfaces registered on the root (notably the
 * unauthenticated `GET /health` liveness probe): only routes under this context
 * require an authenticated principal.
 */
export function registerAuthenticatedOperatorApi(
  app: FastifyInstance,
  deps: OperatorApiDeps,
  authProvider: AuthProvider,
): void {
  void app.register((instance) => {
    installAuthentication(instance, authProvider);
    registerOperatorApi(instance, deps);
    return Promise.resolve();
  });
}
