import { and, eq, gte, isNull, lt, sql } from "drizzle-orm";

import type { DbHandle } from "../client.js";
import {
  mapEventOutboxRow,
  toEventOutboxInsert,
  type OutboxInsert,
  type OutboxRecord,
} from "../mappers/event-outbox.js";
import { eventOutbox } from "../schema.js";

/**
 * The outbox operations the dispatcher drives, bound to one transaction handle.
 * Kept as a narrow interface (rather than the whole {@link EventOutboxRepository})
 * so the dispatcher is unit-testable against an in-memory fake — see
 * `@mediator/event-bus`.
 */
export interface OutboxOps {
  /**
   * Claim up to `limit` unpublished rows that have not exhausted their retry
   * budget (`attempts < maxAttempts`), in arrival order, locking them with
   * `FOR UPDATE SKIP LOCKED` so concurrent dispatchers never process the same
   * row. Must run inside a transaction; the locks are held until it commits.
   */
  claimReady(limit: number, maxAttempts: number): Promise<OutboxRecord[]>;
  /** Mark a row delivered (all its consumers processed). */
  markPublished(id: string, publishedAt: Date): Promise<void>;
  /** Record a failed delivery: increment `attempts`, store `lastError`. */
  recordFailure(id: string, lastError: string): Promise<void>;
}

/**
 * Persistence for the `event_outbox` transactional outbox. Constructor-bound to a
 * {@link DbHandle} (the pooled db or a `tx()` transaction), matching the repo
 * convention: construct with the transaction handle to run inside `tx()`.
 */
export class EventOutboxRepository implements OutboxOps {
  public constructor(private readonly db: DbHandle) {}

  /**
   * Append an event to the outbox. `ON CONFLICT (event_id) DO NOTHING` makes a
   * repeated emit of the same domain event id a no-op — emitting is idempotent.
   */
  public async insert(insert: OutboxInsert): Promise<void> {
    await this.db
      .insert(eventOutbox)
      .values(toEventOutboxInsert(insert))
      .onConflictDoNothing({ target: eventOutbox.eventId });
  }

  public async claimReady(limit: number, maxAttempts: number): Promise<OutboxRecord[]> {
    const rows = await this.db
      .select()
      .from(eventOutbox)
      .where(and(isNull(eventOutbox.publishedAt), lt(eventOutbox.attempts, maxAttempts)))
      .orderBy(eventOutbox.createdAt, eventOutbox.id)
      .limit(limit)
      .for("update", { skipLocked: true });
    return rows.map(mapEventOutboxRow);
  }

  public async markPublished(id: string, publishedAt: Date): Promise<void> {
    await this.db.update(eventOutbox).set({ publishedAt }).where(eq(eventOutbox.id, id));
  }

  public async recordFailure(id: string, lastError: string): Promise<void> {
    await this.db
      .update(eventOutbox)
      .set({ attempts: sql`${eventOutbox.attempts} + 1`, lastError })
      .where(eq(eventOutbox.id, id));
  }

  /** The outbox row for a domain event id, if one has been emitted. */
  public async findByEventId(eventId: string): Promise<OutboxRecord | undefined> {
    const [row] = await this.db.select().from(eventOutbox).where(eq(eventOutbox.eventId, eventId));
    return row === undefined ? undefined : mapEventOutboxRow(row);
  }

  /**
   * The parked (dead-letter) rows: unpublished and out of retry budget
   * (`attempts >= maxAttempts`). For observability/alerting and manual replay.
   */
  public async listParked(maxAttempts: number): Promise<OutboxRecord[]> {
    const rows = await this.db
      .select()
      .from(eventOutbox)
      .where(and(isNull(eventOutbox.publishedAt), gte(eventOutbox.attempts, maxAttempts)))
      .orderBy(eventOutbox.createdAt, eventOutbox.id);
    return rows.map(mapEventOutboxRow);
  }
}
