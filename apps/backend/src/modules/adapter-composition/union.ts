import type {
  AggregationStrategy,
  IrParameter,
  PostMergeDedup,
  PostMergeFilter,
  PostMergePaginationConventionValue,
  PostMergeSort,
} from "@mediator/domain";

import { topLevelConsumerFieldName } from "./analysis.js";
import { bareParamName } from "./refs.js";

/**
 * **CO-3 — union composition (dedup, post-merge filters, sorts, pagination).** The pure
 * derivation + validation for a `collection-union` `AdapterEndpoint`, so a union never
 * answers a request whose semantics nobody defined
 * (`docs/architecture/adapter-engine.md` *Aggregation strategies*;
 * `docs/flows/adapter-endpoint-composition.md` step 4;
 * `docs/architecture/data-model.md` `AdapterEndpoint.postMerge*`).
 *
 * No I/O: it takes the submitted union config plus the per-contributing-resource facts
 * the {@link import("./context.js").CompositionContextLoader} loads (each backend
 * resource's confirmed `ResourceBinding.nativeIdRef`/`collectionReadRef`/`paginationRef`
 * state and the consumer params it pushes down), and the consumer operation's own
 * parameters + response fields. It folds into CO-2's atomic activation via
 * {@link import("./validate.js").validateComposition}: a union that fails any rule here
 * activates nothing.
 *
 * Executing the union — pushdown vs. post-merge filtering, sorting, paging, dedup — is
 * the aggregator's job (AG-3/AG-4/AG-5); this file only decides whether the union
 * configuration may be activated and what the composer still has to decide.
 */

// ── union parameter classification (a conservative name heuristic) ───────────

/**
 * How a consumer **query** parameter behaves under a union (the split
 * `docs/architecture/adapter-engine.md` *Aggregation strategies* draws):
 *
 * - `pagination` — a page/offset/size input. **Never pushed down** (page N of each
 *   backend is not page N of the union), so it is honorable only via a confirmed
 *   `postMergePagination`.
 * - `sort` — an ordering input. **Never pushed down** (per-backend order does not
 *   survive merging), so honorable only via a `postMergeSorts` entry.
 * - `filter` — everything else: pushed down when mapped in *every* contributing
 *   binding, otherwise honorable only via a `postMergeFilters` entry.
 *
 * The classification is a **conservative** name heuristic, exactly the derive-then-confirm
 * spirit of `ResourceBinding.paginationRef`: only unambiguous, well-known
 * pagination/sort spellings are pulled out of the default `filter` bucket, because the
 * authoritative honoring is always the composer's `postMerge*` config — a filter mis-read
 * as a sort is still served the moment the composer configures it (the runtime consults
 * the config before the heuristic). It is deliberately shared by composition (this module)
 * and request validation (`serve/ir-validation.ts`) so the two never disagree on what a
 * parameter *is* — the recurring "two sides classify differently" bug class.
 *
 * Applies to **query** parameters only; a path parameter is a record/scope input and a
 * header/cookie is not a list parameter, so the caller restricts classification to
 * `location === "query"`.
 */
export type UnionParameterKind = "pagination" | "sort" | "filter";

/** Lower-case a parameter name and strip separators, so `page_size`/`pageSize` normalize alike. */
function normalizeParamName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Well-known pagination position/size spellings (normalized). Kept tight to avoid over-classifying a filter. */
const PAGINATION_PARAM_NAMES: ReadonlySet<string> = new Set([
  "page",
  "pagenumber",
  "pageindex",
  "offset",
  "skip",
  "start",
  "cursor",
  "limit",
  "pagesize",
  "perpage",
  "size",
  "count",
  "pagelimit",
]);

/** Well-known sort spellings (normalized). Kept tight for the same reason. */
const SORT_PARAM_NAMES: ReadonlySet<string> = new Set([
  "sort",
  "sortby",
  "order",
  "orderby",
  "ordering",
  "sortorder",
]);

/** Classify one consumer query parameter under a union (see {@link UnionParameterKind}). */
export function classifyUnionParameter(param: IrParameter): UnionParameterKind {
  const normalized = normalizeParamName(param.name);
  if (PAGINATION_PARAM_NAMES.has(normalized)) {
    return "pagination";
  }
  if (SORT_PARAM_NAMES.has(normalized)) {
    return "sort";
  }
  return "filter";
}

