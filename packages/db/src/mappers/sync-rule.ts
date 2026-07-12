import type { SyncRule } from "@mediator/domain";

import { syncRule } from "../schema.js";

/** A selected `sync_rule` row, with Drizzle's inferred column types. */
export type SyncRuleRow = typeof syncRule.$inferSelect;
/** The insert shape Drizzle expects for `sync_rule`. */
export type SyncRuleInsert = typeof syncRule.$inferInsert;

/**
 * Row → domain. Every column maps 1:1 to the `@mediator/domain` `SyncRule` shape
 * (AM-6 minimal fields); there is no null↔absent collapse because the entity has
 * no optional fields in Phase 3.
 */
export function mapSyncRuleRow(row: SyncRuleRow): SyncRule {
  return {
    id: row.id,
    approvedMappingId: row.approvedMappingId,
    resourcePairRef: row.resourcePairRef,
    status: row.status,
  };
}

/** Domain → insert. */
export function toSyncRuleInsert(rule: SyncRule): SyncRuleInsert {
  return {
    id: rule.id,
    approvedMappingId: rule.approvedMappingId,
    resourcePairRef: rule.resourcePairRef,
    status: rule.status,
  };
}
