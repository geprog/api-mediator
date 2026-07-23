import { randomUUID } from "node:crypto";

import type { DownstreamArtifactOps } from "@mediator/db";
import {
  MAPPING_APPROVED_EVENT_TYPE,
  type ApprovedMapping,
  type FieldMapping,
  type OperationMapping,
} from "@mediator/domain";
import { parseMappingApproved, type DeliveredEvent, type EventConsumer } from "@mediator/event-bus";

import type { ScopeCorrespondenceProposalOps, ScopeProposalOutcome } from "../scope-authoring.js";
import { proposeScopeCorrespondences } from "../scope-authoring.js";
import { adoptSuccessor, type SuccessorAdoptionDeps } from "./adopt.js";
import { instantiateArtifacts } from "./instantiate.js";

/**
 * SS-16 — an optional sink for the `ScopeCorrespondence` proposal outcome. Injected so the
 * typed {@link ScopeProposalSkipReason}s SS-18 returns are **read** (see
 * `underivableScopePairs`): the composition root wires it to surface "scoped but
 * underivable" pairs to the operator. It is called with the **whole** outcome after each
 * proposal run; a no-op default keeps every existing harness behaving exactly as before.
 * Synchronous and side-effect-only (it must not throw): the reaction's correctness never
 * depends on the report, so an observability sink can never fail the instantiation tx.
 */
export type ScopeProposalReporter = (
  outcome: ScopeProposalOutcome,
  context: { readonly approvedMappingId: string },
) => void;

/**
 * The stable consumer identity the Event Bus deduplicates under (its
 * `processed_event.consumer_name`). Stable across restarts so an at-least-once
 * redelivery is skipped, not re-run (AI-3 criterion 1). Shared with the
 * reconciler, which re-derives the same reaction.
 */
export const ARTIFACT_INSTANTIATION_CONSUMER_NAME = "mapping-artifact-instantiation";

/** An `ApprovedMapping` with the children the instantiation needs, loaded by id. */
export interface LoadedApprovedMapping {
  readonly mapping: ApprovedMapping;
  readonly fields: readonly FieldMapping[];
  readonly operations: readonly OperationMapping[];
}

/**
 * Load an `ApprovedMapping` + its `FieldMapping`/`OperationMapping` children by id,
 * through the handler's transaction handle `tx`. Injected (rather than
 * constructing repositories directly) so the consumer is unit-testable against an
 * in-memory fake — production wires it to the `ApprovedMappingRepository` +
 * `MappingArtifactsRepository`. Returns `undefined` when no such mapping exists.
 */
export type ApprovedMappingLoader<TTx> = (
  approvedMappingId: string,
  tx: TTx,
) => Promise<LoadedApprovedMapping | undefined>;

/** Build the transaction-bound {@link DownstreamArtifactOps} the instantiation writes through. */
export type DownstreamArtifactOpsFactory<TTx> = (tx: TTx) => DownstreamArtifactOps;

/**
 * Build the transaction-bound {@link ScopeCorrespondenceProposalOps} the SS-18 proposal
 * reads + writes through (spec IR, resource bindings, the idempotent correspondence
 * propose).
 */
export type ScopeCorrespondenceProposalOpsFactory<TTx> = (
  tx: TTx,
) => ScopeCorrespondenceProposalOps;

export interface MappingApprovedInstantiationConsumerDeps<TTx> {
  readonly load: ApprovedMappingLoader<TTx>;
  readonly ops: DownstreamArtifactOpsFactory<TTx>;
  /**
   * SS-18.1 — the `ScopeCorrespondence` proposal ops. **Optional**: a harness that only
   * exercises the AI-1..AI-3 artifact instantiation may omit it, in which case no
   * correspondence is proposed and the instantiation behaves exactly as before (the
   * proposal is additive to the reaction, never a precondition of it).
   */
  readonly scopeProposalOps?: ScopeCorrespondenceProposalOpsFactory<TTx>;
  /**
   * SS-16 — optional sink for the proposal outcome, so the underivable-skip reasons are
   * surfaced to the operator (see {@link ScopeProposalReporter}). Omitted → no report.
   */
  readonly reportScopeProposal?: ScopeProposalReporter;
  /**
   * SL-7/SL-8 — the successor-adoption capability. When present, an approved mapping carrying
   * a `predecessorMappingId` is **adopted in place** (its predecessor's re-pointed
   * rules/bindings take over the successor's slot) instead of freshly instantiated. Optional:
   * a Phase-3 harness that only exercises first-time instantiation omits it, in which case a
   * successor (which cannot arise before Phase 6) would fall through to fresh instantiation.
   */
  readonly adoption?: SuccessorAdoptionDeps<TTx>;
  /** Id factory for the instantiated rows; defaults to `crypto.randomUUID`. */
  readonly newId?: () => string;
}

