import { type OperationMapping, stripUndefined } from "@mediator/domain";

import { operationMapping } from "../schema.js";

/** A selected `operation_mapping` row, with Drizzle's inferred column types. */
export type OperationMappingRow = typeof operationMapping.$inferSelect;
/** The insert shape Drizzle expects for `operation_mapping`. */
export type OperationMappingInsert = typeof operationMapping.$inferInsert;

/**
 * Row → domain. `target_id_param_ref` collapses NULL → an **absent** domain key
 * ({@link stripUndefined}), matching the domain's `.optional()` — a `create`/`read`
 * row and every consumer-provider row carry NULL here.
 */
export function mapOperationMappingRow(row: OperationMappingRow): OperationMapping {
  return stripUndefined({
    id: row.id,
    mappingId: row.mappingId,
    sourceOperationRef: row.sourceOperationRef,
    targetOperationRef: row.targetOperationRef,
    action: row.action,
    targetIdParamRef: row.targetIdParamRef ?? undefined,
  });
}

/** Domain → insert. An absent `targetIdParamRef` becomes a NULL column. */
export function toOperationMappingInsert(operation: OperationMapping): OperationMappingInsert {
  return {
    id: operation.id,
    mappingId: operation.mappingId,
    sourceOperationRef: operation.sourceOperationRef,
    targetOperationRef: operation.targetOperationRef,
    action: operation.action,
    targetIdParamRef: operation.targetIdParamRef ?? null,
  };
}
