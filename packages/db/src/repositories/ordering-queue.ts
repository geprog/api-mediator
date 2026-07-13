import { and, eq, inArray, sql } from "drizzle-orm";

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
  /**
   * The **not-before** retry-delay gate (OC-4 backoff / OC-3 `defer`): `null` for
   * an immediately-claimable entry, or a timestamp the entry is deferred until —
   * a claim skips it while `available_at > now`. Cleared on claim.
   */
  readonly availableAt: Date | null;
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
   * `processing`, take a lease, bump `attempts`, and clear any `available_at`
   * retry-delay gate. Returns `undefined` when nothing is claimable. See
   * {@link OrderingQueueRepository.claimNext} for the exact predicate (at most one
   * active worker per key; sequential per key; a crashed worker's expired-lease
   * entry re-claimable; a `available_at`-deferred entry skipped until due).
   */
  claimNext(params: ClaimParams): Promise<ClaimedQueueEntry | undefined>;
  /**
   * Mark a claimed entry `done` (the injected handler completed); releases its key.
   *
   * **Lease-owner fenced** (OQ-1 carried-over review fix): the write only applies to
   * an entry still `processing` **under this `owner`'s lease**, so a slow worker
   * whose lease expired and was re-claimed by another worker cannot settle the
   * entry the new worker now owns. Returns `true` when this owner settled it,
   * `false` when the fence rejected the (stale) settle.
   */
  markDone(id: string, owner: string, finishedAt: Date): Promise<boolean>;
  /**
   * Park a claimed entry as `parked` (dead-letter at the retry ceiling, the OC-4
   * concept): terminal, lease cleared — so its key's next entry becomes claimable
   * and neither that key nor any other is blocked (OQ-1 criterion 5). Lease-owner
   * fenced exactly like {@link markDone}.
   */
  park(id: string, reason: string, owner: string, finishedAt: Date): Promise<boolean>;
  /**
   * Return a claimed entry to `pending` after a failed run still under the ceiling,
   * recording `last_error` and clearing the lease, so it is re-claimed and retried.
   * `attempts` was already bumped by the claim. `availableAt` is the **not-before**
   * gate implementing OC-4's exponential backoff **inside** the per-record queue —
   * the entry is not re-claimable until then, so its record's queue waits out the
   * backoff without holding a worker. Lease-owner fenced like {@link markDone}.
   */
  recordRetry(id: string, error: string, owner: string, availableAt: Date): Promise<boolean>;
  /**
   * Return a claimed entry to `pending` **deferred** until `availableAt`, WITHOUT
   * counting the deferral as a failed attempt (it decrements the `attempts` the
   * claim bumped, netting zero) and without recording an error. This is the
   * load-discipline wait (OC-3 criterion 5): a call blocked by a per-app
   * concurrency/rate ceiling or a `Retry-After` re-queues here rather than blocking
   * its worker, so a slow app degrades only its own throughput — and a well-behaved
   * but rate-limited app is never dead-lettered by the retry ceiling. Lease-owner
   * fenced like {@link markDone}.
   */
  defer(id: string, owner: string, availableAt: Date): Promise<boolean>;
  /**
   * Extend a still-`processing` entry's lease to `leaseExpiresAt` (a heartbeat), so
   * a long-running handler is not mistaken for a crash and re-claimed under it.
   * Lease-owner fenced: a no-op unless the entry is `processing` under this `owner`.
   */
  heartbeat(id: string, owner: string, leaseExpiresAt: Date): Promise<void>;
}

/**
 * The read the OQ-4 continuation handoff depends on: "has a given queue drained?".
 * A link-keyed entry may begin only once its establishing pre-link queue(s) hold no
 * more work (`docs/architecture/sync-engine.md` *Ordering and consistency*;
 * `docs/requirements/phase-4-ordering-queue.md` OQ-4). Kept a **narrow read port**,
 * separate from the enqueue/worker ops, so the `HandoffGate` (in
 * `@mediator/sync-engine`) is unit-testable against the in-memory fake and never
 * needs the whole repository.
 */
