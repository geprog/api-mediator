import type { PostMergeFilterOperator, PostMergeSortDirection } from "@mediator/domain";
import type { JsonRecord, JsonValue } from "@mediator/transform";

import type { AggregateOutcome } from "./aggregator.js";
import {
  compareBindingPrecedence,
  resultFailureCause,
  type BindingResult,
  type ResolutionPlan,
} from "./pipeline-types.js";

/**
 * **The pure `collection-union` aggregation core (AG-3 + AG-4).** A function of
 * (plan + already-fetched consumer-shape contributor rows + the request-time
 * {@link CollectionUnionContext}), applying no I/O and no field transforms of its own
 * (each row is already consumer-shape, TE-5.4). The paged bounded fetch (AG-5) and the
 * `RecordLink` reads (AG-3.3) happen in the serve handler **before** this — their
 * results arrive here as data, so the whole merge/dedup/filter/sort/paginate decision
 * is unit-testable over hand-built envelopes with no backend.
 *
 * **Order of operations is exactly AG-4.6:** fetch (handler) → merge → dedup → post-merge
 * filter → sort → paginate — the complete filtered merged collection is materialized
 * before sorting and paginating.
 *
 * **Fail loud, never plausible-but-wrong.** Dedup happens only where identity is
 * provably known (a `RecordLink` pairing or a configured dedup key); with neither, rows
 * are returned exactly as mapped — the mediator never guesses row identity (AG-3.5). A
 * mediator-side defect among the contributors (a transform error) fails the whole
 * request rather than silently shrinking the union. A truncated union is never produced
 * here — the row ceiling (AG-5) fails the request in the handler before aggregation.
 */

// ── request-time config the aggregator consumes ──────────────────────────────

/** One post-merge filter, already bound to the request's supplied parameter value (AG-4.2). */
export interface ResolvedUnionFilter {
  /** The bare **consumer-shape** field the filter constrains (post-response-transform). */
  readonly fieldName: string;
  readonly operator: PostMergeFilterOperator;
  /** The supplied parameter value, as a wire string. */
  readonly value: string;
}

/** The post-merge sort selected by the request's sort parameter value (AG-4.3), or none. */
export interface ResolvedUnionSort {
  readonly fieldName: string;
  readonly direction: PostMergeSortDirection;
}

/** The post-merge pagination window computed from the request (AG-4.3), or none. */
export interface ResolvedUnionPage {
  /** Rows to skip from the front of the sorted merged result (>= 0). */
  readonly offset: number;
  /** Max rows to return, or `undefined` for "to the end". */
  readonly limit: number | undefined;
}

/**
 * How the union collapses duplicates — the executed form of `AdapterEndpoint.postMergeDedup`
 * (AG-3.3/3.4/3.5). `record-link` carries the **precomputed** per-row link-group keys the
 * handler resolved from `RecordLink`s (the aggregator stays pure): rows sharing a
 * non-`undefined` key are the same record; a `undefined` key is an unlinked row that never
 * collapses.
 */
export type UnionDedupPlan =
  | { readonly mode: "none" }
  | { readonly mode: "dedup-key"; readonly fieldName: string }
  | {
      readonly mode: "record-link";
      /** Per contributing binding id → the link-group key of each of its rows (index-aligned). */
      readonly linkGroupKeyByBinding: ReadonlyMap<string, readonly (string | undefined)[]>;
    };

/** Everything request-time the union aggregator needs, all resolved to pure data. */
export interface CollectionUnionContext {
  /** Backend app id per binding id — names a dropped contributor out of band (AG-3.2). */
  readonly backendAppIdByBinding: ReadonlyMap<string, string>;
  readonly dedup: UnionDedupPlan;
  readonly postMergeFilters: readonly ResolvedUnionFilter[];
  readonly sort: ResolvedUnionSort | undefined;
  readonly pagination: ResolvedUnionPage | undefined;
}

// ── internal row model ───────────────────────────────────────────────────────

/** One flattened contributor row plus the metadata the merge/dedup/tiebreak reason over. */
interface UnionRow {
  readonly bindingId: string;
  readonly backendAppId: string;
  /** The contributor's resolved `executionOrder` (precedence, AG-3.3 / AG-4.5). */
  readonly executionOrder: number;
  /** The row's position within its contributor's fetched sequence (stable within a backend). */
  readonly rowIndex: number;
  /** The row's backend-native id (TE-4 provenance), or `undefined` where `nativeIdRef` is unconfirmed. */
  readonly nativeId: string | undefined;
  /** The consumer-shape row body. */
  readonly value: JsonValue;
}

