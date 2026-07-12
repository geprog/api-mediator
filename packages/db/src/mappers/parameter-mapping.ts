import { type ParameterMapping, stripUndefined } from "@mediator/domain";

import { parameterMapping } from "../schema.js";

/** A selected `parameter_mapping` row, with Drizzle's inferred column types. */
export type ParameterMappingRow = typeof parameterMapping.$inferSelect;
/** The insert shape Drizzle expects for `parameter_mapping`. */
export type ParameterMappingInsert = typeof parameterMapping.$inferInsert;

/**
 * Row → domain. Both `transform` and `transform_config` collapse NULL → an
 * **absent** domain key ({@link stripUndefined}): a pass-through parameter (a
 * mapped parameter with no transform) carries NULL in both.
 */
export function mapParameterMappingRow(row: ParameterMappingRow): ParameterMapping {
  return stripUndefined({
    id: row.id,
    operationMappingId: row.operationMappingId,
    sourceParamRef: row.sourceParamRef,
    targetParamRef: row.targetParamRef,
    transform: row.transform ?? undefined,
    transformConfig: row.transformConfig ?? undefined,
  });
}

/** Domain → insert. An absent `transform`/`transformConfig` becomes a NULL column. */
export function toParameterMappingInsert(parameter: ParameterMapping): ParameterMappingInsert {
  return {
    id: parameter.id,
    operationMappingId: parameter.operationMappingId,
    sourceParamRef: parameter.sourceParamRef,
    targetParamRef: parameter.targetParamRef,
    transform: parameter.transform ?? null,
    transformConfig: parameter.transformConfig ?? null,
  };
}
