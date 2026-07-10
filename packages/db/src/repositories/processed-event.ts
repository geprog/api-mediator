import { and, eq } from "drizzle-orm";

import type { DbHandle } from "../client.js";
import { processedEvent } from "../schema.js";

/**
 * The consumer-idempotency-ledger operations the dispatcher drives, bound to one
 * transaction handle. A narrow interface (rather than the whole
 * {@link ProcessedEventRepository}) so the dispatcher is unit-testable against an
 * in-memory fake — see `@mediator/event-bus`.
 */
export interface ProcessedEventOps {
  /** Has `consumerName` already handled `eventId`? (dedup-by-event-id check). */
  isProcessed(consumerName: string, eventId: string): Promise<boolean>;
  /**
   * Record that `consumerName` handled `eventId`. Called **in the same
   * transaction as the handler's writes**, so "handled" and its effects commit
   * atomically. `ON CONFLICT DO NOTHING` keeps it safe under an at-least-once
   * redelivery race.
   */
  markProcessed(consumerName: string, eventId: string): Promise<void>;
}

/**
 * Persistence for the `processed_event` idempotency ledger. Constructor-bound to
 * a {@link DbHandle} (the pooled db or a `tx()` transaction), matching the repo
 * convention.
 */
export class ProcessedEventRepository implements ProcessedEventOps {
  public constructor(private readonly db: DbHandle) {}

  public async isProcessed(consumerName: string, eventId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: processedEvent.id })
      .from(processedEvent)
      .where(
        and(eq(processedEvent.consumerName, consumerName), eq(processedEvent.eventId, eventId)),
      )
      .limit(1);
    return row !== undefined;
  }

  public async markProcessed(consumerName: string, eventId: string): Promise<void> {
    await this.db
      .insert(processedEvent)
      .values({ consumerName, eventId })
      .onConflictDoNothing({ target: [processedEvent.consumerName, processedEvent.eventId] });
  }
}
