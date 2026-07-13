import { and, eq, sql } from "drizzle-orm";

import type { DbHandle } from "../client.js";
import { orderingQueue, type OrderingQueueStatus } from "../schema.js";

/**
 * The parameters a worker passes when it claims the next entry. The clock is
 * **injected** (`now`) — never `now()` inside the SQL — so lease expiry is
 * deterministic in tests and the same claim can be exercised "before" and "after"
 * a lease boundary. `leaseExpiresAt` is `now + leaseDuration`, precomputed by the
 * caller (the dispatcher owns the lease-duration policy).
 */
export interface ClaimParams {
  /** The claim's notion of "now" — drives lease-expiry re-claim and the stamps. */
  readonly now: Date;
  /** When the claimed entry's new lease expires (`now + leaseDuration`). */
  readonly leaseExpiresAt: Date;
  /** The claiming worker's opaque id, recorded as `lease_owner`. */
  readonly owner: string;
}

/** The minimum a worker needs about the entry it just claimed. */
export interface ClaimedQueueEntry {
  readonly id: string;
  /** The opaque ordering key this entry serializes on (OQ-2/OQ-3 decide it). */
  readonly queueKey: string;
  /** The opaque work descriptor handed to the injected pipeline handler. */
  readonly payload: Record<string, unknown>;
  /** The **post-increment** attempt count (this claim bumped `attempts`). */
  readonly attempts: number;
}

/** A full `ordering_queue` row in domain-facing shape (reads / observability / tests). */
export interface OrderingQueueEntry {
  readonly id: string;
  readonly queueKey: string;
  readonly payload: Record<string, unknown>;
  readonly status: OrderingQueueStatus;
  readonly attempts: number;
  readonly leaseOwner: string | null;
  readonly leaseExpiresAt: Date | null;
  readonly lastError: string | null;
  readonly enqueuedAt: Date;
  readonly claimedAt: Date | null;
  readonly finishedAt: Date | null;
}

/**
 * The enqueue operation the poller (SP-5) drives, bound to one handle. A narrow
 * interface (rather than the whole {@link OrderingQueueRepository}) so producers
 * are unit-testable against the in-memory fake.
 */
export interface OrderingQueueEnqueueOps {
  /**
   * Durably append a work entry under `queueKey`, returning its id. The entry
   * lands `pending` with a DB-assigned `enqueue_seq`, so a key's later entry always
   * sorts after its earlier one (OQ-1 criterion 2). `queueKey` is **opaque** — this
   * layer never interprets it (OQ-2/OQ-3 own the keying rules).
   */
  enqueue(queueKey: string, payload: Record<string, unknown>): Promise<string>;
}

/**
 * The claim/settle operations the dispatcher's workers drive, bound to one handle.
 * A narrow interface so the dispatcher is unit-testable against an in-memory fake
 * that mirrors the exact `SKIP LOCKED` claim semantics ([[fakes-must-mirror-real-repos]]).
 */
export interface OrderingQueueWorkerOps {
  /**
   * Claim the next processable entry with `FOR UPDATE SKIP LOCKED`, flip it to
   * `processing`, take a lease, and bump `attempts`. Returns `undefined` when
   * nothing is claimable. See {@link OrderingQueueRepository.claimNext} for the
   * exact predicate (at most one active worker per key; sequential per key; a
   * crashed worker's expired-lease entry re-claimable).
   */
  claimNext(params: ClaimParams): Promise<ClaimedQueueEntry | undefined>;
  /** Mark a claimed entry `done` (the injected handler completed); releases its key. */
  markDone(id: string, finishedAt: Date): Promise<void>;
  /**
   * Park a claimed entry as `parked` (dead-letter at the retry ceiling, the OC-4
   * concept): terminal, lease cleared — so its key's next entry becomes claimable
   * and neither that key nor any other is blocked (OQ-1 criterion 5).
   */
  park(id: string, reason: string, finishedAt: Date): Promise<void>;
  /**
   * Return a claimed entry to `pending` after a failed run still under the ceiling,
   * recording `last_error` and clearing the lease, so it is re-claimed and retried.
   * `attempts` was already bumped by the claim.
   */
  recordRetry(id: string, error: string): Promise<void>;
  /**
   * Extend a still-`processing` entry's lease to `leaseExpiresAt` (a heartbeat), so
   * a long-running handler is not mistaken for a crash and re-claimed under it. A
   * no-op if the entry is no longer `processing`.
   */
  heartbeat(id: string, leaseExpiresAt: Date): Promise<void>;
}

/** The subset of the raw claim's `RETURNING` row this repo reads back. */
type ClaimResultRow = Record<string, unknown>;

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mapRow(row: typeof orderingQueue.$inferSelect): OrderingQueueEntry {
  return {
    id: row.id,
    queueKey: row.queueKey,
    payload: row.payload,
    status: row.status,
    attempts: row.attempts,
    leaseOwner: row.leaseOwner,
    leaseExpiresAt: row.leaseExpiresAt,
    lastError: row.lastError,
    enqueuedAt: row.enqueuedAt,
    claimedAt: row.claimedAt,
    finishedAt: row.finishedAt,
  };
}

/**
 * Persistence for the `ordering_queue` durable per-key queue (OQ-1). Constructor-
 * bound to a {@link DbHandle} (the pooled db or a `tx()` transaction), matching the
 * repo convention. It implements the two narrow ops interfaces the producer and the
 * dispatcher depend on, plus reads for observability/tests.
 *
 * Everything but {@link claimNext} uses the query builder; the claim is raw `sql`
 * because it needs `FOR UPDATE SKIP LOCKED` and a self-referential per-key predicate
 * the builder cannot express.
 */
