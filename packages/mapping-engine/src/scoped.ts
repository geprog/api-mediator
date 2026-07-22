import type { ApiSpec, CandidatePair, NoCounterpartResource } from "@mediator/domain";

import {
  analyzeCandidate,
  shortlistCall,
  type CandidateAnalysisResult,
  type DetectionDeps,
  type ShortlistOutcome,
} from "./detection.js";
import type { CandidateSpecPair } from "./enumerate.js";
import type { LlmCallMetrics } from "./metrics.js";
import { buildSpecSummaryIR, inScopeResources } from "./summaries.js";

/**
 * **SL-3 — the scoped additive-delta analysis, reusing the Phase-2 two-stage runner
 * *scoped* rather than standing up a second pipeline.** Given a newly-ingested
 * additive spec version, a counterpart spec, and the structural scope the diff
 * produced, it drives exactly the reused stage-1 (`shortlistCall`) and stage-2
 * (`analyzeCandidate`) machinery over just the genuinely-new in-scope elements — so
 * the output is an ordinary `CandidateAnalysisResult` (a `MappingProposal` + its
 * `MappingProposalItem`s) that goes through the ordinary Phase-3 review (SL-3.3).
 *
 * Pure over its injected `DetectionDeps` (provider + retry cap + prompt version): it
 * neither reads a registry nor persists a proposal — the worker-side
 * `runScopedAdditiveAnalysis` (see `run.ts`) supplies the specs, the established
 * pairs, and persistence.
 */

/**
 * The two staging buckets of an additive delta, mirroring the mapping engine's
 * *Re-mapping on spec change* granularity:
 *
 * - `newResourceGroups` — genuinely-new **in-scope** resource groups (SL-3.1): one
 *   scoped stage-1 shortlist against the counterpart, then a detail call per
 *   shortlisted pair.
 * - `changedResources` — existing in-scope resources that gained a new field/operation
 *   (SL-3.2): stage 1 is skipped, a detail call runs for the already-shortlisted pair.
 */
export interface AdditiveAnalysisScope {
  readonly newResourceGroups: readonly string[];
  readonly changedResources: readonly string[];
}

/**
 * An already-shortlisted counterpart resource for a changed resource (SL-3.2),
 * discovered from a prior proposal's `shortlistResult`. `newResourceRef` is the
 * changed resource on the new spec; `counterpartResourceRef` is the resource it was
 * previously shortlisted against on the counterpart — the pair a scoped detail call
 * (no new shortlist) re-analyzes.
 */
export interface EstablishedResourcePair {
  readonly newResourceRef: string;
  readonly counterpartResourceRef: string;
}

/** The rationale stamped on an SL-3.2 forced detail pair (stage 1 was skipped). */
const CHANGED_RESOURCE_RATIONALE =
  "Additive change inside an already-shortlisted resource — scoped detail re-analysis (stage 1 skipped).";

/**
 * A synthetic, zero-cost shortlist metric for a delta that made **no** stage-1 call
 * (a changed-resources-only delta): `analyzeCandidate` always folds the shortlist
 * metric into its result, and this records "no stage-1 call happened" honestly
 * (`attempts: 0`) without ever being emitted as a real LLM call.
 */
function syntheticShortlistMetric(): LlmCallMetrics {
  return {
    stage: "shortlist",
    outcome: "success",
    attempts: 0,
    durationMs: 0,
    usage: { promptEvalCount: 0, evalCount: 0 },
  };
}

/** A collision-free dedup key for a candidate pair (visible JSON, never a NUL byte). */
function pairKey(pair: CandidatePair): string {
  return JSON.stringify([pair.sourceResource, pair.targetResource]);
}

/**
 * Map each enumerated directional candidate of the pair onto `newSpec`/`counterpart`
 * and run `analyzeCandidate` with the shared scoped shortlist outcome — reusing the
 * detail stage, its per-pair `analysisFailed` blast radius, and item construction
 * unchanged (peer-peer runs both directions; consumer-provider the one direction).
 */
async function runDirections(
  candidates: readonly CandidateSpecPair[],
  newSpec: ApiSpec,
  counterpart: ApiSpec,
  outcome: ShortlistOutcome,
  deps: DetectionDeps,
): Promise<CandidateAnalysisResult[]> {
  const byId = new Map<string, ApiSpec>([
    [newSpec.id, newSpec],
    [counterpart.id, counterpart],
  ]);
  const results: CandidateAnalysisResult[] = [];
  for (const candidate of candidates) {
    const source = byId.get(candidate.sourceSpecId);
    const target = byId.get(candidate.targetSpecId);
    if (source === undefined || target === undefined) {
      throw new Error("analyzeAdditiveDelta: a candidate references a spec outside the pair");
    }
    results.push(await analyzeCandidate(candidate, { source, target }, outcome, deps));
  }
  return results;
}

