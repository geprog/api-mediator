import type { DeliveredEvent } from "@mediator/event-bus";
import { describe, expect, it } from "vitest";

import {
  ADAPTER_CACHE_INVALIDATION_CONSUMER_NAME,
  SyncEventCacheInvalidationConsumer,
  targetResourceRefForOrigin,
} from "./cache-invalidation.js";
import type { CacheInvalidator } from "./serve/cache-invalidator.js";
import { ResponseCacheInvalidator } from "./serve/cache-invalidator.js";
import {
  InProcessResponseCache,
  type ContributingBackendResource,
} from "./serve/response-cache.js";

/**
 * CH-3 — the `SyncEvent` → `(backendAppId, resourceRef)` translation contract, pinned with
 * **no engine running**: the consumer is exercised directly over a fake rule reader + either a
 * spy invalidator (to assert the exact resolved pair) or a real cache + invalidator (to assert
 * the exact set of dropped entries). See `serve/response-cache.spec.ts` for the coarse-drop
 * mechanics and `serve/cache-serve.spec.ts` for the CH-4 write-side of the same seam.
 */

const t0 = new Date(1_000_000);
const live = new Date(t0.getTime() + 1_000);

/** A canonical, direction-agnostic pair as `canonicalResourcePairRef` builds it. */
const PAIR = "appA:tasks|appB:issues"; // appA is the source side; appB the changed target.

function syncEvent(payload: Record<string, unknown>): DeliveredEvent {
  return { id: "evt-1", type: "sync-execution", occurredAt: t0, payload };
}

function successEvent(overrides: Record<string, unknown> = {}): DeliveredEvent {
  return syncEvent({
    status: "success",
    originAppId: "appB",
    relatedRuleId: "rule-1",
    relatedMappingId: "mapping-1",
    ...overrides,
  });
}

/** A rule reader that maps `rule-1` → PAIR and every other rule id → absent (mirrors getById). */
const ruleReader = (ruleId: string): Promise<string | undefined> =>
  Promise.resolve(ruleId === "rule-1" ? PAIR : undefined);

class SpyInvalidator implements CacheInvalidator {
  public readonly calls: { backendAppId: string; resourceRef: string }[] = [];
  public invalidateBackendResource(backendAppId: string, resourceRef: string): void {
    this.calls.push({ backendAppId, resourceRef });
  }
}

function seed(
  cache: InProcessResponseCache,
  endpointId: string,
  key: string,
  resources: ContributingBackendResource[],
): void {
  cache.set(
    {
      endpointId,
      normalizedParams: key,
      body: { seeded: key },
      contributingBackendAppIds: resources.map((resource) => resource.backendAppId),
      contributingBackendResources: resources,
      cacheTtl: 60_000,
    },
    t0,
  );
}

function consumer(invalidator: CacheInvalidator): SyncEventCacheInvalidationConsumer<undefined> {
  return new SyncEventCacheInvalidationConsumer<undefined>(invalidator, ruleReader);
}

// ── targetResourceRefForOrigin (the pure translation) ────────────────────────

describe("targetResourceRefForOrigin (CH-3.2)", () => {
  it("selects the side whose app is the changed target", () => {
    expect(targetResourceRefForOrigin(PAIR, "appB")).toBe("issues");
    expect(targetResourceRefForOrigin(PAIR, "appA")).toBe("tasks");
  });

  it("returns undefined when the origin app is not a side of the pair", () => {
    expect(targetResourceRefForOrigin(PAIR, "appZ")).toBeUndefined();
  });

  it("returns undefined for a malformed pair (not exactly two sides)", () => {
    expect(targetResourceRefForOrigin("appA:tasks", "appA")).toBeUndefined();
    expect(targetResourceRefForOrigin("a:1|b:2|c:3", "a")).toBeUndefined();
  });

  it("returns undefined for an ambiguous same-app pair (both sides match the origin)", () => {
    expect(targetResourceRefForOrigin("appA:tasks|appA:notes", "appA")).toBeUndefined();
  });

  it("keeps a resource ref that itself contains a colon (only the app-id colon is consumed)", () => {
    expect(targetResourceRefForOrigin("appA:ns:tasks|appB:issues", "appA")).toBe("ns:tasks");
  });
});

