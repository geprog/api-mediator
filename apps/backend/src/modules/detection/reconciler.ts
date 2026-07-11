import type { Reconciler } from "@mediator/event-bus";

import { DETECTION_CONSUMER_NAME } from "./consumer.js";

/**
 * The first real reconciliation-sweep {@link Reconciler} (DT-2 crit 4): it makes
 * "bus loss degrades timeliness, never correctness" true for detection. It finds
 * every `active` `ApiSpec` that ended up with **no detection job at all** — the
 * concept's named example, "an ingested spec with no analysis run" — and
 * re-enqueues a job for it, so a `SpecIngested` reaction the bus dropped is
 * eventually recovered.
 *
 * "Analyzed" is defined as **a detection job exists for the spec in ANY status**
 * (closing README open-question #8): a spec with a job is analyzed-or-analyzing and
 * is left alone — a `completed` job that produced zero proposals (the first spec in
 * the landscape), a `pending`/`running` job in flight, and a `failed`/parked
 * shortlist outcome are all recorded outcomes, not absences, so the sweep does not
 * loop on them (DT-2 crit 5). The `enqueue` it drives is itself idempotent, so a
 * race with the live consumer collapses to one job.
 */
export interface DetectionReconcilerDeps {
  /** Spec ids that are `active` but have no `mapping_detection_job`. */
  readonly findMissingSpecIds: () => Promise<readonly string[]>;
  /** Idempotently record intent to run detection for a spec (its own transaction). */
  readonly enqueue: (apiSpecId: string) => Promise<void>;
}

export class DetectionReconciler implements Reconciler {
  /** Shares the consumer's name — one derivation, one reconciler for it. */
  public readonly name = DETECTION_CONSUMER_NAME;
  readonly #findMissingSpecIds: () => Promise<readonly string[]>;
  readonly #enqueue: (apiSpecId: string) => Promise<void>;

  public constructor(deps: DetectionReconcilerDeps) {
    this.#findMissingSpecIds = deps.findMissingSpecIds;
    this.#enqueue = deps.enqueue;
  }

  public async reconcile(): Promise<void> {
    const specIds = await this.#findMissingSpecIds();
    for (const specId of specIds) {
      await this.#enqueue(specId);
    }
  }
}
