import type {
  ApiSpec,
  CandidatePair,
  FieldMapping,
  MappingVariant,
  NoCounterpartResource,
  OperationMapping,
} from "@mediator/domain";
import type { PriorMappingFeedback } from "@mediator/llm";

import {
  analyzeCandidate,
  shortlistCall,
  type CandidateAnalysisResult,
  type DetectionDeps,
  type PriorFeedbackLookup,
  type ShortlistOutcome,
} from "./detection.js";
import { unorderedPairKey, type CandidateSpecPair } from "./enumerate.js";
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

// ── SL-6 — the scoped breaking re-review analysis (detail-only, priorFeedback) ──

/**
 * One affected resource pair of a stale mapping, in the mapping's `source → target`
 * orientation — the SL-6.1 unit of re-analysis (one detail call, no shortlist).
 */
export interface ReReviewResourcePair {
  readonly sourceResource: string;
  readonly targetResource: string;
}

/** The stale mapping's approved content, fed back as `priorFeedback` (SL-6.2). */
export interface PriorMappingContent {
  readonly fields: readonly FieldMapping[];
  readonly operations: readonly OperationMapping[];
}

/** The rationale stamped on an SL-6 forced re-review pair (stage 1 skipped — correspondence already established). */
const RE_REVIEW_PAIR_RATIONALE =
  "Breaking change touched this established resource pair — scoped detail re-review (stage 1 skipped).";

/**
 * The resource-group portion of a serialized IR path/operation ref (`issues/title`,
 * `issues/updateIssue`): a `resourceRef` never contains a `/`, so the resource is
 * everything before the **first** `/` (mirrors the approval serializer / SL-4's
 * `resourceOfRef`). A whole-resource ref (no `/`) is its own resource.
 */
function resourceOf(ref: string): string {
  const slash = ref.indexOf("/");
  return slash === -1 ? ref : ref.slice(0, slash);
}

/**
 * The **proposal-oriented** `{ sourceRef, targetRef }` of a `FieldMapping`: which
 * path references the source spec vs. the target spec. A consumer-provider
 * **response**-phase field inverts the convention (`sourcePath` is the backend /
 * target-spec field and `targetPath` the consumer / source-spec field), exactly as
 * SL-4's `mappingChangedSideRefs` reads it; a peer-peer / request-phase field is
 * `sourcePath → source`, `targetPath → target`.
 */
function orientedFieldRefs(field: FieldMapping): { sourceRef: string; targetRef: string } {
  const inverted = field.phase === "response";
  return {
    sourceRef: inverted ? field.targetPath : field.sourcePath,
    targetRef: inverted ? field.sourcePath : field.targetPath,
  };
}

/** A collision-free `{ sourceResource, targetResource }` key (visible JSON, never a NUL byte). */
function reReviewPairKey(sourceResource: string, targetResource: string): string {
  return JSON.stringify([sourceResource, targetResource]);
}

/** A short, metadata-only note describing an approved field correspondence (transform kind / phase / identity). */
function fieldFeedbackNote(field: FieldMapping): string {
  const parts = [`transform=${field.transform}`];
  if (field.phase !== undefined) parts.push(`phase=${field.phase}`);
  if (field.isIdentityKey === true) parts.push("identity-key");
  return `prior approved field mapping (${parts.join(", ")})`;
}

/**
 * **SL-6.2 — group the stale mapping's approved content into per-resource-pair
 * `priorFeedback`.** Each `FieldMapping`/`OperationMapping` becomes one
 * {@link PriorMappingFeedback} (its source/target refs + a metadata-only note),
 * bucketed under the proposal-oriented resource pair it belongs to, so the detail
 * call for a given pair is fed exactly that pair's prior correspondences. Pure and
 * **metadata-only** — resource-qualified IR refs + transform kinds, never a value or
 * a secret.
 */
export function buildReReviewPriorFeedback(
  content: PriorMappingContent,
): Map<string, PriorMappingFeedback[]> {
  const byPair = new Map<string, PriorMappingFeedback[]>();
  const push = (sourceRef: string, targetRef: string, note: string): void => {
    const key = reReviewPairKey(resourceOf(sourceRef), resourceOf(targetRef));
    const bucket = byPair.get(key);
    const entry: PriorMappingFeedback = { sourceRef, targetRef, note };
    if (bucket === undefined) {
      byPair.set(key, [entry]);
    } else {
      bucket.push(entry);
    }
  };
  for (const field of content.fields) {
    const { sourceRef, targetRef } = orientedFieldRefs(field);
    push(sourceRef, targetRef, fieldFeedbackNote(field));
  }
  for (const operation of content.operations) {
    push(
      operation.sourceOperationRef,
      operation.targetOperationRef,
      `prior approved operation mapping (action=${operation.action})`,
    );
  }
  return byPair;
}

