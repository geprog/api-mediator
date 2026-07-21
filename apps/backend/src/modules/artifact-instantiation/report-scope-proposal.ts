import { describeUnderivableScopeSkip, underivableScopePairs } from "../scope-authoring.js";
import type { ScopeProposalReporter } from "./consumer.js";

/**
 * The minimal logger surface {@link buildScopeProposalReporter} needs — a structural
 * subset of the shared pino/Fastify logger (`warn(obj, msg)`), so this module does not
 * depend on the whole composition root. `warn` is the right level: an underivable scoped
 * pair is not an error (the instantiation succeeded, the pair simply cannot sync scoped
 * until the operator acts), but it is an operator-actionable anomaly, not routine `info`.
 */
export interface ScopeProposalLogSink {
  warn(obj: Record<string, unknown>, msg: string): void;
}

/**
 * **SS-16 — build the operator-facing sink for the SS-18 proposal outcome.** The consumer
 * that SS-18 left the typed {@link ScopeProposalSkipReason}s for: it reads each proposal
 * outcome, filters to the pairs that look **scoped but underivable**
 * ({@link underivableScopePairs}), and logs one structured `warn` per such pair — its
 * `resourcePairRef`, its typed `reason`, and a human explanation
 * ({@link describeUnderivableScopeSkip}). Observability (structured logs → Grafana) is the
 * current operator surface for this class of anomaly (no business-metrics/audit surface for
 * it exists yet, and adding one is out of this slice / would need a migration).
 *
 * The healthy case — every pair proposed a correspondence or was correctly `not-scoped` —
 * logs **nothing**, so the surface is quiet until it has something an operator should act
 * on. Metadata only: a `resourcePairRef` is operator config (app ids + resource nouns),
 * never a secret or a payload value.
 */
export function buildScopeProposalReporter(log: ScopeProposalLogSink): ScopeProposalReporter {
  return (outcome, context): void => {
    for (const pair of underivableScopePairs(outcome)) {
      log.warn(
        {
          approvedMappingId: context.approvedMappingId,
          resourcePairRef: pair.resourcePairRef,
          reason: pair.reason,
        },
        `scoped resource pair could not derive a ScopeCorrespondence: ${describeUnderivableScopeSkip(
          pair.reason,
        )}`,
      );
    }
  };
}
