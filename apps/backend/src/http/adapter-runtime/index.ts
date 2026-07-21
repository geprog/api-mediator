/**
 * `apps/backend/src/http/adapter-runtime` — the **REST implementation** of the
 * Adapter Server Runtime (Phase-5 RT-1…RT-5), the server side of the concept's
 * Protocol Client/Server seam.
 *
 * This is where every OpenAPI/REST/Fastify specific lives — HTTP verbs, status
 * codes, path templating, header handling, the Fastify instance — behind the
 * `@mediator/adapter-engine` core's neutral ports. The core decides *what* a request
 * resolves to; this layer realizes it *over HTTP*.
 */

export {
  buildAdapterRuntime,
  type AdapterRuntime,
  type AdapterRuntimeDeps,
} from "./build-adapter-runtime.js";
export { buildAdapterMountReactions, type AdapterMountReactions } from "./background.js";
export {
  headerConsumerAppResolver,
  CONSUMER_APP_HEADER,
  type ConsumerAppResolver,
  type ResolvedConsumerApp,
} from "./consumer-app-resolver.js";
export {
  createTokenConsumerAppResolver,
  type AdapterTokenValidator,
} from "./token-consumer-app-resolver.js";
export { DbAdapterStore } from "./db-adapter-store.js";
export { RestProtocolServer } from "./rest-protocol-server.js";
export { deriveRestRoutes, matchRoute, type RestRoute, type RouteMatch } from "./rest-routes.js";
export {
  CAUSE_HEADER,
  DEGRADED_HEADER,
  CONTRIBUTING_BACKENDS_HEADER,
  renderHttpResponse,
  auditFieldsFor,
  causeTokenOf,
  type AdapterResult,
  type CauseToken,
} from "./outcome-http.js";
