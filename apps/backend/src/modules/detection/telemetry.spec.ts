import type { ApiSpec, IrResourceGroup, MappingProposal } from "@mediator/domain";
import { FakeProvider } from "@mediator/llm";
import {
  detectForSpec,
  type CandidateAnalysisResult,
  type DetectionRunResult,
  type LlmCallMetrics,
} from "@mediator/mapping-engine";
import { describe, expect, it } from "vitest";

import {
  createDetectionMetricsSink,
  shortlistYieldReadings,
  type DetectionMetricsSink,
} from "./telemetry.js";

// ── shortlistYieldReadings: per-unordered-pair dedup ─────────────────────────

function proposalWith(
  sourceSpecId: string,
  targetSpecId: string,
  candidatePairCount: number | null,
): MappingProposal {
  const base = {
    id: `${sourceSpecId}->${targetSpecId}`,
    sourceSpecId,
    targetSpecId,
    generatedBy: { providerId: "fake", model: "fake-model", promptVersion: "v1" },
    status: "pending" as const,
    createdAt: new Date("2026-07-11T00:00:00.000Z"),
  };
  if (candidatePairCount === null) {
    return { ...base, status: "failed", shortlistResult: null };
  }
  return {
    ...base,
    shortlistResult: {
      candidatePairs: Array.from({ length: candidatePairCount }, (_unused, index) => ({
        sourceResource: `s${String(index)}`,
        targetResource: `t${String(index)}`,
        confidence: 0.5,
        rationale: "x",
        analysisFailed: false,
      })),
      noCounterpartResources: [],
    },
  };
}

function runResult(proposals: readonly MappingProposal[]): DetectionRunResult {
  const analyses: CandidateAnalysisResult[] = proposals.map((proposal) => ({
    proposal,
    items: [],
    metrics: [],
  }));
  return { newSpecId: "spec-a", analyses };
}

describe("shortlistYieldReadings", () => {
  it("reports one yield per unordered spec pair, deduping peer directions and skipping failed", () => {
    const readings = shortlistYieldReadings(
      runResult([
        proposalWith("spec-a", "spec-b", 2), // {a,b} forward
        proposalWith("spec-b", "spec-a", 2), // {a,b} reverse — deduped
        proposalWith("spec-a", "spec-c", null), // failed shortlist — skipped
        proposalWith("spec-a", "spec-d", 1), // {a,d}
      ]),
    );

    expect(readings).toStrictEqual([2, 1]);
  });

  it("returns nothing for a run with only failed proposals", () => {
    expect(
      shortlistYieldReadings(runResult([proposalWith("spec-a", "spec-b", null)])),
    ).toStrictEqual([]);
  });
});

// ── createDetectionMetricsSink: no-op clean when telemetry is disabled ────────

describe("createDetectionMetricsSink (telemetry disabled → no-op meter)", () => {
  it("emits every signal without throwing", () => {
    const sink = createDetectionMetricsSink("ollama");
    const shortlist: LlmCallMetrics = {
      stage: "shortlist",
      outcome: "success",
      attempts: 1,
      durationMs: 12,
      usage: { promptEvalCount: 5, evalCount: 7 },
    };
    const detailFailed: LlmCallMetrics = {
      stage: "detail",
      variant: "peer-peer",
      outcome: "failed", // exercises the retry-ceiling counter branch
      attempts: 3,
      durationMs: 40,
      usage: { promptEvalCount: 3, evalCount: 0 },
    };

    expect(() => {
      sink.onLlmCall(shortlist);
      sink.onLlmCall(detailFailed);
      sink.onDetectionRun(runResult([proposalWith("spec-a", "spec-b", 2)]));
    }).not.toThrow();
  });
});

// ── Wiring: per-stage metrics reach a sink wired to the engine's onMetrics ────

