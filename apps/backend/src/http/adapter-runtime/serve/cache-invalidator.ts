import type { ResponseCache } from "./response-cache.js";

/**
 * **The single coarse-invalidation seam (CH-3/CH-4/CH-5).** Every producer of a cache-drop
 * signal routes through this one interface rather than poking the cache directly — the
 * `SyncEvent` consumer (CH-3) and the adapter write path (CH-4) by **backend resource**, and
 * the composition/status-mutation operations (CH-5, CO-6) by **endpoint id** — so the whole
 * invalidation contract is pinned in one place (CH-5.6: one mechanism, two key kinds).
 *
 * The backend-resource input is the explicit `(backendAppId, resourceRef)` pair the cache
 * captures on every entry (`ResponseCacheEntry.contributingBackendResources`), so a unit test
 * can assert the mapping from a `SyncEvent` to the exact set of dropped keys with no engine
 * running (CH-3.2). Invalidation is coarse and always correctness-safe — the worst outcome is a
 * spurious miss → re-fetch — which is why it needs no transaction (CH-3.4).
 */
export interface CacheInvalidator {
  /**
   * Drop every cached response of every endpoint bound to `(backendAppId, resourceRef)`
   * (CH-3.1/CH-3.3). A no-op for a backend resource nothing is cached for.
   */
  invalidateBackendResource(backendAppId: string, resourceRef: string): void;
  /**
   * CH-5 — drop **all** of one endpoint's cached entries when its serving configuration or a
   * binding's status changes, or it is disabled/re-enabled (CO-6): a cached response must not
   * outlive the configuration that produced it (CH-5.1/5.2/5.5). The by-endpoint sibling of
   * {@link invalidateBackendResource}, over the SAME cache (CH-5.6). A no-op for an endpoint
   * with nothing cached (e.g. every commit of an endpoint that has no `cacheTtl`).
   */
  invalidateEndpoint(endpointId: string): void;
}

/**
 * The production {@link CacheInvalidator}: a thin adapter over the cache's two drop
 * operations. It holds only the drop capability of the cache, never `get`/`set` —
 * invalidation and serving stay distinct roles over one shared in-process cache instance.
 */
export class ResponseCacheInvalidator implements CacheInvalidator {
  readonly #cache: Pick<ResponseCache, "dropByBackendResource" | "dropByEndpoint">;

  public constructor(cache: Pick<ResponseCache, "dropByBackendResource" | "dropByEndpoint">) {
    this.#cache = cache;
  }

  public invalidateBackendResource(backendAppId: string, resourceRef: string): void {
    this.#cache.dropByBackendResource(backendAppId, resourceRef);
  }

  public invalidateEndpoint(endpointId: string): void {
    this.#cache.dropByEndpoint(endpointId);
  }
}
