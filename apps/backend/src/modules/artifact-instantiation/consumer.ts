import { randomUUID } from "node:crypto";

import type { DownstreamArtifactOps } from "@mediator/db";
import {
  MAPPING_APPROVED_EVENT_TYPE,
  type ApprovedMapping,
  type FieldMapping,
  type OperationMapping,
} from "@mediator/domain";
import { parseMappingApproved, type DeliveredEvent, type EventConsumer } from "@mediator/event-bus";

import type { ScopeCorrespondenceProposalOps } from "../scope-authoring.js";
import { proposeScopeCorrespondences } from "../scope-authoring.js";
import { instantiateArtifacts } from "./instantiate.js";

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
  readonly #newId: () => string;

  public constructor(deps: MappingApprovedInstantiationConsumerDeps<TTx>) {
    this.#load = deps.load;
    this.#ops = deps.ops;
    this.#scopeProposalOps = deps.scopeProposalOps;
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
      await proposeScopeCorrespondences({
        mapping: loaded.mapping,
        fields: loaded.fields,
        operations: loaded.operations,
        ops: scopeProposalOps(tx),
        newId: this.#newId,
      });
    }
  }
}
