import type { AdapterBinding } from "@mediator/domain";

import { adapterBinding } from "../schema.js";

/** A selected `adapter_binding` row, with Drizzle's inferred column types. */
export type AdapterBindingRow = typeof adapterBinding.$inferSelect;
/** The insert shape Drizzle expects for `adapter_binding`. */
export type AdapterBindingInsert = typeof adapterBinding.$inferInsert;

/**
 * Row → domain. Every column maps 1:1 to the `@mediator/domain` `AdapterBinding`
 * shape (AM-6 minimal fields); Phase 3 does not model `executionOrder`/
 * `dependsOnBindingId`/`chainInputs` (Phase 5 composition state).
 */
export function mapAdapterBindingRow(row: AdapterBindingRow): AdapterBinding {
  return {
    id: row.id,
    adapterEndpointId: row.adapterEndpointId,
    backendAppId: row.backendAppId,
    backendOperationId: row.backendOperationId,
    approvedMappingId: row.approvedMappingId,
    role: row.role,
    status: row.status,
  };
}

/** Domain → insert. */
export function toAdapterBindingInsert(binding: AdapterBinding): AdapterBindingInsert {
  return {
    id: binding.id,
    adapterEndpointId: binding.adapterEndpointId,
    backendAppId: binding.backendAppId,
    backendOperationId: binding.backendOperationId,
    approvedMappingId: binding.approvedMappingId,
    role: binding.role,
    status: binding.status,
  };
}