// ── per-contributing-resource facts (validator + derivation input) ───────────

/**
 * The persisted union facts about one contributing binding — its backend resource's
 * `ResourceBinding` ref confirmation state and the consumer parameters it pushes down.
 * Loaded once by the context loader (all resource-pair scoped) so this module stays pure.
 */
export interface UnionBindingFacts {
  readonly bindingId: string;
  /** The binding's backend resource ref (the `resourceRef` of `backendOperationId`). */
  readonly backendResourceRef: string;
  /** CO-3.2 — `link-based` dedup needs every contributing resource's native id as row provenance. */
  readonly nativeIdRefConfirmed: boolean;
  /** CO-3.7 — a union is composable over a resource only with its collection read confirmed (AG-5.3). */
  readonly collectionReadRefConfirmed: boolean;
  /** CO-3.7 — whether a `paginationRef` was derived at all (absent = the read is not paged). */
  readonly paginationRefPresent: boolean;
  /** CO-3.7 — whether that `paginationRef` is confirmed (required only where the read is paged). */
  readonly paginationRefConfirmed: boolean;
  /**
   * The bare consumer parameter names this binding maps via a `ParameterMapping`
   * (pair-scoped source refs) — the pushdown source. A filter parameter is pushdown-eligible
   * only when present here for **every** contributing binding (CO-3.4).
   */
  readonly pushdownConsumerParamNames: ReadonlySet<string>;
}

/** The union slice of a composition submission — the CO-3 config the composer supplies. */
export interface UnionSubmission {
  readonly postMergeDedup?: PostMergeDedup;
  readonly postMergeFilters?: readonly PostMergeFilter[];
  readonly postMergeSorts?: readonly PostMergeSort[];
  /** The pagination convention the composer proposes; confirmation is stamped server-side (CO-3.5). */
  readonly postMergePagination?: PostMergePaginationConventionValue;
}

/** The full CO-3 validation input: the submission plus the loaded facts. */
export interface UnionValidationInput {
  readonly strategy: AggregationStrategy;
  readonly submission: UnionSubmission;
  readonly unionBindingFacts: readonly UnionBindingFacts[];
  /** The consumer operation's declared parameters (for ref existence + classification). */
  readonly consumerParameters: readonly IrParameter[];
  /** The consumer operation's response-schema field names (bare, top-level) — the consumer-shape fields. */
  readonly consumerResponseFieldNames: ReadonlySet<string>;
}

// ── named rejection reasons ──────────────────────────────────────────────────

/**
 * Why a union composition is not activatable — a discriminated union on `code`, every
 * variant naming the offending binding / resource / parameter / field. Included in
 * `validate.ts`'s {@link import("./validate.js").CompositionRejectionReason} so the whole
 * composition validates (and rejects) as one atomic decision (CO-2.8).
 */
export type UnionRejectionReason =
  | {
      readonly code: "union-config-on-non-union";
      readonly field: string;
      readonly strategy: AggregationStrategy;
    }
  | { readonly code: "union-missing-dedup-choice" }
  | {
      readonly code: "union-link-based-native-id-unconfirmed";
      readonly bindingId: string;
      readonly backendResourceRef: string;
    }
  | { readonly code: "union-dedup-key-unknown-field"; readonly dedupKeyFieldPath: string }
  | {
      readonly code: "union-not-composable-collection-read";
      readonly bindingId: string;
      readonly backendResourceRef: string;
    }
  | {
      readonly code: "union-not-composable-pagination";
      readonly bindingId: string;
      readonly backendResourceRef: string;
    }
  | { readonly code: "union-filter-unknown-param"; readonly consumerParamRef: string }
  | {
      readonly code: "union-filter-unknown-field";
      readonly consumerParamRef: string;
      readonly consumerFieldPath: string;
    }
  | { readonly code: "union-sort-unknown-param"; readonly consumerParamRef: string }
  | {
      readonly code: "union-sort-unknown-field";
      readonly consumerParamRef: string;
      readonly consumerFieldPath: string;
    }
  | { readonly code: "union-pagination-unknown-param"; readonly consumerParamRef: string };

// ── the validator ────────────────────────────────────────────────────────────

