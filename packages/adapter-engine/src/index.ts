/**
 * `@mediator/adapter-engine` — the **protocol-neutral core** of the Adapter Server
 * Runtime (Phase 5).
 *
 * This package is the planner/aggregator side of the concept's Protocol
 * Client/Server interface pair (`docs/architecture/extensibility.md` *Beyond
 * REST/OpenAPI*). It owns:
 *
 * - the single definition of an operation's neutral key + mount derivation from IR
 *   ({@link operationKey}, {@link deriveMountedOperations});
 * - the RT-3 three-answer resolution ({@link resolveRequest}, {@link ResolutionOutcome});
 * - the protocol-neutral request shape and the serving seam RP/TE/AG build behind
 *   ({@link AdapterRequest}, {@link ServeHandler}, {@link ServeOutcome});
 * - the persistence + Protocol Server ports ({@link AdapterStore},
 *   {@link ProtocolServer}) and the mount lifecycle ({@link MountManager}).
 *
 * **Nothing OpenAPI- or Fastify-specific lives here.** HTTP verbs, status codes,
 * path templating, and header handling live in `apps/backend/src/http/adapter-runtime`,
 * behind the {@link ProtocolServer} seam. The core reads only the IR's neutral
 * identifiers, never an operation's method/path — a reviewer can confirm the seam by
 * grepping this package for `.method`/`.path` and finding none.
 */

export { operationKey, deriveMountedOperations, type MountedOperation } from "./operation-key.js";
export { type AdapterRequest } from "./request.js";
export { resolveRequest, type EndpointState, type ResolutionOutcome } from "./resolution.js";
export {
  type ServeHandler,
  type ServeInput,
  type ServeOutcome,
  type ServeRejectionReason,
} from "./serve.js";
export { type AdapterStore, type ProtocolServer, type MountedConsumerApp } from "./ports.js";
export { MountManager, type MountManagerDeps } from "./mount-manager.js";
