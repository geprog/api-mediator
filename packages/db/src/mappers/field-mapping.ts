import { type FieldMapping, stripUndefined } from "@mediator/domain";

import { fieldMapping } from "../schema.js";

/** A selected `field_mapping` row, with Drizzle's inferred column types. */
export type FieldMappingRow = typeof fieldMapping.$inferSelect;
/** The insert shape Drizzle expects for `field_mapping`. */
export type FieldMappingInsert = typeof fieldMapping.$inferInsert;

/**
 * Row → domain. Every conditionally-meaningful column collapses NULL → an
 * **absent** domain key ({@link stripUndefined}), which is exactly what keeps the
 * domain `FieldMapping` refinements satisfiable: a consumer-provider row has NULL
 * `is_identity_key`/`target_lookup_param_ref`/`conflict_policy` (→ absent), and a
 * peer-peer row has NULL `phase` (→ absent). Phase 3 stores `is_identity_key`
 * **only** as `true` on the confirmed identity field (all others NULL → absent).
 */
export function mapFieldMappingRow(row: FieldMappingRow): FieldMapping {
  return stripUndefined({
    id: row.id,
    mappingId: row.mappingId,
    sourcePath: row.sourcePath,
    targetPath: row.targetPath,
    transform: row.transform,
    transformConfig: row.transformConfig ?? undefined,
    phase: row.phase ?? undefined,
    isIdentityKey: row.isIdentityKey ?? undefined,
    targetLookupParamRef: row.targetLookupParamRef ?? undefined,
    conflictPolicy: row.conflictPolicy ?? undefined,
  });
}

/** Domain → insert. Each absent conditional key becomes a NULL column. */
export function toFieldMappingInsert(field: FieldMapping): FieldMappingInsert {
  return {
    id: field.id,
    mappingId: field.mappingId,
    sourcePath: field.sourcePath,
    targetPath: field.targetPath,
    transform: field.transform,
    transformConfig: field.transformConfig ?? null,
    phase: field.phase ?? null,
    isIdentityKey: field.isIdentityKey ?? null,
    targetLookupParamRef: field.targetLookupParamRef ?? null,
    conflictPolicy: field.conflictPolicy ?? null,
  };
}
