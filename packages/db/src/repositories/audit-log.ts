import type { AuditLogEntry } from "@mediator/domain";
import { and, desc, eq, gte } from "drizzle-orm";

import type { DbHandle } from "../client.js";
import { mapAuditLogRow, toAuditLogInsert } from "../mappers/audit-log.js";
import { auditLog } from "../schema.js";

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
