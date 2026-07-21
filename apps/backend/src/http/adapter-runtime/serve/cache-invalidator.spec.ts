import { describe, expect, it } from "vitest";

import { ResponseCacheInvalidator } from "./cache-invalidator.js";
import { InProcessResponseCache, type ResponseCacheEntry } from "./response-cache.js";

/**
 * **The single coarse-invalidation seam, both key kinds (CH-3/CH-4/CH-5.6).** The production
 * {@link ResponseCacheInvalidator} is a thin adapter over the shared cache's two drop
 * operations; these tests pin that it forwards each call and only that call — by backend
 * resource (CH-3/CH-4) and by endpoint id (CH-5) — over one mechanism.
 */

const t0 = new Date("2026-07-21T00:00:00.000Z");

/** A cache that records which drop op was invoked, to pin the forwarding contract exactly. */
class RecordingCache {
  public readonly resourceDrops: { backendAppId: string; resourceRef: string }[] = [];
  public readonly endpointDrops: string[] = [];
  public dropByBackendResource(backendAppId: string, resourceRef: string): void {
    this.resourceDrops.push({ backendAppId, resourceRef });
  }
  public dropByEndpoint(endpointId: string): void {
    this.endpointDrops.push(endpointId);
  }
}

function entry(endpointId: string, normalizedParams: string): ResponseCacheEntry {
  return {
    endpointId,
    normalizedParams,
    body: { seeded: normalizedParams },
    contributingBackendAppIds: ["backend-app"],
    contributingBackendResources: [{ backendAppId: "backend-app", resourceRef: "tasks" }],
    cacheTtl: 60_000,
  };
}

describe("ResponseCacheInvalidator", () => {
  it("invalidateBackendResource forwards to dropByBackendResource and nothing else (CH-3/CH-4)", () => {
    const cache = new RecordingCache();
    new ResponseCacheInvalidator(cache).invalidateBackendResource("backend-app", "tasks");

    expect(cache.resourceDrops).toEqual([{ backendAppId: "backend-app", resourceRef: "tasks" }]);
    expect(cache.endpointDrops).toEqual([]);
  });

  it("invalidateEndpoint forwards to dropByEndpoint and nothing else (CH-5.6)", () => {
    const cache = new RecordingCache();
    new ResponseCacheInvalidator(cache).invalidateEndpoint("endpoint-1");

    expect(cache.endpointDrops).toEqual(["endpoint-1"]);
    expect(cache.resourceDrops).toEqual([]);
  });

  it("CH-5.1/5.2: invalidateEndpoint evicts EVERY cached entry of that endpoint, over the real cache", () => {
    const cache = new InProcessResponseCache();
    cache.set(entry("endpoint-1", "a"), t0);
    cache.set(entry("endpoint-1", "b"), t0);
    cache.set(entry("endpoint-2", "a"), t0);

    new ResponseCacheInvalidator(cache).invalidateEndpoint("endpoint-1");

    // Both of endpoint-1's entries are gone; endpoint-2's entry is untouched (coarse per endpoint).
    expect(cache.get("endpoint-1", "a", t0)).toBeUndefined();
    expect(cache.get("endpoint-1", "b", t0)).toBeUndefined();
    expect(cache.get("endpoint-2", "a", t0)).toBeDefined();
  });

  it("invalidateEndpoint is a safe no-op for an endpoint with nothing cached", () => {
    const cache = new InProcessResponseCache();
    expect(() => {
      new ResponseCacheInvalidator(cache).invalidateEndpoint("unknown");
    }).not.toThrow();
  });
});
