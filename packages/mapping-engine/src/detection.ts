import { randomUUID } from "node:crypto";

import type {
  ApiSpec,
  CandidatePair,
  IrResourceGroup,
  MappingProposal,
  MappingProposalItem,
  NoCounterpartResource,
  ResourceShortlist,
  ShortlistResult,
  ShortlistResultPair,
} from "@mediator/domain";
import {
  buildGeneratedBy,
  type LLMMappingProvider,
  type MappingPromptContext,
  type PriorMappingFeedback,
  type ShortlistPromptContext,
} from "@mediator/llm";

import type { CandidateSpecPair } from "./enumerate.js";
import { enumerateCandidatePairs } from "./enumerate.js";
import { buildItems, type ItemResourceRefs } from "./items.js";
import type { LlmCallMetrics } from "./metrics.js";
import { callWithRetry } from "./retry.js";
import { buildSpecSummaryIR, inScopeResources } from "./summaries.js";

/**
 * The two-stage detection core (TD-1..4, PP-1..3): stage-1 shortlist once per
 * unordered spec pair (shared by both directions of a peer pair), stage-2 detail
 * per shortlisted resource pair per direction, each with the corrective-retry
 * loop, the two failure blast radii, and mechanical `shortlistResult` enrichment.
 *
 * This module is **pure-ish**: it depends only on an injected `LLMMappingProvider`
 * and the two specs' IR; it neither reads a registry nor persists a proposal. The
 * persisting `runDetectionForSpec` wraps it (see `run.ts`); the eval harness uses
 * {@link analyzeCandidate} / {@link detectForSpec} on the **non-persisting** path.
 */

// ── Dependencies ─────────────────────────────────────────────────────────────

export interface DetectionDeps {
  /** The active provider; driven **sequentially** so its `lastUsage` seam is safe. */
  readonly provider: LLMMappingProvider;
  /** Corrective-retry cap (`config.mappingLlm.maxRetries`): attempts = 1 + maxRetries. */
  readonly maxRetries: number;
  /** Stamped into every proposal's `generatedBy.promptVersion` (LP-4). */
  readonly promptVersion: string;
  /** Id factory for proposal + item ids; defaults to `crypto.randomUUID`. */
  readonly newId?: () => string;
  /** Clock for `MappingProposal.createdAt`; defaults to `() => new Date()`. */
  readonly now?: () => Date;
  /** Monotonic clock for latency metrics; defaults to `Date.now`. */
  readonly monotonicNow?: () => number;
  /** Observability sink for each stage call's metrics record (OTel is the next slice). */
  readonly onMetrics?: (metrics: LlmCallMetrics) => void;
}

// ── Result shapes ────────────────────────────────────────────────────────────

/** One directional analysis: the proposal, its items, and the run's LLM metrics. */
export interface CandidateAnalysisResult {
  readonly proposal: MappingProposal;
  readonly items: MappingProposalItem[];
  readonly metrics: readonly LlmCallMetrics[];
}

/**
 * The stage-1 outcome for an unordered spec pair, computed **once** and shared by
 * both directional analyses. `ok` carries the validated, in-scope-filtered
 * candidate pairs in the pair's **canonical** orientation (specs ordered by id),
 * plus the mechanically computed no-counterpart set; `failed` carries nothing
 * reviewable (the shortlist-stage blast radius, TD-4).
 */
export type ShortlistOutcome =
  | {
      readonly status: "ok";
      readonly canonicalSourceId: string;
      readonly canonicalTargetId: string;
      readonly candidatePairs: readonly CandidatePair[];
      readonly noCounterpartResources: readonly NoCounterpartResource[];
      readonly metrics: LlmCallMetrics;
    }
  | { readonly status: "failed"; readonly metrics: LlmCallMetrics };

// ── Default-dep resolution ───────────────────────────────────────────────────

function newIdOf(deps: DetectionDeps): () => string {
  return deps.newId ?? randomUUID;
}
function nowOf(deps: DetectionDeps): () => Date {
  return deps.now ?? ((): Date => new Date());
}
function emitMetrics(deps: DetectionDeps, metrics: LlmCallMetrics): LlmCallMetrics {
  deps.onMetrics?.(metrics);
  return metrics;
}

// ── Stage 1: shortlist (once per unordered pair) ─────────────────────────────

