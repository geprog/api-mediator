import type { Attributes, Counter, Histogram } from "@opentelemetry/api";
import type { DetectionRunResult, LlmCallMetrics } from "@mediator/mapping-engine";
import { getMeter } from "@mediator/telemetry";

/**
 * The Mapping Engine's per-detection observability sink (TD-3.5 / observability.md
 * *Mapping Engine*). The engine already surfaces a per-call {@link LlmCallMetrics}
 * record for every stage call (attempts, latency, outcome, token usage threaded
 * from the provider's `lastUsage` seam) via its `onMetrics` hook; this sink turns
 * those — plus each run's shortlist yield — into OpenTelemetry metrics.
 *
 * It is a thin adapter over `@mediator/telemetry`, so it **no-ops cleanly when
 * telemetry is disabled**: `getMeter` then returns the OpenTelemetry API's no-op
 * meter and every `record`/`add` is a no-op. Telemetry is never on a
 * business-critical path.
 */
export interface DetectionMetricsSink {
  /** Wire this to the engine `DetectionDeps.onMetrics` — one call per stage call. */
  onLlmCall(metrics: LlmCallMetrics): void;
  /** Call after a `runDetectionForSpec` resolves — emits per-pair shortlist yield. */
  onDetectionRun(result: DetectionRunResult): void;
}

/** The metrics-sink used when telemetry is off / not wired: a total no-op. */
export const noopDetectionMetricsSink: DetectionMetricsSink = {
  onLlmCall(): void {
    /* no-op */
  },
  onDetectionRun(): void {
    /* no-op */
  },
};

/**
 * The shortlist-yield readings for one detection run: the candidate-pair count per
 * **unordered** spec pair. A peer-peer pair yields two directional proposals that
 * share the one shortlist, so this dedupes by the pair to avoid double-counting; a
 * `failed` (shortlist-ceiling) proposal has no yield and is skipped. Pulled out as
 * a pure function so the dedup logic is unit-testable without a live meter.
 */
export function shortlistYieldReadings(result: DetectionRunResult): number[] {
  const seen = new Set<string>();
  const readings: number[] = [];
  for (const analysis of result.analyses) {
    const { shortlistResult, sourceSpecId, targetSpecId } = analysis.proposal;
    if (shortlistResult === null) {
      continue;
    }
    const key = [sourceSpecId, targetSpecId].sort().join("::");
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    readings.push(shortlistResult.candidatePairs.length);
  }
  return readings;
}

/**
 * Build the OpenTelemetry-backed {@link DetectionMetricsSink}, labeling every
 * signal with the active `provider` (observability.md asks for "per provider").
 * Emits, per stage (shortlist vs. detail, and the detail call's variant):
 *
 *  - `mapping.detection.llm_call.duration` (ms histogram) — LLM call latency;
 *  - `mapping.detection.llm_call.count` (counter, `outcome` attr) — success/failure;
 *  - `mapping.detection.llm_call.attempts` (histogram) — attempts incl. retries;
 *  - `mapping.detection.llm.tokens` (counter, `token_type` = prompt|eval) — usage;
 *  - `mapping.detection.retry_ceiling.count` (counter) — a call that hit the retry
 *    ceiling (`outcome = failed`); the alert hook, labeled by stage so a shortlist
 *    ceiling (whole spec pair lost) is distinguishable from a detail ceiling (one
 *    resource pair lost);
 *  - `mapping.detection.shortlist.yield` (histogram) — candidate pairs per spec
 *    pair, from each run's persisted `shortlistResult`.
 */
export function createDetectionMetricsSink(provider: string): DetectionMetricsSink {
  const meter = getMeter("@mediator/mapping-engine");

  const duration: Histogram = meter.createHistogram("mapping.detection.llm_call.duration", {
    description: "LLM stage-call latency",
    unit: "ms",
  });
  const attempts: Histogram = meter.createHistogram("mapping.detection.llm_call.attempts", {
    description: "LLM stage-call attempts (initial + corrective retries)",
  });
  const calls: Counter = meter.createCounter("mapping.detection.llm_call.count", {
    description: "LLM stage calls by outcome",
  });
  const tokens: Counter = meter.createCounter("mapping.detection.llm.tokens", {
    description: "LLM token usage (prompt/eval) per stage",
    unit: "{token}",
  });
  const retryCeiling: Counter = meter.createCounter("mapping.detection.retry_ceiling.count", {
    description: "Stage calls that exhausted the corrective-retry ceiling",
  });
  const shortlistYield: Histogram = meter.createHistogram("mapping.detection.shortlist.yield", {
    description: "Shortlisted candidate resource pairs per spec pair",
  });

  function stageAttrs(metrics: LlmCallMetrics): Attributes {
    return metrics.variant === undefined
      ? { provider, stage: metrics.stage }
      : { provider, stage: metrics.stage, variant: metrics.variant };
  }

  return {
    onLlmCall(metrics: LlmCallMetrics): void {
      const base = stageAttrs(metrics);
      duration.record(metrics.durationMs, base);
      attempts.record(metrics.attempts, base);
      calls.add(1, { ...base, outcome: metrics.outcome });
      tokens.add(metrics.usage.promptEvalCount, { ...base, token_type: "prompt" });
      tokens.add(metrics.usage.evalCount, { ...base, token_type: "eval" });
      if (metrics.outcome === "failed") {
        // A call that hit the retry ceiling — the alert hook (observability.md
        // *Alerting*), labeled by stage so the shortlist case can be alerted more
        // urgently than the detail case.
        retryCeiling.add(1, base);
      }
    },

    onDetectionRun(result: DetectionRunResult): void {
      for (const yieldCount of shortlistYieldReadings(result)) {
        shortlistYield.record(yieldCount, { provider });
      }
    },
  };
}