// ── the consumer ─────────────────────────────────────────────────────────────

describe("SyncEventCacheInvalidationConsumer (CH-3)", () => {
  it("only handles sync-execution events", () => {
    const c = consumer(new SpyInvalidator());
    expect(c.handles("sync-execution")).toBe(true);
    expect(c.handles("SpecIngested")).toBe(false);
    expect(c.handles("MappingApproved")).toBe(false);
    expect(c.name).toBe(ADAPTER_CACHE_INVALIDATION_CONSUMER_NAME);
  });

  it("CH-3.2: a successful event resolves EXACTLY the changed (backendAppId, resourceRef)", async () => {
    const spy = new SpyInvalidator();
    await consumer(spy).handle(successEvent(), undefined);
    expect(spy.calls).toEqual([{ backendAppId: "appB", resourceRef: "issues" }]);
  });

  it("CH-3.1/3.3: over a pre-seeded cache it drops exactly the entries bound to the changed resource", async () => {
    const cache = new InProcessResponseCache();
    // Dropped: entries contributed to by (appB, issues) — including a multi-resource endpoint.
    seed(cache, "ep-1", "k1", [{ backendAppId: "appB", resourceRef: "issues" }]);
    seed(cache, "ep-2", "k2", [
      { backendAppId: "appB", resourceRef: "issues" },
      { backendAppId: "appC", resourceRef: "extra" },
    ]);
    // Survive: the source side (appA, tasks) and the same app's OTHER resource (appB, tasks).
    seed(cache, "ep-3", "k3", [{ backendAppId: "appA", resourceRef: "tasks" }]);
    seed(cache, "ep-4", "k4", [{ backendAppId: "appB", resourceRef: "tasks" }]);

    await consumer(new ResponseCacheInvalidator(cache)).handle(successEvent(), undefined);

    expect(cache.get("ep-1", "k1", live)).toBeUndefined();
    expect(cache.get("ep-2", "k2", live)).toBeUndefined();
    expect(cache.get("ep-3", "k3", live)?.body).toEqual({ seeded: "k3" });
    expect(cache.get("ep-4", "k4", live)?.body).toEqual({ seeded: "k4" });
  });

  it("is idempotent — a redelivery re-drops without throwing and changes nothing further", async () => {
    const cache = new InProcessResponseCache();
    seed(cache, "ep-1", "k1", [{ backendAppId: "appB", resourceRef: "issues" }]);
    seed(cache, "ep-3", "k3", [{ backendAppId: "appA", resourceRef: "tasks" }]);
    const c = consumer(new ResponseCacheInvalidator(cache));

    await c.handle(successEvent(), undefined);
    await c.handle(successEvent(), undefined);

    expect(cache.get("ep-1", "k1", live)).toBeUndefined();
    expect(cache.get("ep-3", "k3", live)?.body).toEqual({ seeded: "k3" });
  });

  it("CH-3 selectivity: a non-applied status invalidates nothing", async () => {
    for (const status of ["failure", "skipped-loop", "skipped-policy", "conflict"]) {
      const spy = new SpyInvalidator();
      await consumer(spy).handle(successEvent({ status }), undefined);
      expect(spy.calls).toHaveLength(0);
    }
  });

  it("invalidates nothing when the target app or the rule id is absent", async () => {
    const missingOrigin = new SpyInvalidator();
    await consumer(missingOrigin).handle(successEvent({ originAppId: undefined }), undefined);
    expect(missingOrigin.calls).toHaveLength(0);

    const missingRule = new SpyInvalidator();
    await consumer(missingRule).handle(successEvent({ relatedRuleId: undefined }), undefined);
    expect(missingRule.calls).toHaveLength(0);
  });

  it("invalidates nothing when the rule no longer resolves (since-deleted rule)", async () => {
    const spy = new SpyInvalidator();
    await consumer(spy).handle(successEvent({ relatedRuleId: "gone" }), undefined);
    expect(spy.calls).toHaveLength(0);
  });
});