/** Order the two specs by id into a stable, direction-agnostic canonical orientation. */
function canonicalOrder(specA: ApiSpec, specB: ApiSpec): { source: ApiSpec; target: ApiSpec } {
  return specA.id <= specB.id ? { source: specA, target: specB } : { source: specB, target: specA };
}

function shortlistContext(
  sourceSummary: ShortlistPromptContext["sourceSpecSummaryIR"],
  targetSummary: ShortlistPromptContext["targetSpecSummaryIR"],
  promptVersion: string,
  correctiveFeedback: string | undefined,
): ShortlistPromptContext {
  return correctiveFeedback === undefined
    ? { sourceSpecSummaryIR: sourceSummary, targetSpecSummaryIR: targetSummary, promptVersion }
    : {
        sourceSpecSummaryIR: sourceSummary,
        targetSpecSummaryIR: targetSummary,
        promptVersion,
        correctiveFeedback,
      };
}

/** One stage-1 shortlist call's validated result + its emitted per-call metrics. */
export interface ShortlistCallResult {
  readonly outcome: "success" | "failed";
  /** The validated `ResourceShortlist`, present only on `outcome === "success"`. */
  readonly value: ResourceShortlist | undefined;
  readonly metrics: LlmCallMetrics;
}

/**
 * The raw stage-1 call with corrective retries + metrics emission (TD-1/TD-3),
 * factored so **both** the full `resolveShortlist` (in-scope summaries of the whole
 * pair) and the SL-3 scoped shortlist (the new spec restricted to its new groups vs.
 * a counterpart) share the exact same call/retry/metrics wiring — the filtering and
 * no-counterpart enrichment that differ between the two live in their callers.
 */
export async function shortlistCall(
  sourceSummary: ShortlistPromptContext["sourceSpecSummaryIR"],
  targetSummary: ShortlistPromptContext["targetSpecSummaryIR"],
  deps: DetectionDeps,
): Promise<ShortlistCallResult> {
  const result = await callWithRetry(
    (correctiveFeedback) =>
      deps.provider.shortlistResourcePairs(
        shortlistContext(sourceSummary, targetSummary, deps.promptVersion, correctiveFeedback),
      ),
    () => deps.provider.lastUsage,
    deps.maxRetries,
    deps.monotonicNow,
  );
  const metrics = emitMetrics(deps, {
    stage: "shortlist",
    outcome: result.outcome,
    attempts: result.attempts,
    durationMs: result.durationMs,
    usage: result.usage,
  });
  return { outcome: result.outcome, value: result.value, metrics };
}

/**
 * Run stage 1 for an unordered spec pair (TD-1) and mechanically enrich its result
 * (PP-3). Exactly **one** `shortlistResourcePairs` call is made per pair (plus any
 * corrective retries), over the two specs' **in-scope** resource summaries. The
 * returned candidate pairs are filtered to those that resolve to real in-scope
 * resources on both sides, and the no-counterpart set is computed by **set
 * difference** — the engine's own computation, never trusted from the LLM.
 */
export async function resolveShortlist(
  specA: ApiSpec,
  specB: ApiSpec,
  deps: DetectionDeps,
): Promise<ShortlistOutcome> {
  const { source, target } = canonicalOrder(specA, specB);
  const sourceGroups = inScopeResources(source);
  const targetGroups = inScopeResources(target);
  const sourceSummary = buildSpecSummaryIR(sourceGroups);
  const targetSummary = buildSpecSummaryIR(targetGroups);

  const result = await shortlistCall(sourceSummary, targetSummary, deps);
  const { metrics } = result;

  if (result.outcome === "failed" || result.value === undefined) {
    return { status: "failed", metrics };
  }

  const sourceRefs = new Set(sourceGroups.map((group) => group.resourceRef));
  const targetRefs = new Set(targetGroups.map((group) => group.resourceRef));
  // Keep only pairs that resolve to real in-scope resources on both sides — a
  // hallucinated ref is dropped rather than turned into a broken detail lookup.
  const candidatePairs = result.value.candidatePairs.filter(
    (pair) => sourceRefs.has(pair.sourceResource) && targetRefs.has(pair.targetResource),
  );

  const pairedSources = new Set(candidatePairs.map((pair) => pair.sourceResource));
  const pairedTargets = new Set(candidatePairs.map((pair) => pair.targetResource));
  const noCounterpartResources: NoCounterpartResource[] = [];
  for (const group of sourceGroups) {
    if (!pairedSources.has(group.resourceRef)) {
      noCounterpartResources.push({ specId: source.id, resourceRef: group.resourceRef });
    }
  }
  for (const group of targetGroups) {
    if (!pairedTargets.has(group.resourceRef)) {
      noCounterpartResources.push({ specId: target.id, resourceRef: group.resourceRef });
    }
  }

  return {
    status: "ok",
    canonicalSourceId: source.id,
    canonicalTargetId: target.id,
    candidatePairs,
    noCounterpartResources,
    metrics,
  };
}

