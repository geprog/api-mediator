import {
  type AdapterWriteOutcome,
  type AdapterWriteOutcomeMetadata,
  type AdapterWriteResult,
  stripUndefined,
} from "@mediator/domain";

import { adapterWriteOutcome } from "../schema.js";

/** A selected `adapter_write_outcome` row, with Drizzle's inferred column types. */
export type AdapterWriteOutcomeRow = typeof adapterWriteOutcome.$inferSelect;
/** The insert shape Drizzle expects for `adapter_write_outcome`. */
export type AdapterWriteOutcomeInsert = typeof adapterWriteOutcome.$inferInsert;

/**
 * Reassemble the domain `AdapterWriteResult` discriminated union from the flat
 * `outcome` / `response_status` / `response_body` columns. The store flattens the
 * union into columns (one status enum + two nullable payload columns) rather than
 * a single `jsonb` blob, so the `outcome` discriminant is a first-class,
 * queryable column — a recorded failure can never be *read* as a success (AD-4.5).
 * A NULL payload column collapses to an **absent** union key.
 */
function mapResult(row: AdapterWriteOutcomeRow): AdapterWriteResult {
  if (row.outcome === "success") {
    if (row.responseStatus === null) {
      // A recorded success always reached the backend, so it always has a status
      // (the domain shape requires it). A NULL here is a corrupt row, not a state.
      throw new Error("adapter_write_outcome success row has NULL response_status");
    }
    return stripUndefined({
      outcome: "success" as const,
      responseStatus: row.responseStatus,
      responseBody: row.responseBody ?? undefined,
    });
  }
  return stripUndefined({
    outcome: "failure" as const,
    responseStatus: row.responseStatus ?? undefined,
    responseBody: row.responseBody ?? undefined,
    // The specific cause the original delivery failed with, so a replay reports it
    // verbatim (WR-3.4 / WR-5.1). Absent on a pre-write-serve-path row (NULL column).
    cause: row.cause ?? undefined,
  });
}

/** Row → domain (full record, incl. the response body — the replay path only). */
export function mapAdapterWriteOutcomeRow(row: AdapterWriteOutcomeRow): AdapterWriteOutcome {
  return {
    id: row.id,
    idempotencyKey: row.idempotencyKey,
    adapterEndpointId: row.adapterEndpointId,
    adapterBindingId: row.adapterBindingId,
    result: mapResult(row),
    executedAt: row.executedAt,
    expiresAt: row.expiresAt,
  };
}

/**
 * Row → **metadata** projection (AD-4.4): everything except `response_body`, so no
 * operator-facing read path can surface the stored payload. Mirrors the
 * `credential` metadata discipline — the "no payload dump" invariant is enforced
 * by never selecting/mapping the body, not by convention.
 */
export function mapAdapterWriteOutcomeMetadataRow(
  // The exact projected columns (a `Pick`, not `Omit`) so this stays decoupled from
  // any new store column — `response_body` is never selected (the no-payload-dump
  // invariant), and the failure `cause` is a full-record concern, not metadata here.
  row: Pick<
    AdapterWriteOutcomeRow,
    | "id"
    | "idempotencyKey"
    | "adapterEndpointId"
    | "adapterBindingId"
    | "outcome"
    | "responseStatus"
    | "executedAt"
    | "expiresAt"
  >,
): AdapterWriteOutcomeMetadata {
  return stripUndefined({
    id: row.id,
    idempotencyKey: row.idempotencyKey,
    adapterEndpointId: row.adapterEndpointId,
    adapterBindingId: row.adapterBindingId,
    outcome: row.outcome,
    responseStatus: row.responseStatus ?? undefined,
    executedAt: row.executedAt,
    expiresAt: row.expiresAt,
  });
}

/** Domain → insert. Flattens the `result` union back into the three columns. */
export function toAdapterWriteOutcomeInsert(
  outcome: AdapterWriteOutcome,
): AdapterWriteOutcomeInsert {
  return {
    id: outcome.id,
    idempotencyKey: outcome.idempotencyKey,
    adapterEndpointId: outcome.adapterEndpointId,
    adapterBindingId: outcome.adapterBindingId,
    outcome: outcome.result.outcome,
    // Only a failure carries a cause; a success row's cause column stays NULL.
    cause: outcome.result.outcome === "failure" ? (outcome.result.cause ?? null) : null,
    responseStatus: outcome.result.responseStatus ?? null,
    responseBody: outcome.result.responseBody ?? null,
    executedAt: outcome.executedAt,
    expiresAt: outcome.expiresAt,
  };
}
