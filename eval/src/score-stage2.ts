import type { MappingProposalItem } from "@mediator/domain";

import { fieldRoot, operationRefKey, parameterName } from "./align.js";
import {
  itemSourceField,
  itemSourceOperationId,
  itemSourceParameter,
  itemTargetField,
  itemTargetOperationId,
  itemTargetParameter,
  mappedItemsForPair,
  type ProposalWithItems,
  type ScoringContext,
} from "./context.js";
import type { GtConsumerProviderPair, GtPeerPair } from "./ground-truth.js";
import { alignConsumerPair, alignPeerPair } from "./pair-align.js";
import {
  type ConsumerOpResult,
  type CrudResult,
  type FieldFinding,
  type IdentityResult,
  ratioMetric,
  type RatioMetric,
  type Stage2ConsumerPairResult,
  type Stage2PairResult,
  type Stage2PeerPairResult,
  type Stage2Report,
  type TransformResult,
} from "./report.js";

/**
 * Stage-2 (detail) scoring — EH-3. Over the shortlisted resource pairs' produced
 * `MappingProposalItem`s it measures, per ground-truth pair:
 *
 * - **operation CRUD classification** — does a detected `operationMapping` pair the
 *   right target op for each CRUD action, by `METHOD /path` identity (so Vikunja's
 *   `PUT` = create / `POST` = update inversion is scored by semantics, not verb).
 * - **field precision / recall** — genuine field pairs found vs. spurious, with the
 *   ground-truth `unmapped` sources and `plausible` false-positives (e.g. scenario-1
 *   `number` ↔ `index`) counted as things detection must NOT confidently map.
 * - **identity-candidate hit rate** — did detection flag the ground-truth identity
 *   pairing with `identityCandidate`, and correctly leave it unset on a keyless pair.
 * - **transform-kind agreement** — the detected `transform` vs. the expected kind,
 *   with the ground-truth `direct` (same-name value-preserving) scored against the
 *   concept's value-preserving `rename` (the concept's enum has no `direct` member;
 *   this modeling mapping is reported, see {@link TRANSFORM_MODELING_NOTE}).
 * - **consumer-provider** — request/response `phase` correctness, `parameterMappings`
 *   presence, and the request-phase constant-synthesis case (scenario-3 `done=true`).
 */

export const TRANSFORM_MODELING_NOTE =
  "Transform agreement scores the ground-truth `direct` (same-name value-preserving) " +
  "against the concept's value-preserving `rename` bucket — the `MappingSuggestionSet." +
  "transform` enum (rename|coerce|aggregate|expression) has no `direct` member (adopted decision).";

// ── Transform modeling: direct → rename ──────────────────────────────────────

function canonicalTransform(kind: string): string {
  return kind === "direct" ? "rename" : kind;
}

/** Whether a detected transform agrees with the expected kind, mapping `direct` onto `rename`. */
export function transformAgrees(expected: string, detected: string): boolean {
  return canonicalTransform(expected) === canonicalTransform(detected);
}

// ── Produced-item projections ────────────────────────────────────────────────

interface ProducedField {
  readonly sourceRoot: string;
  readonly targetRoot: string;
  readonly transform: string;
  readonly confidence: number;
  readonly identityCandidate: boolean;
  readonly phase: MappingProposalItem["phase"];
}

function producedFields(
  items: readonly MappingProposalItem[],
  sourceRef: string,
  targetRef: string,
): ProducedField[] {
  return mappedItemsForPair(items, sourceRef, targetRef, "field").flatMap((item) => {
    const source = itemSourceField(item);
    const target = itemTargetField(item);
    if (source === undefined || target === undefined) return [];
    const transform =
      item.transformSuggestion !== undefined && item.transformSuggestion !== null
        ? item.transformSuggestion.transform
        : "rename";
    return [
      {
        sourceRoot: fieldRoot(source),
        targetRoot: fieldRoot(target),
        transform,
        confidence: item.confidenceScore,
        identityCandidate: item.identityCandidate === true,
        phase: item.phase,
      },
    ];
  });
}

function fieldKey(source: string, target: string): string {
  return `${source}~${target}`;
}

// ── Peer-peer scoring ────────────────────────────────────────────────────────

