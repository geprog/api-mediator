import type { ApiSpec } from "@mediator/domain";

import { resolveResourceRef } from "./align.js";
import type { ScoringContext } from "./context.js";
import type { GtConsumerProviderPair, GtOperationRef, GtPeerPair } from "./ground-truth.js";

/**
 * Pair alignment — resolve a ground-truth pair's endpoints to the produced specs
 * and IR `resourceRef`s both stage scorers key off (see `align.ts` for the
 * identity rules). Kept separate from the low-level identity helpers because it
 * threads the {@link ScoringContext}'s spec lookup and is shared by stage 1 + 2.
 */

export interface AlignedPeerPair {
  readonly sourceSpec: ApiSpec | undefined;
  readonly targetSpec: ApiSpec | undefined;
  readonly sourceRef: string | undefined;
  readonly targetRef: string | undefined;
  /** Both specs found AND both resources aligned to an IR group in the detection input. */
  readonly resolved: boolean;
}

/** Collect the non-null source/target operation refs of a peer pair's CRUD operations. */
export function peerPairOperationRefs(gt: GtPeerPair): {
  source: GtOperationRef[];
  target: GtOperationRef[];
} {
  const source: GtOperationRef[] = [];
  const target: GtOperationRef[] = [];
  for (const op of gt.operations.values()) {
    if (op.source !== null) source.push(op.source);
    if (op.target !== null) target.push(op.target);
  }
  return { source, target };
}

export function alignPeerPair(ctx: ScoringContext, gt: GtPeerPair): AlignedPeerPair {
  const sourceSpec = ctx.specForApp(gt.sourceApp);
  const targetSpec = ctx.specForApp(gt.targetApp);
  const { source, target } = peerPairOperationRefs(gt);
  const sourceRef =
    sourceSpec === undefined
      ? undefined
      : resolveResourceRef(sourceSpec, source, gt.sourceResource);
  const targetRef =
    targetSpec === undefined
      ? undefined
      : resolveResourceRef(targetSpec, target, gt.targetResource);
  return {
    sourceSpec,
    targetSpec,
    sourceRef,
    targetRef,
    resolved:
      sourceSpec !== undefined &&
      targetSpec !== undefined &&
      sourceRef !== undefined &&
      targetRef !== undefined,
  };
}

export interface AlignedConsumerTarget {
  readonly targetApp: string;
  readonly targetSpec: ApiSpec | undefined;
  readonly targetRef: string | undefined;
  readonly backendOps: readonly GtOperationRef[];
  readonly resolved: boolean;
}

export interface AlignedConsumerPair {
  readonly sourceSpec: ApiSpec | undefined;
  readonly sourceRef: string | undefined;
  readonly targets: readonly AlignedConsumerTarget[];
}

/** The backend operations bound to a given provider app (an unnamed backend applies to the sole provider). */
function backendOpsFor(gt: GtConsumerProviderPair, targetApp: string): GtOperationRef[] {
  const ops: GtOperationRef[] = [];
  for (const op of gt.operations) {
    for (const backend of op.backends) {
      if (backend.app === targetApp || backend.app === null) ops.push(backend.operation);
    }
  }
  return ops;
}

export function alignConsumerPair(
  ctx: ScoringContext,
  gt: GtConsumerProviderPair,
): AlignedConsumerPair {
  const sourceSpec = ctx.specForApp(gt.sourceApp);
  const consumerOps = gt.operations.map((op) => op.consumer);
  const sourceRef =
    sourceSpec === undefined
      ? undefined
      : resolveResourceRef(sourceSpec, consumerOps, gt.sourceResource);

  const targets = gt.targetApps.map((targetApp): AlignedConsumerTarget => {
    const targetSpec = ctx.specForApp(targetApp);
    const backendOps = backendOpsFor(gt, targetApp);
    const targetRef =
      targetSpec === undefined ? undefined : resolveResourceRef(targetSpec, backendOps, "");
    return {
      targetApp,
      targetSpec,
      targetRef,
      backendOps,
      resolved: sourceSpec !== undefined && targetSpec !== undefined && targetRef !== undefined,
    };
  });

  return { sourceSpec, sourceRef, targets };
}
