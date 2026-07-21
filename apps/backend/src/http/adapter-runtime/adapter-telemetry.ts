import { getMeter, getTracer } from "@mediator/telemetry";
import type { Attributes, Counter, Histogram, Tracer } from "@opentelemetry/api";

import type { AdapterResult, CauseToken } from "./outcome-http.js";

/**
 * OpenTelemetry for the Adapter Server Runtime (RT-5.2/5.3). One trace per inbound
 * request (the {@link tracer}) and per-`AdapterEndpoint` metrics: request rate,
 * latency, error rate, degraded rate, and the response-cache hit/miss counters that
 * make cache hit rate per endpoint observable (CH-1.5).
 *
 * **Security (RT-5.5):** every attribute here is an id or an enum — the operation
 * key, the endpoint id, the consumer app id, the outcome, the cause. **Never** a
 * request/response payload value, a token, or credential material.
 *
 * When telemetry is disabled `getMeter`/`getTracer` return the OpenTelemetry API's
 * no-op implementations, so this is safe to call unconditionally.
 */
export interface AdapterRequestMetric {
  readonly operationKey: string;
  readonly endpointId: string | undefined;
  readonly consumerAppId: string;
  /** The result kind, or `internal-error` for an unexpected runtime failure. */
  readonly outcome: AdapterResult["kind"] | "internal-error";
  readonly cause: CauseToken | undefined;
  readonly degraded: boolean;
  readonly durationMs: number;
}

export class AdapterTelemetry {
  public readonly tracer: Tracer;
  readonly #requestCount: Counter;
  readonly #requestDuration: Histogram;
  readonly #degradedCount: Counter;
  readonly #cacheHitCount: Counter;
  readonly #cacheMissCount: Counter;

  public constructor() {
    this.tracer = getTracer("@mediator/adapter-engine");
    const meter = getMeter("@mediator/adapter-engine");
    this.#requestCount = meter.createCounter("adapter.request.count", {
      description: "Adapter requests per endpoint, by outcome and cause",
    });
    this.#requestDuration = meter.createHistogram("adapter.request.duration", {
      description: "Adapter request latency per endpoint",
      unit: "ms",
    });
    this.#degradedCount = meter.createCounter("adapter.request.degraded.count", {
      description: "Degraded (failed-supplement) adapter responses per endpoint",
    });
    this.#cacheHitCount = meter.createCounter("adapter.request.cache_hit.count", {
      description: "Adapter response-cache hits per endpoint (CH-1)",
    });
    this.#cacheMissCount = meter.createCounter("adapter.request.cache_miss.count", {
      description:
        "Adapter response-cache misses per endpoint (CH-1); hit rate = hits / (hits + misses)",
    });
  }

  /** Record one completed adapter request's metrics (ids/enums only). */
  public recordRequest(metric: AdapterRequestMetric): void {
    const endpointId = metric.endpointId ?? "none";
    const base: Attributes = {
      operation: metric.operationKey,
      endpoint_id: endpointId,
      consumer_app_id: metric.consumerAppId,
    };
    this.#requestCount.add(1, {
      ...base,
      outcome: metric.outcome,
      cause: metric.cause ?? "none",
    });
    this.#requestDuration.record(metric.durationMs, { ...base, outcome: metric.outcome });
    if (metric.degraded) {
      this.#degradedCount.add(1, base);
    }
  }

  /**
   * CH-1.5 — count one response-cache **hit** for the per-endpoint hit-rate metric. The
   * serve handler calls this when a read is served from cache (short-circuiting backends).
   */
  public recordCacheHit(operationKey: string, endpointId: string): void {
    this.#cacheHitCount.add(1, { operation: operationKey, endpoint_id: endpointId });
  }

  /**
   * CH-1.5 — count one response-cache **miss** (a cacheable read with no live entry). Hit
   * rate per endpoint = hits / (hits + misses) over these two counters.
   */
  public recordCacheMiss(operationKey: string, endpointId: string): void {
    this.#cacheMissCount.add(1, { operation: operationKey, endpoint_id: endpointId });
  }
}