function isJsonRecord(value: JsonValue): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Read a bare top-level field off a consumer-shape row; `undefined` for a non-object or absent field. */
function readField(value: JsonValue, fieldName: string): JsonValue | undefined {
  return isJsonRecord(value) ? value[fieldName] : undefined;
}

function defect(detail: string): AggregateOutcome {
  return { kind: "failure", failure: { cause: "mediator-transform-error", detail } };
}

type FailureLike = Extract<BindingResult, { kind: "failure" | "not-called" }>;
type SuccessResult = Extract<BindingResult, { kind: "success" }>;

/**
 * **Aggregate a `collection-union` endpoint's results (AG-3 + AG-4).** Every binding is
 * an equivalent `supplement` contributor (AG-3.1); a failed contributor is dropped
 * (non-strict) or fails the whole request (strict), never substituted (AG-3.2). Surviving
 * rows merge, dedup only where identity is known, then post-merge filter/sort/paginate.
 */
export function aggregateCollectionUnion(
  plan: ResolutionPlan,
  results: readonly BindingResult[],
  context: CollectionUnionContext,
): AggregateOutcome {
  if (plan.aggregationStrategy !== "collection-union") {
    return defect(`aggregateCollectionUnion received a '${plan.aggregationStrategy}' plan`);
  }

  // AG-3.1 — every binding is an equivalent `supplement` contributor; a `primary`/`fallback`
  // is a composition defect (CO-2 enforces the role table) surfaced loudly, never merged.
  const stray = results.find((result) => result.role !== "supplement");
  if (stray !== undefined) {
    return defect(`collection-union binding ${stray.bindingId} has role '${stray.role}'`);
  }

  const failures = results.filter((result): result is FailureLike => result.kind !== "success");
  const successes = results.filter((result): result is SuccessResult => result.kind === "success");

  // A mediator-side defect among the contributors (a transform error) is a mediator bug,
  // not a droppable backend outage: fail loud rather than silently shrink the union.
  const mediatorDefect = failures.find(
    (failure) => resultFailureCause(failure).cause === "mediator-transform-error",
  );
  if (mediatorDefect !== undefined) {
    return { kind: "failure", failure: resultFailureCause(mediatorDefect) };
  }

  const orderedFailures = [...failures].sort(compareBindingPrecedence);

  // AG-3.2 — strict mode: ANY contributor failure fails the whole request.
  if (plan.strictness === "strict") {
    const first = orderedFailures[0];
    if (first !== undefined) {
      return { kind: "failure", failure: resultFailureCause(first) };
    }
  }

  // AG-3.2 — non-strict: a failed contributor is DROPPED (never substituted) and named
  // out of band. When EVERY contributor failed there is no authoritative answer, so the
  // request fails (a representative cause) rather than returning an empty — and therefore
  // plausible-but-wrong — union.
  if (successes.length === 0) {
    const first = orderedFailures[0];
    if (first === undefined) {
      return defect("collection-union has no contributing bindings");
    }
    return { kind: "failure", failure: resultFailureCause(first) };
  }

  const flattened = flattenRows(successes);
  if (!flattened.ok) {
    return defect(flattened.detail);
  }

  // merge → dedup → filter → sort → paginate (AG-4.6).
  const deduped = dedupRows(flattened.rows, context.dedup);
  const filtered = applyFilters(deduped, context.postMergeFilters);
  const sorted = sortRows(filtered, context.sort);
  const paged = paginateRows(sorted, context.pagination);

  const payload: JsonValue[] = paged.map((row) => row.value);
  const degradedBackendAppIds = orderedFailures.map(
    (failure) => context.backendAppIdByBinding.get(failure.bindingId) ?? failure.bindingId,
  );
  const contributingBackendAppIds = [...successes]
    .sort(compareBindingPrecedence)
    .map((success) => success.backendAppId);

  return {
    kind: "success",
    payload,
    contributingBackendAppIds,
    degraded: degradedBackendAppIds.length > 0,
    degradedBackendAppIds,
  };
}

/**
 * Flatten each successful contributor's collection payload into {@link UnionRow}s, pairing
 * each row with its backend-native id provenance (index-aligned `rowProvenance`). A success
 * whose payload is not an array is a mediator-side defect (a union contributor must yield a
 * list) surfaced loudly.
 */