/**
 * The `MappingApproved` Event Bus consumer (AI-1..AI-3). It reacts to each
 * `MappingApproved` by instantiating the approval's disabled downstream artifacts
 * — one disabled `SyncRule` per resource pair for a peer-peer mapping, or a
 * `proposed` `AdapterBinding` under an ensured `AdapterEndpoint` for a
 * consumer-provider mapping — plus the projected `GraphEdge`.
 *
 * Unlike the Phase-2 detection consumer, this consumer's work is **pure database**
 * (no LLM, no network), so it completes **inside** the dispatcher transaction `tx`:
 * the whole instantiation and its `processed_event` ledger row commit atomically
 * (AI-3 criterion 3). The event carries only `approvedMappingId` + `variant`; the
 * full `ApprovedMapping` and its children are re-loaded from persisted state, so a
 * redelivery and an incremental approval are handled identically by the idempotent
 * upserts inside {@link instantiateArtifacts}.
 *
 * `TTx` is the transaction-handle type (`DbTransaction` in production, an in-memory
 * fake in unit tests), matching {@link EventConsumer}.
 */
export class MappingApprovedInstantiationConsumer<TTx> implements EventConsumer<TTx> {
  public readonly name = ARTIFACT_INSTANTIATION_CONSUMER_NAME;
  readonly #load: ApprovedMappingLoader<TTx>;
  readonly #ops: DownstreamArtifactOpsFactory<TTx>;
  readonly #scopeProposalOps: ScopeCorrespondenceProposalOpsFactory<TTx> | undefined;
  readonly #reportScopeProposal: ScopeProposalReporter | undefined;
  readonly #adoption: SuccessorAdoptionDeps<TTx> | undefined;
  readonly #newId: () => string;

  public constructor(deps: MappingApprovedInstantiationConsumerDeps<TTx>) {
    this.#load = deps.load;
    this.#ops = deps.ops;
    this.#scopeProposalOps = deps.scopeProposalOps;
    this.#reportScopeProposal = deps.reportScopeProposal;
    this.#adoption = deps.adoption;
    this.#newId = deps.newId ?? ((): string => randomUUID());
  }

  public handles(type: string): boolean {
    return type === MAPPING_APPROVED_EVENT_TYPE;
  }

  public async handle(event: DeliveredEvent, tx: TTx): Promise<void> {
    const { approvedMappingId } = parseMappingApproved(event);
    const loaded = await this.#load(approvedMappingId, tx);
    if (loaded === undefined) {
      // The mapping is gone. The emit is transactional with the approval, so this
      // is anomalous rather than expected; there is nothing to instantiate, so the
      // event is treated as handled (a no-op) rather than retried forever.
      return;
    }

    // SL-7.2 — a mapping carrying a `predecessorMappingId` is a **successor** (its re-review
    // proposal was approved): adopt it **in place** across everything derived from the stale
    // predecessor — re-pointing the predecessor's rules/bindings, transferring the
    // counterpart, and superseding the predecessor — instead of freshly instantiating brand
    // new artifacts (which would restart the relationship and lose the sync operational
    // state). Adoption runs ONLY here, as the ordinary consequence of the successor's
    // `MappingApproved` (the safety promise; no adoption without human approval). The
    // successor's carried-forward content (SL-7.6) is already committed from approval, so the
    // adapter half re-validates against the complete content.
    const predecessorMappingId = loaded.mapping.predecessorMappingId ?? undefined;
    if (predecessorMappingId != null && this.#adoption !== undefined) {
      await adoptSuccessor({
        successor: loaded.mapping,
        predecessorMappingId,
        // SL-8.5 — the successor's persisted fields (the SL-7.6 carry-forward union) let adoption
        // detect which field pairs the successor added and enqueue their baseline seeding.
        successorFields: loaded.fields,
        deps: this.#adoption,
        tx,
      });
      return;
    }

    await instantiateArtifacts({
      mapping: loaded.mapping,
      fields: loaded.fields,
      operations: loaded.operations,
      ops: this.#ops(tx),
      newId: this.#newId,
    });
    // SS-18.1 — the moment source *and* target resources are both known, propose a
    // `ScopeCorrespondence` for each **scoped** resource pair the mapping covers. It runs
    // in the SAME transaction as the artifact instantiation (still pure database), so a
    // pair's rule and its proposed correspondence commit together or not at all; and it is
    // idempotent (SS-18.6), so a redelivery converges on one unconfirmed candidate per pair
    // and never clobbers a confirmed one.
    const scopeProposalOps = this.#scopeProposalOps;
    if (scopeProposalOps !== undefined) {
      const outcome = await proposeScopeCorrespondences({
        mapping: loaded.mapping,
        fields: loaded.fields,
        operations: loaded.operations,
        ops: scopeProposalOps(tx),
        newId: this.#newId,
      });
      // SS-16 — surface the outcome (its underivable skips especially) to the operator.
      this.#reportScopeProposal?.(outcome, { approvedMappingId });
    }
  }
}
