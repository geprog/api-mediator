import { z } from "zod";

import { adapterWriteOutcomeStatusSchema } from "./adapter-enums.js";

/**
 * `AdapterWriteOutcome` — one record of the bounded **write-outcome store**
 * (`docs/architecture/adapter-engine.md` *Write operations* — *Idempotency* /
 * *Failure semantics*; `docs/glossary.md` `Write-outcome store`; AD-4).
 *
 * A deduplicated repeat delivery of an adapter write is answered with **what
 * actually happened** the first time — never re-executed, and never answered with
 * a fabricated success. That requires retaining the original execution's status
 * *and response body*, which is precisely why this is its own store and not a
 * `SyncEvent`/`AuditLog` row: the Audit Log stays **metadata-only**
 * (`docs/architecture/security.md` *Audit logging*), and a row holding a live
 * response payload would break that invariant for the whole log (AD-4.2).
 *
 * ## Bounded, never unbounded (AD-4.3)
 *
 * Retention is scoped to the dedup lookback window: every record carries an
 * `expiresAt`, and expired records are pruned
 * (`AdapterWriteOutcomeRepository.deleteExpired`). The window *length* is
 * config-defined and shared with the Phase-4 idempotency window (README open
 * question 5) — this shape only requires that an expiry exists.
 *
 * ## What it must never hold (AD-4.4)
 *
 * No credential material, ever — not in `responseBody`, not anywhere. The stored
 * body is the backend's response as mapped back to the consumer's schema, and the
 * operator API/UI reads only {@link AdapterWriteOutcomeMetadata} (this shape minus
 * `responseBody`), so the store is never dumped as a payload through the operator
 * surface. The body exists for exactly one consumer: WR-3 replaying the original
 * outcome to the original caller.
 */

/**
 * The recorded result of the original execution. A **discriminated union** on
 * `outcome` so a recorded failure can never be mistaken for a success (AD-4.5) —
 * the replay path branches on the discriminant, not on a nullable status code.
 *
 * - `success` — the write completed; `responseStatus` is the status it returned
 *   (always present) and `responseBody` its body (absent for a bodyless response
 *   such as `204`).
 * - `failure` — the write failed; `responseStatus`/`responseBody` carry the
 *   upstream error where the call reached the backend at all, and are **absent**
 *   when it did not (a timeout or connection failure produced no HTTP response).
 *   A replayed delivery is answered with this failure rather than treated as
 *   never-executed.
 */
export const adapterWriteResultSchema = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal(adapterWriteOutcomeStatusSchema.enum.success),
    responseStatus: z.number().int(),
    responseBody: z.unknown().optional(),
  }),
  z.object({
    outcome: z.literal(adapterWriteOutcomeStatusSchema.enum.failure),
    responseStatus: z.number().int().optional(),
    responseBody: z.unknown().optional(),
  }),
]);
export type AdapterWriteResult = z.infer<typeof adapterWriteResultSchema>;

/**
 * One write-outcome record.
 *
 * - `idempotencyKey` — the write's key: the caller-supplied one where the consumer
 *   operation declares an idempotency-key parameter, otherwise the deterministic
 *   key derived from the request by the shared Phase-4 mechanism (OC-2). Computing
 *   it is WR-3's job, not this shape's.
 * - `adapterEndpointId` / `adapterBindingId` — the originating endpoint and the
 *   binding that executed the write. A write endpoint is always `single` with
 *   exactly one active binding, so the dedup lookup is keyed by
 *   `(adapterEndpointId, idempotencyKey)` and the binding is provenance.
 * - `result` — the recorded status + body (above).
 * - `executedAt` — when the original execution completed.
 * - `expiresAt` — when this record leaves the dedup window. After it, a repeat
 *   delivery is a *new* write again; the record is prunable from that instant.
 */
export const adapterWriteOutcomeSchema = z.object({
  id: z.string(),
  idempotencyKey: z.string().min(1),
  adapterEndpointId: z.string(),
  adapterBindingId: z.string(),
  result: adapterWriteResultSchema,
  executedAt: z.date(),
  expiresAt: z.date(),
});
export type AdapterWriteOutcome = z.infer<typeof adapterWriteOutcomeSchema>;

/**
 * The **only** shape a write-outcome read returns to anything but the replay path:
 * everything except `responseBody`. Mirrors `CredentialMetadata`'s discipline —
 * the "no payload dump through the operator API/UI" invariant (AD-4.4) is enforced
 * in the type system, not by convention, so no operator-facing read path can
 * surface a stored response body even by accident.
 */
export const adapterWriteOutcomeMetadataSchema = z.object({
  id: z.string(),
  idempotencyKey: z.string().min(1),
  adapterEndpointId: z.string(),
  adapterBindingId: z.string(),
  outcome: adapterWriteOutcomeStatusSchema,
  responseStatus: z.number().int().optional(),
  executedAt: z.date(),
  expiresAt: z.date(),
});
export type AdapterWriteOutcomeMetadata = z.infer<typeof adapterWriteOutcomeMetadataSchema>;
