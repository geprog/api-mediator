import type { RecordLink } from "@mediator/domain";
import type {
  ClaimedQueueEntry,
  ClaimParams,
  OrderingQueueDrainQuery,
  OrderingQueueWorkerOps,
} from "@mediator/db";

/**
 * **OQ-4 — the continuation handoff.** A change enqueued under a `RecordLink` id must
 * begin processing only once the **establishing pre-link queue** (the queue that
 * created the link) has **drained** — the link-keyed queue opens strictly as a
 * *continuation* of that queue, **never beside it**, so a record is on exactly **one**
 * queue at every moment of the handoff (`docs/architecture/sync-engine.md` *Ordering
 * and consistency*; `docs/requirements/phase-4-ordering-queue.md` OQ-4).
 *
 * The window this closes: one direction is still queued under the pre-link identity
 * value (or native id) while another — seeing the link that the establishing execution
 * just created — enqueues under the **link id**. Without the gate the two queues would
 * run *beside* each other and the same record would be actively processed twice at once.
 *
 * **How it composes with OQ-1 without touching the claim.** This is a thin decorator
 * over the merged OQ-1 `OrderingQueueWorkerOps`: it delegates every settle op straight
 * through and only *wraps* {@link claimNext}. After OQ-1's claim hands back a candidate,
 * the gate asks whether that candidate is **link-keyed** (its `queue_key` is a
 * `RecordLink` id — resolved by a `getById`, since OQ-2 keys linked changes by link id)
 * and, if so, whether the link's establishing queue(s) have drained
 * ({@link OrderingQueueDrainQuery.hasUndrainedEntries}, the same non-terminal predicate
 * the claim uses). A gated candidate is returned to the queue via the **attempt-neutral**
 * `defer` (a handoff wait is not a failed attempt, so a waiting entry can never park),
 * and the gate scans on for another key's work — so a gated link entry never blocks
 * *other* keys, and OQ-1's at-most-one-active-worker-per-key + `available_at` discipline
 * is preserved exactly (a claimed-then-deferred entry stays the lowest non-terminal of
 * its own key, so nothing behind it on that key is claimable meanwhile).
 *
 * Crucially, the handler **never runs** for a gated entry: the gate defers it *before*
 * returning to the dispatcher, so "actively processed" (handler running) is confined to
 * ungated entries — the one-record-one-queue invariant (OQ-4.3).
 *
 * The establishing key(s) come from the link's retained `establishingQueueKey` (RL / SD-2):
 *  - `identity-value` → the single pre-link identity-value key (which the stage also uses
 *    to retain the native-id fallback for a create-propagation/identity-match link with
 *    no identity value — the stored string is the pre-link key either way);
 *  - `both-native-id-queues` → a **manual** link established absent a confirmed identity
 *    key: there is no single establishing queue, so the link-keyed queue opens only after
 *    **both** sides' native-id queues drain (OQ-4.4) — those keys are the link's two
 *    native ids.
 */
export interface EstablishingQueueKeyLookup {
  /** One link by id — used to classify a link-keyed entry and read its establishing key. */
  getById(id: string): Promise<RecordLink | undefined>;
}

export interface HandoffGateOptions {
  /**
   * How far in the future a gated (still-waiting) link entry is deferred before it is
   * re-examined, in milliseconds (default 250). MUST be > 0 — a non-positive delay
   * would leave the entry claimable at the same `now` and spin. The wait is served as
   * `available_at` (attempt-neutral), so a long handoff never dead-letters the entry.
   */
  readonly recheckDelayMs?: number;
  /**
   * Safety bound on how many candidates one {@link HandoffGate.claimNext} scans past
   * before yielding `undefined` (idle) — reached only if an unusual number of distinct
   * gated keys are claimable at once (default 1024). The deferred entries are retried
   * on the next tick regardless.
   */
  readonly maxScanPerClaim?: number;
}

const DEFAULT_RECHECK_DELAY_MS = 250;
const DEFAULT_MAX_SCAN_PER_CLAIM = 1024;

/**
 * The OQ-4 continuation gate. Wraps an OQ-1 {@link OrderingQueueWorkerOps} (the real
 * `OrderingQueueRepository` or the faithful `FakeOrderingQueue`) plus its
 * {@link OrderingQueueDrainQuery} read and a {@link EstablishingQueueKeyLookup}. Pass an
 * instance to {@link OrderingQueueDispatcher} in place of the raw queue and the handoff
 * is enforced transparently — the dispatcher, handler, and settle path are unchanged.
 */
export class HandoffGate implements OrderingQueueWorkerOps {
  readonly #inner: OrderingQueueWorkerOps;
  readonly #drainQuery: OrderingQueueDrainQuery;
  readonly #links: EstablishingQueueKeyLookup;
  readonly #recheckDelayMs: number;
  readonly #maxScanPerClaim: number;

