import type {
  ApiSpec,
  GeneratedBy,
  MappingProposal,
  MappingProposalItem,
  ShortlistResultPair,
} from "@mediator/domain";

import { buildOperationRefLookup, KEY_SEP } from "./align.js";
import type { HarnessConfig } from "./config.js";
import type { GroundTruth, GtOperationRef } from "./ground-truth.js";
import type { LoadedSpec } from "./scenario-loader.js";

/** One directional proposal plus its items — the unit the scoring reads. */
export interface ProposalWithItems {
  readonly proposal: MappingProposal;
  readonly items: readonly MappingProposalItem[];
}

/** An unordered spec pair and its shared, direction-agnostic shortlist. */
export interface UnorderedSpecPair {
  readonly specIdA: string;
  readonly specIdB: string;
  readonly candidatePairs: readonly ShortlistResultPair[];
  /** True when the pair's stage-1 shortlist failed (no reviewable candidate pairs). */
  readonly shortlistFailed: boolean;
}

export interface ScoringInput {
  readonly scenario: string;
  readonly groundTruth: GroundTruth;
  readonly specs: readonly LoadedSpec[];
  readonly proposals: readonly ProposalWithItems[];
  readonly generatedBy: GeneratedBy;
  readonly config: HarnessConfig;
}

/**
 * The shared, memoized read-model over one scenario's ground truth + specs +
 * produced proposals that both stage scorers project from. It owns proposal /
 * shortlist lookup and IR-backed operation resolution so the stage scorers stay
 * focused on the metric each computes.
 */
export class ScoringContext {
  private readonly specByApp = new Map<string, ApiSpec>();
  private readonly proposalByDirection = new Map<string, ProposalWithItems>();
  private readonly opLookups = new Map<
    string,
    (resourceRef: string, operationId: string) => GtOperationRef | undefined
  >();

  public constructor(public readonly input: ScoringInput) {
    for (const loaded of input.specs) this.specByApp.set(loaded.app, loaded.spec);
    for (const withItems of input.proposals) {
      const { sourceSpecId, targetSpecId } = withItems.proposal;
      this.proposalByDirection.set(directionKey(sourceSpecId, targetSpecId), withItems);
    }
  }

  public specForApp(app: string): ApiSpec | undefined {
    return this.specByApp.get(app);
  }

  public proposalFor(sourceSpecId: string, targetSpecId: string): ProposalWithItems | undefined {
    return this.proposalByDirection.get(directionKey(sourceSpecId, targetSpecId));
  }

  /**
   * The shared candidate pairs of the unordered spec pair — taken from whichever
   * directional proposal carries a (non-null) `shortlistResult`; both directions
   * of a peer pair carry identical candidate pairs (PP-3). Empty when the shortlist
   * failed or neither direction exists.
   */
  public candidatePairsFor(specIdA: string, specIdB: string): readonly ShortlistResultPair[] {
    const forward = this.proposalFor(specIdA, specIdB);
    const backward = this.proposalFor(specIdB, specIdA);
    for (const candidate of [forward, backward]) {
      const shortlist = candidate?.proposal.shortlistResult;
      if (shortlist !== undefined && shortlist !== null) return shortlist.candidatePairs;
    }
    return [];
  }

  /** Whether a candidate pair (in any orientation) links the two resource refs. */
  public isShortlisted(
    specIdA: string,
    specIdB: string,
    refA: string,
    refB: string,
  ): ShortlistResultPair | undefined {
    return this.candidatePairsFor(specIdA, specIdB).find(
      (pair) =>
        (pair.sourceResource === refA && pair.targetResource === refB) ||
        (pair.sourceResource === refB && pair.targetResource === refA),
    );
  }

  /** Every distinct unordered spec pair that produced a proposal, with its shared shortlist. */
  public unorderedSpecPairs(): UnorderedSpecPair[] {
    const seen = new Set<string>();
    const result: UnorderedSpecPair[] = [];
    for (const { proposal } of this.input.proposals) {
      const [a, b] = [proposal.sourceSpecId, proposal.targetSpecId].sort();
      if (a === undefined || b === undefined) continue;
      const key = `${a}${KEY_SEP}${b}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const forward = this.proposalFor(a, b);
      const backward = this.proposalFor(b, a);
      const failed =
        (forward?.proposal.shortlistResult ?? null) === null &&
        (backward?.proposal.shortlistResult ?? null) === null;
      result.push({
        specIdA: a,
        specIdB: b,
        candidatePairs: this.candidatePairsFor(a, b),
        shortlistFailed: failed,
      });
    }
    return result;
  }

  /** Resolve a produced operation/parameter item's `operationId` back to its `METHOD /path`. */
  public operationRefOf(
    specId: string,
    resourceRef: string,
    operationId: string,
  ): GtOperationRef | undefined {
    let lookup = this.opLookups.get(specId);
    if (lookup === undefined) {
      const spec = [...this.specByApp.values()].find((s) => s.id === specId);
      if (spec === undefined) return undefined;
      lookup = buildOperationRefLookup(spec);
      this.opLookups.set(specId, lookup);
    }
    return lookup(resourceRef, operationId);
  }
}

function directionKey(sourceSpecId: string, targetSpecId: string): string {
  return `${sourceSpecId}${KEY_SEP}${targetSpecId}`;
}

// ── Item accessors (over the discriminated ref target) ───────────────────────

/** The mapped items of a directional proposal for one source→target resource pair and kind. */
export function mappedItemsForPair(
  items: readonly MappingProposalItem[],
  sourceRef: string,
  targetRef: string,
  kind: MappingProposalItem["kind"],
): MappingProposalItem[] {
  return items.filter(
    (item) =>
      item.kind === kind &&
      !item.unmapped &&
      item.sourceRef.resourceRef === sourceRef &&
      item.targetRef?.resourceRef === targetRef,
  );
}

export function itemSourceOperationId(item: MappingProposalItem): string | undefined {
  return item.sourceRef.target.kind === "operation" ? item.sourceRef.target.operationId : undefined;
}

export function itemTargetOperationId(item: MappingProposalItem): string | undefined {
  const target = item.targetRef?.target;
  return target?.kind === "operation" ? target.operationId : undefined;
}

export function itemSourceField(item: MappingProposalItem): string | undefined {
  return item.sourceRef.target.kind === "field" ? item.sourceRef.target.path : undefined;
}

export function itemTargetField(item: MappingProposalItem): string | undefined {
  const target = item.targetRef?.target;
  return target?.kind === "field" ? target.path : undefined;
}

export function itemSourceParameter(item: MappingProposalItem): string | undefined {
  return item.sourceRef.target.kind === "parameter" ? item.sourceRef.target.parameter : undefined;
}

export function itemTargetParameter(item: MappingProposalItem): string | undefined {
  const target = item.targetRef?.target;
  return target?.kind === "parameter" ? target.parameter : undefined;
}
