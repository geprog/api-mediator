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
 * The record/rule context a parked (dead-letter) write carries, projected from its
 * serialized `DetectedChange` `payload` — **ids/refs only**. This projection is the
 * data-boundary firewall (SA-5 / `docs/architecture/security.md`): it reads **only**
 * the known scalar id/ref keys and **never** the payload's `observedRecord` (live
 * field values) or any other nested object, so a parked write's data can never leak
 * through the dead-letter read surface. A key absent or non-string in the payload
 * projects to `null` rather than being invented.
 */
export interface ParkedWriteContext {
  readonly ruleId: string | null;
  readonly mappingId: string | null;
  readonly sourceAppId: string | null;
  readonly targetAppId: string | null;
  readonly resourcePairRef: string | null;
  readonly sourceNativeId: string | null;
  readonly changeKind: string | null;
}

/**
 * One parked (dead-letter) write for the SA-5 dead-letter queue — a **safe projection**
 * of an `ordering_queue` row whose `status = 'parked'` (OC-4 retry ceiling). It carries
 * the addressable identity + decision context (ids/refs, `last_error`, attempts,
 * timestamps) and the {@link superseded} flag, and it deliberately **omits the raw
 * `payload`** so a live field value never reaches a response ({@link ParkedWriteContext}).
 *
 * The opaque `queue_key` is **deliberately not exposed**: for a parked *create* it is the
 * record's identity-key **value** (email/SKU — a synced field value), so surfacing it on
 * the viewer-readable dead-letter read would breach the data boundary. The entry `id`
 * addresses the write for replay; `context.ruleId`/`sourceNativeId`/`resourcePairRef`
 * identify the record without any value.
 */
export interface ParkedWriteEntry {
  readonly id: string;
  /** The record/rule context projected from the payload — ids/refs only, never a value. */
  readonly context: ParkedWriteContext;
  readonly lastError: string | null;
  readonly attempts: number;
  /**
   * **Superseded** (SA-5.3): a later same-key change already reached `done`, so this
   * parked write has been overtaken by a later successful sync and replay would be a
   * no-op. The queue's `enqueue_seq` order is the authoritative signal (the queue is
   * the ordering authority — `docs/architecture/sync-engine.md` *Write failures* /
   * *Ordering and consistency*): true iff a `done` entry with the same `queue_key`
   * and a **higher** `enqueue_seq` exists.
   */
  readonly superseded: boolean;
  /** When the entry was dead-lettered (`finished_at` at park time). */
  readonly parkedAt: Date | null;
  readonly enqueuedAt: Date;
}

/**
 * The result of {@link OrderingQueueRepository.reactivate} — a discriminated union so
 * the caller can distinguish the single-active-per-key guard (`blocked-key-busy`) from
 * the terminal-state cases. **`reactivated`** flips a `parked` entry back to `pending`
 * so the running dispatcher re-claims it and re-runs the full pipeline (SA-5.2 — a
 * re-run against current state, never a blind re-issue).
 */
export type ReactivateParkedResult =
  | { readonly kind: "reactivated"; readonly entry: OrderingQueueEntry }
  /**
   * A later same-key change already reached `done` (higher `enqueue_seq`), so this write
   * has been superseded (SA-5.3) — reactivating it would re-run a stale change. Decided
   * **atomically** inside the reactivating `UPDATE`, so a change that commits `done`
   * mid-replay is caught rather than re-run.
   */
  | { readonly kind: "superseded" }
  /** Another non-terminal (`pending`/`processing`) entry shares the `queue_key`; reactivating would break single-active-per-key (OQ). */
  | { readonly kind: "blocked-key-busy" }
  /** The entry exists but is not `parked` (already `done`/`pending`/`processing`) — nothing to replay. */
  | { readonly kind: "not-parked" }
  /** No entry with that id exists. */
  | { readonly kind: "not-found" };

/**
 * The SA-5 dead-letter operations the operator API drives over the `ordering_queue`:
 * read the parked writes ({@link listParked}) and reactivate one back to `pending`
 * under the atomic single-active-per-key + not-superseded guards ({@link reactivate}).
 * A narrow interface (separate from the enqueue/worker/drain ops) so it is
 * unit-testable against the in-memory fake ([[fakes-must-mirror-real-repos]]).
 */