export interface OrderingQueueDrainQuery {
  /**
   * Whether **any** of `queueKeys` still has a **non-terminal** (`pending` or
   * `processing`) entry — i.e. at least one of those queues has **not drained**.
   * `false` for an empty `queueKeys`. Uses the exact same non-terminal predicate as
   * {@link OrderingQueueWorkerOps.claimNext}, so "drained" here means precisely "no
   * entry OQ-1 could still claim under that key".
   */
  hasUndrainedEntries(queueKeys: readonly string[]): Promise<boolean>;
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
    availableAt: row.availableAt,
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
export class OrderingQueueRepository
  implements OrderingQueueEnqueueOps, OrderingQueueWorkerOps, OrderingQueueDrainQuery
{
  public constructor(private readonly db: DbHandle) {}

  /**
   * OQ-4 handoff read: is any of `queueKeys` still non-terminal? A single existence
   * query over the same `status IN ('pending','processing')` predicate the claim
   * uses, so the continuation gate and the claim agree on what "drained" means.
   */
  public async hasUndrainedEntries(queueKeys: readonly string[]): Promise<boolean> {
    if (queueKeys.length === 0) {
      return false;
    }
    const [row] = await this.db
      .select({ id: orderingQueue.id })
      .from(orderingQueue)
      .where(
        and(
          inArray(orderingQueue.queueKey, [...queueKeys]),
          inArray(orderingQueue.status, ["pending", "processing"]),
        ),
      )
      .limit(1);
    return row !== undefined;
  }

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
          AND (c.available_at IS NULL OR c.available_at <= ${now})
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
          available_at = NULL,
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

  /**
   * The lease-owner fence shared by every settle op (OQ-1 carried-over review fix):
   * an entry is only mutated while it is still `processing` **under this owner's
   * lease**. A worker whose lease expired mid-run (and whose entry was re-claimed by
   * another worker) matches zero rows and its late settle is a safe no-op.
   */
  #ownedAndProcessing(id: string, owner: string) {
    return and(
      eq(orderingQueue.id, id),
      eq(orderingQueue.leaseOwner, owner),
      eq(orderingQueue.status, "processing"),
    );
  }

  public async markDone(id: string, owner: string, finishedAt: Date): Promise<boolean> {
    const settled = await this.db
      .update(orderingQueue)
      .set({ status: "done", finishedAt, leaseOwner: null, leaseExpiresAt: null })
      .where(this.#ownedAndProcessing(id, owner))
      .returning({ id: orderingQueue.id });
    return settled.length > 0;
  }

  public async park(id: string, reason: string, owner: string, finishedAt: Date): Promise<boolean> {
    const settled = await this.db
      .update(orderingQueue)
      .set({
        status: "parked",
        lastError: reason,
        finishedAt,
        leaseOwner: null,
        leaseExpiresAt: null,
      })
      .where(this.#ownedAndProcessing(id, owner))
      .returning({ id: orderingQueue.id });
    return settled.length > 0;
  }

  public async recordRetry(
    id: string,
    error: string,
    owner: string,
    availableAt: Date,
  ): Promise<boolean> {
    const settled = await this.db
      .update(orderingQueue)
      .set({
        status: "pending",
        lastError: error,
        availableAt,
        leaseOwner: null,
        leaseExpiresAt: null,
      })
      .where(this.#ownedAndProcessing(id, owner))
      .returning({ id: orderingQueue.id });
    return settled.length > 0;
  }

  public async defer(id: string, owner: string, availableAt: Date): Promise<boolean> {
    const settled = await this.db
      .update(orderingQueue)
      .set({
        status: "pending",
        availableAt,
        // A load-discipline deferral is not a failed attempt: undo the bump the
        // claim applied so a rate-limited app is never dead-lettered by the ceiling.
        attempts: sql`${orderingQueue.attempts} - 1`,
        leaseOwner: null,
        leaseExpiresAt: null,
      })
      .where(this.#ownedAndProcessing(id, owner))
      .returning({ id: orderingQueue.id });
    return settled.length > 0;
  }

  public async heartbeat(id: string, owner: string, leaseExpiresAt: Date): Promise<void> {
    await this.db
      .update(orderingQueue)
      .set({ leaseExpiresAt })
      .where(this.#ownedAndProcessing(id, owner));
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
