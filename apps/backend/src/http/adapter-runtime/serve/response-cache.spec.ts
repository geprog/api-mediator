import type { AdapterRequest } from "@mediator/adapter-engine";
import type { IrOperation } from "@mediator/domain";
import { describe, expect, it } from "vitest";

import {
  InProcessResponseCache,
  normalizeCacheParams,
  type ResponseCacheEntry,
} from "./response-cache.js";

const getTodo: IrOperation = {
  operationId: "getTodo",
  method: "get",
  path: "/lists/{listId}/todos/{todoId}",
  parameters: [],
};

function request(overrides: Partial<AdapterRequest> = {}): AdapterRequest {
  return {
    consumerAppId: "consumer-app",
    operationKey: "todos/getTodo",
    pathParameters: {},
    query: {},
    headers: {},
    body: undefined,
    ...overrides,
  };
}

function entry(overrides: Partial<ResponseCacheEntry> = {}): ResponseCacheEntry {
  return {
    endpointId: "endpoint-1",
    normalizedParams: "k-1",
    body: { id: "42" },
    contributingBackendAppIds: ["backend-app"],
    contributingBackendResources: [{ backendAppId: "backend-app", resourceRef: "tasks" }],
    cacheTtl: 30_000,
    ...overrides,
  };
}

describe("normalizeCacheParams (CH-1.2)", () => {
  it("is insensitive to path-parameter key ordering (same values → same key)", () => {
    // Same values, different object insertion order — must collide.
    const a = request({ pathParameters: { listId: "7", todoId: "42" } });
    const b = request({ pathParameters: { todoId: "42", listId: "7" } });
    expect(normalizeCacheParams(getTodo, a)).toBe(normalizeCacheParams(getTodo, b));
  });

  it("is insensitive to query key ordering AND repeated-value expression", () => {
    const a = request({ query: { tag: ["x", "y"], q: "hi" } });
    const b = request({ query: { q: "hi", tag: ["x", "y"] } });
    expect(normalizeCacheParams(getTodo, a)).toBe(normalizeCacheParams(getTodo, b));
  });

  it("changes when any path-parameter VALUE differs", () => {
    const a = request({ pathParameters: { listId: "7", todoId: "42" } });
    const b = request({ pathParameters: { listId: "7", todoId: "43" } });
    expect(normalizeCacheParams(getTodo, a)).not.toBe(normalizeCacheParams(getTodo, b));
  });

  it("changes when any query VALUE differs", () => {
    const a = request({ query: { q: "hi" } });
    const b = request({ query: { q: "ho" } });
    expect(normalizeCacheParams(getTodo, a)).not.toBe(normalizeCacheParams(getTodo, b));
  });

  it("distinguishes repeated-value ORDER (a genuine value difference, not a reordering)", () => {
    const a = request({ query: { tag: ["x", "y"] } });
    const b = request({ query: { tag: ["y", "x"] } });
    expect(normalizeCacheParams(getTodo, a)).not.toBe(normalizeCacheParams(getTodo, b));
  });

  it("folds the body only when present, canonically and value-sensitively", () => {
    const noBody = request({ body: undefined });
    const withBody = request({ body: { a: 1, b: 2 } });
    const reordered = request({ body: { b: 2, a: 1 } });
    const different = request({ body: { a: 1, b: 3 } });
    expect(normalizeCacheParams(getTodo, withBody)).not.toBe(normalizeCacheParams(getTodo, noBody));
    // Object key order inside the body must not matter (canonical, like `canonicalJson`).
    expect(normalizeCacheParams(getTodo, withBody)).toBe(normalizeCacheParams(getTodo, reordered));
    expect(normalizeCacheParams(getTodo, withBody)).not.toBe(
      normalizeCacheParams(getTodo, different),
    );
  });

  it("folds the method (which one endpoint pins)", () => {
    const post: IrOperation = { ...getTodo, method: "post" };
    expect(normalizeCacheParams(getTodo, request())).not.toBe(
      normalizeCacheParams(post, request()),
    );
  });
});

describe("InProcessResponseCache (CH-1)", () => {
  const t0 = new Date(1_000_000);

  it("stores and returns a live entry within its TTL", () => {
    const cache = new InProcessResponseCache();
    cache.set(entry({ normalizedParams: "k", cacheTtl: 30_000 }), t0);
    const hit = cache.get("endpoint-1", "k", new Date(t0.getTime() + 29_999));
    expect(hit?.body).toEqual({ id: "42" });
    expect(hit?.contributingBackendAppIds).toEqual(["backend-app"]);
    expect(hit?.contributingBackendResources).toEqual([
      { backendAppId: "backend-app", resourceRef: "tasks" },
    ]);
  });

  it("is a miss for an unknown key or endpoint", () => {
    const cache = new InProcessResponseCache();
    cache.set(entry({ normalizedParams: "k" }), t0);
    expect(cache.get("endpoint-1", "other", t0)).toBeUndefined();
    expect(cache.get("other-endpoint", "k", t0)).toBeUndefined();
  });

  it("treats an entry AT or AFTER its expiry as a miss and drops it (CH-1.4)", () => {
    const cache = new InProcessResponseCache();
    cache.set(entry({ normalizedParams: "k", cacheTtl: 30_000 }), t0);
    // Exactly at expiry counts as elapsed (>=), so it is a miss.
    expect(cache.get("endpoint-1", "k", new Date(t0.getTime() + 30_000))).toBeUndefined();
    // …and the expired entry was dropped: a later read at an EARLIER time still misses.
    expect(cache.get("endpoint-1", "k", new Date(t0.getTime() + 1))).toBeUndefined();
  });

  it("a fresh set after expiry re-establishes the entry with a new expiry", () => {
    const cache = new InProcessResponseCache();
    cache.set(entry({ normalizedParams: "k", cacheTtl: 10_000 }), t0);
    expect(cache.get("endpoint-1", "k", new Date(t0.getTime() + 10_000))).toBeUndefined();
    const t1 = new Date(t0.getTime() + 50_000);
    cache.set(entry({ normalizedParams: "k", body: { id: "99" }, cacheTtl: 10_000 }), t1);
    expect(cache.get("endpoint-1", "k", new Date(t1.getTime() + 5_000))?.body).toEqual({
      id: "99",
    });
  });

  it("a key set under one request is a hit under a reordered-but-equal request (CH-1.2)", () => {
    const cache = new InProcessResponseCache();
    const keyA = normalizeCacheParams(
      getTodo,
      request({ pathParameters: { listId: "7", todoId: "42" } }),
    );
    const keyB = normalizeCacheParams(
      getTodo,
      request({ pathParameters: { todoId: "42", listId: "7" } }),
    );
    cache.set(entry({ normalizedParams: keyA }), t0);
    expect(cache.get("endpoint-1", keyB, t0)?.body).toEqual({ id: "42" });
  });
});
