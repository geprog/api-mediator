import type { Ir } from "@mediator/domain";

import type { EndpointState } from "./resolution.js";

/**
 * A consumer app whose `CONSUMER`-spec operation surface should be routable, as the
 * mount manager hands it to the {@link ProtocolServer}. It carries the app id and
 * the spec's {@link Ir}.
 *
 * The IR is passed **opaquely** across this seam: the mount manager never reads its
 * HTTP method/path (those are REST specifics), it only relays it so the Protocol
 * Server implementation can realize the surface in its own protocol. A future
 * non-REST Protocol Server would read different fields of the same neutral IR.
 */
export interface MountedConsumerApp {
  readonly consumerAppId: string;
  readonly ir: Ir;
}

/**
 * The persistence the runtime reads from, as a protocol-neutral port: no SQL/ORM,
 * no OpenAPI, no HTTP. The REST runtime supplies a `@mediator/db`-backed
 * implementation; unit tests supply an in-memory fake.
 */
export interface AdapterStore {
  /**
   * The consumer apps whose surface should currently be mounted (RT-2.1/RT-4): every
   * `active` `CONSUMER` `ApiSpec` whose owning app is `active`. A disabled or
   * deregistered app, or a superseded/archived spec, is simply absent — which is what
   * lets the mounted surface be **re-derived from persisted state alone** on restart
   * (RT-4.5) and after any lifecycle change (RT-4.2/4.3).
   */
  listMountableConsumerApps(): Promise<readonly MountedConsumerApp[]>;
  /**
   * The persisted serving state of one mounted operation (RT-3): its `AdapterEndpoint`
   * (if any) and all of that endpoint's `AdapterBinding`s. The store loads; the pure
   * {@link resolveRequest} decides.
   */
  loadEndpointState(consumerAppId: string, operationKey: string): Promise<EndpointState>;
}

/**
 * **The Protocol Server seam** (RT-1.5) — the server side of the concept's Protocol
 * Client/Server interface pair. REST is the first implementation
 * (`apps/backend/src/http/adapter-runtime`); the mount manager drives it with a
 * protocol-neutral *desired surface* and the implementation realizes it as concrete
 * routes.
 *
 * `setMountedSurface` is declarative and total — it replaces the whole mounted
 * surface with exactly the given apps — which makes mounting inherently **idempotent**
 * (RT-2.5: no duplicate route registration) and the lifecycle a pure function of
 * persisted state (RT-4.5). The implementation must apply it without a port re-bind,
 * so a live update never races the listener.
 */
export interface ProtocolServer {
  setMountedSurface(apps: readonly MountedConsumerApp[]): void;
}