/**
 * Validate the union slice of a composition. Returns every violated CO-3 rule named
 * (no short-circuit), or an empty list when the union configuration is activatable.
 * When `strategy` is not `collection-union` it only rejects stray union config; the
 * union-specific rules apply solely to a real union.
 */
export function validateUnionConfiguration(input: UnionValidationInput): UnionRejectionReason[] {
  const { strategy, submission } = input;
  const reasons: UnionRejectionReason[] = [];

  // Union configuration is unrepresentable outside a union (the AD-1 domain refinement
  // enforces this on the entity too); reject a stray field with a named reason so the
  // composer sees *why* rather than an opaque persistence failure.
  if (strategy !== "collection-union") {
    const strayFields: [string, unknown][] = [
      ["postMergeDedup", submission.postMergeDedup],
      ["postMergeFilters", submission.postMergeFilters],
      ["postMergeSorts", submission.postMergeSorts],
      ["postMergePagination", submission.postMergePagination],
    ];
    for (const [field, value] of strayFields) {
      if (value !== undefined) {
        reasons.push({ code: "union-config-on-non-union", field, strategy });
      }
    }
    return reasons;
  }

  // CO-3.1 — dedup is an explicit choice (none / record-link / dedup-key), never an unset
  // default that silently means something. A union with no dedup submitted is incomplete.
  const dedup = submission.postMergeDedup;
  if (dedup === undefined) {
    reasons.push({ code: "union-missing-dedup-choice" });
  } else if (dedup.mode === "record-link") {
    // CO-3.2 — link-based dedup needs each row's backend-native id as provenance, so it is
    // valid only when EVERY contributing backend resource has a confirmed nativeIdRef.
    for (const facts of input.unionBindingFacts) {
      if (!facts.nativeIdRefConfirmed) {
        reasons.push({
          code: "union-link-based-native-id-unconfirmed",
          bindingId: facts.bindingId,
          backendResourceRef: facts.backendResourceRef,
        });
      }
    }
  } else if (dedup.mode === "dedup-key") {
    // The dedup key is a field of the CONSUMER schema (dedup runs on consumer-shape rows).
    if (!input.consumerResponseFieldNames.has(topLevelConsumerFieldName(dedup.dedupKeyFieldPath))) {
      reasons.push({
        code: "union-dedup-key-unknown-field",
        dedupKeyFieldPath: dedup.dedupKeyFieldPath,
      });
    }
  }

  // CO-3.7 — a union is composable over a contributing resource only with its collection
  // read confirmed, and its pagination confirmed where the read is paged (a present-but-
  // unconfirmed paginationRef). Otherwise AG-5 cannot enumerate it — not composable.
  for (const facts of input.unionBindingFacts) {
    if (!facts.collectionReadRefConfirmed) {
      reasons.push({
        code: "union-not-composable-collection-read",
        bindingId: facts.bindingId,
        backendResourceRef: facts.backendResourceRef,
      });
    }
    if (facts.paginationRefPresent && !facts.paginationRefConfirmed) {
      reasons.push({
        code: "union-not-composable-pagination",
        bindingId: facts.bindingId,
        backendResourceRef: facts.backendResourceRef,
      });
    }
  }

  const consumerParamNames = new Set(input.consumerParameters.map((param) => param.name));
  const knowsParam = (ref: string): boolean => consumerParamNames.has(bareParamName(ref));
  const knowsField = (path: string): boolean =>
    input.consumerResponseFieldNames.has(topLevelConsumerFieldName(path));

  // CO-3.4 — a postMergeFilters entry must name a real consumer parameter and a real
  // consumer-shape field (post-merge filtering runs after the response transform).
  for (const filter of submission.postMergeFilters ?? []) {
    if (!knowsParam(filter.consumerParamRef)) {
      reasons.push({
        code: "union-filter-unknown-param",
        consumerParamRef: filter.consumerParamRef,
      });
    }
    if (!knowsField(filter.consumerFieldPath)) {
      reasons.push({
        code: "union-filter-unknown-field",
        consumerParamRef: filter.consumerParamRef,
        consumerFieldPath: filter.consumerFieldPath,
      });
    }
  }

  // CO-3.5 — a postMergeSorts entry must likewise name a real consumer parameter + field.
  for (const sort of submission.postMergeSorts ?? []) {
    if (!knowsParam(sort.consumerParamRef)) {
      reasons.push({ code: "union-sort-unknown-param", consumerParamRef: sort.consumerParamRef });
    }
    if (!knowsField(sort.consumerFieldPath)) {
      reasons.push({
        code: "union-sort-unknown-field",
        consumerParamRef: sort.consumerParamRef,
        consumerFieldPath: sort.consumerFieldPath,
      });
    }
  }

  // CO-3.5 — the pagination convention's parameter refs must all be real consumer params.
  for (const ref of paginationConventionParamRefs(submission.postMergePagination)) {
    if (!knowsParam(ref)) {
      reasons.push({ code: "union-pagination-unknown-param", consumerParamRef: ref });
    }
  }

  return reasons;
}

