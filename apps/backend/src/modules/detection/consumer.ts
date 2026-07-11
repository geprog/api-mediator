import { SPEC_INGESTED_EVENT_TYPE } from "@mediator/domain";
import { parseSpecIngested, type DeliveredEvent, type EventConsumer } from "@mediator/event-bus";

/**
 * The stable consumer identity the Event Bus deduplicates under (its
 * `processed_event.consumer_name`). Stable across restarts so an at-least-once
 * redelivery is skipped, not re-run.
 */
export const DETECTION_CONSUMER_NAME = "mapping-detection";

/**
 * How the consumer records intent to run detection for a spec, **inside the
 * handler's transaction** `tx`. Injected (rather than constructing a repository
 * directly) so the consumer is unit-testable against an in-memory fake — the
 * production wiring passes `(apiSpecId, tx) => new DetectionJobRepository(tx).enqueue(apiSpecId)`.
 */
export type DetectionEnqueue<TTx> = (apiSpecId: string, tx: TTx) => Promise<void>;

/**
 * The `SpecIngested` Event Bus consumer (DT-1/DT-2). It reacts to each
 * `SpecIngested` by **recording intent** — enqueuing a `mapping_detection_job`
 * through the handler's transaction handle — and returning immediately.
 *
 * **It deliberately runs NO detection here.** The `@mediator/event-bus`
 * `OutboxDispatcher` invokes `handle()` inside its own DB transaction (holding
 * outbox row locks), so the ~1,000-call LLM/network analysis MUST NOT run inline;
 * it runs later, outside that transaction, in the `DetectionWorker` that claims the
 * job. Because the enqueue commits atomically with the dispatcher's "processed"
 * ledger row, "handled" and "a job exists" are the same commit — and the enqueue
 * is idempotent, so a redelivered event never produces a second job (DT-2 crit 2).
 *
 * `TTx` is the transaction-handle type (`DbTransaction` in production, an in-memory
 * fake in unit tests), matching {@link EventConsumer}.
 */
export class SpecIngestedDetectionConsumer<TTx> implements EventConsumer<TTx> {
  public readonly name = DETECTION_CONSUMER_NAME;
  readonly #enqueue: DetectionEnqueue<TTx>;

  public constructor(enqueue: DetectionEnqueue<TTx>) {
    this.#enqueue = enqueue;
  }

  public handles(type: string): boolean {
    return type === SPEC_INGESTED_EVENT_TYPE;
  }

  public async handle(event: DeliveredEvent, tx: TTx): Promise<void> {
    const { apiSpecId } = parseSpecIngested(event);
    await this.#enqueue(apiSpecId, tx);
  }
}