  public constructor(
    inner: OrderingQueueWorkerOps,
    drainQuery: OrderingQueueDrainQuery,
    links: EstablishingQueueKeyLookup,
    options: HandoffGateOptions = {},
  ) {
    this.#inner = inner;
    this.#drainQuery = drainQuery;
    this.#links = links;
    this.#recheckDelayMs = Math.max(1, options.recheckDelayMs ?? DEFAULT_RECHECK_DELAY_MS);
    this.#maxScanPerClaim = options.maxScanPerClaim ?? DEFAULT_MAX_SCAN_PER_CLAIM;
  }

  /**
   * Claim the next entry OQ-1 would, then enforce the OQ-4 gate: if the candidate is
   * link-keyed and its establishing queue has **not** drained, defer it (attempt-neutral)
   * and scan on to another key's work; otherwise hand it back to the dispatcher. Returns
   * `undefined` when nothing ungated is claimable (the dispatcher then idle-waits, and
   * the deferred link entries retry once their `recheckDelayMs` elapses).
   */
  public async claimNext(params: ClaimParams): Promise<ClaimedQueueEntry | undefined> {
    for (let scanned = 0; scanned < this.#maxScanPerClaim; scanned += 1) {
      const entry = await this.#inner.claimNext(params);
      if (entry === undefined) {
        return undefined;
      }
      if (!(await this.#isGated(entry))) {
        return entry;
      }
      // Gated: the establishing queue has not drained. Return the entry to `pending`
      // with an attempt-neutral not-before, then scan on — this key waits, others proceed.
      const availableAt = new Date(params.now.getTime() + this.#recheckDelayMs);
      const deferred = await this.#inner.defer(entry.id, params.owner, availableAt);
      if (!deferred) {
        // The lease was lost between claim and defer (should not happen synchronously);
        // yield rather than risk re-claiming the same row in a tight loop.
        return undefined;
      }
    }
    return undefined;
  }

  /**
   * Whether `entry` must wait for a continuation handoff: true iff its `queue_key` is a
   * `RecordLink` id whose establishing queue(s) still hold non-terminal work. A
   * non-link key (a pre-link identity value or native id) is never gated.
   */
  async #isGated(entry: ClaimedQueueEntry): Promise<boolean> {
    // A `RecordLink` id is always a UUID, so a non-UUID key (a pre-link identity value
    // or native id) cannot be a link and is never gated. This guard is also load-
    // bearing against the real store: `RecordLinkRepository.getById` queries a
    // `uuid`-typed column, and Postgres rejects a non-UUID literal outright — so a
    // pre-link key must never reach it.
    if (!isUuidLike(entry.queueKey)) {
      return false;
    }
    const link = await this.#links.getById(entry.queueKey);
    if (link === undefined) {
      return false;
    }
    const establishingKeys = establishingQueueKeysOf(link);
    if (establishingKeys.length === 0) {
      return false;
    }
    return this.#drainQuery.hasUndrainedEntries(establishingKeys);
  }

  // ── delegated settle / lease ops (OQ-1 semantics, untouched) ─────────────────

  public markDone(id: string, owner: string, finishedAt: Date): Promise<boolean> {
    return this.#inner.markDone(id, owner, finishedAt);
  }

  public park(id: string, reason: string, owner: string, finishedAt: Date): Promise<boolean> {
    return this.#inner.park(id, reason, owner, finishedAt);
  }

  public recordRetry(
    id: string,
    error: string,
    owner: string,
    availableAt: Date,
  ): Promise<boolean> {
    return this.#inner.recordRetry(id, error, owner, availableAt);
  }

  public defer(id: string, owner: string, availableAt: Date): Promise<boolean> {
    return this.#inner.defer(id, owner, availableAt);
  }

  public heartbeat(id: string, owner: string, leaseExpiresAt: Date): Promise<void> {
    return this.#inner.heartbeat(id, owner, leaseExpiresAt);
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Whether `value` is shaped like a `RecordLink` id (a lower/upper-hex UUID). Stricter
 * than Postgres's `uuid` acceptance, so anything this admits the DB also admits — and
 * anything it rejects is definitively not a link id (link ids are always UUIDs).
 */
function isUuidLike(value: string): boolean {
  return UUID_PATTERN.test(value);
}

/**
 * The establishing queue key(s) a link-keyed entry must wait to drain, derived from the
 * link's retained `establishingQueueKey` (OQ-4.1/4.4). `identity-value` → the single
 * retained key; `both-native-id-queues` → the link's two native ids (a manual link with
 * no confirmed identity key — wait for both sides' native-id queues).
 */
export function establishingQueueKeysOf(link: RecordLink): readonly string[] {
  const key = link.establishingQueueKey;
  if (key.kind === "identity-value") {
    return [key.value];
  }
  return [link.appANativeId, link.appBNativeId];
}
