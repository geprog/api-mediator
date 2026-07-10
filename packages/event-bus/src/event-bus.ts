import { EventOutboxRepository, type DbHandle } from "@mediator/db";
import type { DomainEventEnvelope } from "@mediator/domain";

import { toOutboxInsert } from "./event.js";

/**
 * The producer-facing Event Bus: append a domain event to the durable outbox
 * **inside the caller's transaction**, so the event and the state change that
 * produced it commit or roll back together (transactional outbox — overview.md
 * *Event Bus*). The dispatcher delivers the outbox rows to consumers separately.
 */
export interface EventBus {
  /**
   * Emit `event` within the caller's transaction `tx`. Re-emitting the same
   * `event.id` is a no-op (the outbox `event_id` is UNIQUE), so a retried
   * producer never double-publishes.
   */
  emit(event: DomainEventEnvelope, tx: DbHandle): Promise<void>;
}

/** The Postgres-outbox {@link EventBus}: `emit` is a single insert into `event_outbox`. */
export class PostgresEventBus implements EventBus {
  public async emit(event: DomainEventEnvelope, tx: DbHandle): Promise<void> {
    await new EventOutboxRepository(tx).insert(toOutboxInsert(event));
  }
}