export interface OrderingQueueDeadLetterOps {
  /**
   * The dead-letter queue (SA-5.1): the `parked` entries as **safe projections**
   * ({@link ParkedWriteEntry} — ids/refs/error/attempts/timestamps + `superseded`,
   * **no raw payload, no queue key**), newest-parked first, bounded by `limit`.
   */
  listParked(limit: number): Promise<ParkedWriteEntry[]>;
  /**
   * Reactivate a `parked` entry to `pending` (SA-5.2): clear its lease and set
   * `available_at = now` so the dispatcher re-claims it and re-runs the full pipeline.
   * Two guards are enforced **atomically inside the one `UPDATE`**, so no interleaving
   * change can defeat them (see {@link ReactivateParkedResult}):
   *  - **single-active-per-key (OQ):** no other non-terminal (`pending`/`processing`)
   *    entry may share the `queue_key` — else two active entries on one key would break
   *    per-key ordering (`blocked-key-busy`);
   *  - **not-superseded (SA-5.3):** no same-key `done` entry with a higher `enqueue_seq`
   *    may exist — else a later change already handled the record and re-running this
   *    stale write would forge divergence (`superseded`).
   */
  reactivate(id: string, now: Date): Promise<ReactivateParkedResult>;
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

/** The raw `listParked` `execute` row (validated + narrowed by {@link mapParkedRow}). */
type ParkedRow = Record<string, unknown>;

/**
 * Map a raw parked-write row to its {@link ParkedWriteEntry} safe projection. The
 * `queue_key` is intentionally NOT selected/mapped — it can be a live identity-key value
 * for a parked create (data boundary); only the payload's id/ref keys are projected.
 */
function mapParkedRow(row: ParkedRow): ParkedWriteEntry {
  const payload = isJsonObject(row.payload) ? row.payload : {};
  return {
    id: requireString(row.id, "id"),
    context: projectParkedContext(payload),
    lastError: nullableString(row.last_error),
    attempts: requireNumber(row.attempts, "attempts"),
    superseded: row.superseded === true,
    parkedAt: toDate(row.finished_at),
    enqueuedAt: requireDate(row.enqueued_at, "enqueued_at"),
  };
}

/**
 * Project a parked entry's serialized `DetectedChange` payload to **ids/refs only** — a
 * strict whitelist of known scalar keys. `observedRecord` (live field values) and any
 * other nested value are simply never read, so the dead-letter surface can never leak a
 * record's data (SA-5 data boundary / `docs/architecture/security.md`).
 */
function projectParkedContext(payload: Record<string, unknown>): ParkedWriteContext {
  return {
    ruleId: stringFieldOrNull(payload.ruleId),
    mappingId: stringFieldOrNull(payload.mappingId),
    sourceAppId: stringFieldOrNull(payload.sourceAppId),
    targetAppId: stringFieldOrNull(payload.targetAppId),
    resourcePairRef: stringFieldOrNull(payload.resourcePairRef),
    sourceNativeId: stringFieldOrNull(payload.sourceNativeId),
    changeKind: stringFieldOrNull(payload.changeKind),
  };
}

function stringFieldOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function requireString(value: unknown, column: string): string {
  if (typeof value !== "string") {
    throw new Error(`ordering_queue parked row has a non-string ${column}`);
  }
  return value;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function requireNumber(value: unknown, column: string): number {
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "" && !Number.isNaN(Number(value))) {
    return Number(value);
  }
  throw new Error(`ordering_queue parked row has a non-numeric ${column}`);
}

function requireDate(value: unknown, column: string): Date {
  const date = toDate(value);
  if (date === null) {
    throw new Error(`ordering_queue parked row has an invalid ${column}`);
  }
  return date;
}

function toDate(value: unknown): Date | null {
  if (value instanceof Date) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
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
  implements
    OrderingQueueEnqueueOps,
    OrderingQueueWorkerOps,
    OrderingQueueDrainQuery,
    OrderingQueueDeadLetterOps
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

  // ── SA-5 dead-letter operations ──────────────────────────────────────────────

  /**
   * The dead-letter queue (SA-5.1): the `parked` entries as **safe projections**,
   * newest-parked first, bounded by `limit`. The `superseded` flag is computed in the
   * same statement via an `EXISTS` over same-key `done` entries with a higher
   * `enqueue_seq` (the queue is the ordering authority — SA-5.3). The raw `payload` is
   * projected to ids/refs only ({@link projectParkedContext}) so no live field value is
   * ever returned (data boundary).
   */
  public async listParked(limit: number): Promise<ParkedWriteEntry[]> {
    const rows = await this.db.execute<ParkedRow>(sql`
      SELECT p.id AS id,
             p.payload AS payload,
             p.last_error AS last_error,
             p.attempts AS attempts,
             p.enqueued_at AS enqueued_at,
             p.finished_at AS finished_at,
             EXISTS (
               SELECT 1
               FROM ${orderingQueue} AS later
               WHERE later.queue_key = p.queue_key
                 AND later.status = 'done'
                 AND later.enqueue_seq > p.enqueue_seq
             ) AS superseded
      FROM ${orderingQueue} AS p
      WHERE p.status = 'parked'
      ORDER BY p.finished_at DESC NULLS LAST, p.enqueue_seq DESC
      LIMIT ${limit}
    `);
    return rows.rows.map(mapParkedRow);
  }

  /**
   * Reactivate a `parked` entry to `pending` (SA-5.2) — atomically **guarded** by two
   * `NOT EXISTS` sub-selects *inside the one `UPDATE`*, so no interleaving change can
   * defeat either. The write applies only when the row is still `parked` **and** (a) no
   * other non-terminal (`pending`/`processing`) entry shares its `queue_key` — else two
   * active entries on one key would break per-key ordering — **and** (b) no same-key
   * `done` entry with a higher `enqueue_seq` exists — else a later change already handled
   * the record (SA-5.3) and re-running this stale write would forge divergence. On
   * success the entry is claimable immediately (`available_at = now`, lease cleared) and
   * the running dispatcher re-runs the full pipeline against current state.
   *
   * A zero-row `UPDATE` is classified by a follow-up read (advisory only — the atomic
   * guards already protected the invariants): absent → `not-found`; not `parked` →
   * `not-parked`; still `parked` and superseded → `superseded`; otherwise →
   * `blocked-key-busy`. `superseded` is checked first so an entry both overtaken and
   * key-busy reports the no-op outcome (replay is pointless either way).
   */
  public async reactivate(id: string, now: Date): Promise<ReactivateParkedResult> {
    const updated = await this.db.execute<{ id: string }>(sql`
      UPDATE ${orderingQueue} AS oq
      SET status = 'pending',
          available_at = ${now},
          lease_owner = NULL,
          lease_expires_at = NULL
      WHERE oq.id = ${id}
        AND oq.status = 'parked'
        AND NOT EXISTS (
          SELECT 1
          FROM ${orderingQueue} AS other
          WHERE other.queue_key = oq.queue_key
            AND other.status IN ('pending', 'processing')
        )
        AND NOT EXISTS (
          SELECT 1
          FROM ${orderingQueue} AS later
          WHERE later.queue_key = oq.queue_key
            AND later.status = 'done'
            AND later.enqueue_seq > oq.enqueue_seq
        )
      RETURNING oq.id AS id
    `);
    if (updated.rows[0] !== undefined) {
      const entry = await this.getById(id);
      if (entry === undefined) {
        // Unreachable — the row was just updated in this statement.
        throw new Error(`ordering_queue reactivate lost row ${id} after a successful update`);
      }
      return { kind: "reactivated", entry };
    }
    const current = await this.getById(id);
    if (current === undefined) {
      return { kind: "not-found" };
    }
    if (current.status !== "parked") {
      return { kind: "not-parked" };
    }
    if (await this.#isSupersededParked(id)) {
      return { kind: "superseded" };
    }
    return { kind: "blocked-key-busy" };
  }

  /**
   * Whether `id` is a `parked` write superseded by a later same-key `done` entry — the
   * same authoritative queue signal {@link listParked} exposes and {@link reactivate}
   * guards on. Used only to classify a blocked reactivation (advisory).
   */
  async #isSupersededParked(id: string): Promise<boolean> {
    const result = await this.db.execute<{ superseded: boolean }>(sql`
      SELECT EXISTS (
        SELECT 1
        FROM ${orderingQueue} AS later
        WHERE later.queue_key = p.queue_key
          AND later.status = 'done'
          AND later.enqueue_seq > p.enqueue_seq
      ) AS superseded
      FROM ${orderingQueue} AS p
      WHERE p.id = ${id} AND p.status = 'parked'
      LIMIT 1
    `);
    return result.rows[0]?.superseded === true;
  }
}
