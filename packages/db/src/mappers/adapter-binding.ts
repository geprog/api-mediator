import { type AdapterBinding, stripUndefined } from "@mediator/domain";

import { adapterBinding } from "../schema.js";

/** A selected `adapter_binding` row, with Drizzle's inferred column types. */
export type AdapterBindingRow = typeof adapterBinding.$inferSelect;
/** The insert shape Drizzle expects for `adapter_binding`. */
export type AdapterBindingInsert = typeof adapterBinding.$inferInsert;

/**
 * Row → domain. The AM-6 columns map 1:1; every AD-2 execution/chaining column is
 * **nullable with no DB default**, so a NULL collapses to an **absent** domain key
 * ({@link stripUndefined}) — a Phase-3-attached `proposed` binding reads back with
 * `executionOrder`/`dependsOnBindingId`/`chainInputs` absent, composing nothing
 * (AD-2.5). An absent `executionOrder` resolves to the documented default `0`
 * through `resolveExecutionOrder` at read sites, not here (AD-6.2).
 */
export function mapAdapterBindingRow(row: AdapterBindingRow): AdapterBinding {
  return stripUndefined({
    id: row.id,
    adapterEndpointId: row.adapterEndpointId,
    backendAppId: row.backendAppId,
    backendOperationId: row.backendOperationId,
    approvedMappingId: row.approvedMappingId,
    role: row.role,
    status: row.status,
    executionOrder: row.executionOrder ?? undefined,
    dependsOnBindingId: row.dependsOnBindingId ?? undefined,
    chainInputs: row.chainInputs ?? undefined,
  });
}

/**
 * Domain → insert. An absent execution/chaining field becomes a NULL column (the
 * Phase-3 AI-2 minimal insert sets none of them — backward compatible). A present
 * field is written as-is.
 */
export function toAdapterBindingInsert(binding: AdapterBinding): AdapterBindingInsert {
  return {
    id: binding.id,
    adapterEndpointId: binding.adapterEndpointId,
    backendAppId: binding.backendAppId,
    backendOperationId: binding.backendOperationId,
    approvedMappingId: binding.approvedMappingId,
    role: binding.role,
    status: binding.status,
    executionOrder: binding.executionOrder ?? null,
    dependsOnBindingId: binding.dependsOnBindingId ?? null,
    chainInputs: binding.chainInputs ?? null,
  };
}