/**
 * **SL-6 — the scoped breaking re-review analysis for ONE stale mapping, reusing the
 * Phase-2 detail runner *scoped* rather than a second pipeline.** Given the successor's
 * `source`/`target` specs (the stale mapping's spec pair with the changed side advanced
 * to the new version), the affected resource pairs the breaking change touched, and the
 * stale mapping's approved content, it:
 *
 * - injects the affected pairs straight into an `ok` {@link ShortlistOutcome} (a
 *   synthetic, zero-cost shortlist metric — **no** stage-1 call, since the correspondence
 *   is already established — SL-6.1), so `analyzeCandidate` runs only its detail calls;
 * - threads the stale mapping's approved content as **`priorFeedback`** per resource pair
 *   (SL-6.2), so unaffected correspondences come back intact;
 * - stamps the resulting ordinary `MappingProposal` with `reReviewOf = staleMappingId`
 *   (SL-6.3/6.4), the link approval turns into the successor's `predecessorMappingId`.
 *
 * The result is an **ordinary** `CandidateAnalysisResult` (a `pending`/`failed`
 * `MappingProposal` + its items) reviewed through the ordinary Phase-3 flow — nothing is
 * auto-approved (SL-6.3). A detail call for a resource whose group was removed resolves to
 * no IR group and is marked `analysisFailed` on the pair (SL-6.5 — surfaced, never silently
 * lost), exactly as a first-time detail failure. Pure over its injected `DetectionDeps`;
 * the persisting {@link runScopedReReviewAnalysis} (see `run.ts`) supplies the specs,
 * the stale content, and persistence.
 */
export async function analyzeReReview(args: {
  readonly staleMappingId: string;
  readonly source: ApiSpec;
  readonly target: ApiSpec;
  readonly variant: MappingVariant;
  readonly affectedPairs: readonly ReReviewResourcePair[];
  readonly priorContent: PriorMappingContent;
  readonly deps: DetectionDeps;
}): Promise<CandidateAnalysisResult> {
  const { staleMappingId, source, target, variant, affectedPairs, priorContent, deps } = args;

  // Dedupe the affected pairs (a breaking change may touch a resource pair through
  // several fields/operations); forge each into a forced detail pair.
  const seen = new Set<string>();
  const forcedPairs: CandidatePair[] = [];
  for (const pair of affectedPairs) {
    const key = reReviewPairKey(pair.sourceResource, pair.targetResource);
    if (seen.has(key)) continue;
    seen.add(key);
    forcedPairs.push({
      sourceResource: pair.sourceResource,
      targetResource: pair.targetResource,
      confidence: 1,
      rationale: RE_REVIEW_PAIR_RATIONALE,
    });
  }

  const priorFeedbackByPair = buildReReviewPriorFeedback(priorContent);
  const priorFeedbackFor: PriorFeedbackLookup = (sourceResourceRef, targetResourceRef) =>
    priorFeedbackByPair.get(reReviewPairKey(sourceResourceRef, targetResourceRef));

  // No stage-1 call: the affected pairs ARE the shortlist (canonical = the successor's
  // own source → target orientation, so `analyzeCandidate` maps them through unchanged).
  const outcome: ShortlistOutcome = {
    status: "ok",
    canonicalSourceId: source.id,
    canonicalTargetId: target.id,
    candidatePairs: forcedPairs,
    noCounterpartResources: [],
    metrics: syntheticShortlistMetric(),
  };
  const candidate: CandidateSpecPair = {
    sourceSpecId: source.id,
    targetSpecId: target.id,
    variant,
    unorderedKey: unorderedPairKey(source.id, target.id),
  };

  const result = await analyzeCandidate(
    candidate,
    { source, target },
    outcome,
    deps,
    priorFeedbackFor,
  );
  // SL-6.3/6.4 — tag the ordinary proposal as this stale mapping's re-review, the link
  // approval turns into the successor's `predecessorMappingId` (the SL-7 adoption seam).
  return { ...result, proposal: { ...result.proposal, reReviewOf: staleMappingId } };
}