// ── Stage 2: detail per shortlisted pair, per direction ──────────────────────

function findGroup(spec: ApiSpec, resourceRef: string): IrResourceGroup | undefined {
  return spec.parsedIR.find((group) => group.resourceRef === resourceRef);
}

/**
 * A per-resource-pair lookup of the `priorFeedback` a scoped **re-review** analysis
 * (SL-6) threads into the detail call: the stale mapping's approved correspondences
 * for that resource pair, so the model reproduces the unaffected ones intact and
 * review concentrates on the break (SL-6.2). Absent for a first-time / additive
 * analysis, which passes no prior feedback.
 */
export type PriorFeedbackLookup = (
  sourceResourceRef: string,
  targetResourceRef: string,
) => readonly PriorMappingFeedback[] | undefined;

function detailContext(
  sourceResourceIR: IrResourceGroup,
  targetResourceIR: IrResourceGroup,
  variant: CandidateSpecPair["variant"],
  promptVersion: string,
  correctiveFeedback: string | undefined,
  priorFeedback: readonly PriorMappingFeedback[] | undefined,
): MappingPromptContext {
  // Build with exactOptionalPropertyTypes-safe conditional spreads: an optional key
  // is present only when it carries a value (never a present `undefined`).
  return {
    sourceResourceIR,
    targetResourceIR,
    variant,
    promptVersion,
    ...(correctiveFeedback !== undefined ? { correctiveFeedback } : {}),
    ...(priorFeedback !== undefined && priorFeedback.length > 0 ? { priorFeedback } : {}),
  };
}

/**
 * Analyze one **directional** candidate given the shared stage-1 outcome (TD-2,
 * TD-4, PP-1..3) and return its proposal + items **without persisting**.
 *
 * - A **failed** shortlist → a `failed` proposal with `shortlistResult = null` and
 *   no items (shortlist blast radius). Passing the *same* failed outcome to both
 *   directions of a peer pair is what fails both (TD-4 crit 4).
 * - Otherwise a `pending` proposal: one stage-2 detail call per shortlisted pair
 *   in this direction, each with corrective retries; a pair whose detail call
 *   exhausts the cap is marked `analysisFailed` in *this* proposal's
 *   `shortlistResult` while every other pair is still analyzed (detail blast
 *   radius). The candidate pairs + no-counterpart set are stored in the shared
 *   canonical orientation, identical across both directions (PP-3 crit 5).
 *
 * `priorFeedbackFor` (optional) supplies the SL-6 re-review `priorFeedback` per
 * resource pair — the stale mapping's approved content for that pair — threaded into
 * the detail call so unaffected correspondences come back intact. First-time /
 * additive analyses omit it (no prior feedback).
 */
