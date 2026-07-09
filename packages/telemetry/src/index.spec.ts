import { afterEach, describe, expect, it } from "vitest";
import type { TelemetryConfig } from "@mediator/config";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import { NodeSDK } from "@opentelemetry/sdk-node";

import {
  buildTelemetryResource,
  getActiveTraceContext,
  getMeter,
  getTracer,
  shutdownTelemetry,
  startTelemetry,
} from "./index.js";

const disabledConfig: TelemetryConfig = { enabled: false };
const enabledConfig: TelemetryConfig = {
  enabled: true,
  endpoint: "http://localhost:4318",
  protocol: "http/protobuf",
  serviceName: "test-service",
};

// Every test tears the SDK down so global OpenTelemetry providers never leak
// into the next test (and no live collector is ever contacted beyond a best-effort
// flush on shutdown, which fails silently).
afterEach(async () => {
  await shutdownTelemetry();
});

describe("buildTelemetryResource", () => {
  it("carries the configured service.name", () => {
    const resource = buildTelemetryResource("my-service");

    expect(resource.attributes[ATTR_SERVICE_NAME]).toBe("my-service");
  });
});

describe("startTelemetry when disabled", () => {
  it("returns null and starts nothing", () => {
    expect(startTelemetry(disabledConfig)).toBeNull();
  });

  it("leaves the trace/metric helpers as safe no-ops", () => {
    startTelemetry(disabledConfig);

    const span = getTracer("test").startSpan("noop");
    expect(span.isRecording()).toBe(false);
    span.end();

    // Creating instruments on the no-op meter must not throw.
    expect(() => getMeter("test").createCounter("noop_counter")).not.toThrow();
  });

  it("reports no active trace context", () => {
    startTelemetry(disabledConfig);

    expect(getActiveTraceContext()).toBeNull();
  });
});

describe("startTelemetry when enabled", () => {
  it("constructs and starts an SDK without needing a live collector", () => {
    const sdk = startTelemetry(enabledConfig);

    expect(sdk).not.toBeNull();
    expect(sdk).toBeInstanceOf(NodeSDK);
  });

  it("is idempotent while an SDK is already running", () => {
    const first = startTelemetry(enabledConfig);
    const second = startTelemetry(enabledConfig);

    expect(second).toBe(first);
  });

  it("wires getTracer to a real, recording tracer", () => {
    startTelemetry(enabledConfig);

    const span = getTracer("test").startSpan("real");
    expect(span.isRecording()).toBe(true);
    span.end();
  });

  it("exposes the active span's trace/span ids", () => {
    startTelemetry(enabledConfig);

    const { expected, actual } = getTracer("test").startActiveSpan("op", (span) => {
      const spanContext = span.spanContext();
      const observed = getActiveTraceContext();
      span.end();
      return { expected: spanContext, actual: observed };
    });

    expect(actual).toEqual({ traceId: expected.traceId, spanId: expected.spanId });
  });
});

describe("shutdownTelemetry", () => {
  it("is a safe no-op when nothing was started", async () => {
    await expect(shutdownTelemetry()).resolves.toBeUndefined();
  });
});
