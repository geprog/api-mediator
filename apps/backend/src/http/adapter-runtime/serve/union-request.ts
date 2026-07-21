import type { AdapterRequest } from "@mediator/adapter-engine";
import type { AdapterEndpoint, PostMergePaginationConventionValue } from "@mediator/domain";

import { topLevelConsumerFieldName } from "../../../modules/adapter-composition/analysis.js";
import type {
  ResolvedUnionFilter,
  ResolvedUnionPage,
  ResolvedUnionSort,
} from "./union-aggregate.js";
import { paramRefBareName } from "./request-mapping.js";

/**
 * **Pure request-time resolution of a `collection-union` endpoint's `postMerge*` config
 * against one request (AG-4).** Turns the persisted, composer-confirmed
 * `postMergeFilters`/`postMergeSorts`/`postMergePagination` plus the request's supplied
 * query values into the {@link ResolvedUnionFilter}s / {@link ResolvedUnionSort} /
 * {@link ResolvedUnionPage} the pure aggregator applies. No I/O — a request in, a resolved
 * config out — so it is unit-testable, and the aggregator never re-reads the request.
 *
 * Only the parameters the request actually **supplies** produce a resolved entry: an
 * unsupplied filter/sort/pagination parameter is simply not applied (RP-2 already rejected
 * a *supplied* one with no configured semantics, so nothing unfiltered/mispaged is served).
 */

/** The first supplied value of a query parameter (repeated keys keep the first), or `undefined`. */
function suppliedQuery(request: AdapterRequest, name: string): string | undefined {
  const raw = request.query[name];
  if (raw === undefined) {
    return undefined;
  }
  return typeof raw === "string" ? raw : raw[0];
}

/** AG-4.2 — the post-merge filters whose parameter the request supplies, bound to its value. */
export function resolvePostMergeFilters(
  endpoint: AdapterEndpoint,
  request: AdapterRequest,
): ResolvedUnionFilter[] {
  const resolved: ResolvedUnionFilter[] = [];
  for (const filter of endpoint.postMergeFilters ?? []) {
    const value = suppliedQuery(request, paramRefBareName(filter.consumerParamRef));
    if (value === undefined) {
      continue;
    }
    resolved.push({
      fieldName: topLevelConsumerFieldName(filter.consumerFieldPath),
      operator: filter.operator,
      value,
    });
  }
  return resolved;
}

/**
 * AG-4.3 — the post-merge sort the request selects, or `undefined`. A value-driven sort
 * parameter (`?sort=title`) matches the `postMergeSorts` entry whose `paramValue` equals the
 * supplied value; a fixed sort parameter (no `paramValue`) matches on the parameter merely
 * being supplied. The first matching entry wins (a request rarely supplies more than one).
 */
export function resolvePostMergeSort(
  endpoint: AdapterEndpoint,
  request: AdapterRequest,
): ResolvedUnionSort | undefined {
  for (const sort of endpoint.postMergeSorts ?? []) {
    const supplied = suppliedQuery(request, paramRefBareName(sort.consumerParamRef));
    if (supplied === undefined) {
      continue;
    }
    if (sort.paramValue === undefined || sort.paramValue === supplied) {
      return {
        fieldName: topLevelConsumerFieldName(sort.consumerFieldPath),
        direction: sort.direction,
      };
    }
  }
  return undefined;
}

/**
 * AG-4.3 — the pagination window the request selects over the merged result, or `undefined`
 * (no window → the whole merged result). Honored only when the convention is **confirmed**
 * (derive-then-confirm) and the request supplies a page **size**; the position parameter
 * defaults to the first page / offset 0 when absent.
 */
export function resolvePostMergePage(
  endpoint: AdapterEndpoint,
  request: AdapterRequest,
): ResolvedUnionPage | undefined {
  const pagination = endpoint.postMergePagination;
  if (
    pagination === undefined ||
    pagination.confirmedBy === null ||
    pagination.confirmedAt === null
  ) {
    return undefined;
  }
  const convention = pagination.convention;
  const size = positiveInt(suppliedQuery(request, paramRefBareName(convention.sizeParamRef)));
  if (size === undefined) {
    // Without a page size there is no window to compute — return the whole merged result.
    return undefined;
  }
  return { offset: offsetOf(convention, request, size), limit: size };
}

/** The zero-based offset the position parameter selects, given the page size. */
function offsetOf(
  convention: PostMergePaginationConventionValue,
  request: AdapterRequest,
  size: number,
): number {
  if (convention.convention === "offset") {
    const offset = nonNegativeInt(
      suppliedQuery(request, paramRefBareName(convention.offsetParamRef)),
    );
    return offset ?? 0;
  }
  const page = nonNegativeInt(suppliedQuery(request, paramRefBareName(convention.pageParamRef)));
  if (page === undefined) {
    return 0;
  }
  return Math.max(0, (page - convention.firstPageNumber) * size);
}

function positiveInt(value: string | undefined): number | undefined {
  const parsed = nonNegativeInt(value);
  return parsed !== undefined && parsed > 0 ? parsed : undefined;
}

function nonNegativeInt(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}