function scoreCrud(
  ctx: ScoringContext,
  gt: GtPeerPair,
  sourceSpecId: string,
  targetSpecId: string,
  sourceRef: string,
  targetRef: string,
  items: readonly MappingProposalItem[],
): CrudResult[] {
  const produced = mappedItemsForPair(items, sourceRef, targetRef, "operation").map((item) => {
    const sourceId = itemSourceOperationId(item);
    const targetId = itemTargetOperationId(item);
    const sourceOp =
      sourceId === undefined ? undefined : ctx.operationRefOf(sourceSpecId, sourceRef, sourceId);
    const targetOp =
      targetId === undefined ? undefined : ctx.operationRefOf(targetSpecId, targetRef, targetId);
    return {
      sourceKey: sourceOp === undefined ? undefined : operationRefKey(sourceOp),
      targetKey: targetOp === undefined ? undefined : operationRefKey(targetOp),
    };
  });

  const results: CrudResult[] = [];
  for (const [action, op] of gt.operations) {
    if (op.source === null || op.target === null) continue;
    const expectedSource = operationRefKey(op.source);
    const expectedTarget = operationRefKey(op.target);
    const hit = produced.some(
      (p) => p.sourceKey === expectedSource && p.targetKey === expectedTarget,
    );
    results.push({
      action,
      hit,
      detail: hit
        ? `${expectedSource} → ${expectedTarget}`
        : `expected ${expectedSource} → ${expectedTarget}, not paired`,
    });
  }
  return results;
}

function scoreIdentity(gt: GtPeerPair, fields: readonly ProducedField[]): IdentityResult {
  const { source, target } = gt.identityKey;
  const detectedAny = fields.some((f) => f.identityCandidate);
  if (source === null || target === null) {
    // Keyless pair (e.g. comments): detection should leave `identityCandidate` unset.
    return {
      expectedSource: source,
      expectedTarget: target,
      hit: false,
      correctlyAbsent: !detectedAny,
      detail: detectedAny
        ? "keyless pair, but detection flagged an identity candidate"
        : "keyless pair, no identity candidate flagged (correct)",
    };
  }
  const expectedSource = fieldRoot(source);
  const expectedTarget = fieldRoot(target);
  const hit = fields.some(
    (f) =>
      f.identityCandidate && f.sourceRoot === expectedSource && f.targetRoot === expectedTarget,
  );
  return {
    expectedSource: source,
    expectedTarget: target,
    hit,
    correctlyAbsent: false,
    detail: hit
      ? `identityCandidate on ${source} ↔ ${target}`
      : `expected identityCandidate on ${source} ↔ ${target}, not flagged`,
  };
}

function scorePeerPair(ctx: ScoringContext, gt: GtPeerPair): Stage2PeerPairResult {
  const a = alignPeerPair(ctx, gt);
  const emptyResult: Stage2PeerPairResult = {
    kind: "peer-peer",
    source: { app: gt.sourceApp, resource: gt.sourceResource, resourceRef: a.sourceRef ?? null },
    target: { app: gt.targetApp, resource: gt.targetResource, resourceRef: a.targetRef ?? null },
    analyzed: false,
    crud: [],
    fieldPrecision: ratioMetric(0, 0),
    fieldRecall: ratioMetric(0, 0),
    identity: scoreIdentity(gt, []),
    transforms: [],
    falsePositiveFields: [],
  };

  if (!a.resolved || !a.sourceSpec || !a.targetSpec || !a.sourceRef || !a.targetRef) {
    return emptyResult;
  }
  const proposal = ctx.proposalFor(a.sourceSpec.id, a.targetSpec.id);
  if (proposal === undefined || proposal.proposal.status === "failed") return emptyResult;

  const items = proposal.items;
  const fields = producedFields(items, a.sourceRef, a.targetRef);
  const threshold = ctx.input.config.confidenceThreshold;

  // Field precision / recall (by root-name identity).
  const gtGenuine = gt.fields.filter((f) => f.source !== null && f.target !== null);
  const gtKeys = new Set(
    gtGenuine.map((f) => fieldKey(fieldRoot(f.source ?? ""), fieldRoot(f.target ?? ""))),
  );
  const producedKeys = fields.map((f) => fieldKey(f.sourceRoot, f.targetRoot));
  const recallMatched = [...gtKeys].filter((k) => producedKeys.includes(k)).length;
  const precisionMatched = producedKeys.filter((k) => gtKeys.has(k)).length;

  // Transform-kind agreement over produced genuine field pairs (direct → rename).
  const transforms: TransformResult[] = [];
  for (const field of gtGenuine) {
    const sourceRoot = fieldRoot(field.source ?? "");
    const targetRoot = fieldRoot(field.target ?? "");
    const match = fields.find((f) => f.sourceRoot === sourceRoot && f.targetRoot === targetRoot);
    if (match === undefined || field.transform === null) continue;
    transforms.push({
      source: sourceRoot,
      target: targetRoot,
      expected: field.transform,
      detected: match.transform,
      agrees: transformAgrees(field.transform, match.transform),
    });
  }

  // False positives: confidently-mapped `plausible` pairs and `unmapped` sources.
  const plausibleKeys = new Set(
    gt.plausibleFields
      .filter((f) => f.source !== null && f.target !== null)
      .map((f) => fieldKey(fieldRoot(f.source ?? ""), fieldRoot(f.target ?? ""))),
  );
  const unmappedRoots = new Set(gt.unmappedSources.map(fieldRoot));
  const falsePositiveFields: FieldFinding[] = [];
  for (const f of fields) {
    if (f.confidence < threshold) continue;
    const key = fieldKey(f.sourceRoot, f.targetRoot);
    if (plausibleKeys.has(key)) {
      falsePositiveFields.push({
        source: f.sourceRoot,
        target: f.targetRoot,
        detail: `confidently mapped a "plausible" false-positive (${f.confidence.toFixed(2)})`,
      });
    } else if (unmappedRoots.has(f.sourceRoot)) {
      falsePositiveFields.push({
        source: f.sourceRoot,
        target: f.targetRoot,
        detail: `confidently mapped a source the ground truth marks unmapped (${f.confidence.toFixed(2)})`,
      });
    }
  }

  return {
    kind: "peer-peer",
    source: { app: gt.sourceApp, resource: gt.sourceResource, resourceRef: a.sourceRef },
    target: { app: gt.targetApp, resource: gt.targetResource, resourceRef: a.targetRef },
    analyzed: true,
    crud: scoreCrud(ctx, gt, a.sourceSpec.id, a.targetSpec.id, a.sourceRef, a.targetRef, items),
    fieldPrecision: ratioMetric(precisionMatched, fields.length),
    fieldRecall: ratioMetric(recallMatched, gtKeys.size),
    identity: scoreIdentity(gt, fields),
    transforms,
    falsePositiveFields,
  };
}

