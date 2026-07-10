import { eventOutbox } from "../schema.js";

/** A selected `event_outbox` row, with Drizzle's inferred column types. */
export type EventOutboxRow = typeof eventOutbox.$inferSelect;
/** The insert shape Drizzle expects for `event_outbox`. */
export type EventOutboxInsertRow = typeof eventOutbox.$inferInsert;

/**
 * A dispatcher-facing outbox row, decoupled from Drizzle's inferred types. The
 * envelope columns (`eventId`/`type`/`occurredAt`) are separate from the
 * type-specific `payload` (mirroring the columns), so the dispatcher can
 * reconstruct the delivered event with a real `Date` `occurredAt` rather than the
 * ISO string a jsonb round-trip would yield.
 */
export interface OutboxRecord {
  readonly id: string;
  readonly eventId: string;
  readonly type: string;
  readonly payload: Record<string, unknown>;
  readonly occurredAt: Date;
  readonly publishedAt: Date | null;
  readonly attempts: number;
  readonly lastError: string | null;
  readonly createdAt: Date;
}

/**
 * The fields a producer supplies when appending to the outbox: the event id, its
 * type, the type-specific payload, and when it occurred. `id`, `attempts`,
 * `published_at`, `last_error`, and `created_at` are database-managed.
 */
export interface OutboxInsert {
  readonly eventId: string;
  readonly type: string;
  readonly payload: Record<string, unknown>;
  readonly occurredAt: Date;
}

/** Row → dispatcher record. */
export function mapEventOutboxRow(row: EventOutboxRow): OutboxRecord {
  return {
    id: row.id,
    eventId: row.eventId,
    type: row.type,
    payload: row.payload,
    occurredAt: row.occurredAt,
    publishedAt: row.publishedAt,
    attempts: row.attempts,
    lastError: row.lastError,
    createdAt: row.createdAt,
  };
}

/** Producer insert → Drizzle insert row. */
export function toEventOutboxInsert(insert: OutboxInsert): EventOutboxInsertRow {
  return {
    eventId: insert.eventId,
    type: insert.type,
    payload: insert.payload,
    occurredAt: insert.occurredAt,
  };
}