/**
 * Analyze the scoped additive delta for ONE unordered spec pair {newSpec, counterpart}
 * and return its directional proposal(s) + items.
 *
 * - **new groups (SL-3.1):** one scoped `shortlistCall` for the new groups' summaries
 *   vs. the counterpart's in-scope summaries, then a detail call per shortlisted pair;
 * - **changed resources (SL-3.2):** each established resource pair is injected straight
 *   into the shortlist outcome, so `analyzeCandidate` runs only its detail call — stage
 *   1 skipped;
 * - **exclusions (SL-3.4):** both sides come from `inScopeResources`, so an excluded
 *   resource is never summarized, shortlisted, or detailed.
 *
 * The candidate pairs are expressed newSpec-as-canonical-source, so `analyzeCandidate`
 * maps them onto each direction unchanged. A scoped stage-1 failure fails the pair — the
 * TD-4 shortlist blast radius — exactly as full detection does. When there is nothing
 * new to review against this counterpart, no proposal is produced (no review noise).
 */
export async function analyzeAdditiveDelta(args: {
  readonly newSpec: ApiSpec;
  readonly counterpart: ApiSpec;
  readonly candidates: readonly CandidateSpecPair[];
  readonly scope: AdditiveAnalysisScope;
  readonly establishedPairs: readonly EstablishedResourcePair[];
  readonly deps: DetectionDeps;
}): Promise<CandidateAnalysisResult[]> {
  const { newSpec, counterpart, candidates, scope, establishedPairs, deps } = args;

  const newInScope = inScopeResources(newSpec);
  const newInScopeRefs = new Set(newInScope.map((group) => group.resourceRef));
  const counterpartInScope = inScopeResources(counterpart);
  const counterpartRefs = new Set(counterpartInScope.map((group) => group.resourceRef));

  // SL-3.4 — restrict the new groups to those still in scope (drops excluded/absent refs).
  const newGroupSet = new Set(scope.newResourceGroups);
  const newGroups = newInScope.filter((group) => newGroupSet.has(group.resourceRef));

  // ── SL-3.1: one scoped stage-1 shortlist for the new groups against the counterpart ──
  let shortlistFailed = false;
  let shortlistMetric: LlmCallMetrics | undefined;
  const newGroupPairs: CandidatePair[] = [];
  const newGroupNoCounterpart: NoCounterpartResource[] = [];
  if (newGroups.length > 0) {
    const call = await shortlistCall(
      buildSpecSummaryIR(newGroups),
      buildSpecSummaryIR(counterpartInScope),
      deps,
    );
    shortlistMetric = call.metrics;
    if (call.outcome === "failed" || call.value === undefined) {
      shortlistFailed = true;
    } else {
      const newGroupRefs = new Set(newGroups.map((group) => group.resourceRef));
      for (const pair of call.value.candidatePairs) {
        // Keep only pairs that resolve to a real new group / in-scope counterpart.
        if (newGroupRefs.has(pair.sourceResource) && counterpartRefs.has(pair.targetResource)) {
          newGroupPairs.push(pair);
        }
      }
      const paired = new Set(newGroupPairs.map((pair) => pair.sourceResource));
      for (const group of newGroups) {
        if (!paired.has(group.resourceRef)) {
          newGroupNoCounterpart.push({ specId: newSpec.id, resourceRef: group.resourceRef });
        }
      }
    }
  }

  // Shortlist blast radius (TD-4): a scoped stage-1 failure fails this spec pair.
  if (shortlistFailed) {
    const failed: ShortlistOutcome = {
      status: "failed",
      metrics: shortlistMetric ?? syntheticShortlistMetric(),
    };
    return runDirections(candidates, newSpec, counterpart, failed, deps);
  }

  // ── SL-3.2: inject the changed resources' established pairs (no stage-1 call) ──
  const changedResourceSet = new Set(scope.changedResources);
  const seen = new Set(newGroupPairs.map(pairKey));
  const forcedPairs: CandidatePair[] = [];
  for (const established of establishedPairs) {
    if (!changedResourceSet.has(established.newResourceRef)) continue;
    if (!newInScopeRefs.has(established.newResourceRef)) continue; // SL-3.4 (new side in scope)
    if (!counterpartRefs.has(established.counterpartResourceRef)) continue; // SL-3.4 (counterpart)
    const pair: CandidatePair = {
      sourceResource: established.newResourceRef,
      targetResource: established.counterpartResourceRef,
      confidence: 1,
      rationale: CHANGED_RESOURCE_RATIONALE,
    };
    const key = pairKey(pair);
    if (seen.has(key)) continue;
    seen.add(key);
    forcedPairs.push(pair);
  }

  const candidatePairs = [...newGroupPairs, ...forcedPairs];
  if (candidatePairs.length === 0 && newGroupNoCounterpart.length === 0) {
    // Nothing genuinely-new to review against this counterpart — produce no proposal.
    return [];
  }

  const outcome: ShortlistOutcome = {
    status: "ok",
    canonicalSourceId: newSpec.id,
    canonicalTargetId: counterpart.id,
    candidatePairs,
    noCounterpartResources: newGroupNoCounterpart,
    metrics: shortlistMetric ?? syntheticShortlistMetric(),
  };
  return runDirections(candidates, newSpec, counterpart, outcome, deps);
}
