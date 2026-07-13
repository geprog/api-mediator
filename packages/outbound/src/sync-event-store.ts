import type { AuditLogEntry } from "@mediator/domain";
import type { AuditLogRepository } from "@mediator/db";

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
 * The Postgres-backed {@link SyncEventStore}, delegating to the real
 * {@link AuditLogRepository} (`@mediator/db`). Thin on purpose: the executor owns
 * the dedup *policy*, the repository owns the bounded SQL.
 */
export class DbSyncEventStore implements SyncEventStore {
  public constructor(private readonly auditLog: AuditLogRepository) {}

  public async record(entry: AuditLogEntry): Promise<void> {
    await this.auditLog.insert(entry);
  }

  public findRecentByIdempotencyKey(
    idempotencyKey: string,
    options: { readonly since: Date; readonly limit: number },
  ): Promise<AuditLogEntry[]> {
    return this.auditLog.findRecentByIdempotencyKey(idempotencyKey, options);
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
