import { resolveResourceRef } from "./align.js";
import type { ScoringContext } from "./context.js";
import type { GtEndpoint } from "./ground-truth.js";
import { alignConsumerPair, alignPeerPair } from "./pair-align.js";
import {
  type AlignedResource,
  type NegativeResult,
  ratioMetric,
  type Stage1PairResult,
  type Stage1Report,
} from "./report.js";

/**
 * Stage-1 (shortlist) scoring — EH-2. Measures how well the recall-biased
 * shortlist recovers the genuine resource pairs and avoids **confidently**
 * proposing the ground-truth negatives, at the IR-group granularity the shortlist
 * actually operates on:
 *
 * - **recall** — resolved ground-truth pairs present in the produced
 *   `shortlistResult` candidate pairs; each miss is listed explicitly (the offline
 *   escape-hatch proxy, EH-2 crit 2).
 * - **precision** — candidate pairs corresponding to a genuine ground-truth pair.
 * - **shortlist yield** — candidate pairs per spec pair (EH-2 crit 5).
 * - **negatives-avoidance** — a `no-counterpart` / `incorrect-but-tempting`
 *   negative confidently proposed is a scored failure line; an `ambiguous` one is
 *   a failure only when confident, tolerated as a low-confidence shortlist entry
 *   (EH-2 crit 3/4). "Confident" is `confidenceScore ≥ config.confidenceThreshold`.
 *
 * The IR-group granularity has an honest consequence: because several ground-truth
 * resources collapse into one IR group (see `align.ts`), a negative whose endpoints
 * align to a group-pair that is ITSELF a genuine correspondence is not counted as a
 * proposal of the negative — the guard against faulting detection for the coarse
 * grouping rather than a real mistake.
 */

interface ResolvedEndpoint {
  readonly specId: string | undefined;
  readonly resourceRef: string | undefined;
}

/** Unordered key for a resource-group pair across two specs. */
function groupPairKey(specIdA: string, specIdB: string, refA: string, refB: string): string {
  const specs = [specIdA, specIdB].sort().join("~");
  const refs = [refA, refB].sort().join("~");
  return `${specs}|${refs}`;
}

function alignedResource(app: string, resource: string, ref: string | undefined): AlignedResource {
  return { app, resource, resourceRef: ref ?? null };
}

function describeEndpoint(endpoint: GtEndpoint): string {
  return endpoint.kind === "resource"
    ? `${endpoint.app}/${endpoint.resource}`
    : `${endpoint.app} ${endpoint.operation.method} ${endpoint.operation.path}`;
}

function resolveEndpoint(ctx: ScoringContext, endpoint: GtEndpoint): ResolvedEndpoint {
  const spec = ctx.specForApp(endpoint.app);
  if (spec === undefined) return { specId: undefined, resourceRef: undefined };
  const resourceRef =
    endpoint.kind === "resource"
      ? resolveResourceRef(spec, [], endpoint.resource)
      : resolveResourceRef(spec, [endpoint.operation], "");
  return { specId: spec.id, resourceRef };
}

/** A confident (≥ threshold), mapped proposal item linking two resource groups (either orientation). */
function hasConfidentItemBetween(
  ctx: ScoringContext,
  specIdA: string,
  specIdB: string,
  refA: string,
  refB: string,
  threshold: number,
): boolean {
  for (const [from, to] of [
    [specIdA, specIdB],
    [specIdB, specIdA],
  ] as const) {
    const proposal = ctx.proposalFor(from, to);
    if (proposal === undefined) continue;
    for (const item of proposal.items) {
      if (item.unmapped || item.confidenceScore < threshold) continue;
      const src = item.sourceRef.resourceRef;
      const tgt = item.targetRef?.resourceRef;
      if (tgt === undefined) continue;
      if ((src === refA && tgt === refB) || (src === refB && tgt === refA)) return true;
    }
  }
  return false;
}

// ── Pair scoring (recall + the aligned per-pair results) ─────────────────────

