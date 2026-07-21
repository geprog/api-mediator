import type { AdapterRequest } from "@mediator/adapter-engine";
import type { IrOperation } from "@mediator/domain";

/**
 * **The adapter Response cache (CH-1/CH-2).** Read responses of an `AdapterEndpoint`
 * with a configured `cacheTtl` are cached per `(adapterEndpointId, normalized request
 * params)`; a subsequent equivalent request within the TTL is served from cache,
 * short-circuiting all backend calls (CH-1.1). Only complete, valid responses enter the
 * cache — never degraded/error/write responses (CH-2), which would freeze a transient
 * failure across the whole TTL for every caller.
 *
 * The cache is **in-process**: the deployment is single-instance, so a restart simply
 * empties it, which is correctness-safe (the spec's explicit implementation choice — TTL
 * is the only *guaranteed* staleness bound anyway). There is no table and no migration.
 *
 * Coarse invalidation (CH-3/CH-4) is built on this port: every entry captures the set of
 * `(backendAppId, resourceRef)` pairs it was built from (see
 * {@link ContributingBackendResource}), and {@link ResponseCache.dropByBackendResource}
 * evicts — across every endpoint — each entry whose contributing set includes a signaled
 * pair. A drop is always correctness-safe (worst case a spurious miss → re-fetch), which
 * is exactly what lets it run outside any transaction. CH-5's per-endpoint invalidation is
 * a LATER slice; {@link ResponseCache.dropByEndpoint} is the seam it will drive, present
 * here but wired to no trigger yet.
 */

/**
 * CH-3/CH-4 provenance: one backend resource a cached response was built from, as
 * `(backendAppId, resourceRef)`. Captured on every entry so the coarse-invalidation seam
 * can drop entries by backend resource without re-deriving them
 * ({@link ResponseCache.dropByBackendResource}).
 */
export interface ContributingBackendResource {
  readonly backendAppId: string;
  readonly resourceRef: string;
}

/** A cached, complete-and-valid read response (CH-1/CH-2). */
export interface ResponseCacheEntry {
  readonly endpointId: string;
  /** The canonical, normalized request params — see {@link normalizeCacheParams}. */
  readonly normalizedParams: string;
  /** The served consumer-shape response body (CH-1.1). */
  readonly body: unknown;
  /** The backends that contributed the response, for the out-of-band provenance header. */
  readonly contributingBackendAppIds: readonly string[];
  /** CH-3/CH-4 forward-wiring — see {@link ContributingBackendResource}. */
  readonly contributingBackendResources: readonly ContributingBackendResource[];
  /**
   * The endpoint's `cacheTtl` in **milliseconds** (the unit the domain models it in —
   * `AdapterEndpoint.cacheTtl`). {@link ResponseCache.set} derives the entry's expiry as
   * `now + cacheTtl`.
   */
  readonly cacheTtl: number;
}

/**
 * The in-process response-cache port (CH-1). A `now: Date` is passed into every operation
 * so TTL is driven by the caller's injected clock (deterministic under test): `get` treats
 * an entry at/after its expiry as a miss (CH-1.4), and `set` stamps `now + cacheTtl`.
 */
export interface ResponseCache {
  /** A live (non-expired) entry for the key, or `undefined` on a miss (CH-1.1/CH-1.4). */
  get(endpointId: string, normalizedParams: string, now: Date): ResponseCacheEntry | undefined;
  /** Store a complete, valid response, expiring at `now + entry.cacheTtl` (CH-1/CH-2). */
  set(entry: ResponseCacheEntry, now: Date): void;
  /**
   * CH-3.2/CH-3.3 — the explicit "drop everything for this backend resource" op. Evicts
   * **every** entry, across **all** endpoints, whose `contributingBackendResources` includes
   * `(backendAppId, resourceRef)`. Coarse by construction: an endpoint bound to several
   * backend resources loses **all** its cached entries when **one** of them signals, because
   * each such entry lists that resource among its contributors and is therefore dropped
   * regardless of its other contributors (CH-3.3). Safe to call for an unknown pair (no-op),
   * and always correctness-safe — the worst outcome is a spurious miss → re-fetch — which is
   * what lets it run outside any transaction (CH-3.4).
   */
  dropByBackendResource(backendAppId: string, resourceRef: string): void;
  /**
   * CH-5 seam — drop **all** entries of one endpoint. Present so the later configuration /
   * binding-health invalidation slice (CH-5) can route through the SAME cache port by
   * endpoint id rather than backend resource; **no CH-5 trigger is wired in this slice**.
   * Safe to call for an unknown endpoint (no-op).
   */
  dropByEndpoint(endpointId: string): void;
}

/**
 * CH-1.5 — the narrow hit/miss metric seam the serve handler records the response cache's
 * per-endpoint hit rate through. The shared `AdapterTelemetry` satisfies this structurally
 * (its `recordCacheHit`/`recordCacheMiss` write the OTel counters); a serve handler built
 * without it simply records nothing, so the metric never sits on a business-critical path.
 */
export interface ResponseCacheMetrics {
  recordCacheHit(operationKey: string, endpointId: string): void;
  recordCacheMiss(operationKey: string, endpointId: string): void;
}

/** One stored entry plus its absolute expiry (epoch ms), derived on {@link InProcessResponseCache.set}. */
interface StoredEntry {
  readonly entry: ResponseCacheEntry;
  readonly expiresAt: number;
}

