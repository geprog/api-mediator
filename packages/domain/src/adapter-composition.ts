import { z } from "zod";

import {
  postMergeDedupModeSchema,
  postMergeFilterOperatorSchema,
  postMergePaginationConventionSchema,
  postMergeSortDirectionSchema,
} from "./adapter-enums.js";
import { transformConfigSchema } from "./field-mapping.js";
import { transformKindSchema } from "./mapping-enums.js";

/**
 * The composition-time sub-shapes an `AdapterEndpoint`/`AdapterBinding` carries
 * (AD-1, AD-2). Types only: **choosing** or validating any of these values is
 * composition (CO-2/CO-3) and **executing** them is the aggregator/executor
 * (the AG and TE stories); this file only says what a composed endpoint may hold.
 *
 * Everything here is `collection-union`-only or chaining-only configuration, so
 * every field that carries it on the parent entity is `.optional()` and the
 * parent's refinement makes it unrepresentable outside its strategy
 * (`downstream-artifacts.ts`).
 */

// ── postMergeFilters (AD-1.3) ────────────────────────────────────────────────

/**
 * One consumer **filter** parameter's post-merge semantics — a filter that is not
 * pushdown-eligible (not mapped in every contributing binding), applied by the
 * mediator to the merged result itself
 * (`docs/architecture/data-model.md` `AdapterEndpoint.postMergeFilters`).
 *
 * `consumerParamRef` names the consumer operation's parameter; `consumerFieldPath`
 * the **consumer-shape** field it constrains (post-merge filtering happens after
 * the response-phase transform, so it never reaches into a backend's native
 * schema); `operator` the comparison. A filter parameter with neither pushdown nor
 * an entry here rejects requests that use it at request validation (RP-2) — it is
 * never silently answered unfiltered.
 */
export const postMergeFilterSchema = z.object({
  consumerParamRef: z.string().min(1),
  consumerFieldPath: z.string().min(1),
  operator: postMergeFilterOperatorSchema,
});
export type PostMergeFilter = z.infer<typeof postMergeFilterSchema>;

// ── postMergeSorts (AD-1.3) ──────────────────────────────────────────────────

/**
 * One accepted value of one consumer **sort** parameter, and what it orders by
 * (`docs/architecture/data-model.md` `AdapterEndpoint.postMergeSorts`). Sort is
 * never pushed down (per-backend order does not survive merging), so an entry
 * here is the only way a union endpoint can honor a sort parameter.
 *
 * `paramValue` is **present** for a value-driven sort parameter (`?sort=name`) —
 * one entry per accepted value — and **absent** for a fixed sort parameter, whose
 * mere presence selects the order. Absent is therefore meaningful, not a
 * placeholder for "any value".
 */
export const postMergeSortSchema = z.object({
  consumerParamRef: z.string().min(1),
  paramValue: z.string().min(1).optional(),
  consumerFieldPath: z.string().min(1),
  direction: postMergeSortDirectionSchema,
});
export type PostMergeSort = z.infer<typeof postMergeSortSchema>;

// ── postMergePagination (AD-1.3) ─────────────────────────────────────────────

/**
 * Which consumer parameters carry the page/offset and size inputs, and the
 * convention between them. A discriminated union on `convention` rather than an
 * optional-field bag, because `firstPageNumber` is meaningful **only** for
 * `page-number` — `?page=0` and `?page=1` name the same page in different APIs,
 * so a page-number convention that does not say which is an off-by-one-page bug
 * waiting to happen, while an offset convention has no such datum at all.
 */
