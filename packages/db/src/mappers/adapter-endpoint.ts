import type { AdapterEndpoint } from "@mediator/domain";

import { adapterEndpoint } from "../schema.js";

/** A selected `adapter_endpoint` row, with Drizzle's inferred column types. */
export type AdapterEndpointRow = typeof adapterEndpoint.$inferSelect;
/** The insert shape Drizzle expects for `adapter_endpoint`. */
export type AdapterEndpointInsert = typeof adapterEndpoint.$inferInsert;

/**
 * Row → domain. Every column maps 1:1 to the `@mediator/domain` `AdapterEndpoint`
 * shape (AM-6 minimal fields); Phase 3 does not model `aggregationStrategy`/
 * `cacheTtl`/post-merge columns (Phase 5).
 */
export function mapAdapterEndpointRow(row: AdapterEndpointRow): AdapterEndpoint {
  return {
    id: row.id,
    consumerAppId: row.consumerAppId,
    consumerOperationId: row.consumerOperationId,
    status: row.status,
  };
}

/** Domain → insert. */
export function toAdapterEndpointInsert(endpoint: AdapterEndpoint): AdapterEndpointInsert {
  return {
    id: endpoint.id,
    consumerAppId: endpoint.consumerAppId,
    consumerOperationId: endpoint.consumerOperationId,
    status: endpoint.status,
  };
}
