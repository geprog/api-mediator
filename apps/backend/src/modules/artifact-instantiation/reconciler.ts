import type { Reconciler } from "@mediator/event-bus";

import { ARTIFACT_INSTANTIATION_CONSUMER_NAME } from "./consumer.js";

/**
 * The reconciliation-sweep {@link Reconciler} for artifact instantiation (AI-3
 * criterion 4): it makes "bus loss degrades timeliness, never correctness" true
 * for the approval reaction. It finds every `active` `ApprovedMapping` that ended
 * up with **no** instantiated downstream artifacts — the concept's "the reaction
 * was lost" case — and re-triggers instantiation for it, re-derived from the
 * persisted `ApprovedMapping` + children.
 *
 * "Instantiated" is defined as having ≥1 `SyncRule` OR ≥1 `AdapterBinding`; the
 * `DownstreamArtifactRepository` query further restricts the set to mappings that
 * would actually produce an artifact (a peer-peer mapping with a field/operation
 * child, a consumer-provider mapping with an operation child), so a genuinely empty
 * mapping is not re-triggered forever — a recorded outcome is not an absence. The
 * re-trigger it drives is itself idempotent (the natural-key upserts), so a race
 * with the live consumer collapses to one committed set of artifacts.
 */
export interface ArtifactInstantiationReconcilerDeps {
  /** Ids of `active` mappings that would produce artifacts but have none instantiated. */
  readonly findMissingMappingIds: () => Promise<readonly string[]>;
  /** Idempotently (re-)instantiate a mapping's artifacts, in its own transaction. */
  readonly instantiate: (approvedMappingId: string) => Promise<void>;
}

export class ArtifactInstantiationReconciler implements Reconciler {
  /** Shares the consumer's name — one derivation, one reconciler for it. */
  public readonly name = ARTIFACT_INSTANTIATION_CONSUMER_NAME;
  readonly #findMissingMappingIds: () => Promise<readonly string[]>;
  readonly #instantiate: (approvedMappingId: string) => Promise<void>;

  public constructor(deps: ArtifactInstantiationReconcilerDeps) {
    this.#findMissingMappingIds = deps.findMissingMappingIds;
    this.#instantiate = deps.instantiate;
  }

  public async reconcile(): Promise<void> {
    const mappingIds = await this.#findMissingMappingIds();
    for (const mappingId of mappingIds) {
      await this.#instantiate(mappingId);
    }
  }
}