interface PairScoring {
  readonly results: Stage1PairResult[];
  readonly genuine: Set<string>;
}

function scorePairs(ctx: ScoringContext): PairScoring {
  const results: Stage1PairResult[] = [];
  const genuine = new Set<string>();

  for (const gt of ctx.input.groundTruth.pairs) {
    if (gt.kind === "peer-peer") {
      const a = alignPeerPair(ctx, gt);
      const entry =
        a.resolved && a.sourceSpec && a.targetSpec && a.sourceRef && a.targetRef
          ? ctx.isShortlisted(a.sourceSpec.id, a.targetSpec.id, a.sourceRef, a.targetRef)
          : undefined;
      results.push({
        kind: "peer-peer",
        source: alignedResource(gt.sourceApp, gt.sourceResource, a.sourceRef),
        target: alignedResource(gt.targetApp, gt.targetResource, a.targetRef),
        resolved: a.resolved,
        shortlisted: entry !== undefined,
        shortlistConfidence: entry?.confidence ?? null,
      });
      if (a.resolved && a.sourceSpec && a.targetSpec && a.sourceRef && a.targetRef) {
        genuine.add(groupPairKey(a.sourceSpec.id, a.targetSpec.id, a.sourceRef, a.targetRef));
      }
      continue;
    }

    const al = alignConsumerPair(ctx, gt);
    for (const target of al.targets) {
      const resolved = al.sourceRef !== undefined && target.resolved;
      const entry =
        resolved && al.sourceSpec && target.targetSpec && al.sourceRef && target.targetRef
          ? ctx.isShortlisted(
              al.sourceSpec.id,
              target.targetSpec.id,
              al.sourceRef,
              target.targetRef,
            )
          : undefined;
      results.push({
        kind: "consumer-provider",
        source: alignedResource(gt.sourceApp, gt.sourceResource, al.sourceRef),
        target: alignedResource(
          target.targetApp,
          target.targetRef ?? "(backend)",
          target.targetRef,
        ),
        resolved,
        shortlisted: entry !== undefined,
        shortlistConfidence: entry?.confidence ?? null,
      });
      if (resolved && al.sourceSpec && target.targetSpec && al.sourceRef && target.targetRef) {
        genuine.add(
          groupPairKey(al.sourceSpec.id, target.targetSpec.id, al.sourceRef, target.targetRef),
        );
      }
    }
  }

  return { results, genuine };
}

// ── Negatives-avoidance ──────────────────────────────────────────────────────

function assessNoCounterpart(
  ctx: ScoringContext,
  specId: string,
  ref: string,
  genuine: Set<string>,
  threshold: number,
): { confident: boolean; shortlistedLow: boolean; detail: string } {
  let shortlistedLow = false;
  for (const pair of ctx.unorderedSpecPairs()) {
    if (pair.specIdA !== specId && pair.specIdB !== specId) continue;
    for (const candidate of pair.candidatePairs) {
      if (candidate.sourceResource !== ref && candidate.targetResource !== ref) continue;
      const key = groupPairKey(
        pair.specIdA,
        pair.specIdB,
        candidate.sourceResource,
        candidate.targetResource,
      );
      if (genuine.has(key)) continue; // subsumed by a genuine correspondence — not a violation
      if (candidate.confidence >= threshold) {
        return {
          confident: true,
          shortlistedLow: false,
          detail: `confidently shortlisted (${candidate.confidence.toFixed(2)}) despite having no counterpart`,
        };
      }
      shortlistedLow = true;
    }
  }
  return {
    confident: false,
    shortlistedLow,
    detail: shortlistedLow
      ? "only a low-confidence shortlist entry — tolerated"
      : "no counterpart proposed",
  };
}

