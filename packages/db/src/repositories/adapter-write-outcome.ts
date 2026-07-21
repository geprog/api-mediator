import type { AdapterWriteOutcome, AdapterWriteOutcomeMetadata } from "@mediator/domain";
import { and, eq, lte } from "drizzle-orm";

import type { DbHandle } from "../client.js";
import {
  mapAdapterWriteOutcomeMetadataRow,
  mapAdapterWriteOutcomeRow,
  toAdapterWriteOutcomeInsert,
} from "../mappers/adapter-write-outcome.js";
import { adapterWriteOutcome } from "../schema.js";

/**
 * The narrow write surface the adapter write path (WR-3, a later slice) drives
 * against the bounded write-outcome store. A narrow interface (rather than the
 * whole {@link AdapterWriteOutcomeRepository}) so the write pipeline is
 * unit-testable against an in-memory fake mirroring these exact insert-if-absent /
 * lookup semantics (AD-6.5).
 */
export interface AdapterWriteOutcomeOps {
  /**
   * Record the original execution's outcome unless one already exists for its
   * `(adapterEndpointId, idempotencyKey)` — the dedup key. Returns the persisted
   * record (the freshly inserted `outcome` on first delivery, the existing one on
   * a race). This is the store's answer to "record the outcome exactly once, never
   * fabricate a repeat" (AD-4.5).
   */
  recordOutcomeIfAbsent(outcome: AdapterWriteOutcome): Promise<AdapterWriteOutcome>;
  /**
   * The recorded outcome for a delivery, if one is still in the store — what a
   * deduplicated repeat delivery is answered with (AD-4.1). Returns the **full**
   * record (incl. the response body) because replay reconstructs the original
   * response; only the operator-facing reads use the metadata projection.
   */
  findByDedupKey(
    adapterEndpointId: string,
    idempotencyKey: string,
  ): Promise<AdapterWriteOutcome | undefined>;
}

/**
 * Persistence for the bounded write-outcome store (`adapter_write_outcome`,
 * AD-4). Constructor-bound to a {@link DbHandle} (the pooled db or a `tx()`
 * transaction), matching the repo convention. It implements
 * {@link AdapterWriteOutcomeOps} plus the boundedness sweep (`deleteExpired`) and
 * a metadata-only read for the operator API/UI (AD-4.4 — never the payload).
 */
export class AdapterWriteOutcomeRepository implements AdapterWriteOutcomeOps {
  public constructor(private readonly db: DbHandle) {}

  public async recordOutcomeIfAbsent(outcome: AdapterWriteOutcome): Promise<AdapterWriteOutcome> {
    const [inserted] = await this.db
      .insert(adapterWriteOutcome)
      .values(toAdapterWriteOutcomeInsert(outcome))
      .onConflictDoNothing({
        target: [adapterWriteOutcome.adapterEndpointId, adapterWriteOutcome.idempotencyKey],
      })
      .returning();
    if (inserted !== undefined) {
      return mapAdapterWriteOutcomeRow(inserted);
    }
    // Conflict: a record already exists for this delivery → return it (never
    // re-execute, never fabricate a success — AD-4.5).
    const existing = await this.findByDedupKey(outcome.adapterEndpointId, outcome.idempotencyKey);
    if (existing === undefined) {
      throw new Error("adapter_write_outcome record-if-absent found no row after a conflict");
    }
    return existing;
  }

  public async findByDedupKey(
    adapterEndpointId: string,
    idempotencyKey: string,
  ): Promise<AdapterWriteOutcome | undefined> {
    const [row] = await this.db
      .select()
      .from(adapterWriteOutcome)
      .where(
        and(
          eq(adapterWriteOutcome.adapterEndpointId, adapterEndpointId),
          eq(adapterWriteOutcome.idempotencyKey, idempotencyKey),
        ),
      );
    return row === undefined ? undefined : mapAdapterWriteOutcomeRow(row);
  }

  /**
   * The metadata for a delivery (never the response body — AD-4.4). The operator
   * API/UI read path.
   */
  public async findMetadataByDedupKey(
    adapterEndpointId: string,
    idempotencyKey: string,
  ): Promise<AdapterWriteOutcomeMetadata | undefined> {
    const [row] = await this.db
      .select({
        id: adapterWriteOutcome.id,
        idempotencyKey: adapterWriteOutcome.idempotencyKey,
        adapterEndpointId: adapterWriteOutcome.adapterEndpointId,
        adapterBindingId: adapterWriteOutcome.adapterBindingId,
        outcome: adapterWriteOutcome.outcome,
        responseStatus: adapterWriteOutcome.responseStatus,
        executedAt: adapterWriteOutcome.executedAt,
        expiresAt: adapterWriteOutcome.expiresAt,
      })
      .from(adapterWriteOutcome)
      .where(
        and(
          eq(adapterWriteOutcome.adapterEndpointId, adapterEndpointId),
          eq(adapterWriteOutcome.idempotencyKey, idempotencyKey),
        ),
      );
    return row === undefined ? undefined : mapAdapterWriteOutcomeMetadataRow(row);
  }

  /**
   * Delete every record whose dedup window has closed at `now` — the boundedness
   * sweep that keeps the store bounded rather than growing unbounded (AD-4.3).
   * Returns how many rows were pruned.
   */
  public async deleteExpired(now: Date): Promise<number> {
    const deleted = await this.db
      .delete(adapterWriteOutcome)
      .where(lte(adapterWriteOutcome.expiresAt, now))
      .returning({ id: adapterWriteOutcome.id });
    return deleted.length;
  }
}
