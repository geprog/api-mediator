import type { AuditLogEntry, AuditLogStatus, AuditLogType } from "@mediator/domain";
import { and, desc, eq, gte, inArray, sql, type SQL } from "drizzle-orm";

import type { DbHandle } from "../client.js";
import { mapAuditLogRow, toAuditLogInsert } from "../mappers/audit-log.js";
import { auditLog } from "../schema.js";

/**
 * The `AuditLog.type`s that make up the **sync** audit log the SA-2.3 read
 * endpoint surfaces (`docs/architecture/data-model.md` `SyncEvent / AuditLog`): a
 * per-record `sync-execution`, a `poll-run`, or a `backfill-run`. Deliberately
 * excludes `mapping-decision`/`adapter-request`/`credential-access` — those belong
 * to other read surfaces.
 */
const SYNC_EVENT_TYPES: readonly AuditLogType[] = ["sync-execution", "poll-run", "backfill-run"];

/**
 * The SA-2.3 sync-audit-log filter: by rule, record (link or source native id),
 * and/or execution status. Every filter is optional (AND-combined); `limit` bounds
 * the scan so the read is never unbounded history.
 */
export interface SyncEventQuery {
  readonly relatedRuleId?: string;
  readonly recordLinkId?: string;
  readonly sourceNativeId?: string;
  readonly status?: AuditLogStatus;
  /**
   * SS-16 — narrow to rows whose `details` begins with this literal prefix, pushed
   * down to SQL as a `LIKE '<prefix>%'` with the prefix's own `%`/`_`/`\` escaped, so
   * the prefix is matched **literally** and a metacharacter inside it can never widen
   * the match (the same defensive discipline as
   * `ScopeCorrespondenceRepository.listByResourceSide`).
   *
   * Load-bearing rather than cosmetic: the `details`-encoded families (the
   * ambiguous-container park, the ambiguous-identity match) are read through a
   * **bounded** scan, so without pushing their discriminator into the query the bound
   * is spent on *every* `failure` row of every family and the family being read gets
   * crowded out of its own response. Filtering at the database makes `limit` a bound on
   * the rows the caller actually wants.
   */
  readonly detailsPrefix?: string;
  /**
   * SS-16 — skip this many matching rows before collecting `limit` (most-recent-first,
   * so the paging order is stable). Lets a caller walk a bounded window in pages when a
   * page can contain entries it must discard, without ever widening `limit` itself into
   * an unbounded read.
   */
  readonly offset?: number;
  readonly limit: number;
}

/**
 * Escape a literal string for use as a SQL `LIKE` **prefix** pattern: `\` first (so it
 * cannot double-escape a metacharacter escaped after it), then `%` and `_`. Paired with
 * the explicit `ESCAPE '\'` clause below, which Postgres defaults to but which is stated
 * so the pattern's meaning does not depend on a server default.
 */
function escapeLikePrefix(prefix: string): string {
  return prefix.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

/**
 * Persistence for the `SyncEvent / AuditLog` — Phase 3 writes only
 * `mapping-decision` rows (AS-1 criterion 5, and the approve action's
 * attribution). Constructor-bound to a {@link DbHandle} so an audit entry commits
 * atomically with the mutation it records (a per-item decision, an approve).
 *
 * **Metadata only** — an audit row carries who/what/when/decision, never secret
 * material (`docs/architecture/security.md`).
 */
export class AuditLogRepository {
  public constructor(private readonly db: DbHandle) {}

  /** Append one audit entry. */
  public async insert(entry: AuditLogEntry): Promise<void> {
    await this.db.insert(auditLog).values(toAuditLogInsert(entry));
  }

  /** The decision history for a proposal, most recent first. */
  public async listByProposalId(proposalId: string): Promise<AuditLogEntry[]> {
    const rows = await this.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.relatedProposalId, proposalId))
      .orderBy(desc(auditLog.timestamp));
    return rows.map(mapAuditLogRow);
  }

  /** The decision history for an approved mapping, most recent first. */
  public async listByMappingId(mappingId: string): Promise<AuditLogEntry[]> {
    const rows = await this.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.relatedMappingId, mappingId))
      .orderBy(desc(auditLog.timestamp));
    return rows.map(mapAuditLogRow);
  }

  /**
   * The SA-2.3 **sync audit log** query: `sync-execution`/`poll-run`/`backfill-run`
   * rows filtered by rule/record/status, most-recent-first, bounded by `limit`. The
   * rows carry status/metadata/ids/hashes and `traceId`/`spanId` — **never** a
   * payload value or credential material, by construction of the `audit_log` schema
   * (`docs/architecture/security.md` *Audit logging*). The DTO mapper decides which
   * columns reach the wire.
   */
  public async querySyncEvents(query: SyncEventQuery): Promise<AuditLogEntry[]> {
    const conditions: SQL[] = [inArray(auditLog.type, [...SYNC_EVENT_TYPES])];
    if (query.relatedRuleId !== undefined) {
      conditions.push(eq(auditLog.relatedRuleId, query.relatedRuleId));
    }
    if (query.recordLinkId !== undefined) {
      conditions.push(eq(auditLog.recordLinkId, query.recordLinkId));
    }
    if (query.sourceNativeId !== undefined) {
      conditions.push(eq(auditLog.sourceNativeId, query.sourceNativeId));
    }
    if (query.status !== undefined) {
      conditions.push(eq(auditLog.status, query.status));
    }
    if (query.detailsPrefix !== undefined) {
      // SS-16 — push the `details` family discriminator down to SQL so `limit` bounds
      // the rows the caller wants rather than every `failure` row of every family.
      conditions.push(
        sql`${auditLog.details} like ${`${escapeLikePrefix(query.detailsPrefix)}%`} escape '\\'`,
      );
    }
    const rows = await this.db
      .select()
      .from(auditLog)
      .where(and(...conditions))
      .orderBy(desc(auditLog.timestamp))
      .limit(query.limit)
      .offset(query.offset ?? 0);
    return rows.map(mapAuditLogRow);
  }

  /**
   * OC-2's **bounded-lookback** idempotency query: the most recent audit rows
   * carrying `idempotencyKey`, no older than `since` and capped at `limit` — the
   * concept's "last N per-record events or a configured retention period, **never**
   * unbounded history". Returns the (bounded) matching rows most-recent-first; the
   * Outbound Call Executor inspects them for a prior `success` before it decides to
   * skip a write (a prior `failure` must NOT suppress its retry). The dedup
   * *policy* lives in the executor; this method only bounds the scan.
   */
  public async findRecentByIdempotencyKey(
    idempotencyKey: string,
    options: { readonly since: Date; readonly limit: number },
  ): Promise<AuditLogEntry[]> {
    const rows = await this.db
      .select()
      .from(auditLog)
      .where(
        and(eq(auditLog.idempotencyKey, idempotencyKey), gte(auditLog.timestamp, options.since)),
      )
      .orderBy(desc(auditLog.timestamp))
      .limit(options.limit);
    return rows.map(mapAuditLogRow);
  }
}
