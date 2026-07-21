import { randomUUID } from "node:crypto";

import type { AdapterWriteOutcomeOps } from "@mediator/db";
import type { AdapterWriteOutcome, AdapterWriteResult } from "@mediator/domain";

/**
 * The **narrow, dedup-window-aware seam** the {@link AdapterServeHandler} drives the
 * bounded write-outcome store through (WR-3) — the write-path analogue of
 * `unionLinkResolver`, so the handler is unit-testable against an in-memory fake and
 * never owns the window length, clock, or id generation itself.
 *
 * The window policy lives entirely in the {@link DbWriteOutcomeStore} implementation:
 * `lookup` returns a recorded outcome **only while it is still inside the dedup
 * window** (an aged-out row reads as absent — WR-3.5), and `record` stamps the
 * `executedAt`/`expiresAt` bounds. The handler simply asks "is there a live recorded
 * outcome for this key?" and, failing that, records the one it just produced.
 */
export interface WriteOutcomeStore {
  /**
   * The still-in-window recorded outcome for a delivery, or `undefined` when there is
   * none or it has aged out of the dedup window (WR-3.3/3.5). The **full** record
   * (incl. the response body) so a deduplicated delivery is answered with the original
   * response.
   */
  lookup(
    adapterEndpointId: string,
    idempotencyKey: string,
  ): Promise<AdapterWriteOutcome | undefined>;
  /**
   * Record this delivery's outcome and return the authoritative persisted record
   * (this delivery's, or — on a race with a still-fresh duplicate — the winner's).
   * Idempotent within the window: a concurrent duplicate never clobbers the original
   * (WR-3.3/3.4); an aged-out row is replaced afresh (WR-3.5).
   */
  record(input: RecordWriteOutcomeInput): Promise<AdapterWriteOutcome>;
}

/** A completed write to record — the store fills the id + window bounds. */
export interface RecordWriteOutcomeInput {
  readonly idempotencyKey: string;
  readonly adapterEndpointId: string;
  readonly adapterBindingId: string;
  readonly result: AdapterWriteResult;
}

/**
 * The default dedup window (24h) — matched to the Phase-4 OC-2 lookback window default
 * (`packages/outbound/src/executor.ts` `DEFAULT_LOOKBACK_WINDOW_MS`), the window this
 * shape shares (README open question 5). Overridable via {@link DbWriteOutcomeStoreOptions}.
 */
export const DEFAULT_WRITE_OUTCOME_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface DbWriteOutcomeStoreOptions {
  /** The dedup-window length (ms); default {@link DEFAULT_WRITE_OUTCOME_WINDOW_MS}. */
  readonly windowMs?: number;
  /** Injected clock (epoch `Date`), so window expiry is deterministic in tests. */
  readonly now?: () => Date;
  /** Injected id generator for the persisted row; default `crypto.randomUUID`. */
  readonly newId?: () => string;
}

/**
 * The `@mediator/db`-backed {@link WriteOutcomeStore} — wraps the persistence
 * {@link AdapterWriteOutcomeOps} with the dedup-window policy. `lookup` filters the
 * repo read to the live window; `record` stamps `executedAt`/`expiresAt` and delegates
 * to the aged-out-aware `recordOutcome` (which replaces only an already-expired row).
 */
export class DbWriteOutcomeStore implements WriteOutcomeStore {
  readonly #ops: AdapterWriteOutcomeOps;
  readonly #windowMs: number;
  readonly #now: () => Date;
  readonly #newId: () => string;

  public constructor(ops: AdapterWriteOutcomeOps, options: DbWriteOutcomeStoreOptions = {}) {
    this.#ops = ops;
    this.#windowMs = options.windowMs ?? DEFAULT_WRITE_OUTCOME_WINDOW_MS;
    this.#now = options.now ?? ((): Date => new Date());
    this.#newId = options.newId ?? ((): string => randomUUID());
  }

  public async lookup(
    adapterEndpointId: string,
    idempotencyKey: string,
  ): Promise<AdapterWriteOutcome | undefined> {
    const row = await this.#ops.findByDedupKey(adapterEndpointId, idempotencyKey);
    if (row === undefined) {
      return undefined;
    }
    // WR-3.5 — an entry past its window is treated as absent (a new delivery).
    return row.expiresAt.getTime() > this.#now().getTime() ? row : undefined;
  }

  public async record(input: RecordWriteOutcomeInput): Promise<AdapterWriteOutcome> {
    const now = this.#now();
    const outcome: AdapterWriteOutcome = {
      id: this.#newId(),
      idempotencyKey: input.idempotencyKey,
      adapterEndpointId: input.adapterEndpointId,
      adapterBindingId: input.adapterBindingId,
      result: input.result,
      executedAt: now,
      expiresAt: new Date(now.getTime() + this.#windowMs),
    };
    return this.#ops.recordOutcome(outcome, now);
  }
}