export const postMergePaginationConventionValueSchema = z.discriminatedUnion("convention", [
  z.object({
    convention: z.literal(postMergePaginationConventionSchema.enum["page-number"]),
    /** The consumer parameter carrying the page number. */
    pageParamRef: z.string().min(1),
    /** The consumer parameter carrying the page size. */
    sizeParamRef: z.string().min(1),
    /** Which page number the consumer's first page has (commonly `0` or `1`). */
    firstPageNumber: z.number().int().nonnegative(),
  }),
  z.object({
    convention: z.literal(postMergePaginationConventionSchema.enum.offset),
    /** The consumer parameter carrying the number of rows to skip. */
    offsetParamRef: z.string().min(1),
    /** The consumer parameter carrying the page size. */
    sizeParamRef: z.string().min(1),
  }),
]);
export type PostMergePaginationConventionValue = z.infer<
  typeof postMergePaginationConventionValueSchema
>;

/**
 * `AdapterEndpoint.postMergePagination` — the pagination convention **plus its
 * own confirmation state**, the same `{ value, confirmedBy, confirmedAt }` shape
 * as {@link ConfirmableRef} and for the same reason: the data model calls this
 * one "heuristically pre-filled at composition and composer-confirmed, the same
 * derive-then-correct pattern as `ResourceBinding.paginationRef`", so a derived
 * convention must be distinguishable from a confirmed one and must never
 * auto-confirm itself. Requests using pagination parameters while it is
 * unconfirmed are rejected (RP-2), which is only expressible because the
 * unconfirmed state is representable.
 *
 * `confirmedBy`/`confirmedAt` are both `null` while unconfirmed and both set
 * together at confirmation — enforced by the refinement, exactly like every
 * `ResourceBinding` ref.
 */
export const postMergePaginationSchema = z
  .object({
    convention: postMergePaginationConventionValueSchema,
    confirmedBy: z.string().nullable(),
    confirmedAt: z.date().nullable(),
  })
  .superRefine((pagination, ctx) => {
    const byIsNull = pagination.confirmedBy === null;
    const atIsNull = pagination.confirmedAt === null;
    if (byIsNull !== atIsNull) {
      ctx.addIssue({
        code: "custom",
        message:
          "confirmedBy and confirmedAt must both be null (unconfirmed) or both be set (confirmed)",
        path: [byIsNull ? "confirmedBy" : "confirmedAt"],
      });
    }
  });
export type PostMergePagination = z.infer<typeof postMergePaginationSchema>;

// ── postMergeDedup (AD-1.4) ──────────────────────────────────────────────────

/**
 * How a `collection-union` endpoint collapses duplicate rows
 * (`docs/architecture/data-model.md` `AdapterEndpoint.postMergeDedup`).
 *
 * A **discriminated union** on `mode` rather than `{ mode, dedupKeyFieldPath? }`
 * loose-optional soup: `dedupKeyFieldPath` is required by — and only by — the
 * `dedup-key` mode, so the union makes "dedup-key without a field path" and
 * "record-link with a stray field path" both unrepresentable.
 *
 * AD-1.4's three states are `none` / `record-link` / `dedup-key`. A **fourth**
 * state is the parent's *absent* `postMergeDedup` key: "not composed yet",
 * distinct from the explicitly chosen `none`. That distinction is the point of
 * modeling `none` as a real value instead of an absent field (CO-3.1: no dedup is
 * an explicit choice, never an inference).
 */
export const postMergeDedupSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal(postMergeDedupModeSchema.enum.none) }),
  z.object({ mode: z.literal(postMergeDedupModeSchema.enum["record-link"]) }),
  z.object({
    mode: z.literal(postMergeDedupModeSchema.enum["dedup-key"]),
    /** The **consumer**-schema field whose value identifies a duplicate row. */
    dedupKeyFieldPath: z.string().min(1),
  }),
]);
export type PostMergeDedup = z.infer<typeof postMergeDedupSchema>;

// ── acknowledgedIgnoredInputs (CO-5.4) ───────────────────────────────────────

