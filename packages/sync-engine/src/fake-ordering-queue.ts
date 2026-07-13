import type {
  ClaimedQueueEntry,
  ClaimParams,
  OrderingQueueDrainQuery,
  OrderingQueueEnqueueOps,
  OrderingQueueEntry,
  OrderingQueueStatus,
  OrderingQueueWorkerOps,
} from "@mediator/db";

/** One in-memory queue entry — the fake's analogue of an `ordering_queue` row. */
interface FakeEntry {
  id: string;
  queueKey: string;
  /** The fake's `enqueue_seq`: a monotone counter, assigned at enqueue. */
  seq: number;
  payload: Record<string, unknown>;
  status: OrderingQueueStatus;
  attempts: number;
  leaseOwner: string | null;
  leaseExpiresAt: Date | null;
  lastError: string | null;
  availableAt: Date | null;
  enqueuedAt: Date;
  claimedAt: Date | null;
  finishedAt: Date | null;
}

/**
 * An in-memory {@link OrderingQueueEnqueueOps} + {@link OrderingQueueWorkerOps} that
 * **faithfully mirrors** the real `OrderingQueueRepository`'s `FOR UPDATE SKIP LOCKED`
 * claim semantics ([[fakes-must-mirror-real-repos]]) — so the dispatcher's per-key
 * serialization, park-moves-on, cross-key parallelism, and handler-seam contract can
 * be unit-tested without a database and still exercise the exact claim rules the SQL
 * enforces:
 *
 *  - **`enqueue`** assigns a monotone `seq` (the `bigserial enqueue_seq`), so a key's
 *    later entry always sorts after its earlier one.
 *  - **`claimNext`** picks the **lowest-`seq` non-terminal (`pending`/`processing`)
 *    entry per key** that is claimable now — `pending`, or `processing` with an
 *    **expired** lease (a crashed worker). Because a live-lease `processing` entry is
 *    always its key's lowest non-terminal entry, this one rule yields "at most one
 *    active worker per key", "sequential per key in enqueue order", and "distinct
 *    keys claimed independently" — identical to the SQL predicate in
 *    `OrderingQueueRepository.claimNext`.
 *  - it claims **atomically**: the method mutates synchronously with no intervening
 *    `await`, so two concurrent `claimNext()` calls (`Promise.all`) resolve one fully
 *    before the other — the JS analogue of the row lock + `SKIP LOCKED` that stops two
 *    workers taking the same key.
 *
 * This is an in-memory implementation, not "test-only glue": it is the reference the
 * downstream OQ-2/OQ-3/OQ-4 and pipeline slices reuse to unit-test against the queue.
 */
