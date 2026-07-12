import type { AuditLogEntry } from "@mediator/domain";
import { desc, eq } from "drizzle-orm";

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
}
