import type { ResponseCache } from "./response-cache.js";

/**
 * **The single coarse-invalidation seam (CH-3/CH-4).** Both producers of a backend-resource
 * change signal — the `SyncEvent` consumer (CH-3) and the adapter write path (CH-4) — route
 * through this one interface rather than each poking the cache directly, so the contract
 * "a change signal for `(backendAppId, resourceRef)` drops every cached response bound to it"
 * is pinned in exactly one place (CH-4.3: reuse, not a parallel mechanism).
 *
 * The input is deliberately the explicit `(backendAppId, resourceRef)` pair the cache captures
 * on every entry (`ResponseCacheEntry.contributingBackendResources`), so a unit test can assert
 * the mapping from a `SyncEvent` to the exact set of dropped keys with no engine running
 * (CH-3.2). Invalidation is coarse and always correctness-safe — the worst outcome is a spurious
 * miss → re-fetch — which is why it needs no transaction (CH-3.4).
 */
export interface CacheInvalidator {
  /**
   * Drop every cached response of every endpoint bound to `(backendAppId, resourceRef)`
   * (CH-3.1/CH-3.3). A no-op for a backend resource nothing is cached for.
   */
  invalidateBackendResource(backendAppId: string, resourceRef: string): void;
}

/**
 * The production {@link CacheInvalidator}: a thin adapter over
 * {@link ResponseCache.dropByBackendResource}. It holds only the drop capability of the
 * cache, never `get`/`set` — invalidation and serving stay distinct roles over one shared
 * in-process cache instance.
 */
export class ResponseCacheInvalidator implements CacheInvalidator {
  readonly #cache: Pick<ResponseCache, "dropByBackendResource">;

  public constructor(cache: Pick<ResponseCache, "dropByBackendResource">) {
    this.#cache = cache;
  }

  public invalidateBackendResource(backendAppId: string, resourceRef: string): void {
    this.#cache.dropByBackendResource(backendAppId, resourceRef);
  }
}