export class FakeOrderingQueue
  implements OrderingQueueEnqueueOps, OrderingQueueWorkerOps, OrderingQueueDrainQuery
{
  readonly #entries: FakeEntry[] = [];
  #seq = 0;
  #ids = 0;

  /**
   * The OQ-4 handoff read (`OrderingQueueDrainQuery`): is any of `queueKeys` still
   * non-terminal? Mirrors the real repo's existence query over the **exact same**
   * `pending`/`processing` predicate the claim uses, so a link-keyed entry's gate and
   * the claim agree on "drained".
   */
  public hasUndrainedEntries(queueKeys: readonly string[]): Promise<boolean> {
    const keys = new Set(queueKeys);
    const undrained = this.#entries.some(
      (entry) =>
        keys.has(entry.queueKey) && (entry.status === "pending" || entry.status === "processing"),
    );
    return Promise.resolve(undrained);
  }

  public enqueue(queueKey: string, payload: Record<string, unknown>): Promise<string> {
    this.#seq += 1;
    this.#ids += 1;
    const id = `fake-${String(this.#ids)}`;
    this.#entries.push({
      id,
      queueKey,
      seq: this.#seq,
      payload,
      status: "pending",
      attempts: 0,
      leaseOwner: null,
      leaseExpiresAt: null,
      lastError: null,
      availableAt: null,
      enqueuedAt: new Date(0),
      claimedAt: null,
      finishedAt: null,
    });
    return Promise.resolve(id);
  }

  public claimNext(params: ClaimParams): Promise<ClaimedQueueEntry | undefined> {
    const { now, leaseExpiresAt, owner } = params;
    // Mirror the SQL exactly. Mutation happens with NO await before it, so
    // concurrent calls never interleave (the atomic-claim analogue).
    let chosen: FakeEntry | undefined;
    for (const c of this.#entries) {
      if (c.status !== "pending" && c.status !== "processing") {
        continue;
      }
      // `c` must be its key's lowest-seq non-terminal entry.
      const hasEarlierNonTerminal = this.#entries.some(
        (earlier) =>
          earlier.queueKey === c.queueKey &&
          (earlier.status === "pending" || earlier.status === "processing") &&
          earlier.seq < c.seq,
      );
      if (hasEarlierNonTerminal) {
        continue;
      }
      // Deferred by a retry-delay / load-discipline `defer` (OC-4 / OC-3): not
      // claimable until its `available_at` not-before is due — mirrors the SQL
      // `(available_at IS NULL OR available_at <= now)` gate.
      if (c.availableAt !== null && c.availableAt.getTime() > now.getTime()) {
        continue;
      }
      // Claimable now: fresh, or a crashed worker's expired lease.
      const claimable =
        c.status === "pending" ||
        (c.leaseExpiresAt !== null && c.leaseExpiresAt.getTime() <= now.getTime());
      if (!claimable) {
        continue;
      }
      if (chosen === undefined || c.seq < chosen.seq) {
        chosen = c;
      }
    }
    if (chosen === undefined) {
      return Promise.resolve(undefined);
    }
    chosen.status = "processing";
    chosen.leaseOwner = owner;
    chosen.leaseExpiresAt = leaseExpiresAt;
    chosen.claimedAt = now;
    chosen.availableAt = null;
    chosen.attempts += 1;
    return Promise.resolve({
      id: chosen.id,
      queueKey: chosen.queueKey,
      payload: chosen.payload,
      attempts: chosen.attempts,
    });
  }

  /**
   * The lease-owner fence (OQ-1 carried-over review fix) — mirrors the real repo's
   * `WHERE id = $id AND lease_owner = $owner AND status = 'processing'`: a settle
   * only applies while the entry is `processing` under this owner's lease, so a
   * slow re-claimed worker's late settle is a safe no-op.
   */
  #owned(id: string, owner: string): FakeEntry | undefined {
    const entry = this.#find(id);
    if (entry !== undefined && entry.status === "processing" && entry.leaseOwner === owner) {
      return entry;
    }
    return undefined;
  }

  public markDone(id: string, owner: string, finishedAt: Date): Promise<boolean> {
    const entry = this.#owned(id, owner);
    if (entry === undefined) {
      return Promise.resolve(false);
    }
    entry.status = "done";
    entry.finishedAt = finishedAt;
    entry.leaseOwner = null;
    entry.leaseExpiresAt = null;
    return Promise.resolve(true);
  }

  public park(id: string, reason: string, owner: string, finishedAt: Date): Promise<boolean> {
    const entry = this.#owned(id, owner);
    if (entry === undefined) {
      return Promise.resolve(false);
    }
    entry.status = "parked";
    entry.lastError = reason;
    entry.finishedAt = finishedAt;
    entry.leaseOwner = null;
    entry.leaseExpiresAt = null;
    return Promise.resolve(true);
  }

  public recordRetry(
    id: string,
    error: string,
    owner: string,
    availableAt: Date,
  ): Promise<boolean> {
    const entry = this.#owned(id, owner);
    if (entry === undefined) {
      return Promise.resolve(false);
    }
    entry.status = "pending";
    entry.lastError = error;
    entry.availableAt = availableAt;
    entry.leaseOwner = null;
    entry.leaseExpiresAt = null;
    return Promise.resolve(true);
  }

  public defer(id: string, owner: string, availableAt: Date): Promise<boolean> {
    const entry = this.#owned(id, owner);
    if (entry === undefined) {
      return Promise.resolve(false);
    }
    entry.status = "pending";
    entry.availableAt = availableAt;
    // Attempt-neutral: undo the claim's bump so a rate-limited app never parks.
    entry.attempts -= 1;
    entry.leaseOwner = null;
    entry.leaseExpiresAt = null;
    return Promise.resolve(true);
  }

  public heartbeat(id: string, owner: string, leaseExpiresAt: Date): Promise<void> {
    const entry = this.#owned(id, owner);
    if (entry !== undefined) {
      entry.leaseExpiresAt = leaseExpiresAt;
    }
    return Promise.resolve();
  }

  /** One entry by id (test assertions). */
  public getById(id: string): OrderingQueueEntry | undefined {
    const entry = this.#find(id);
    return entry === undefined ? undefined : toEntry(entry);
  }

  /** Every entry in a given state, in enqueue order (test assertions). */
  public listByStatus(status: OrderingQueueStatus): OrderingQueueEntry[] {
    return this.#entries
      .filter((entry) => entry.status === status)
      .sort((a, b) => a.seq - b.seq)
      .map(toEntry);
  }

  #find(id: string): FakeEntry | undefined {
    return this.#entries.find((entry) => entry.id === id);
  }
}

function toEntry(entry: FakeEntry): OrderingQueueEntry {
  return {
    id: entry.id,
    queueKey: entry.queueKey,
    payload: entry.payload,
    status: entry.status,
    attempts: entry.attempts,
    leaseOwner: entry.leaseOwner,
    leaseExpiresAt: entry.leaseExpiresAt,
    lastError: entry.lastError,
    availableAt: entry.availableAt,
    enqueuedAt: entry.enqueuedAt,
    claimedAt: entry.claimedAt,
    finishedAt: entry.finishedAt,
  };
}
