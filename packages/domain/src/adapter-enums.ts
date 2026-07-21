import { z } from "zod";

/**
 * Canonical domain enumerations for the Phase 5 adapter composition/serving slice
 * (`AdapterEndpoint` composition state, `AdapterBinding` chaining state, the
 * write-outcome store, and the `adapter-request` audit columns — AD-1..AD-5).
 *
 * Same triple-derivation pattern as `enums.ts` / `sync-enums.ts` (a single tuple
 * of literals yields the Zod validator, the string-union type, and the
 * `as const`-style value object):
 *
 * ```ts
 * export const fooSchema = z.enum(["a", "b"]);   // runtime validator
 * export type Foo = z.infer<typeof fooSchema>;   // "a" | "b"
 * export const Foo = fooSchema.enum;             // { a: "a"; b: "b" }
 * ```
 *
 * Literal spellings are taken **verbatim** from `docs/architecture/data-model.md`,
 * `docs/architecture/adapter-engine.md`, and `docs/glossary.md` and must not be
 * renamed. The three enums Phase 3 already owns — `adapterEndpointStatus`,
 * `adapterBindingRole`, `adapterBindingStatus` — live in
 * `approved-mapping-enums.ts` and are **reused unchanged** (AD-1.1, AD-2.1).
 */

// ── AdapterEndpoint.aggregationStrategy (AD-1) ───────────────────────────────

/**
 * How an `AdapterEndpoint` combines the results of its `AdapterBinding`s
 * (`docs/architecture/data-model.md` `AdapterEndpoint.aggregationStrategy`;
 * `docs/glossary.md` `Aggregation strategy`). Exactly these four values — the
 * concept coins no `list`-style extra, and a write endpoint is always `single`
 * (`docs/architecture/adapter-engine.md` *Write operations*).
 */
export const aggregationStrategySchema = z.enum([
  "single",
  "fanout-merge",
  "collection-union",
  "fanout-first-success",
]);
export type AggregationStrategy = z.infer<typeof aggregationStrategySchema>;
export const AggregationStrategy = aggregationStrategySchema.enum;

// ── AdapterEndpoint.strictness (AD-1) ────────────────────────────────────────

/**
 * An `AdapterEndpoint`'s partial-failure mode
 * (`docs/architecture/data-model.md` `AdapterEndpoint.strictness`;
 * `docs/glossary.md` `Strictness`;
 * `docs/architecture/adapter-engine.md` *Error and partial-failure semantics*).
 *
 * Under `degraded` a failed `supplement` binding omits the (necessarily
 * *optional*) consumer fields it would have supplied and the degradation is
 * signalled out-of-band via a response header. Under `strict` any binding failure
 * fails the whole request regardless of role. The **load-bearing-supplement**
 * rule is not a third value: a `supplement` supplying a *required* consumer field
 * fails the whole request even under `degraded`, which is a property of the
 * consumer schema (evaluated at composition — CO-4), not of this enum.
 */
export const endpointStrictnessSchema = z.enum(["strict", "degraded"]);
export type EndpointStrictness = z.infer<typeof endpointStrictnessSchema>;
export const EndpointStrictness = endpointStrictnessSchema.enum;

// ── AdapterEndpoint.postMergeFilters[].operator (AD-1) ───────────────────────

/**
 * The comparison a `postMergeFilters` entry applies to the merged result
 * (`docs/architecture/data-model.md` `AdapterEndpoint.postMergeFilters`). Exactly
 * these four — a filter parameter with neither pushdown nor an entry here rejects
 * requests that use it, rather than being approximated by a wider operator set.
 */
export const postMergeFilterOperatorSchema = z.enum(["eq", "contains", "gte", "lte"]);
export type PostMergeFilterOperator = z.infer<typeof postMergeFilterOperatorSchema>;
export const PostMergeFilterOperator = postMergeFilterOperatorSchema.enum;

// ── AdapterEndpoint.postMergeSorts[].direction (AD-1) ────────────────────────

/**
 * The order a `postMergeSorts` entry imposes on the merged result
 * (`docs/architecture/data-model.md` `AdapterEndpoint.postMergeSorts`).
 */
