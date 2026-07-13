import { describe, expect, it } from "vitest";

import { NullRecentlyWrittenCache, TtlRecentlyWrittenCache } from "./recently-written-cache.js";
import type { RecentWriteKey, RecentlyWrittenCache } from "./types.js";

const KEY: RecentWriteKey = { appId: "appB", resource: "customers", nativeId: "b1" };

describe("TtlRecentlyWrittenCache (EP-2)", () => {
  it("a freshly written key is recently-written; expires exactly at the TTL boundary", () => {
    let now = 1_000;
    const cache = new TtlRecentlyWrittenCache(500, { now: () => now });

    cache.markWritten(KEY);
    expect(cache.isRecentlyWritten(KEY)).toBe(true);

    now = 1_499; // still inside the TTL window
    expect(cache.isRecentlyWritten(KEY)).toBe(true);

    now = 1_500; // expiry (now + ttl) reached → treated as expired
    expect(cache.isRecentlyWritten(KEY)).toBe(false);
  });

  it("distinguishes keys by (appId, resource, nativeId)", () => {
    const cache = new TtlRecentlyWrittenCache(1_000, { now: () => 0 });
    cache.markWritten(KEY);

    expect(cache.isRecentlyWritten({ ...KEY, appId: "appA" })).toBe(false);
    expect(cache.isRecentlyWritten({ ...KEY, resource: "orders" })).toBe(false);
    expect(cache.isRecentlyWritten({ ...KEY, nativeId: "b2" })).toBe(false);
    expect(cache.isRecentlyWritten(KEY)).toBe(true);
  });

  it("re-marking refreshes the TTL", () => {
    let now = 0;
    const cache = new TtlRecentlyWrittenCache(100, { now: () => now });
    cache.markWritten(KEY);
    now = 50;
    cache.markWritten(KEY); // refresh → expiry now 150
    now = 120;
    expect(cache.isRecentlyWritten(KEY)).toBe(true);
    now = 150;
    expect(cache.isRecentlyWritten(KEY)).toBe(false);
  });

  it("rejects a non-positive TTL", () => {
    expect(() => new TtlRecentlyWrittenCache(0)).toThrow();
    expect(() => new TtlRecentlyWrittenCache(-1)).toThrow();
  });
});

describe("NullRecentlyWrittenCache (the disabled default)", () => {
  it("never reports a key as recently-written, even right after a write", () => {
    // Typed as the interface so the always-miss no-ops are exercised via the same
    // surface the stage uses (the concrete methods ignore their argument).
    const cache: RecentlyWrittenCache = new NullRecentlyWrittenCache();
    cache.markWritten(KEY);
    expect(cache.isRecentlyWritten(KEY)).toBe(false);
  });
});