/**
 * One consumer input the composer has **explicitly acknowledged as ignored** — an
 * input that reaches no backend (no `ParameterMapping`/`chainInput` for a parameter,
 * no request-phase `FieldMapping` for a body field) and that the composer chose to
 * **serve-and-drop** rather than reject (CO-5.2/CO-5.4). Recorded on the
 * `AdapterEndpoint` so the runtime can tell an acknowledged input (served, dropped —
 * the acknowledgement is what makes the drop non-silent) from an unacknowledged one
 * (still rejected as `unmapped-consumer-input`, RP-2.4).
 *
 * A **discriminated union** on `kind` rather than an optional-field bag: a
 * `parameter` is matched at request time by its **bare consumer parameter name**
 * (`consumerParamName`, the name the RP-2 inbound check compares), a `body-field` by
 * its **consumer request-schema field path** (`consumerFieldPath`).
 *
 * Only an **optional** unmapped input can be acknowledged: a **required** consumer
 * input that reaches no backend is a mapping defect, a blocking composition finding
 * (CO-5.3) that cannot be acknowledged away.
 */
export const acknowledgedIgnoredInputSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("parameter"), consumerParamName: z.string().min(1) }),
  z.object({ kind: z.literal("body-field"), consumerFieldPath: z.string().min(1) }),
]);
export type AcknowledgedIgnoredInput = z.infer<typeof acknowledgedIgnoredInputSchema>;

// ── chainInputs (AD-2.2) ─────────────────────────────────────────────────────

/**
 * One chained input of an `AdapterBinding`: it feeds **one** backend-operation
 * parameter of *this* binding from a field of the **upstream** binding's response
 * (`docs/architecture/data-model.md` `AdapterBinding.chainInputs`).
 *
 * - `upstreamFieldPath` — a path into the upstream binding's **consumer-shape**
 *   response (i.e. after that binding's response-phase transform), deliberately
 *   never the upstream backend's native schema, so a chain never couples two
 *   backends' native schemas directly.
 * - `targetParamRef` — a parameter of *this* binding's backend operation.
 * - `transform` / `transformConfig` — the same transform vocabulary and sandboxed
 *   `expression` evaluator as `FieldMapping` (`docs/architecture/security.md`
 *   *Transformation expression sandboxing*), reused rather than re-coined.
 *   Absent means the upstream value is passed through unchanged.
 *
 * Chain wiring is **composition state, not reviewed correspondence** (AD-2.4), so
 * it lives here on the binding rather than under the mapping's `OperationMapping`s
 * — which is exactly what lets successor adoption carry it over mechanically when
 * the underlying mapping is superseded.
 */
export const chainInputSchema = z.object({
  upstreamFieldPath: z.string().min(1),
  targetParamRef: z.string().min(1),
  transform: transformKindSchema.optional(),
  transformConfig: transformConfigSchema.optional(),
});
export type ChainInput = z.infer<typeof chainInputSchema>;

// ── executionOrder default (AD-2.1 / AD-2.5) ─────────────────────────────────

/**
 * The `AdapterBinding.executionOrder` the data model documents as its default
 * ("int, default 0").
 *
 * It is a **constant applied by readers**, not a Zod or column `.default()`, for
 * the SD-1 reason: a default that materialises a *present* value would make a
 * Phase-3-attached binding — which was composed with nothing — read back as
 * though someone had ordered it (AD-6.2). The column is nullable with no DB
 * default, the domain field is `.optional()`, and {@link resolveExecutionOrder}
 * is the single place that turns "absent" into "the default", so AD-2.5's "its
 * default" and AD-6.2's "every Phase-5 field absent" are both true at once.
 */
export const DEFAULT_EXECUTION_ORDER = 0;

/**
 * The effective execution order of a binding: its composed `executionOrder`, or
 * {@link DEFAULT_EXECUTION_ORDER} when it has none (never composed). Callers
 * ordering bindings use this rather than reading the optional field directly, so
 * an uncomposed binding sorts deterministically instead of `undefined`-first.
 */
export function resolveExecutionOrder(binding: { executionOrder?: number }): number {
  return binding.executionOrder ?? DEFAULT_EXECUTION_ORDER;
}
