import {
  AuditLogType,
  stripUndefined,
  type AuditLogEntry,
  type AuditLogStatus,
  type DomainEventEnvelope,
} from "@mediator/domain";
import { AuditLogRepository, type Database, type DbHandle } from "@mediator/db";

/**
 * The narrow persistence port the Outbound Call Executor needs for the
 * `SyncEvent`/`AuditLog` (OC-5 write + OC-2 bounded-lookback read). A port (not the
 * whole repository) so the executor is unit-testable against {@link FakeSyncEventStore},
 * which **mirrors** the real query semantics ([[fakes-must-mirror-real-repos]]).
 */
export interface SyncEventStore {
  /** Append exactly one `sync-execution` `SyncEvent` (OC-5 criterion 1). */
  record(entry: AuditLogEntry): Promise<void>;
  /**
   * OC-2's **bounded** idempotency lookback: the most-recent audit rows carrying
   * `idempotencyKey`, no older than `since`, capped at `limit` — never unbounded.
   * Most-recent-first. The executor inspects the (bounded) result for a prior
   * `success`.
   */
  findRecentByIdempotencyKey(
    idempotencyKey: string,
    options: { readonly since: Date; readonly limit: number },
  ): Promise<AuditLogEntry[]>;
}

/**
 * **XI-1 — the transactional-outbox emit seam the {@link DbSyncEventStore} publishes a
 * `sync-execution` `SyncEvent` through.** A narrow port (structurally satisfied by the
 * real `PostgresEventBus` from `@mediator/event-bus`, injected by the composition root)
 * so `@mediator/outbound` stays free of an event-bus dependency, exactly as it holds the
 * {@link SyncEventStore}/`CredentialAccess`/`ProtocolClient` seams at arm's length.
 *
 * `emit` appends the event to the durable `event_outbox` **within the caller's
 * transaction** `tx`, so the outbox row commits or rolls back atomically with the
 * audit-log write it rides alongside (overview.md *Event Bus*). Re-emitting the same
 * `event.id` is a no-op (the outbox `event_id` is UNIQUE), so re-recording an entry never
 * double-publishes and the producer needs no exactly-once guarantee (XI-1.6).
 */
export interface SyncEventOutbox {
  emit(event: DomainEventEnvelope, tx: DbHandle): Promise<void>;
}

/**
 * **GR-4 — an arm's-length reactor invoked with each recorded audit entry, in the record
 * transaction.** A narrow injected port (like {@link SyncEventOutbox}) so `@mediator/outbound`
 * stays free of any graph dependency: the composition root wires an implementation that
 * advances the projected `GraphEdge`'s `metadata.lastActivityAt` from the just-recorded
 * `SyncEvent` (`docs/requirements/phase-6-graph.md` GR-4). It runs **inside** the same
 * transaction as the audit-row write, so the activity advance commits or rolls back
 * atomically with it; the advance is a single cheap monotonic DB write (dispatcher-tx-safe)
 * and self-filters (it advances only a `sync-execution` row attributable to a rule), so a
 * `poll-run`/`backfill-run` row passed here is a clean no-op.
 */
export interface RecordedAuditReactor {
  onRecorded(entry: AuditLogEntry, tx: DbHandle): Promise<void>;
}

/**
 * **XI-1 — the `sync-execution` outbox event.** The CH-3 cache-invalidation consumer
 * (`apps/backend/src/http/adapter-runtime/cache-invalidation.ts`) reacts to a
 * `sync-execution`-typed bus event and reads exactly `status` + `originAppId` +
 * `relatedRuleId` off its `payload` to translate it into a `(backendAppId, resourceRef)`
 * cache drop. This is the flat domain-event shape the store emits so those fields land in
 * the outbox `payload`; the bus `type` reuses the `AuditLog` `sync-execution` value the
 * consumer's `handles(type)` matches (not a new PascalCase envelope literal).
 */
export interface SyncExecutionOutboxEvent extends DomainEventEnvelope {
  readonly type: (typeof AuditLogType)["sync-execution"];
  /** The app the change was written to (`= AuditLogEntry.originAppId`, the executor's `targetAppId`). */
  readonly originAppId?: string;
  /** The `SyncRule` whose resource pair changed — the consumer resolves its `resourcePairRef`. */
  readonly relatedRuleId?: string;
  /** The execution outcome, carried **faithfully** so the consumer's `isAppliedChange` guard works (XI-1.3). */
  readonly status?: AuditLogStatus;
}

