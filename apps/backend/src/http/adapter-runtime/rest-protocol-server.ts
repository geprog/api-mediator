import type { MountedConsumerApp, ProtocolServer } from "@mediator/adapter-engine";

import { deriveRestRoutes, matchRoute, type RestRoute, type RouteMatch } from "./rest-routes.js";

/**
 * The **REST implementation of the Protocol Server seam** (RT-1.5). It holds the
 * live per-consumer-app route tables in memory and matches inbound HTTP requests
 * against them; the `@mediator/adapter-engine` core drives it only through the
 * neutral {@link ProtocolServer.setMountedSurface}.
 *
 * The surface is kept in a **single immutable map** replaced atomically by
 * `setMountedSurface`, so a live re-mount (a new `SpecIngested`, an app disable) is
 * a lock-free pointer swap that never races an in-flight match and never re-binds
 * the listener (RT-2.5, RT-4). Because it is rebuilt wholesale from the derived
 * surface each time, mounting is inherently idempotent — re-applying the same
 * surface yields the identical route table.
 *
 * Route tables are keyed by `consumerAppId`, and {@link resolve} only ever consults
 * the caller's app, so identical paths in two consumer specs (`/todos` in both) can
 * never be confused for one another (RT-2.3) — the confusion the token→app seam
 * exists to prevent.
 */
export class RestProtocolServer implements ProtocolServer {
  #routesByApp: ReadonlyMap<string, readonly RestRoute[]> = new Map();

  public setMountedSurface(apps: readonly MountedConsumerApp[]): void {
    const next = new Map<string, readonly RestRoute[]>();
    for (const app of apps) {
      next.set(app.consumerAppId, deriveRestRoutes(app.ir));
    }
    this.#routesByApp = next;
  }

  /**
   * Resolve an inbound request **within one consumer app's surface** to its matched
   * route (RT-2.2/2.3). `undefined` means "no such operation is mounted for this
   * app" — a plain 404, never `not-yet-mapped`.
   */
  public resolve(consumerAppId: string, method: string, path: string): RouteMatch | undefined {
    const routes = this.#routesByApp.get(consumerAppId);
    if (routes === undefined) {
      return undefined;
    }
    return matchRoute(routes, method, path);
  }
}
