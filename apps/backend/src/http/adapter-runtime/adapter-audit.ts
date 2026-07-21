import type { AuditLogEntry } from "@mediator/domain";
import type { ActiveTraceContext } from "@mediator/telemetry";

import type { AdapterAuditFields } from "./outcome-http.js";

/**
 * Persists one `adapter-request` `SyncEvent`/`AuditLog` row per matched request
 * (RT-5.1). A narrow port so the request handler is testable against a fake, and so
 * only the metadata a row may hold ever reaches the database.
 */
export interface AdapterAuditWriter {
  record(entry: AuditLogEntry): Promise<void>;
}

export interface AdapterAuditContext {
  readonly consumerAppId: string;
  /**
   * The adapter-token `Credential` id that authenticated the request (AT-4.3) —
   * a metadata id, never the token value. Absent when the resolver performed no
   * token authentication (the header stand-in).
   */
  readonly credentialId?: string;
  readonly fields: AdapterAuditFields;
  readonly newId: () => string;
  readonly now: Date;
  readonly trace: ActiveTraceContext | null;
}

/**
 * Build the `adapter-request` audit entry for a completed request — **metadata
 * only** (RT-5.5): the caller's app identity as `actor`, the AD-5 endpoint/binding
 * ids, the outcome `status`, the `cause`/`degraded` enums, and the `traceId`/`spanId`
 * correlating the business record to its trace (RT-5.2). It carries **no** request
 * or response payload value, no token, and no credential material — the schema
 * cannot express them and this builder never sets them.
 *
 * `actor` is the consumer app the caller was identified as (the token→app identity
 * the Auth Gateway will supply). The consumer app id is an identifier, never a
 * secret, so recording it does not breach the audit invariant.
 */
export function buildAdapterRequestAudit(context: AdapterAuditContext): AuditLogEntry {
  const { fields, trace } = context;
  // WR-5.4 — a deduplicated write delivery is made distinguishable on the metadata-only
  // audit row via a `details` marker (the audit schema has no dedicated flag, and this
  // slice adds no audit column). The idempotency key rides along as an opaque id.
  const details =
    fields.details ?? (fields.deduplicated === true ? DEDUP_DELIVERY_DETAIL : undefined);
  return {
    id: context.newId(),
    type: "adapter-request",
    actor: `consumer-app:${context.consumerAppId}`,
    status: fields.status,
    timestamp: context.now,
    ...(context.credentialId !== undefined ? { relatedCredentialId: context.credentialId } : {}),
    ...(fields.cause !== undefined ? { cause: fields.cause } : {}),
    ...(fields.degraded !== undefined ? { degraded: fields.degraded } : {}),
    ...(fields.endpointId !== undefined ? { relatedEndpointId: fields.endpointId } : {}),
    ...(fields.bindingId !== undefined ? { relatedBindingId: fields.bindingId } : {}),
    ...(fields.idempotencyKey !== undefined ? { idempotencyKey: fields.idempotencyKey } : {}),
    ...(details !== undefined ? { details } : {}),
    ...(trace !== null ? { traceId: trace.traceId, spanId: trace.spanId } : {}),
  };
}

/** The `details` marker distinguishing a deduplicated write delivery on the audit row (WR-5.4). */
export const DEDUP_DELIVERY_DETAIL = "deduplicated-delivery";