// ── Consumer-provider scoring ────────────────────────────────────────────────

interface ConsumerExpectations {
  readonly request: Set<string>;
  readonly response: Set<string>;
  readonly parameters: Set<string>;
  readonly constantTarget: string | null;
}

function consumerExpectations(gt: GtConsumerProviderPair): ConsumerExpectations {
  const request = new Set<string>();
  const response = new Set<string>();
  const parameters = new Set<string>();
  let constantTarget: string | null = null;
  for (const op of gt.operations) {
    for (const f of op.requestFields) {
      if (f.target === null) continue;
      if (f.source === null) {
        constantTarget = fieldRoot(f.target);
        continue;
      }
      request.add(fieldKey(fieldRoot(f.source), fieldRoot(f.target)));
    }
    for (const f of op.responseFields) {
      if (f.source === null || f.target === null) continue;
      response.add(fieldKey(fieldRoot(f.source), fieldRoot(f.target)));
    }
    for (const p of op.parameters) {
      if (p.target === null) continue;
      parameters.add(fieldKey(parameterName(p.source), parameterName(p.target)));
    }
  }
  return { request, response, parameters, constantTarget };
}

function scoreConsumerTarget(
  ctx: ScoringContext,
  gt: GtConsumerProviderPair,
  sourceRef: string | undefined,
  target: { targetApp: string; targetRef: string | undefined },
  proposal: ProposalWithItems | undefined,
): Stage2ConsumerPairResult {
  const operations: ConsumerOpResult[] = gt.operations.map((op) => ({
    consumer: `${op.consumer.method} ${op.consumer.path}`,
    backends: op.backends
      .filter((b) => b.app === target.targetApp || b.app === null)
      .map((b) => `${b.operation.method} ${b.operation.path}`),
    detail: op.aggregation === null ? "" : `aggregation: ${op.aggregation}`,
  }));

  const base = {
    kind: "consumer-provider" as const,
    source: { app: gt.sourceApp, resource: gt.sourceResource, resourceRef: sourceRef ?? null },
    targetApp: target.targetApp,
    targetResourceRef: target.targetRef ?? null,
    operations,
  };

  const expectations = consumerExpectations(gt);
  const constantSynthesis =
    expectations.constantTarget === null ? null : { expected: true, detected: false };

  if (
    sourceRef === undefined ||
    target.targetRef === undefined ||
    proposal === undefined ||
    proposal.proposal.status === "failed"
  ) {
    return {
      ...base,
      analyzed: false,
      requestPhase: ratioMetric(0, expectations.request.size),
      responsePhase: ratioMetric(0, expectations.response.size),
      phaseCorrectness: ratioMetric(0, 0),
      parameterCoverage: ratioMetric(0, expectations.parameters.size),
      constantSynthesis,
    };
  }

  const fields = producedFields(proposal.items, sourceRef, target.targetRef);
  const requestFields = fields.filter((f) => f.phase === "request");
  const responseFields = fields.filter((f) => f.phase === "response");
  const requestKeys = new Set(requestFields.map((f) => fieldKey(f.sourceRoot, f.targetRoot)));
  const responseKeys = new Set(responseFields.map((f) => fieldKey(f.sourceRoot, f.targetRoot)));

  const requestRecall = [...expectations.request].filter((k) => requestKeys.has(k)).length;
  const responseRecall = [...expectations.response].filter((k) => responseKeys.has(k)).length;

  // Phase correctness: produced phased items whose phase matches the ground-truth phase.
  let phaseMatched = 0;
  let phaseTotal = 0;
  for (const f of fields) {
    if (f.phase === undefined) continue;
    const key = fieldKey(f.sourceRoot, f.targetRoot);
    const expectedPhase = expectations.response.has(key)
      ? "response"
      : expectations.request.has(key)
        ? "request"
        : undefined;
    if (expectedPhase === undefined) continue;
    phaseTotal += 1;
    if (f.phase === expectedPhase) phaseMatched += 1;
  }

  // Parameter coverage.
  const producedParams = mappedItemsForPair(
    proposal.items,
    sourceRef,
    target.targetRef,
    "parameter",
  ).flatMap((item) => {
    const source = itemSourceParameter(item);
    const targetParam = itemTargetParameter(item);
    return source === undefined || targetParam === undefined
      ? []
      : [fieldKey(fieldRoot(source), fieldRoot(targetParam))];
  });
  const paramMatched = [...expectations.parameters].filter((k) =>
    producedParams.includes(k),
  ).length;

  const constantDetected =
    expectations.constantTarget !== null &&
    requestFields.some((f) => f.targetRoot === expectations.constantTarget);

  return {
    ...base,
    analyzed: true,
    requestPhase: ratioMetric(requestRecall, expectations.request.size),
    responsePhase: ratioMetric(responseRecall, expectations.response.size),
    phaseCorrectness: ratioMetric(phaseMatched, phaseTotal),
    parameterCoverage: ratioMetric(paramMatched, expectations.parameters.size),
    constantSynthesis:
      expectations.constantTarget === null ? null : { expected: true, detected: constantDetected },
  };
}