function scoreNegatives(ctx: ScoringContext, genuine: Set<string>): NegativeResult[] {
  const threshold = ctx.input.config.confidenceThreshold;
  return ctx.input.groundTruth.negatives.map((negative): NegativeResult => {
    const source = resolveEndpoint(ctx, negative.source);
    const base = {
      verdict: negative.verdict,
      source: describeEndpoint(negative.source),
      target: negative.target === null ? null : describeEndpoint(negative.target),
    };

    if (source.specId === undefined || source.resourceRef === undefined) {
      return {
        ...base,
        resolved: false,
        confidentlyProposed: false,
        lowConfidenceOnly: false,
        scoredFailure: false,
        detail: "source resource not present as a distinct group in the detection input",
      };
    }

    // Two-endpoint negative: a specific forbidden group-pair.
    if (negative.target !== null) {
      const target = resolveEndpoint(ctx, negative.target);
      if (target.specId === undefined || target.resourceRef === undefined) {
        return {
          ...base,
          resolved: false,
          confidentlyProposed: false,
          lowConfidenceOnly: false,
          scoredFailure: false,
          detail: "target resource not present as a distinct group in the detection input",
        };
      }
      const key = groupPairKey(
        source.specId,
        target.specId,
        source.resourceRef,
        target.resourceRef,
      );
      if (genuine.has(key)) {
        return {
          ...base,
          resolved: true,
          confidentlyProposed: false,
          lowConfidenceOnly: false,
          scoredFailure: false,
          detail:
            "aligns to a genuine correspondence at IR-group granularity — not a distinct proposal",
        };
      }
      const entry = ctx.isShortlisted(
        source.specId,
        target.specId,
        source.resourceRef,
        target.resourceRef,
      );
      const confident =
        (entry !== undefined && entry.confidence >= threshold) ||
        hasConfidentItemBetween(
          ctx,
          source.specId,
          target.specId,
          source.resourceRef,
          target.resourceRef,
          threshold,
        );
      const shortlisted = entry !== undefined;
      return {
        ...base,
        resolved: true,
        confidentlyProposed: confident,
        lowConfidenceOnly: shortlisted && !confident,
        scoredFailure: confident,
        detail: confident
          ? `confidently proposed (${entry?.confidence.toFixed(2) ?? "item"})`
          : shortlisted
            ? "only a low-confidence shortlist entry — tolerated"
            : "not proposed",
      };
    }

    // No-counterpart (target: null): the source resource should stay unpaired.
    const assessment = assessNoCounterpart(
      ctx,
      source.specId,
      source.resourceRef,
      genuine,
      threshold,
    );
    return {
      ...base,
      resolved: true,
      confidentlyProposed: assessment.confident,
      lowConfidenceOnly: assessment.shortlistedLow,
      scoredFailure: assessment.confident,
      detail: assessment.detail,
    };
  });
}

// ── Report assembly ──────────────────────────────────────────────────────────

export function scoreStage1(ctx: ScoringContext): Stage1Report {
  const { results, genuine } = scorePairs(ctx);

  const resolvedResults = results.filter((r) => r.resolved);
  const recallMatched = resolvedResults.filter((r) => r.shortlisted).length;
  const shortlistMisses = resolvedResults.filter((r) => !r.shortlisted);

  const specPairs = ctx.unorderedSpecPairs();
  const totalCandidatePairs = specPairs.reduce((sum, sp) => sum + sp.candidatePairs.length, 0);
  let genuineCandidates = 0;
  for (const sp of specPairs) {
    for (const candidate of sp.candidatePairs) {
      const key = groupPairKey(
        sp.specIdA,
        sp.specIdB,
        candidate.sourceResource,
        candidate.targetResource,
      );
      if (genuine.has(key)) genuineCandidates += 1;
    }
  }

  const negatives = scoreNegatives(ctx, genuine);

  return {
    shortlistYield: specPairs.length === 0 ? null : totalCandidatePairs / specPairs.length,
    specPairCount: specPairs.length,
    totalCandidatePairs,
    recall: ratioMetric(recallMatched, resolvedResults.length),
    precision: ratioMetric(genuineCandidates, totalCandidatePairs),
    unresolvedPairs: results.length - resolvedResults.length,
    pairs: results,
    shortlistMisses,
    negatives,
    negativeFailures: negatives.filter((n) => n.scoredFailure),
  };
}
