/**
 * `@mediator/mapping-engine` — the two-stage detection core of the Mapping Engine
 * (the "core bet"). Over an injected `LLMMappingProvider` (from `@mediator/llm`)
 * and the specs' IR, it:
 *
 * 1. **enumerates** the candidate spec pairs a newly ingested spec introduces
 *    (`enumerateCandidatePairs`, CE-1..4) — deterministic, no LLM;
 * 2. runs **stage 1** (shortlist) once per unordered spec pair, shared by both
 *    directions (`resolveShortlist`, TD-1), and mechanically enriches it with the
 *    set-difference no-counterpart resources (PP-3);
 * 3. runs **stage 2** (detail) per shortlisted resource pair per direction with a
 *    capped **corrective-retry** loop (TD-3), turning each `MappingSuggestionSet`
 *    into `MappingProposalItem`s (`analyzeCandidate` + item construction, TD-2/PP-2);
 * 4. applies the two **blast radii** — a detail failure marks one pair
 *    `analysisFailed`, a shortlist failure fails the whole proposal (TD-4).
 *
 * Two entry points: `runDetectionForSpec` (persisting, `SpecIngested`-triggered)
 * and the non-persisting `detectForSpec` / `analyzeCandidate` (the eval-harness
 * path). Every stage call surfaces a per-call {@link LlmCallMetrics} record
 * (attempts, latency, token usage) for the next slice's OTel emission.
 *
 * `pnpm verify` exercises this entirely against the deterministic `FakeProvider`;
 * the Postgres-backed persistence path has its own excluded integration test.
 */

export { type CandidateSpecPair, enumerateCandidatePairs, unorderedPairKey } from "./enumerate.js";

export { buildSpecSummaryIR, inScopeResources, toResourceSummary } from "./summaries.js";

export { buildItems, type ItemBuildDeps, type ItemResourceRefs } from "./items.js";

export { type LlmCallMetrics, type LlmCallStage } from "./metrics.js";

export {
  callWithRetry,
  maxAttempts,
  type Attempt,
  type ReadUsage,
  type RetryResult,
} from "./retry.js";

export {
  analyzeCandidate,
  type CandidateAnalysisResult,
  type DetectionDeps,
  detectForSpec,
  resolveShortlist,
  shortlistCall,
  type ShortlistCallResult,
  type ShortlistOutcome,
} from "./detection.js";

export {
  type AdditiveAnalysisScope,
  analyzeAdditiveDelta,
  type EstablishedResourcePair,
} from "./scoped.js";

export {
  createDbPriorProposalSource,
  createDbProposalStore,
  createDbSpecSource,
  deriveEstablishedPairs,
  type DetectionRunResult,
  type PersistableProposal,
  type PriorProposalSource,
  type ProposalStore,
  runDetectionForSpec,
  type RunDetectionDeps,
  runScopedAdditiveAnalysis,
  type RunScopedDeps,
  type ScopedAnalysisJob,
  type SpecSource,
} from "./run.js";