function scoreConsumerPair(
  ctx: ScoringContext,
  gt: GtConsumerProviderPair,
): Stage2ConsumerPairResult[] {
  const al = alignConsumerPair(ctx, gt);
  return al.targets.map((target) => {
    const proposal =
      al.sourceSpec && target.targetSpec
        ? ctx.proposalFor(al.sourceSpec.id, target.targetSpec.id)
        : undefined;
    return scoreConsumerTarget(
      ctx,
      gt,
      al.sourceRef,
      { targetApp: target.targetApp, targetRef: target.targetRef },
      proposal,
    );
  });
}

// ── Aggregation ──────────────────────────────────────────────────────────────

function sumRatios(metrics: readonly RatioMetric[]): RatioMetric {
  let matched = 0;
  let total = 0;
  for (const m of metrics) {
    matched += m.matched;
    total += m.total;
  }
  return ratioMetric(matched, total);
}

export function scoreStage2(ctx: ScoringContext): Stage2Report {
  const pairs: Stage2PairResult[] = [];
  for (const gt of ctx.input.groundTruth.pairs) {
    if (gt.kind === "peer-peer") pairs.push(scorePeerPair(ctx, gt));
    else pairs.push(...scoreConsumerPair(ctx, gt));
  }

  const peerPairs = pairs.filter((p): p is Stage2PeerPairResult => p.kind === "peer-peer");
  const consumerPairs = pairs.filter(
    (p): p is Stage2ConsumerPairResult => p.kind === "consumer-provider",
  );

  const crud = sumRatios(
    peerPairs.flatMap((p) => p.crud).map((c) => ratioMetric(c.hit ? 1 : 0, 1)),
  );
  const fieldPrecision = sumRatios(peerPairs.map((p) => p.fieldPrecision));
  const fieldRecall = sumRatios(peerPairs.map((p) => p.fieldRecall));
  const identityKeyed = peerPairs.filter((p) => p.identity.expectedSource !== null);
  const identityHitRate = ratioMetric(
    identityKeyed.filter((p) => p.identity.hit).length,
    identityKeyed.length,
  );
  const transformAgreement = sumRatios(
    peerPairs.flatMap((p) => p.transforms).map((t) => ratioMetric(t.agrees ? 1 : 0, 1)),
  );

  return {
    crud,
    fieldPrecision,
    fieldRecall,
    identityHitRate,
    transformAgreement,
    phaseCorrectness: sumRatios(consumerPairs.map((p) => p.phaseCorrectness)),
    parameterCoverage: sumRatios(consumerPairs.map((p) => p.parameterCoverage)),
    falsePositiveFields: peerPairs.flatMap((p) => p.falsePositiveFields),
    pairs,
  };
}