function flattenRows(
  successes: readonly SuccessResult[],
):
  | { readonly ok: true; readonly rows: UnionRow[] }
  | { readonly ok: false; readonly detail: string } {
  const rows: UnionRow[] = [];
  for (const success of successes) {
    if (!Array.isArray(success.payload)) {
      return {
        ok: false,
        detail: `collection-union contributor ${success.bindingId} did not return a list`,
      };
    }
    const provenance = success.rowProvenance ?? [];
    success.payload.forEach((value, rowIndex) => {
      rows.push({
        bindingId: success.bindingId,
        backendAppId: success.backendAppId,
        executionOrder: success.executionOrder,
        rowIndex,
        nativeId: provenance[rowIndex],
        value,
      });
    });
  }
  return { ok: true, rows };
}

/**
 * AG-3.3/3.4/3.5 — collapse rows only where identity is provably known. `record-link`
 * groups by the precomputed link-group key, `dedup-key` by a consumer field's value; a row
 * with no link / no key value is a singleton (never guessed). Each group of >1 collapses to
 * one row, field conflicts resolved by the shared precedence rule (`executionOrder`, then
 * binding id). With mode `none`, every row stands.
 */
function dedupRows(rows: readonly UnionRow[], dedup: UnionDedupPlan): UnionRow[] {
  if (dedup.mode === "none") {
    return [...rows];
  }
  const groups = new Map<string, UnionRow[]>();
  const order: string[] = [];
  let singletonCounter = 0;
  for (const row of rows) {
    const identity = identityKeyOf(row, dedup);
    const key = identity ?? ` singleton ${String(singletonCounter++)}`;
    const existing = groups.get(key);
    if (existing === undefined) {
      groups.set(key, [row]);
      order.push(key);
    } else {
      existing.push(row);
    }
  }
  return order.map((key) => mergeGroup(groups.get(key) ?? []));
}

/** The identity key a row collapses by, or `undefined` when its identity is not known. */
function identityKeyOf(row: UnionRow, dedup: UnionDedupPlan): string | undefined {
  if (dedup.mode === "dedup-key") {
    const fieldValue = readField(row.value, dedup.fieldName);
    if (fieldValue === undefined || fieldValue === null) {
      return undefined; // no key value → never guess two rows are the same record.
    }
    return `k ${scalarKey(fieldValue)}`;
  }
  if (dedup.mode === "record-link") {
    // The precomputed group key; `undefined` = unlinked (its own singleton).
    return dedup.linkGroupKeyByBinding.get(row.bindingId)?.[row.rowIndex];
  }
  // mode `none` never reaches here (dedupRows short-circuits) — kept total for the checker.
  return undefined;
}

/** A stable string key for a scalar consumer field value (objects/arrays never key a dedup). */
function scalarKey(value: JsonValue): string {
  if (typeof value === "string") {
    return `s:${value}`;
  }
  if (typeof value === "number") {
    return `n:${String(value)}`;
  }
  if (typeof value === "boolean") {
    return `b:${String(value)}`;
  }
  // An object/array dedup-key value is not a scalar identity — encode it so it only ever
  // matches an identical structure (never a coincidental string collision).
  return `j:${JSON.stringify(value)}`;
}

/**
 * Collapse a group of same-record rows to one, merging field conflicts by the shared
 * precedence rule (AG-3.3): highest precedence (`executionOrder`, then binding id) wins each
 * field. The merged row keeps the winning row's provenance for the deterministic tiebreak.
 */
function mergeGroup(group: readonly UnionRow[]): UnionRow {
  const ordered = [...group].sort(compareBindingPrecedence);
  const winner = ordered[0];
  if (winner === undefined) {
    // Unreachable: a group is only created with >= 1 row. Kept total for the type checker.
    throw new Error("mergeGroup received an empty group");
  }
  if (ordered.length === 1 || !ordered.every((row) => isJsonRecord(row.value))) {
    // A single row, or any non-object row in the group: nothing mergeable — keep the
    // highest-precedence row's value verbatim rather than spreading lossily.
    return winner;
  }
  const merged: JsonRecord = {};
  const written = new Set<string>();
  for (const row of ordered) {
    if (!isJsonRecord(row.value)) {
      continue;
    }
    for (const [field, value] of Object.entries(row.value)) {
      if (!written.has(field)) {
        merged[field] = value;
        written.add(field);
      }
    }
  }
  return { ...winner, value: merged };
}