/**
 * XI-1 — project a recorded {@link AuditLogEntry} into the {@link SyncExecutionOutboxEvent}
 * to enqueue, or `undefined` when the row is **not** a `sync-execution` and so carries no
 * CH-3 signal (a `backfill-run` also flows through {@link DbSyncEventStore.record}; CH-3
 * handles `sync-execution` only). The event id **is** the audit row's id, so the outbox row
 * is 1:1 with the durable audit record and a re-record of the same id de-dups on the outbox
 * `event_id` (XI-1.6). Pure and total — it never throws, so it can run on the sync write
 * path without endangering the write (XI-1.4). `status` is carried as-is (XI-1.3);
 * `stripUndefined` keeps an absent `relatedRuleId`/`status`/`originAppId` out of the payload
 * rather than emitting an explicit `undefined`.
 */
export function syncExecutionOutboxEvent(
  entry: AuditLogEntry,
): SyncExecutionOutboxEvent | undefined {
  if (entry.type !== AuditLogType["sync-execution"]) {
    return undefined;
  }
  return stripUndefined({
    id: entry.id,
    type: entry.type,
    occurredAt: entry.timestamp,
    originAppId: entry.originAppId,
    relatedRuleId: entry.relatedRuleId,
    status: entry.status,
  });
}

/**
 * The Postgres-backed {@link SyncEventStore}. It delegates the row read/write to the real
 * {@link AuditLogRepository} (`@mediator/db`) and — **XI-1** — enqueues each recorded
 * `sync-execution` `SyncEvent` onto the `event_outbox` **in the same transaction** as the
 * audit write, activating the registered-but-inert CH-3 cache-invalidation consumer.
 *
 * **Atomicity vs. never-failing the sync write (XI-1.4).** The write that must never be
 * failed is the outbound REST change to the target app — the executor has **already**
 * completed it by the time it records the `SyncEvent`; `record` is durable bookkeeping. The
 * audit insert and the outbox insert commit as one unit: if either fails, both roll back
 * (the standard transactional-outbox pattern — a rolled-back sync execution correctly leaves
 * neither an audit row nor an outbox row), and the already-applied target-side change is
 * untouched. So the enqueue can never corrupt or partially-commit the recorded execution;
 * what it can do is fail the whole `record` exactly as an audit insert alone could today.
 * The bus-loss tolerance (XI-1.5) is about **delivery**, not the enqueue: once committed, if
 * the dispatcher never delivers the row, the stale cache entry simply lives out its
 * `cacheTtl` while the business record stays durably in the Audit Log.
 */
export class DbSyncEventStore implements SyncEventStore {
  public constructor(
    private readonly db: Database,
    private readonly outbox: SyncEventOutbox,
    private readonly activityReactor?: RecordedAuditReactor,
  ) {}

  public async record(entry: AuditLogEntry): Promise<void> {
    await this.db.transaction(async (tx) => {
      await new AuditLogRepository(tx).insert(entry);
      const event = syncExecutionOutboxEvent(entry);
      if (event !== undefined) {
        await this.outbox.emit(event, tx);
      }
      // GR-4 — advance the edge's lastActivityAt from this durable SyncEvent, in the
      // SAME transaction (atomic, monotonic, dispatcher-tx-safe). The reactor self-filters
      // to sync-execution rows, so a poll-run/backfill-run is a no-op here.
      if (this.activityReactor !== undefined) {
        await this.activityReactor.onRecorded(entry, tx);
      }
    });
  }

  public findRecentByIdempotencyKey(
    idempotencyKey: string,
    options: { readonly since: Date; readonly limit: number },
  ): Promise<AuditLogEntry[]> {
    return new AuditLogRepository(this.db).findRecentByIdempotencyKey(idempotencyKey, options);
  }
}

/**
 * An in-memory {@link SyncEventStore} that **faithfully mirrors** the real
 * `AuditLogRepository.findRecentByIdempotencyKey` (filter by exact key + `timestamp
 * >= since`, most-recent-first, capped at `limit`) — so the executor's OC-2 dedup
 * and OC-5 write can be unit-tested without a database and still exercise the exact
 * lookback bounds the SQL enforces ([[fakes-must-mirror-real-repos]]).
 */
export class FakeSyncEventStore implements SyncEventStore {
  readonly #entries: AuditLogEntry[] = [];

  public record(entry: AuditLogEntry): Promise<void> {
    this.#entries.push(entry);
    return Promise.resolve();
  }

  public findRecentByIdempotencyKey(
    idempotencyKey: string,
    options: { readonly since: Date; readonly limit: number },
  ): Promise<AuditLogEntry[]> {
    const matches = this.#entries
      .filter(
        (entry) =>
          entry.idempotencyKey === idempotencyKey &&
          entry.timestamp.getTime() >= options.since.getTime(),
      )
      .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
      .slice(0, options.limit);
    return Promise.resolve(matches);
  }

  /** Every recorded entry, in insertion order (test assertions). */
  public all(): readonly AuditLogEntry[] {
    return [...this.#entries];
  }
}