/**
 * The in-process {@link ResponseCache}. Entries are held in a per-endpoint bucket — the
 * `(endpointId, normalizedParams)` key structure directly, and the grouping
 * {@link InProcessResponseCache.dropByEndpoint} (CH-5 seam) drops in O(1).
 *
 * TTL is enforced lazily **on read**: an entry at/after its expiry reads as a miss and is
 * dropped so it never lingers (CH-1.4). Eviction is intentionally just expiry-on-read —
 * no size bound — which is sufficient for the single-instance, restart-clears-it model.
 *
 * {@link InProcessResponseCache.dropByBackendResource} (CH-3.2/CH-3.3) scans buckets for
 * entries contributed to by the signaled `(backendAppId, resourceRef)`; a full scan is
 * acceptable because invalidation is a rare change signal, not a per-request hot path.
 */
export class InProcessResponseCache implements ResponseCache {
  readonly #byEndpoint = new Map<string, Map<string, StoredEntry>>();

  public get(
    endpointId: string,
    normalizedParams: string,
    now: Date,
  ): ResponseCacheEntry | undefined {
    const bucket = this.#byEndpoint.get(endpointId);
    if (bucket === undefined) {
      return undefined;
    }
    const stored = bucket.get(normalizedParams);
    if (stored === undefined) {
      return undefined;
    }
    if (now.getTime() >= stored.expiresAt) {
      // CH-1.4 — the TTL elapsed: a miss, and dropped so an expired entry never lingers.
      bucket.delete(normalizedParams);
      if (bucket.size === 0) {
        this.#byEndpoint.delete(endpointId);
      }
      return undefined;
    }
    return stored.entry;
  }

  public set(entry: ResponseCacheEntry, now: Date): void {
    let bucket = this.#byEndpoint.get(entry.endpointId);
    if (bucket === undefined) {
      bucket = new Map<string, StoredEntry>();
      this.#byEndpoint.set(entry.endpointId, bucket);
    }
    bucket.set(entry.normalizedParams, { entry, expiresAt: now.getTime() + entry.cacheTtl });
  }

  public dropByBackendResource(backendAppId: string, resourceRef: string): void {
    for (const [endpointId, bucket] of this.#byEndpoint) {
      for (const [normalizedParams, stored] of bucket) {
        const contributedTo = stored.entry.contributingBackendResources.some(
          (resource) =>
            resource.backendAppId === backendAppId && resource.resourceRef === resourceRef,
        );
        if (contributedTo) {
          // CH-3.3 — any entry the signaled resource contributed to is dropped, regardless
          // of its other contributors; a multi-resource endpoint thereby loses all of them.
          bucket.delete(normalizedParams);
        }
      }
      if (bucket.size === 0) {
        this.#byEndpoint.delete(endpointId);
      }
    }
  }

  public dropByEndpoint(endpointId: string): void {
    // CH-5 seam — O(1) whole-bucket drop. Unknown endpoint → no-op.
    this.#byEndpoint.delete(endpointId);
  }
}

/**
 * CH-1.2 — the canonical, normalized cache params for a read request. It folds the
 * request's method (from the consumer operation — one `AdapterEndpoint` pins exactly one
 * operation, hence one method) with its path parameters, query, and body (only when the
 * read carries one), serialized so that:
 *
 * - two requests differing only in parameter **ordering** map to the SAME key (object keys
 *   are sorted), and
 * - two requests differing in any parameter **value** map to DIFFERENT keys.
 *
 * Percent-**encoding** is already decoded at the REST boundary before this runs (path
 * parameters by the route matcher, query by Fastify), so re-encoded-but-equal requests
 * already arrive with identical values and therefore collide here.
 *
 * This replicates `@mediator/outbound`'s `canonicalJson` semantics (sorted object keys,
 * arrays keep their order, primitives via `JSON.stringify`) rather than importing it,
 * because the request body is typed `unknown` — not the `JsonValue` `canonicalJson`
 * requires — so reusing it would force an unsafe narrowing. The two must stay semantically
 * identical; see the accompanying tests.
 */
export function normalizeCacheParams(operation: IrOperation, request: AdapterRequest): string {
  const material: Record<string, unknown> = {
    method: operation.method,
    pathParameters: request.pathParameters,
    query: request.query,
  };
  if (request.body !== undefined) {
    material.body = request.body;
  }
  return canonicalize(material);
}

/** Canonical, stable stringification of an arbitrary value (see {@link normalizeCacheParams}). */
function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return canonicalizePrimitive(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  // Sort keys → parameter ordering never changes the key; drop `undefined`-valued keys
  // exactly as JSON serialization would, so an explicit `undefined` never affects the key.
  const keys = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort();
  const members = keys.map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`);
  return `{${members.join(",")}}`;
}

/**
 * Stringify a non-object canonically. `undefined`/function/symbol are not JSON values
 * (they occur only as array holes here, since object keys carrying them are dropped
 * above); render them as `null` — matching `JSON.stringify`'s array-hole behavior — so the
 * key is always stable and never throws. `bigint` (never present in a parsed request, but
 * defended against) stringifies to its decimal digits.
 */
function canonicalizePrimitive(value: unknown): string {
  if (value === undefined || typeof value === "function" || typeof value === "symbol") {
    return "null";
  }
  if (typeof value === "bigint") {
    return `"${value.toString()}"`;
  }
  return JSON.stringify(value);
}