const resourceA: IrResourceGroup = {
  resourceRef: "issues",
  name: "Issues",
  operations: [
    { operationId: "listA", method: "get", path: "/a", summary: "List A", parameters: [] },
  ],
  schemas: [{ name: "Issue", fields: [{ name: "title", type: "string", required: true }] }],
  crossResourceRefs: [],
};
const resourceB: IrResourceGroup = {
  resourceRef: "tasks",
  name: "Tasks",
  operations: [
    { operationId: "listB", method: "get", path: "/b", summary: "List B", parameters: [] },
  ],
  schemas: [{ name: "Task", fields: [{ name: "title", type: "string", required: true }] }],
  crossResourceRefs: [],
};

function specOf(id: string, group: IrResourceGroup): ApiSpec {
  return {
    id,
    appId: `app-${id}`,
    role: "PROVIDER",
    rawDocument: { openapi: "3.1.0" },
    parsedIR: [group],
    analysisExclusions: [],
    version: 1,
    contentHash: `sha256:${id}`,
    status: "active",
    createdAt: new Date("2026-07-11T00:00:00.000Z"),
  };
}

function peerDetail(sourceOp: string, targetOp: string): unknown {
  return {
    variant: "peer-peer",
    operationMappings: [
      {
        sourceOperationId: sourceOp,
        targetOperationId: targetOp,
        confidence: 0.9,
        rationale: "list ↔ list",
        ambiguousAlternatives: [],
        unmapped: false,
      },
    ],
    fieldMappings: [
      {
        sourceField: "title",
        targetField: "title",
        transform: "rename",
        transformDetail: "",
        confidence: 0.9,
        rationale: "same title",
        ambiguousAlternatives: [],
        unmapped: false,
      },
    ],
  };
}

/** A DetectionMetricsSink that records every call for assertions. */
function recordingSink(): {
  readonly sink: DetectionMetricsSink;
  readonly llmCalls: LlmCallMetrics[];
  readonly runs: DetectionRunResult[];
} {
  const llmCalls: LlmCallMetrics[] = [];
  const runs: DetectionRunResult[] = [];
  return {
    llmCalls,
    runs,
    sink: {
      onLlmCall: (metrics) => {
        llmCalls.push(metrics);
      },
      onDetectionRun: (result) => {
        runs.push(result);
      },
    },
  };
}

describe("engine → metrics-sink wiring", () => {
  it("delivers per-stage LlmCallMetrics to a sink wired to onMetrics", async () => {
    const recorder = recordingSink();
    // spec-a < spec-b → canonical shortlist orientation is issues → tasks.
    const specA = specOf("spec-a", resourceA);
    const specB = specOf("spec-b", resourceB);
    const provider = new FakeProvider({
      shortlist: {
        "issues=>tasks": [
          {
            candidatePairs: [
              {
                sourceResource: "issues",
                targetResource: "tasks",
                confidence: 0.8,
                rationale: "x",
              },
            ],
          },
        ],
      },
      detail: {
        "issues=>tasks@peer-peer": [peerDetail("listA", "listB")],
        "tasks=>issues@peer-peer": [peerDetail("listB", "listA")],
      },
    });

    const analyses = await detectForSpec(specA, [specB], {
      provider,
      maxRetries: 3,
      promptVersion: "test",
      onMetrics: (metrics) => {
        recorder.sink.onLlmCall(metrics);
      },
    });
    recorder.sink.onDetectionRun({ newSpecId: specA.id, analyses });

    // One shared shortlist call + two directional detail calls reached the sink.
    const stages = recorder.llmCalls.map((call) => call.stage);
    expect(stages.filter((stage) => stage === "shortlist")).toHaveLength(1);
    expect(stages.filter((stage) => stage === "detail")).toHaveLength(2);
    expect(recorder.llmCalls.every((call) => call.outcome === "success")).toBe(true);
    // The detail calls are labeled with the peer-peer variant; the shortlist is not.
    const detail = recorder.llmCalls.filter((call) => call.stage === "detail");
    expect(detail.every((call) => call.variant === "peer-peer")).toBe(true);
    const shortlist = recorder.llmCalls.find((call) => call.stage === "shortlist");
    expect(shortlist?.variant).toBeUndefined();

    expect(recorder.runs).toHaveLength(1);
    expect(shortlistYieldReadings(recorder.runs[0] ?? runResult([]))).toStrictEqual([1]);
  });
});