export const postMergeSortDirectionSchema = z.enum(["asc", "desc"]);
export type PostMergeSortDirection = z.infer<typeof postMergeSortDirectionSchema>;
export const PostMergeSortDirection = postMergeSortDirectionSchema.enum;

// ── AdapterEndpoint.postMergeDedup.mode (AD-1) ───────────────────────────────

/**
 * How a `collection-union` endpoint collapses duplicate rows
 * (`docs/architecture/data-model.md` `AdapterEndpoint.postMergeDedup`;
 * `docs/glossary.md` `postMergeDedup`).
 *
 * - `record-link` — collapse rows the mediator can *know* are the same record,
 *   via existing `RecordLink`s between peer-synced backends. Offered at
 *   composition only when every contributing backend resource has its
 *   `ResourceBinding.nativeIdRef` confirmed (CO-3 enforces that, not this type).
 * - `dedup-key` — collapse on a field of the **consumer** schema.
 * - `none` — the honest default: duplicates are returned as mapped, provenance
 *   out-of-band. An *explicit* choice, never an inferred one (CO-3.1).
 */
export const postMergeDedupModeSchema = z.enum(["none", "record-link", "dedup-key"]);
export type PostMergeDedupMode = z.infer<typeof postMergeDedupModeSchema>;
export const PostMergeDedupMode = postMergeDedupModeSchema.enum;

// ── AdapterEndpoint.postMergePagination convention (AD-1) ────────────────────

/**
 * Which pagination convention a union endpoint's consumer parameters express
 * (`docs/architecture/data-model.md` `AdapterEndpoint.postMergePagination`:
 * "which consumer parameters carry the page/offset and size inputs and the
 * convention between them").
 *
 * - `page-number` — the position parameter counts *pages* (its first page number
 *   is part of the convention, since `?page=0` and `?page=1` name the same page
 *   in different APIs).
 * - `offset` — the position parameter counts *rows* skipped.
 */
export const postMergePaginationConventionSchema = z.enum(["page-number", "offset"]);
export type PostMergePaginationConvention = z.infer<typeof postMergePaginationConventionSchema>;
export const PostMergePaginationConvention = postMergePaginationConventionSchema.enum;

// ── AuditLog.cause on an `adapter-request` row (AD-5) ────────────────────────

/**
 * Why an `adapter-request` audit row did not serve a clean result
 * (`docs/architecture/adapter-engine.md` *Error and partial-failure semantics*;
 * `docs/glossary.md` adapter error entries). The **six named causes** plus a
 * seventh for "the backend itself failed", so every failure is attributable to a
 * distinguishable cause rather than collapsing into one opaque error (AD-5.2).
 *
 * This is deliberately **not** an `AuditLogStatus` value: the row reuses the
 * Phase-4 `status` enum unchanged and carries the cause separately (AD-5.5).
 */
export const adapterRequestCauseSchema = z.enum([
  "not-yet-mapped",
  "endpoint-disabled",
  "mapping-stale",
  "mapping-suspended",
  "backend-disabled",
  "mediator-transform-error",
  "upstream-error",
]);
export type AdapterRequestCause = z.infer<typeof adapterRequestCauseSchema>;
export const AdapterRequestCause = adapterRequestCauseSchema.enum;

// ── AdapterWriteOutcome.outcome (AD-4) ───────────────────────────────────────

/**
 * Whether the recorded original execution of a deduplicated adapter write
 * succeeded or failed (`docs/architecture/adapter-engine.md` *Write operations* —
 * *Failure semantics*). A replayed delivery of a **failed** write is answered
 * with that failure, never treated as never-executed and never answered with a
 * fabricated success (AD-4.5).
 */
export const adapterWriteOutcomeStatusSchema = z.enum(["success", "failure"]);
export type AdapterWriteOutcomeStatus = z.infer<typeof adapterWriteOutcomeStatusSchema>;
export const AdapterWriteOutcomeStatus = adapterWriteOutcomeStatusSchema.enum;
