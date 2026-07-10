import type { DeliveredEvent } from "./event.js";

/**
 * An idempotent event consumer. `handles(type)` selects which event types it
 * reacts to; `handle(event, tx)` performs the reaction, writing through the same
 * transaction handle `tx` that the dispatcher uses to record the event as
 * processed — so the reaction and its "processed" ledger row commit atomically.
 *
 * `TTx` is the transaction-handle type (`DbTransaction` in production; an
 * in-memory fake in unit tests). `name` is the consumer's stable identity: it is
 * the `processed_event.consumer_name` this consumer deduplicates under, so it
 * must be unique across registered consumers and stable across restarts.
 */
export interface EventConsumer<TTx> {
  readonly name: string;
  handles(type: string): boolean;
  handle(event: DeliveredEvent, tx: TTx): Promise<void>;
}

/** Thrown when two consumers share a `name` (they would collide in the ledger). */
export class DuplicateConsumerError extends Error {
  public constructor(name: string) {
    super(`An event consumer named "${name}" is already registered.`);
    this.name = "DuplicateConsumerError";
  }
}

/**
 * The set of registered consumers the dispatcher routes events to. Keyed by
 * `name` so a duplicate registration fails loudly rather than silently letting
 * one consumer's ledger entries suppress another's.
 */
export class ConsumerRegistry<TTx> {
  readonly #consumers = new Map<string, EventConsumer<TTx>>();

  public register(consumer: EventConsumer<TTx>): void {
    if (this.#consumers.has(consumer.name)) {
      throw new DuplicateConsumerError(consumer.name);
    }
    this.#consumers.set(consumer.name, consumer);
  }

  /** The registered consumers that handle `type`, in registration order. */
  public consumersFor(type: string): EventConsumer<TTx>[] {
    return [...this.#consumers.values()].filter((consumer) => consumer.handles(type));
  }

  /** All registered consumers, in registration order. */
  public all(): EventConsumer<TTx>[] {
    return [...this.#consumers.values()];
  }
}
