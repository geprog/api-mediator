import { type AdapterEndpoint, type PostMergePagination, stripUndefined } from "@mediator/domain";

import { adapterEndpoint, type PostMergePaginationRow } from "../schema.js";

/** A selected `adapter_endpoint` row, with Drizzle's inferred column types. */
export type AdapterEndpointRow = typeof adapterEndpoint.$inferSelect;
/** The insert shape Drizzle expects for `adapter_endpoint`. */
export type AdapterEndpointInsert = typeof adapterEndpoint.$inferInsert;

/**
 * The `jsonb` row form → domain conversion for `postMergePagination`: `jsonb`
 * has no `Date`, so `confirmedAt` is stored as an ISO-8601 string (or `null`) and
 * converted back to a `Date` on read — the same treatment `resource-binding.ts`
 * uses for its refs' `confirmedAt`.
 */
function mapPostMergePaginationRow(row: PostMergePaginationRow): PostMergePagination {
  return {
    convention: row.convention,
    confirmedBy: row.confirmedBy,
    confirmedAt: row.confirmedAt === null ? null : new Date(row.confirmedAt),
  };
}

/** Domain → `jsonb` row form: the `Date` `confirmedAt` becomes an ISO-8601 string. */
function toPostMergePaginationRow(pagination: PostMergePagination): PostMergePaginationRow {
  return {
    convention: pagination.convention,
    confirmedBy: pagination.confirmedBy,
    confirmedAt: pagination.confirmedAt === null ? null : pagination.confirmedAt.toISOString(),
  };
}

/**
 * Row → domain. The four AM-6 columns map 1:1; every AD-1 composition column is
 * **nullable with no DB default**, so a NULL collapses to an **absent** domain key
 * ({@link stripUndefined}) — a Phase-3-instantiated `composition-required` endpoint
 * reads back as exactly the four AM-6 fields, carrying no serving configuration
 * (AD-1.6). The `post_merge_pagination` `jsonb` needs its `confirmedAt` string
 * rehydrated to a `Date`; the other three `post_merge_*` columns are JSON-safe.
 */
export function mapAdapterEndpointRow(row: AdapterEndpointRow): AdapterEndpoint {
  return stripUndefined({
    id: row.id,
    consumerAppId: row.consumerAppId,
    consumerOperationId: row.consumerOperationId,
    status: row.status,
    aggregationStrategy: row.aggregationStrategy ?? undefined,
    cacheTtl: row.cacheTtl ?? undefined,
    strictness: row.strictness ?? undefined,
    postMergeFilters: row.postMergeFilters ?? undefined,
    postMergeSorts: row.postMergeSorts ?? undefined,
    postMergePagination:
      row.postMergePagination === null
        ? undefined
        : mapPostMergePaginationRow(row.postMergePagination),
    postMergeDedup: row.postMergeDedup ?? undefined,
  });
}

/**
 * Domain → insert. An absent composition field becomes a NULL column (the Phase-3
 * AI-2 minimal insert sets none of them, so they all land NULL — backward
 * compatible). A present field is written as-is; `postMergePagination`'s `Date`
 * `confirmedAt` is serialized to an ISO-8601 string for `jsonb`.
 */
export function toAdapterEndpointInsert(endpoint: AdapterEndpoint): AdapterEndpointInsert {
  return {
    id: endpoint.id,
    consumerAppId: endpoint.consumerAppId,
    consumerOperationId: endpoint.consumerOperationId,
    status: endpoint.status,
    aggregationStrategy: endpoint.aggregationStrategy ?? null,
    cacheTtl: endpoint.cacheTtl ?? null,
    strictness: endpoint.strictness ?? null,
    postMergeFilters: endpoint.postMergeFilters ?? null,
    postMergeSorts: endpoint.postMergeSorts ?? null,
    postMergePagination:
      endpoint.postMergePagination === undefined
        ? null
        : toPostMergePaginationRow(endpoint.postMergePagination),
    postMergeDedup: endpoint.postMergeDedup ?? null,
  };
}