/** The consumer parameter refs a pagination convention names (page/offset + size). */
export function paginationConventionParamRefs(
  convention: PostMergePaginationConventionValue | undefined,
): readonly string[] {
  if (convention === undefined) {
    return [];
  }
  return convention.convention === "page-number"
    ? [convention.pageParamRef, convention.sizeParamRef]
    : [convention.offsetParamRef, convention.sizeParamRef];
}

// ── CO-3 composer derivations (preview, derive-then-confirm) ─────────────────

/**
 * The CO-3 derivations the composer sees before confirming — none of it auto-applied:
 * which filters are unserviceable (CO-3.4), which sort/pagination parameters still need a
 * decision (CO-3.5), the dedup conflict-precedence rule (CO-3.3), and the large-collection
 * size flag (CO-3.8). A union that activates with unserviceable filters or unconfirmed
 * sort/pagination is legal — requests using those parameters simply reject at RP-2.
 */
export interface UnionCompositionAnalysis {
  /** CO-3.4 — filter parameters neither pushdown-eligible nor covered by a postMergeFilters entry. */
  readonly unserviceableFilters: readonly string[];
  /** CO-3.5 — sort parameters with no postMergeSorts entry yet (requests using them reject at RP-2). */
  readonly unconfiguredSortParameters: readonly string[];
  /** CO-3.5 — pagination parameters detected with no confirmed postMergePagination covering them. */
  readonly unconfiguredPaginationParameters: readonly string[];
  /** CO-3.3 — field conflicts between merged rows resolve by this rule (compareBindingPrecedence). */
  readonly dedupConflictPrecedence: "executionOrder-then-bindingId";
  /** CO-3.8 — a union materializes the full merged collection per request; cacheTtl is the mitigation. */
  readonly largeCollectionRisk: {
    readonly flagged: true;
    readonly mitigation: "cacheTtl";
    readonly cacheTtlConfigured: boolean;
  };
}

/** The input for {@link deriveUnionCompositionAnalysis}: the loaded facts + the proposed config. */
export interface UnionAnalysisInput {
  readonly unionBindingFacts: readonly UnionBindingFacts[];
  readonly consumerParameters: readonly IrParameter[];
  readonly submission: UnionSubmission;
  readonly cacheTtlConfigured: boolean;
}

/**
 * Derive the CO-3 composer-facing analysis for a proposed union. Pure: it classifies the
 * consumer operation's query parameters and reports which are unserviceable / still need a
 * decision, plus the always-on precedence rule and size flag. A pushdown-eligible filter
 * is one mapped in **every** contributing binding.
 */
export function deriveUnionCompositionAnalysis(
  input: UnionAnalysisInput,
): UnionCompositionAnalysis {
  const pushdownEligible = pushdownEligibleParamNames(input.unionBindingFacts);
  const filterParamRefs = new Set(
    (input.submission.postMergeFilters ?? []).map((filter) =>
      bareParamName(filter.consumerParamRef),
    ),
  );
  const sortParamRefs = new Set(
    (input.submission.postMergeSorts ?? []).map((sort) => bareParamName(sort.consumerParamRef)),
  );
  const paginationParamRefs = new Set(
    paginationConventionParamRefs(input.submission.postMergePagination).map(bareParamName),
  );

  const unserviceableFilters: string[] = [];
  const unconfiguredSortParameters: string[] = [];
  const unconfiguredPaginationParameters: string[] = [];
  for (const param of input.consumerParameters) {
    if (param.location !== "query") {
      continue;
    }
    const kind = classifyUnionParameter(param);
    if (kind === "filter") {
      if (!pushdownEligible.has(param.name) && !filterParamRefs.has(param.name)) {
        unserviceableFilters.push(param.name);
      }
    } else if (kind === "sort") {
      if (!sortParamRefs.has(param.name)) {
        unconfiguredSortParameters.push(param.name);
      }
    } else if (!paginationParamRefs.has(param.name)) {
      unconfiguredPaginationParameters.push(param.name);
    }
  }

  return {
    unserviceableFilters,
    unconfiguredSortParameters,
    unconfiguredPaginationParameters,
    dedupConflictPrecedence: "executionOrder-then-bindingId",
    largeCollectionRisk: {
      flagged: true,
      mitigation: "cacheTtl",
      cacheTtlConfigured: input.cacheTtlConfigured,
    },
  };
}

