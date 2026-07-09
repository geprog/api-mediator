import { metrics, trace } from "@opentelemetry/api";
import type { Meter, Tracer } from "@opentelemetry/api";
import type { TelemetryConfig } from "@mediator/config";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-proto";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-proto";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { resourceFromAttributes } from "@opentelemetry/resources";
import type { Resource } from "@opentelemetry/resources";
import { BatchLogRecordProcessor } from "@opentelemetry/sdk-logs";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";

/**
 * `@mediator/telemetry` — OpenTelemetry bootstrap for the API Mediator.
 *
 * Telemetry is a complementary operational layer, never on any business-critical
 * path (`docs/architecture/observability.md`): when it is disabled (no OTLP
 * endpoint) {@link startTelemetry} is a clean no-op and every helper degrades to
 * the OpenTelemetry API's built-in no-op implementations, so the mediator runs
 * correctly with the pipeline down.
 *
 * The SDK is deliberately NOT started at import time — the app's preload/bootstrap
 * (`apps/backend/src/otel.ts`, a later slice) calls {@link startTelemetry}.
 */

/** The opaque SDK handle returned by {@link startTelemetry}. */
export type TelemetrySDK = NodeSDK;

/** traceId/spanId of the active span, written onto `SyncEvent`/`AuditLog` rows. */
export interface ActiveTraceContext {
  readonly traceId: string;
  readonly spanId: string;
}

let activeSdk: NodeSDK | null = null;

/**
 * Build the telemetry {@link Resource} carrying `service.name`. Exposed so the
 * resource can be inspected in isolation (e.g. in tests) without starting an SDK.
 */
export function buildTelemetryResource(serviceName: string): Resource {
  return resourceFromAttributes({ [ATTR_SERVICE_NAME]: serviceName });
}

/** Join an OTLP base endpoint with a per-signal path, tolerating a trailing slash. */
function signalUrl(endpoint: string, signalPath: string): string {
  const base = endpoint.endsWith("/") ? endpoint.slice(0, -1) : endpoint;
  return `${base}/${signalPath}`;
}

/**
 * Start the OpenTelemetry SDK for the given telemetry configuration.
 *
 * Returns `null` — a deliberate no-op — when telemetry is disabled. When enabled,
 * it wires OTLP http/protobuf exporters for traces, metrics, and logs at the
 * configured endpoint, registers the Node auto-instrumentations (http, fastify,
 * pg, …), and starts the SDK. Calling it again while an SDK is already running
 * returns the existing instance rather than starting a second one.
 */
export function startTelemetry(cfg: TelemetryConfig): TelemetrySDK | null {
  if (!cfg.enabled) {
    return null;
  }
  if (activeSdk !== null) {
    return activeSdk;
  }

  const sdk = new NodeSDK({
    resource: buildTelemetryResource(cfg.serviceName),
    traceExporter: new OTLPTraceExporter({ url: signalUrl(cfg.endpoint, "v1/traces") }),
    metricReader: new PeriodicExportingMetricReader({
      exporter: new OTLPMetricExporter({ url: signalUrl(cfg.endpoint, "v1/metrics") }),
    }),
    logRecordProcessors: [
      new BatchLogRecordProcessor({
        exporter: new OTLPLogExporter({ url: signalUrl(cfg.endpoint, "v1/logs") }),
      }),
    ],
    instrumentations: [
      getNodeAutoInstrumentations({
        // The app's own pino `mixin` already stamps the active span's
        // camelCase `traceId`/`spanId` (matching `SyncEvent.traceId`/`spanId`)
        // onto every log record, so silence this instrumentation's redundant
        // snake_case `trace_id`/`span_id` log-correlation injection. Only log
        // correlation is disabled — the pino→OTLP log bridge stays on.
        "@opentelemetry/instrumentation-pino": { disableLogCorrelation: true },
      }),
    ],
  });

  sdk.start();
  activeSdk = sdk;
  return sdk;
}

/**
 * Shut down the running SDK (flushing pending telemetry) if one was started.
 * A safe no-op when telemetry is disabled or already shut down.
 */
export async function shutdownTelemetry(): Promise<void> {
  if (activeSdk === null) {
    return;
  }
  const sdk = activeSdk;
  activeSdk = null;
  await sdk.shutdown();
}

/**
 * Get a named {@link Tracer}. Safe to call regardless of telemetry state: when
 * disabled it returns the OpenTelemetry API's no-op tracer.
 */
export function getTracer(name: string, version?: string): Tracer {
  return trace.getTracer(name, version);
}

/**
 * Get a named {@link Meter}. Safe to call regardless of telemetry state: when
 * disabled it returns the OpenTelemetry API's no-op meter.
 */
export function getMeter(name: string, version?: string): Meter {
  return metrics.getMeter(name, version);
}

/**
 * Read the active span's `traceId`/`spanId`, or `null` when there is no active
 * span (including when telemetry is disabled).
 */
export function getActiveTraceContext(): ActiveTraceContext | null {
  const span = trace.getActiveSpan();
  if (span === undefined) {
    return null;
  }
  const spanContext = span.spanContext();
  return { traceId: spanContext.traceId, spanId: spanContext.spanId };
}
