import { randomUUID } from "node:crypto";

import type { OutboxInsert, OutboxRecord } from "@mediator/db";
import {
  SPEC_INGESTED_EVENT_TYPE,
  specIngestedSchema,
  type ApiSpecRole,
  type DomainEventEnvelope,
  type SpecIngested,
} from "@mediator/domain";

/**
 * The in-memory form the dispatcher hands a consumer, reconstructed from an
 * outbox row. The envelope (`id`/`type`/`occurredAt`) comes from the row's
 * dedicated columns — so `occurredAt` is a real `Date`, not the ISO string a
 * jsonb round-trip would produce — and `payload` carries the event's
 * type-specific fields. A consumer that `handles(type)` knows the concrete event
 * and re-validates it with that type's `@mediator/domain` schema (e.g. via
 * {@link parseSpecIngested}); the bus itself stays event-type-agnostic.
 */
export interface DeliveredEvent {
  readonly id: string;
  readonly type: string;
  readonly occurredAt: Date;
  readonly payload: Record<string, unknown>;
}

/**
 * Split a domain event into an outbox insert: the envelope becomes columns
 * (`eventId`/`type`/`occurredAt`) and everything else becomes the type-specific
 * `payload`. Works for any concrete event because the split is done on the
 * runtime object's own keys, not the static (base-envelope) type.
 */
export function toOutboxInsert(event: DomainEventEnvelope): OutboxInsert {
  const source: Record<string, unknown> = { ...event };
  const payload: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (key !== "id" && key !== "type" && key !== "occurredAt") {
      payload[key] = value;
    }
  }
  return {
    eventId: event.id,
    type: event.type,
    occurredAt: event.occurredAt,
    payload,
  };
}

/** Reconstruct the delivered event from a claimed outbox row. */
export function reconstructEvent(row: OutboxRecord): DeliveredEvent {
  return {
    id: row.eventId,
    type: row.type,
    occurredAt: row.occurredAt,
    payload: row.payload,
  };
}

/**
 * Recover the flat domain-event object (envelope merged back over its payload)
 * so it can be validated with a concrete `@mediator/domain` schema. The
 * column-sourced envelope wins over any stale copy in the payload, so
 * `occurredAt` is the `Date` from the row.
 */
export function flattenDeliveredEvent(event: DeliveredEvent): Record<string, unknown> {
  return {
    ...event.payload,
    id: event.id,
    type: event.type,
    occurredAt: event.occurredAt,
  };
}

/**
 * Validate a delivered event as a `SpecIngested`, or throw if it is not one /
 * is malformed. The Phase-2 mapping-detection consumer uses this to recover full
 * typing from the type-agnostic {@link DeliveredEvent}.
 */
export function parseSpecIngested(event: DeliveredEvent): SpecIngested {
  return specIngestedSchema.parse(flattenDeliveredEvent(event));
}

/**
 * Construct a `SpecIngested` domain event with a fresh event id and
 * `occurredAt`. The registration slice calls this after storing an `ApiSpec` and
 * hands the result to `EventBus.emit(event, tx)` (EB-1). The event id is what
 * consumers deduplicate by.
 */
export function createSpecIngested(input: {
  readonly apiSpecId: string;
  readonly appId: string;
  readonly role: ApiSpecRole;
}): SpecIngested {
  return specIngestedSchema.parse({
    id: randomUUID(),
    type: SPEC_INGESTED_EVENT_TYPE,
    occurredAt: new Date(),
    apiSpecId: input.apiSpecId,
    appId: input.appId,
    role: input.role,
  });
}
