import type { FastifyInstance } from "fastify";

import { installAuthentication, type AuthProvider } from "../auth/index.js";
import { registerAdapterEndpointRoutes } from "./adapter-endpoints.routes.js";
import { registerAdapterRequestRoutes } from "./adapter-requests.routes.js";
import { registerAdapterTokenRoutes } from "./adapter-token.routes.js";
import { registerApprovedMappingRoutes } from "./approved-mappings.routes.js";
import { registerAppRoutes } from "./apps.routes.js";
import { registerDeadLetterRoutes } from "./dead-letter.routes.js";
import type { OperatorApiDeps } from "./deps.js";
import { registerMappingProposalRoutes } from "./mapping-proposals.routes.js";
import { registerParkedConflictRoutes } from "./parked-conflicts.routes.js";
import { registerPollTriggerRoutes } from "./poll-trigger.routes.js";
import { registerRecordLinkRoutes } from "./record-links.routes.js";
import { registerResourceBindingRoutes } from "./resource-bindings.routes.js";
import { registerScopeIdentityKeyRoutes } from "./scope-identity-key.routes.js";
import { registerScopeLinkRoutes } from "./scope-links.routes.js";
import { registerSessionRoute } from "./session.routes.js";
import { registerSpecRoutes } from "./specs.routes.js";
import { registerSyncEventRoutes } from "./sync-events.routes.js";
import { registerSyncRuleRoutes } from "./sync-rules.routes.js";

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
  // Phase-5 adapter-token control plane (AT-1/AT-4). Mounted whenever the service is
  // wired (the real composition root always provides it); the pre-Phase-5 in-memory
  // unit harness omits it, exactly like the sync surface below.
  if (deps.adapterTokens !== undefined) {
    registerAdapterTokenRoutes(app, deps.adapterTokens);
  }
  // Phase-5 adapter endpoint operator surface: AP-1 read state, AP-2 compose/recompose, AP-3
  // enable/disable. Mounted whenever both the composition service (mutations) and the state
  // reader (reads) are wired — the real composition root always provides both; the pre-Phase-5
  // in-memory unit harness omits them and the routes are simply not registered.
  if (deps.adapterComposition !== undefined && deps.adapterState !== undefined) {
    registerAdapterEndpointRoutes(app, deps.adapterComposition, deps.adapterState);
  }
  // Phase-5 adapter request history + endpoint health (AP-5). Mounted whenever the state
  // reader and the request-history reader are wired; the in-memory unit harness omits them.
  if (deps.adapterState !== undefined && deps.adapterRequestHistory !== undefined) {
    registerAdapterRequestRoutes(app, deps.adapterState, deps.adapterRequestHistory);
  }
  registerSpecRoutes(app, deps);
  registerResourceBindingRoutes(app, deps);
  registerMappingProposalRoutes(app, deps);
  // Phase-6 SL-10 — manual suspend/resume of an `ApprovedMapping` + the read surface the
  // control needs. Mounted whenever both the suspension service (mutations) and the reader
  // (list) are wired; the in-memory unit harness omits them, exactly like the adapter surface.
  if (deps.approvedMappingSuspension !== undefined && deps.approvedMappingReader !== undefined) {
    registerApprovedMappingRoutes(app, deps.approvedMappingSuspension, deps.approvedMappingReader);
  }
  // Phase-4 Sync HTTP API (SA-1..SA-5). Mounted only when the Sync Engine runtime
  // is wired in (the real composition root always provides `deps.sync`; the
  // in-memory unit harness omits it, so its sync routes are simply not registered).
  if (deps.sync !== undefined) {
    registerSyncRuleRoutes(app, deps.sync);
    registerSyncEventRoutes(app, deps.sync);
    registerRecordLinkRoutes(app, deps.sync);
    registerScopeLinkRoutes(app, deps.sync);
    registerScopeIdentityKeyRoutes(app, deps.sync);
    registerParkedConflictRoutes(app, deps.sync);
    registerDeadLetterRoutes(app, deps.sync);
    // The deterministic poll-trigger endpoint (SP-5 hook for the SU-6 e2e) is a
    // TEST/DEV-ONLY affordance, NOT an operator feature. It is mounted ONLY when the
    // `sync.testPollTrigger` flag is set (in addition to the sync runtime being
    // present); production/dev leave the flag off, so the route is not registered at
    // all and a request 404s. See @mediator/config `SyncConfig.testPollTrigger`.
    if (deps.syncTestPollTrigger === true) {
      registerPollTriggerRoutes(app, deps.sync);
    }
  }
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