export class OrderingQueueRepository implements OrderingQueueEnqueueOps, OrderingQueueWorkerOps {
  public constructor(private readonly db: DbHandle) {}

  public async enqueue(queueKey: string, payload: Record<string, unknown>): Promise<string> {
    const [row] = await this.db
      .insert(orderingQueue)
      .values({ queueKey, payload, status: "pending" })
      .returning({ id: orderingQueue.id });
    if (row === undefined) {
      throw new Error("ordering_queue enqueue returned no id");
    }
    return row.id;
  }

  /**
   * Claim the next processable entry as a **single atomic statement**: a CTE
   * selects the one claimable candidate with `FOR UPDATE SKIP LOCKED` and the outer
   * `UPDATE ... FROM` flips it — so no separate transaction is needed and the row
   * lock is held only for the statement.
   *
   * The candidate is the **lowest-`enqueue_seq` non-terminal (`pending`/`processing`)
   * entry per key** that is claimable now — i.e. `pending`, or `processing` with an
   * **expired** lease (a crashed worker, OQ-1 criterion 3). Because a live
   * `processing` entry is always its key's lowest non-terminal entry, this single
   * predicate delivers all three guarantees:
   *  - **at most one active worker per key** (criterion 1): a live-lease `processing`
   *    entry is the lowest non-terminal, so its key's later entries are excluded by
   *    the "no earlier non-terminal" check and cannot be claimed;
   *  - **sequential per key in enqueue order** (criterion 2): `ORDER BY enqueue_seq`
   *    over the per-key-lowest candidates;
   *  - **cross-key parallelism** (criterion 4): distinct keys have distinct
   *    candidates, claimed independently.
   * `SKIP LOCKED` means two workers racing the *same* candidate row give it to
   * exactly one; the loser skips it (never falling through to a later same-key
   * entry, since only the lowest per key is ever eligible) and looks at other keys.
   */
  public async claimNext(params: ClaimParams): Promise<ClaimedQueueEntry | undefined> {
    const { now, leaseExpiresAt, owner } = params;
    const result = await this.db.execute<ClaimResultRow>(sql`
      WITH claimable AS (
        SELECT c.id
        FROM ${orderingQueue} AS c
        WHERE c.status IN ('pending', 'processing')
          AND NOT EXISTS (
            SELECT 1
            FROM ${orderingQueue} AS earlier
            WHERE earlier.queue_key = c.queue_key
              AND earlier.status IN ('pending', 'processing')
              AND earlier.enqueue_seq < c.enqueue_seq
          )
          AND (c.status = 'pending' OR c.lease_expires_at <= ${now})
        ORDER BY c.enqueue_seq
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      UPDATE ${orderingQueue} AS oq
      SET status = 'processing',
          lease_owner = ${owner},
          lease_expires_at = ${leaseExpiresAt},
          claimed_at = ${now},
          attempts = oq.attempts + 1
      FROM claimable
      WHERE oq.id = claimable.id
      RETURNING oq.id AS id,
                oq.queue_key AS queue_key,
                oq.payload AS payload,
                oq.attempts AS attempts
    `);
    const row = result.rows[0];
    if (row === undefined) {
      return undefined;
    }
    const { id, queue_key: queueKey, payload, attempts } = row;
    if (typeof id !== "string" || typeof queueKey !== "string" || typeof attempts !== "number") {
      throw new Error("ordering_queue claim returned an unexpected row shape");
    }
    if (!isJsonObject(payload)) {
      throw new Error("ordering_queue claim returned a non-object payload");
    }
    return { id, queueKey, payload, attempts };
  }

  public async markDone(id: string, finishedAt: Date): Promise<void> {
    await this.db
      .update(orderingQueue)
      .set({ status: "done", finishedAt, leaseOwner: null, leaseExpiresAt: null })
      .where(eq(orderingQueue.id, id));
  }

  public async park(id: string, reason: string, finishedAt: Date): Promise<void> {
    await this.db
      .update(orderingQueue)
      .set({
        status: "parked",
        lastError: reason,
        finishedAt,
        leaseOwner: null,
        leaseExpiresAt: null,
      })
      .where(eq(orderingQueue.id, id));
  }

  public async recordRetry(id: string, error: string): Promise<void> {
    await this.db
      .update(orderingQueue)
      .set({ status: "pending", lastError: error, leaseOwner: null, leaseExpiresAt: null })
      .where(eq(orderingQueue.id, id));
  }

  public async heartbeat(id: string, leaseExpiresAt: Date): Promise<void> {
    await this.db
      .update(orderingQueue)
      .set({ leaseExpiresAt })
      .where(and(eq(orderingQueue.id, id), eq(orderingQueue.status, "processing")));
  }

  /** One entry by id (observability / tests). */
  public async getById(id: string): Promise<OrderingQueueEntry | undefined> {
    const [row] = await this.db
      .select()
      .from(orderingQueue)
      .where(eq(orderingQueue.id, id))
      .limit(1);
    return row === undefined ? undefined : mapRow(row);
  }

  /** Every entry in a given state, in enqueue order (observability / tests). */
  public async listByStatus(status: OrderingQueueStatus): Promise<OrderingQueueEntry[]> {
    const rows = await this.db
      .select()
      .from(orderingQueue)
      .where(eq(orderingQueue.status, status))
      .orderBy(orderingQueue.enqueueSeq);
    return rows.map(mapRow);
  }
}