export async function analyzeCandidate(
  candidate: CandidateSpecPair,
  specs: { readonly source: ApiSpec; readonly target: ApiSpec },
  shortlist: ShortlistOutcome,
  deps: DetectionDeps,
  priorFeedbackFor?: PriorFeedbackLookup,
): Promise<CandidateAnalysisResult> {
  if (specs.source.id !== candidate.sourceSpecId || specs.target.id !== candidate.targetSpecId) {
    throw new Error("analyzeCandidate: specs do not match the candidate's source/target");
  }

  const newId = newIdOf(deps);
  const now = nowOf(deps);
  const proposalId = newId();
  const generatedBy = buildGeneratedBy(deps.provider, deps.promptVersion);

  if (shortlist.status === "failed") {
    const proposal: MappingProposal = {
      id: proposalId,
      sourceSpecId: candidate.sourceSpecId,
      targetSpecId: candidate.targetSpecId,
      generatedBy,
      shortlistResult: null,
      status: "failed",
      createdAt: now(),
    };
    return { proposal, items: [], metrics: [shortlist.metrics] };
  }

  const directionIsCanonical = candidate.sourceSpecId === shortlist.canonicalSourceId;
  const items: MappingProposalItem[] = [];
  const shortlistPairs: ShortlistResultPair[] = [];
  const metrics: LlmCallMetrics[] = [shortlist.metrics];

  for (const pair of shortlist.candidatePairs) {
    // Map the canonical-orientation pair onto this direction's source/target refs.
    const sourceResourceRef = directionIsCanonical ? pair.sourceResource : pair.targetResource;
    const targetResourceRef = directionIsCanonical ? pair.targetResource : pair.sourceResource;
    const sourceGroup = findGroup(specs.source, sourceResourceRef);
    const targetGroup = findGroup(specs.target, targetResourceRef);
    if (sourceGroup === undefined || targetGroup === undefined) {
      // Defensive: a filtered shortlist pair always resolves. If it somehow does
      // not, treat it as a failed pair rather than crashing the whole proposal.
      shortlistPairs.push({ ...pair, analysisFailed: true });
      continue;
    }

    const priorFeedback = priorFeedbackFor?.(sourceResourceRef, targetResourceRef);
    const result = await callWithRetry(
      (correctiveFeedback) =>
        deps.provider.generateMappingProposal(
          detailContext(
            sourceGroup,
            targetGroup,
            candidate.variant,
            deps.promptVersion,
            correctiveFeedback,
            priorFeedback,
          ),
        ),
      () => deps.provider.lastUsage,
      deps.maxRetries,
      deps.monotonicNow,
    );

    metrics.push(
      emitMetrics(deps, {
        stage: "detail",
        variant: candidate.variant,
        outcome: result.outcome,
        attempts: result.attempts,
        durationMs: result.durationMs,
        usage: result.usage,
      }),
    );

    if (result.outcome === "failed" || result.value === undefined) {
      // Detail blast radius: this one pair failed; the rest of the proposal proceeds.
      shortlistPairs.push({ ...pair, analysisFailed: true });
      continue;
    }

    const refs: ItemResourceRefs = { sourceResourceRef, targetResourceRef };
    items.push(...buildItems(result.value, refs, { proposalId, newId }));
    shortlistPairs.push({ ...pair, analysisFailed: false });
  }

  const shortlistResult: ShortlistResult = {
    candidatePairs: shortlistPairs,
    noCounterpartResources: [...shortlist.noCounterpartResources],
  };
  const proposal: MappingProposal = {
    id: proposalId,
    sourceSpecId: candidate.sourceSpecId,
    targetSpecId: candidate.targetSpecId,
    generatedBy,
    shortlistResult,
    status: "pending",
    createdAt: now(),
  };
  return { proposal, items, metrics };
}

// ── Whole-spec detection (non-persisting) ────────────────────────────────────

/**
 * Enumerate + analyze every candidate for a newly ingested spec **without
 * persisting** — the eval harness's entry point. Stage 1 is computed **once per
 * unordered pair** (memoized by `unorderedKey`) and reused by both directions, so
 * `shortlistResourcePairs` is called exactly once per pair. Everything runs
 * sequentially, keeping the provider's `lastUsage` seam well-defined.
 */
export async function detectForSpec(
  newSpec: ApiSpec,
  otherActiveSpecs: readonly ApiSpec[],
  deps: DetectionDeps,
): Promise<CandidateAnalysisResult[]> {
  const candidates = enumerateCandidatePairs(newSpec, otherActiveSpecs);
  const specsById = new Map<string, ApiSpec>();
  specsById.set(newSpec.id, newSpec);
  for (const spec of otherActiveSpecs) {
    specsById.set(spec.id, spec);
  }

  const shortlistCache = new Map<string, ShortlistOutcome>();
  const results: CandidateAnalysisResult[] = [];

  for (const candidate of candidates) {
    const source = specsById.get(candidate.sourceSpecId);
    const target = specsById.get(candidate.targetSpecId);
    if (source === undefined || target === undefined) {
      throw new Error("detectForSpec: a candidate references a spec not in the input set");
    }

    let shortlist = shortlistCache.get(candidate.unorderedKey);
    if (shortlist === undefined) {
      shortlist = await resolveShortlist(source, target, deps);
      shortlistCache.set(candidate.unorderedKey, shortlist);
    }

    results.push(await analyzeCandidate(candidate, { source, target }, shortlist, deps));
  }

  return results;
}