/** The consumer parameter names pushed down over the union — those mapped in **every** binding. */
export function pushdownEligibleParamNames(
  unionBindingFacts: readonly UnionBindingFacts[],
): ReadonlySet<string> {
  const [first, ...rest] = unionBindingFacts;
  if (first === undefined) {
    return new Set<string>();
  }
  const intersection = new Set(first.pushdownConsumerParamNames);
  for (const facts of rest) {
    for (const name of intersection) {
      if (!facts.pushdownConsumerParamNames.has(name)) {
        intersection.delete(name);
      }
    }
  }
  return intersection;
}

// ── rendering rejections for the HTTP boundary ───────────────────────────────

/** Render one {@link UnionRejectionReason} into a `{ path, message }` issue (names only, never a value). */
export function formatUnionRejection(reason: UnionRejectionReason): {
  readonly path: string;
  readonly message: string;
} {
  switch (reason.code) {
    case "union-config-on-non-union":
      return {
        path: reason.field,
        message: `${reason.field} is collection-union only, but the strategy is '${reason.strategy}'.`,
      };
    case "union-missing-dedup-choice":
      return {
        path: "postMergeDedup",
        message:
          "A collection-union must choose a dedup mode (none / record-link / dedup-key) — 'none' is an explicit choice, never an unset default.",
      };
    case "union-link-based-native-id-unconfirmed":
      return {
        path: "postMergeDedup",
        message: `Link-based dedup needs a confirmed ResourceBinding.nativeIdRef on every contributing resource, but binding ${reason.bindingId} (resource '${reason.backendResourceRef}') has none.`,
      };
    case "union-dedup-key-unknown-field":
      return {
        path: "postMergeDedup.dedupKeyFieldPath",
        message: `dedup key '${reason.dedupKeyFieldPath}' is not a field of the consumer response schema.`,
      };
    case "union-not-composable-collection-read":
      return {
        path: `bindings.${reason.bindingId}`,
        message: `The union is not composable over binding ${reason.bindingId} (resource '${reason.backendResourceRef}'): its ResourceBinding.collectionReadRef is not confirmed.`,
      };
    case "union-not-composable-pagination":
      return {
        path: `bindings.${reason.bindingId}`,
        message: `The union is not composable over binding ${reason.bindingId} (resource '${reason.backendResourceRef}'): its collection read is paged but ResourceBinding.paginationRef is not confirmed.`,
      };
    case "union-filter-unknown-param":
      return {
        path: "postMergeFilters",
        message: `postMergeFilters.consumerParamRef '${reason.consumerParamRef}' is not a parameter of the consumer operation.`,
      };
    case "union-filter-unknown-field":
      return {
        path: "postMergeFilters",
        message: `postMergeFilters.consumerFieldPath '${reason.consumerFieldPath}' (for parameter '${reason.consumerParamRef}') is not a consumer response field.`,
      };
    case "union-sort-unknown-param":
      return {
        path: "postMergeSorts",
        message: `postMergeSorts.consumerParamRef '${reason.consumerParamRef}' is not a parameter of the consumer operation.`,
      };
    case "union-sort-unknown-field":
      return {
        path: "postMergeSorts",
        message: `postMergeSorts.consumerFieldPath '${reason.consumerFieldPath}' (for parameter '${reason.consumerParamRef}') is not a consumer response field.`,
      };
    case "union-pagination-unknown-param":
      return {
        path: "postMergePagination",
        message: `postMergePagination references consumer parameter '${reason.consumerParamRef}', which the consumer operation does not declare.`,
      };
  }
}