/** AG-4.2 — keep rows the post-merge filters all match (a filter over the merged result). */
function applyFilters(
  rows: readonly UnionRow[],
  filters: readonly ResolvedUnionFilter[],
): UnionRow[] {
  if (filters.length === 0) {
    return [...rows];
  }
  return rows.filter((row) => filters.every((filter) => matchesFilter(row.value, filter)));
}

function matchesFilter(value: JsonValue, filter: ResolvedUnionFilter): boolean {
  const fieldValue = readField(value, filter.fieldName);
  if (fieldValue === undefined || fieldValue === null) {
    // A row that does not carry the filtered field cannot satisfy the filter.
    return false;
  }
  const asString = scalarString(fieldValue);
  switch (filter.operator) {
    case "eq":
      return asString === filter.value;
    case "contains":
      return asString.includes(filter.value);
    case "gte":
      return compareValues(fieldValue, filter.value) >= 0;
    case "lte":
      return compareValues(fieldValue, filter.value) <= 0;
  }
}

/** A scalar consumer value as a comparable wire string (objects/arrays → their JSON form). */
function scalarString(value: JsonValue): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value);
}

/**
 * Compare a field value against a wire string: numerically when **both** parse as finite
 * numbers, else lexicographically. Returns <0 / 0 / >0, so `gte`/`lte` and the sort share
 * one total order.
 */
function compareValues(fieldValue: JsonValue, other: string): number {
  const left = scalarString(fieldValue);
  const leftNum = Number(left);
  const rightNum = Number(other);
  if (
    left.trim() !== "" &&
    other.trim() !== "" &&
    !Number.isNaN(leftNum) &&
    !Number.isNaN(rightNum)
  ) {
    return leftNum === rightNum ? 0 : leftNum < rightNum ? -1 : 1;
  }
  return left === other ? 0 : left < other ? -1 : 1;
}

/**
 * AG-4.3/4.5 — order the merged result by the configured sort (field + direction), then a
 * **deterministic tiebreak** (contributing backend precedence, then native id, then the
 * row's fetch index) so identical repeated requests return identical pages. With no
 * configured sort, the tiebreak alone orders the result — still stable.
 */
function sortRows(rows: readonly UnionRow[], sort: ResolvedUnionSort | undefined): UnionRow[] {
  return [...rows].sort((a, b) => {
    if (sort !== undefined) {
      const primary = compareBySortField(a, b, sort);
      if (primary !== 0) {
        return primary;
      }
    }
    return tiebreak(a, b);
  });
}

function compareBySortField(a: UnionRow, b: UnionRow, sort: ResolvedUnionSort): number {
  const av = readField(a.value, sort.fieldName);
  const bv = readField(b.value, sort.fieldName);
  const cmp = compareOptionalValues(av, bv);
  return sort.direction === "desc" ? -cmp : cmp;
}

/** Compare two optional field values; an absent/null field sorts **after** a present one. */
function compareOptionalValues(a: JsonValue | undefined, b: JsonValue | undefined): number {
  const aMissing = a === undefined || a === null;
  const bMissing = b === undefined || b === null;
  if (aMissing || bMissing) {
    return aMissing === bMissing ? 0 : aMissing ? 1 : -1;
  }
  return compareValues(a, scalarString(b));
}

/** The AG-4.5 deterministic tiebreak: contributor precedence, then native id, then fetch index. */
function tiebreak(a: UnionRow, b: UnionRow): number {
  const byContributor = compareBindingPrecedence(a, b);
  if (byContributor !== 0) {
    return byContributor;
  }
  if (a.nativeId !== b.nativeId) {
    if (a.nativeId === undefined) {
      return 1;
    }
    if (b.nativeId === undefined) {
      return -1;
    }
    return a.nativeId < b.nativeId ? -1 : 1;
  }
  return a.rowIndex - b.rowIndex;
}

/** AG-4.3 — the pagination window over the sorted merged result. */
function paginateRows(rows: readonly UnionRow[], page: ResolvedUnionPage | undefined): UnionRow[] {
  if (page === undefined) {
    return [...rows];
  }
  const start = Math.max(0, page.offset);
  const end = page.limit === undefined ? rows.length : start + Math.max(0, page.limit);
  return rows.slice(start, end);
}
