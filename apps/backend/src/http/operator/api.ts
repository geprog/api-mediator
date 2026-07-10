import type { FastifyInstance } from "fastify";

import { registerAppRoutes } from "./apps.routes.js";
import type { OperatorApiDeps } from "./deps.js";
import { registerResourceBindingRoutes } from "./resource-bindings.routes.js";
import { registerSpecRoutes } from "./specs.routes.js";

export type { OperatorApiDeps } from "./deps.js";

/**
 * Mount the whole operator API surface under `/api` (AR-1/AR-2/AR-3, SI-3/SI-4,
 * RB-2/RB-3). The error taxonomy (400 validation / 404 not-found) is installed
 * separately by `registerErrorHandler` at the composition root.
 */
export function registerOperatorApi(app: FastifyInstance, deps: OperatorApiDeps): void {
  registerAppRoutes(app, deps);
  registerSpecRoutes(app, deps);
  registerResourceBindingRoutes(app, deps);
}
