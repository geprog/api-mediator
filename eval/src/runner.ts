import type { ApiSpec } from "@mediator/domain";
import { buildGeneratedBy, type LLMMappingProvider } from "@mediator/llm";
import { type DetectionDeps, detectForSpec, type LlmCallMetrics } from "@mediator/mapping-engine";

import type { HarnessConfig } from "./config.js";
import type { ProposalWithItems } from "./context.js";
import type { ScenarioReport } from "./report.js";
import type { LoadedScenario } from "./scenario-loader.js";
import { scoreScenario } from "./scoring.js";

/**
 * The end-to-end run (EH-1): drive the **detection engine directly** over a loaded
 * scenario's specs with the configured provider, then score the produced proposals
 * against the ground truth. No Event Bus, no `SpecIngested`, no DB — scoring is a
 * function of inputs + provider only (the adopted direct-invocation decision).
 *
 * Detection is run by simulating incremental registration: spec `i` is analyzed
 * against specs `0..i-1` via the non-persisting `detectForSpec`. Because the loader
 * orders providers before consumers, this forms every peer pair before a consumer
 * joins, and stage-1 shortlist runs exactly once per unordered spec pair (within
 * each `detectForSpec` call), covering every pair across the scenario exactly once.
 */

export interface RunScenarioDeps {
  readonly provider: LLMMappingProvider;
  /** Corrective-retry cap threaded into `DetectionDeps` (config.mappingLlm.maxRetries). */
  readonly maxRetries: number;
  /** Stamped into every proposal's `generatedBy.promptVersion` (LP-4). */
  readonly promptVersion: string;
  readonly config: HarnessConfig;
  /** Optional per-LLM-call metrics sink (the CLI uses it to print call counts/latency). */
  readonly onMetrics?: (metrics: LlmCallMetrics) => void;
}

export async function runScenario(
  scenario: LoadedScenario,
  deps: RunScenarioDeps,
): Promise<ScenarioReport> {
  const detectionDeps: DetectionDeps = deps.onMetrics
    ? {
        provider: deps.provider,
        maxRetries: deps.maxRetries,
        promptVersion: deps.promptVersion,
        onMetrics: deps.onMetrics,
      }
    : {
        provider: deps.provider,
        maxRetries: deps.maxRetries,
        promptVersion: deps.promptVersion,
      };

  const specs: ApiSpec[] = scenario.specs.map((loaded) => loaded.spec);
  const proposals: ProposalWithItems[] = [];
  for (let i = 0; i < specs.length; i += 1) {
    const newSpec = specs[i];
    if (newSpec === undefined) continue;
    const results = await detectForSpec(newSpec, specs.slice(0, i), detectionDeps);
    for (const result of results) {
      proposals.push({ proposal: result.proposal, items: result.items });
    }
  }

  return scoreScenario({
    scenario: scenario.scenario,
    groundTruth: scenario.groundTruth,
    specs: scenario.specs,
    proposals,
    generatedBy: buildGeneratedBy(deps.provider, deps.promptVersion),
    config: deps.config,
  });
}
