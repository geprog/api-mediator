import {
  resolveExecutionOrder,
  type AcknowledgedIgnoredInput,
  type AdapterBindingRole,
  type AggregationStrategy,
  type ChainInput,
  type EndpointStrictness,
  type IrParameter,
  type PostMergeDedup,
  type PostMergeFilter,
  type PostMergePaginationConventionValue,
  type PostMergeSort,
} from "@mediator/domain";

import {
  acknowledgementInputName,
  acknowledgementMatchesInput,
  deriveConsumerInputCoverage,
  type ConsumerInputUniverse,
} from "./analysis.js";
import { bareParamName } from "./refs.js";
import {
  formatUnionRejection,
  validateUnionConfiguration,
  type UnionBindingFacts,
  type UnionRejectionReason,
} from "./union.js";

/**
 * **CO-2 — the composition decision and its validation.** The pure validator that
 * refuses any multi-binding `AdapterEndpoint` configuration whose serving semantics
 * are undefined, so an endpoint never goes live in a state the runtime cannot execute
 * (`docs/architecture/adapter-engine.md` *Role validity per aggregation strategy* /
 * order-chaining validity rules / *Write operations*;
 * `docs/flows/adapter-endpoint-composition.md` step 5).
 *
 * No I/O: it takes the submitted composition plus the per-binding **facts** the
 * {@link import("./context.js").CompositionContextLoader} loads from persisted state
 * (the backend operation's parameters, that mapping's approved `ParameterMapping`s,
 * its `phase = response` `FieldMapping`s, and its operation `action`) and returns a
 * discriminated result — `ok`, or `rejected` with a list of **named** reasons. Every
 * rule is checked (no short-circuit) so the composer sees everything wrong at once,
 * each reason naming the offending binding / role / parameter (feeds CU-1 later).
 *
 * Executing an activated composition is the aggregator/executor's job (AG-*); this
 * file only decides whether the configuration may be activated at all.
 */

// ── The role-validity table (authoritative) ──────────────────────────────────

/**
 * **The role-validity table, as data** (`docs/architecture/adapter-engine.md`
 * *Role validity per aggregation strategy*). Each `aggregationStrategy` maps to the
 * exact set of `AdapterBinding.role`s it uses; a role outside its strategy's set is
 * rejected (CO-2.2). Encoded as a table — one entry per strategy — precisely so it
 * reads back one-to-one against the concept doc rather than as scattered conditionals:
 *
 * | `aggregationStrategy`   | Valid `role`(s)          |
 * |-------------------------|--------------------------|
 * | `single`                | `primary`                |
 * | `fanout-merge`          | `primary`, `supplement`  |
 * | `collection-union`      | `supplement`             |
 * | `fanout-first-success`  | `primary`, `fallback`    |
 */
export const ROLE_VALIDITY_BY_STRATEGY: Readonly<
  Record<AggregationStrategy, readonly AdapterBindingRole[]>
> = {
  single: ["primary"],
  "fanout-merge": ["primary", "supplement"],
  "collection-union": ["supplement"],
  "fanout-first-success": ["primary", "fallback"],
};

/**
 * The one strategy `dependsOnBindingId` (and therefore `chainInputs`) is valid under
 * (`docs/architecture/adapter-engine.md`: "`dependsOnBindingId` is valid under
 * `fanout-merge` only"). Named as a constant so CO-2.3 reads against the doc.
 */
export const CHAINING_STRATEGY: AggregationStrategy = "fanout-merge";

// ── Submission + per-binding facts (validator inputs) ────────────────────────

/** One binding's composition choices, as submitted by the composer (CO-2.1). */
export interface SubmittedBindingComposition {
  readonly bindingId: string;
  readonly role: AdapterBindingRole;
  readonly executionOrder?: number;
  readonly dependsOnBindingId?: string;
  readonly chainInputs?: readonly ChainInput[];
  /**
   * CO-6.2 — mark this binding **disabled** in a (re)composition. A disabled binding is
   * still **addressed** (so the coverage check treats it as configured, not forgotten) but
   * is **not** part of the served configuration: its row is retained `disabled` so a later
   * recomposition can reactivate it, and every serving-semantics rule below is evaluated
   * over the ACTIVE submitted bindings only. Absent/`false` = active. `compose` (first
   * composition) never sets it, so for CO-2/CO-3 the active set equals the full submission
   * and this flag is a pure no-op.
   */
  readonly disabled?: boolean;
}

/** The whole composition submission for one `composition-required` endpoint (CO-2.1). */
export interface CompositionSubmission {
  readonly aggregationStrategy: AggregationStrategy;
  readonly strictness: EndpointStrictness;
  readonly cacheTtl?: number;
  readonly bindings: readonly SubmittedBindingComposition[];
  /**
   * The consumer inputs the composer explicitly acknowledges as ignored (CO-5.4). Each
   * must reference an **optional** consumer input that reaches no backend; a required
   * one is a blocking finding that cannot be acknowledged away (CO-5.3). Absent = none
   * (every unmapped input then rejects at request validation — the fail-loud default).
   */
  readonly acknowledgedIgnoredInputs?: readonly AcknowledgedIgnoredInput[];
  // ── CO-3 collection-union configuration (union endpoints only) ──────────────
  /**
   * How duplicate rows are collapsed (CO-3.1). A **union must supply one** (none /
   * record-link / dedup-key) — "none" is an explicit choice, never an unset default;
   * present on any other strategy is rejected. `record-link` needs every contributing
   * resource's confirmed `nativeIdRef` (CO-3.2).
   */
  readonly postMergeDedup?: PostMergeDedup;
  /** Post-merge semantics per non-pushdown filter parameter (CO-3.4). */
  readonly postMergeFilters?: readonly PostMergeFilter[];
  /** Post-merge semantics per accepted sort parameter value (CO-3.5); presence = configured. */
  readonly postMergeSorts?: readonly PostMergeSort[];
  /**
   * The pagination convention the composer proposes (CO-3.5) — its confirmation is
   * stamped server-side (never client-supplied) via {@link confirmPostMergePagination},
   * so an unconfirmed convention stays distinguishable from a confirmed one (RP-2).
   */
  readonly postMergePagination?: PostMergePaginationConventionValue;
  /** Whether the composer **confirms** the proposed pagination convention (CO-3.5 derive-then-confirm). */
  readonly confirmPostMergePagination?: boolean;
}

/**
 * The persisted facts about one composable binding (an `active` or `proposed` binding
 * of the endpoint) the validator needs — loaded once by the context loader, so the
 * validator stays pure. All parameter names are **bare** (see {@link bareParamName}).
 */
export interface ComposableBindingFacts {
  readonly bindingId: string;
  /**
   * True when this binding's approved `OperationMapping.action` is a write
   * (`create` | `update` | `delete`) — the endpoint is a write endpoint if any
   * contributing binding writes (CO-2.7 / WR-1).
   */
  readonly isWriteOperation: boolean;
  /** The bare names of this binding's backend operation's parameters (CO-2.5 target). */
  readonly backendParameterNames: ReadonlySet<string>;
  /**
   * The bare names of the backend operation's **required** parameters — a path
   * parameter counts as required regardless of its `required` flag, mirroring how the
   * runtime fills parameters (CO-2.6; the scenario-4 `{owner}`/`{repo}` case).
   */
  readonly requiredBackendParameterNames: ReadonlySet<string>;
  /** The bare backend-parameter names covered by this binding's `ParameterMapping`s (CO-2.6). */
  readonly parameterMappedTargetNames: ReadonlySet<string>;
  /**
   * The consumer-shape response field paths this binding provides — the `targetPath`
   * of its `phase = response` `FieldMapping`s. A chained dependent's
   * `chainInputs[].upstreamFieldPath` must name one of these (CO-2.5); it is also the
   * per-supplement supplied-fields set the CO-4 analysis reads. Scoped to the binding's
   * resource pair.
   */
  readonly consumerResponseFieldPaths: ReadonlySet<string>;
  /**
   * The bare **consumer** parameter names this binding sources — every
   * `ParameterMapping.sourceParamRef` plus its transform's additional inputs. A consumer
   * parameter in none of the bindings' sets reaches no backend (CO-5.1). Mirrors the
   * runtime's `mappedConsumerParamNames`.
   */
  readonly mappedConsumerParamNames: ReadonlySet<string>;
  /**
   * The top-level **consumer** request-body field names this binding maps — the
   * record-relative top-level segments its `phase = request` `FieldMapping`s read
   * (primary + additional inputs), scoped to the binding's resource pair. A body field
   * in none of the bindings' sets reaches no backend (CO-5.1).
   */
  readonly mappedConsumerBodyFieldNames: ReadonlySet<string>;
}

/** The full validator input: the submission plus one facts entry per endpoint binding. */
export interface CompositionValidationInput {
  readonly submission: CompositionSubmission;
  readonly bindingFacts: readonly ComposableBindingFacts[];
  /**
   * The consumer operation's inputs (parameters + request body fields, cookie params
   * excluded), the universe the CO-5 coverage report is derived against. Empty when the
   * consumer operation is unresolvable — then no CO-5 finding is raised (the endpoint
   * would fail RP-2 at request time anyway).
   */
  readonly consumerInputs: ConsumerInputUniverse;
  /**
   * CO-3 — the per-contributing-resource union facts (each backend resource's confirmed
   * `nativeIdRef`/`collectionReadRef`/`paginationRef` state and pushed-down consumer
   * params). Only consulted for a `collection-union`; absent/empty for every other
   * strategy (and for the pure CO-2 unit cases that do not exercise unions).
   */
  readonly unionBindingFacts?: readonly UnionBindingFacts[];
  /** CO-3 — the consumer operation's declared parameters (union ref validity + classification). */
  readonly consumerParameters?: readonly IrParameter[];
  /** CO-3 — the consumer operation's response-schema field names (bare, top-level). */
  readonly consumerResponseFieldNames?: ReadonlySet<string>;
}

// ── Named rejection reasons + result ─────────────────────────────────────────

/**
 * Why a composition is not activatable — a discriminated union on `code`, every
 * variant naming the offending binding / role / parameter so the rejection is loud and
 * actionable (the critical CO-2 invariant). {@link formatCompositionRejection} renders
 * each into a `{ path, message }` issue for the HTTP boundary.
 */
export type CompositionRejectionReason =
  | {
      readonly code: "submission-binding-mismatch";
      readonly missingBindingIds: readonly string[];
      readonly unknownBindingIds: readonly string[];
      readonly duplicateBindingIds: readonly string[];
    }
  | {
      readonly code: "role-invalid-for-strategy";
      readonly bindingId: string;
      readonly role: AdapterBindingRole;
      readonly strategy: AggregationStrategy;
      readonly validRoles: readonly AdapterBindingRole[];
    }
  | { readonly code: "fanout-merge-primary-count"; readonly primaryCount: number }
  | {
      readonly code: "depends-on-not-allowed-for-strategy";
      readonly bindingId: string;
      readonly strategy: AggregationStrategy;
    }
  | { readonly code: "depends-on-self"; readonly bindingId: string }
  | {
      readonly code: "depends-on-unknown-binding";
      readonly bindingId: string;
      readonly dependsOnBindingId: string;
    }
  | { readonly code: "depends-on-cycle"; readonly bindingIds: readonly string[] }
  | {
      readonly code: "chain-dependent-ordered-before-upstream";
      readonly bindingId: string;
      readonly upstreamBindingId: string;
      readonly executionOrder: number;
      readonly upstreamExecutionOrder: number;
    }
  | { readonly code: "chain-inputs-without-dependency"; readonly bindingId: string }
  | {
      readonly code: "execution-order-tie-under-first-success";
      readonly executionOrder: number;
      readonly bindingIds: readonly string[];
    }
  | {
      readonly code: "chain-input-unknown-upstream-field";
      readonly bindingId: string;
      readonly upstreamBindingId: string;
      readonly upstreamFieldPath: string;
    }
  | {
      readonly code: "chain-input-unknown-target-param";
      readonly bindingId: string;
      readonly targetParamRef: string;
    }
  | {
      readonly code: "required-parameter-not-composable";
      readonly bindingId: string;
      readonly parameterName: string;
    }
  | { readonly code: "write-endpoint-not-single"; readonly strategy: AggregationStrategy }
  | {
      readonly code: "write-endpoint-not-single-active-binding";
      readonly activeBindingCount: number;
    }
  | {
      // CO-5.3 — a required consumer input reaching no backend is a mapping defect, a
      // blocking finding (cannot be acknowledged away).
      readonly code: "required-consumer-input-unmapped";
      readonly inputKind: "parameter" | "body-field";
      readonly inputName: string;
    }
  | {
      // CO-5.2/5.4 — an acknowledgement must reference a genuinely-unmapped input (an
      // optional one reaching no backend); acknowledging a mapped or unknown input is a
      // composer error.
      readonly code: "acknowledged-input-not-unmapped";
      readonly inputKind: "parameter" | "body-field";
      readonly inputName: string;
    }
  // CO-3 — the union-specific rejections (dedup / composability / post-merge ref
  // validity), folded in so a union that fails any of them activates nothing (CO-2.8).
  | UnionRejectionReason;

/** The validation outcome: `ok`, or `rejected` with the full list of named reasons. */
export type CompositionValidation =
  | { readonly ok: true }
  | { readonly ok: false; readonly reasons: readonly CompositionRejectionReason[] };

// ── The validator ────────────────────────────────────────────────────────────

/**
 * Validate a composition submission against the endpoint's binding facts. Returns
 * `{ ok: true }` when the configuration is activatable, or `{ ok: false, reasons }`
 * with every violated rule named. The service activates **only** on `ok` and in one
 * transaction, so a rejection is inert — the endpoint keeps serving its previous
 * configuration (CO-2.8).
 */
export function validateComposition(input: CompositionValidationInput): CompositionValidation {
  const { submission, bindingFacts } = input;
  const strategy = submission.aggregationStrategy;
  const reasons: CompositionRejectionReason[] = [];

  const factsById = new Map(bindingFacts.map((facts) => [facts.bindingId, facts]));
  const endpointBindingIds = new Set(factsById.keys());
  const submittedById = new Map<string, SubmittedBindingComposition>();
  const duplicateBindingIds: string[] = [];
  for (const submitted of submission.bindings) {
    if (submittedById.has(submitted.bindingId)) {
      duplicateBindingIds.push(submitted.bindingId);
    } else {
      submittedById.set(submitted.bindingId, submitted);
    }
  }

  // Coverage: the submission must configure exactly the endpoint's composable bindings —
  // no proposed binding left unaddressed (it would go live unconfigured), no id that is
  // not a binding of this endpoint. A binding marked `disabled` still counts as addressed
  // (it is configured, just out of service), so it is part of `submittedById` above.
  const missingBindingIds = [...endpointBindingIds].filter((id) => !submittedById.has(id));
  const unknownBindingIds = [...submittedById.keys()].filter((id) => !endpointBindingIds.has(id));
  if (
    missingBindingIds.length > 0 ||
    unknownBindingIds.length > 0 ||
    duplicateBindingIds.length > 0
  ) {
    reasons.push({
      code: "submission-binding-mismatch",
      missingBindingIds,
      unknownBindingIds,
      duplicateBindingIds,
    });
  }

  // CO-6.2 — the ACTIVE served set. A `disabled` binding is addressed (checked above) but
  // never served, so every serving-semantics rule below (role validity, chaining, order,
  // required-parameter composability, write single-active, CO-5 coverage) is evaluated over
  // these only. `compose` sets no `disabled` flag → the active set equals the full
  // submission and all of the following is byte-for-byte the pre-CO-6 CO-2/CO-3 behavior.
  const activeSubmitted = submission.bindings.filter((binding) => binding.disabled !== true);
  const activeBindingIds = new Set(activeSubmitted.map((binding) => binding.bindingId));
  const activeSubmittedById = new Map(
    activeSubmitted.map((binding) => [binding.bindingId, binding] as const),
  );
  const activeBindingFacts = bindingFacts.filter((facts) => activeBindingIds.has(facts.bindingId));

  const validRoles = ROLE_VALIDITY_BY_STRATEGY[strategy];
  const validRoleSet = new Set(validRoles);

  for (const submitted of activeSubmitted) {
    // CO-2.2 — the role-validity table: reject a role outside this strategy's set.
    if (!validRoleSet.has(submitted.role)) {
      reasons.push({
        code: "role-invalid-for-strategy",
        bindingId: submitted.bindingId,
        role: submitted.role,
        strategy,
        validRoles,
      });
    }

    // CO-2.3 — dependsOnBindingId: only under fanout-merge, only another ACTIVE binding of
    // the same endpoint. (The acyclic check runs once over the active graph below.) A
    // dependency on a `disabled` binding is treated as unknown: it would never run, so a
    // chained active binding pointing at it could never be filled (CO-6.2 keeps a broken
    // chain from activating).
    if (submitted.dependsOnBindingId !== undefined) {
      if (strategy !== CHAINING_STRATEGY) {
        reasons.push({
          code: "depends-on-not-allowed-for-strategy",
          bindingId: submitted.bindingId,
          strategy,
        });
      } else if (submitted.dependsOnBindingId === submitted.bindingId) {
        reasons.push({ code: "depends-on-self", bindingId: submitted.bindingId });
      } else if (!activeBindingIds.has(submitted.dependsOnBindingId)) {
        reasons.push({
          code: "depends-on-unknown-binding",
          bindingId: submitted.bindingId,
          dependsOnBindingId: submitted.dependsOnBindingId,
        });
      }
    }

    // CO-2.3/AD-2.3 — chainInputs are unrepresentable without an upstream to read.
    if (
      submitted.chainInputs !== undefined &&
      submitted.chainInputs.length > 0 &&
      submitted.dependsOnBindingId === undefined
    ) {
      reasons.push({ code: "chain-inputs-without-dependency", bindingId: submitted.bindingId });
    }
  }
  // From here on `submitted` iterations are over the ACTIVE served set (CO-6.2).

  // CO-2.2 structural minimum — `fanout-merge` needs exactly ONE `primary`: the primary
  // supplies the base object the `supplement`s contribute fields to
  // (`docs/architecture/adapter-engine.md`: "`primary` supplies the base object;
  // `supplement` bindings contribute additional fields"). Zero primaries = no base object
  // to merge onto; two primaries = two competing base objects — both undefined-semantics
  // merges, the exact class CO-2 exists to reject before activation. (The other
  // strategies need no such minimum: `single` is exactly one binding, `collection-union`
  // is all equivalent supplements, and an all-`fallback` first-success chain is still the
  // well-defined "try in strict order, take the first success".)
  if (strategy === CHAINING_STRATEGY) {
    const primaryCount = activeSubmitted.filter((binding) => binding.role === "primary").length;
    if (primaryCount !== 1) {
      reasons.push({ code: "fanout-merge-primary-count", primaryCount });
    }
  }

  // CO-2.3 — acyclic: chaining is only valid under fanout-merge, so a cycle is only
  // possible (and only worth detecting) there. Detect over the well-formed ACTIVE edges.
  if (strategy === CHAINING_STRATEGY) {
    reasons.push(...detectDependencyCycles(activeSubmitted, activeBindingIds));
  }

  // CO-2.3 — relative order: a chained binding may never be ordered STRICTLY BEFORE the
  // binding it depends on. Dependency overrides order at runtime, but a dependent ordered
  // before its upstream is undispatchable there (the serve-handler backstop) and — worse
  // for a NON-load-bearing chained supplement — the endpoint would compose, then every
  // request would silently degrade while naming a perfectly healthy backend: a persistently
  // misleading endpoint composition must never admit. Equal order is fine (same group — the
  // runtime awaits the upstream). Only well-formed edges are checked; a self/unknown edge is
  // reported by its own reason above, not compounded here.
  if (strategy === CHAINING_STRATEGY) {
    for (const submitted of activeSubmitted) {
      const upstreamId = submitted.dependsOnBindingId;
      if (upstreamId === undefined || upstreamId === submitted.bindingId) {
        continue;
      }
      const upstream = activeSubmittedById.get(upstreamId);
      if (upstream === undefined) {
        continue;
      }
      const executionOrder = resolveExecutionOrder(submitted);
      const upstreamExecutionOrder = resolveExecutionOrder(upstream);
      if (executionOrder < upstreamExecutionOrder) {
        reasons.push({
          code: "chain-dependent-ordered-before-upstream",
          bindingId: submitted.bindingId,
          upstreamBindingId: upstreamId,
          executionOrder,
          upstreamExecutionOrder,
        });
      }
    }
  }

  // CO-2.4 — fanout-first-success: executionOrder must be a strict total order (ties
  // rejected). Group by the effective order value; any value shared by ≥2 bindings ties.
  if (strategy === "fanout-first-success") {
    const bindingIdsByOrder = new Map<number, string[]>();
    for (const submitted of activeSubmitted) {
      const order = resolveExecutionOrder(submitted);
      const group = bindingIdsByOrder.get(order) ?? [];
      group.push(submitted.bindingId);
      bindingIdsByOrder.set(order, group);
    }
    for (const [executionOrder, bindingIds] of bindingIdsByOrder) {
      if (bindingIds.length > 1) {
        reasons.push({
          code: "execution-order-tie-under-first-success",
          executionOrder,
          bindingIds,
        });
      }
    }
  }

  // CO-2.5 — chainInputs validity: each upstreamFieldPath must be a field the upstream
  // binding's consumer-shape response provides; each targetParamRef a real parameter of
  // this binding's backend operation.
  for (const submitted of activeSubmitted) {
    const chainInputs = submitted.chainInputs;
    if (chainInputs === undefined || chainInputs.length === 0) {
      continue;
    }
    const thisFacts = factsById.get(submitted.bindingId);
    const upstreamFacts =
      submitted.dependsOnBindingId === undefined ||
      !activeBindingIds.has(submitted.dependsOnBindingId)
        ? undefined
        : factsById.get(submitted.dependsOnBindingId);
    for (const chainInput of chainInputs) {
      if (
        thisFacts !== undefined &&
        !thisFacts.backendParameterNames.has(bareParamName(chainInput.targetParamRef))
      ) {
        reasons.push({
          code: "chain-input-unknown-target-param",
          bindingId: submitted.bindingId,
          targetParamRef: chainInput.targetParamRef,
        });
      }
      // The upstream-field check needs a resolvable upstream; when there is none the
      // dependsOn reasons above already name the defect, so don't pile on here.
      if (
        upstreamFacts !== undefined &&
        !upstreamFacts.consumerResponseFieldPaths.has(chainInput.upstreamFieldPath)
      ) {
        reasons.push({
          code: "chain-input-unknown-upstream-field",
          bindingId: submitted.bindingId,
          upstreamBindingId: upstreamFacts.bindingId,
          upstreamFieldPath: chainInput.upstreamFieldPath,
        });
      }
    }
  }

  // CO-2.6 — a required backend parameter with no ParameterMapping and no chainInput is
  // not composable: reject with the parameter named (the loud, composition-time TE-1.3).
  for (const submitted of activeSubmitted) {
    const thisFacts = factsById.get(submitted.bindingId);
    if (thisFacts === undefined) {
      continue;
    }
    const chainFilledParams = new Set(
      (submitted.chainInputs ?? []).map((chainInput) => bareParamName(chainInput.targetParamRef)),
    );
    for (const parameterName of thisFacts.requiredBackendParameterNames) {
      const filledByMapping = thisFacts.parameterMappedTargetNames.has(parameterName);
      const filledByChain = chainFilledParams.has(parameterName);
      if (!filledByMapping && !filledByChain) {
        reasons.push({
          code: "required-parameter-not-composable",
          bindingId: submitted.bindingId,
          parameterName,
        });
      }
    }
  }

  // CO-2.7 / CO-6.5 — a write endpoint is always `single` with exactly one active binding
  // (WR-1). The activation sets every ACTIVE submitted binding `active` and every disabled
  // one `disabled`, so the active count is the number of active-submitted bindings — a
  // recompose that would leave a write endpoint with >1 active binding is rejected here.
  const isWriteEndpoint = activeBindingFacts.some((facts) => facts.isWriteOperation);
  if (isWriteEndpoint) {
    if (strategy !== "single") {
      reasons.push({ code: "write-endpoint-not-single", strategy });
    }
    if (activeSubmitted.length !== 1) {
      reasons.push({
        code: "write-endpoint-not-single-active-binding",
        activeBindingCount: activeSubmitted.length,
      });
    }
  }

  // CO-5 — consumer-input coverage. Derive which consumer inputs reach no backend, then:
  // (5.3) a *required* one is a blocking finding — a required input going nowhere is a
  // mapping defect, not a composition preference, and cannot be acknowledged away; and
  // (5.2/5.4) every submitted acknowledgement must reference a genuinely-unmapped input,
  // so a composer cannot acknowledge a mapped or unknown input into silence.
  const coverage = deriveConsumerInputCoverage({
    consumerInputs: input.consumerInputs,
    // CO-6.2 — coverage is over the ACTIVE served bindings: a consumer input only a
    // disabled binding maps reaches no live backend, so disabling the last binding that
    // covers a required input is a blocking finding rather than a silently-honored input.
    bindings: activeBindingFacts.map((facts) => ({
      bindingId: facts.bindingId,
      mappedConsumerParamNames: facts.mappedConsumerParamNames,
      mappedConsumerBodyFieldNames: facts.mappedConsumerBodyFieldNames,
    })),
  });
  for (const unmapped of coverage.unmappedByAllBackends) {
    if (unmapped.required) {
      reasons.push({
        code: "required-consumer-input-unmapped",
        inputKind: unmapped.kind,
        inputName: unmapped.name,
      });
    }
  }
  for (const acknowledgement of submission.acknowledgedIgnoredInputs ?? []) {
    const matches = coverage.unmappedByAllBackends.some((unmapped) =>
      acknowledgementMatchesInput(acknowledgement, unmapped),
    );
    if (!matches) {
      reasons.push({
        code: "acknowledged-input-not-unmapped",
        inputKind: acknowledgement.kind === "parameter" ? "parameter" : "body-field",
        inputName: acknowledgementInputName(acknowledgement),
      });
    }
  }

  // CO-3 — union composition (dedup / composability preconditions / post-merge ref
  // validity), folded into the one atomic decision. On a non-union strategy this only
  // rejects stray union config; the union-specific rules apply solely to a real union.
  reasons.push(
    ...validateUnionConfiguration({
      strategy,
      submission: {
        ...(submission.postMergeDedup !== undefined
          ? { postMergeDedup: submission.postMergeDedup }
          : {}),
        ...(submission.postMergeFilters !== undefined
          ? { postMergeFilters: submission.postMergeFilters }
          : {}),
        ...(submission.postMergeSorts !== undefined
          ? { postMergeSorts: submission.postMergeSorts }
          : {}),
        ...(submission.postMergePagination !== undefined
          ? { postMergePagination: submission.postMergePagination }
          : {}),
      },
      // CO-6.2 — only the ACTIVE contributing resources form the union; a `disabled`
      // binding is not a contributor, so its resource's ref-confirmation and pushdown
      // eligibility must not gate the union.
      unionBindingFacts: (input.unionBindingFacts ?? []).filter((facts) =>
        activeBindingIds.has(facts.bindingId),
      ),
      consumerParameters: input.consumerParameters ?? [],
      consumerResponseFieldNames: input.consumerResponseFieldNames ?? new Set<string>(),
    }),
  );

  return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
}

/**
 * Detect every dependency cycle among the submitted `dependsOnBindingId` edges (CO-2.3
 * acyclic). Only edges pointing at a real, distinct binding of the endpoint are walked
 * — a self-edge or an unknown target is reported by its own reason, not swallowed into a
 * spurious cycle. Iterative DFS with a recursion stack; each detected back-edge yields
 * one `depends-on-cycle` naming the members of that cycle.
 */
function detectDependencyCycles(
  submitted: readonly SubmittedBindingComposition[],
  endpointBindingIds: ReadonlySet<string>,
): CompositionRejectionReason[] {
  const dependsOn = new Map<string, string>();
  for (const binding of submitted) {
    const target = binding.dependsOnBindingId;
    if (
      target !== undefined &&
      target !== binding.bindingId &&
      endpointBindingIds.has(target) &&
      endpointBindingIds.has(binding.bindingId)
    ) {
      // Each binding has at most one dependsOnBindingId (a single column), so this Map
      // is the whole edge set.
      dependsOn.set(binding.bindingId, target);
    }
  }

  const reasons: CompositionRejectionReason[] = [];
  const reportedCycleKeys = new Set<string>();
  const visited = new Set<string>();

  for (const start of dependsOn.keys()) {
    if (visited.has(start)) {
      continue;
    }
    // Walk the unique successor chain from `start`, recording the path, until it ends,
    // reaches an already-visited node, or revisits a node on the current path (a cycle).
    const path: string[] = [];
    const onPath = new Map<string, number>();
    let current: string | undefined = start;
    while (current !== undefined && !visited.has(current)) {
      const seenAt = onPath.get(current);
      if (seenAt !== undefined) {
        const cycle = path.slice(seenAt);
        const key = [...cycle].sort().join("|");
        if (!reportedCycleKeys.has(key)) {
          reportedCycleKeys.add(key);
          reasons.push({ code: "depends-on-cycle", bindingIds: cycle });
        }
        break;
      }
      onPath.set(current, path.length);
      path.push(current);
      current = dependsOn.get(current);
    }
    for (const node of path) {
      visited.add(node);
    }
  }

  return reasons;
}

// ── Rendering rejections for the HTTP boundary ───────────────────────────────

/**
 * Render one {@link CompositionRejectionReason} into a `{ path, message }` issue for the
 * uniform error envelope (`@mediator/contracts` `ValidationIssue`). The message names
 * the offending binding / role / parameter; it never echoes a submitted value beyond the
 * ids/refs/roles the composer supplied, so no secret material can leak.
 */
export function formatCompositionRejection(reason: CompositionRejectionReason): {
  readonly path: string;
  readonly message: string;
} {
  switch (reason.code) {
    case "submission-binding-mismatch": {
      const parts: string[] = [];
      if (reason.missingBindingIds.length > 0) {
        parts.push(`unaddressed bindings ${reason.missingBindingIds.join(", ")}`);
      }
      if (reason.unknownBindingIds.length > 0) {
        parts.push(`unknown bindings ${reason.unknownBindingIds.join(", ")}`);
      }
      if (reason.duplicateBindingIds.length > 0) {
        parts.push(`duplicate bindings ${reason.duplicateBindingIds.join(", ")}`);
      }
      return {
        path: "bindings",
        message: `The composition must configure exactly the endpoint's bindings: ${parts.join("; ")}.`,
      };
    }
    case "role-invalid-for-strategy":
      return {
        path: `bindings.${reason.bindingId}.role`,
        message: `Role '${reason.role}' is not valid under aggregationStrategy '${reason.strategy}' (valid: ${reason.validRoles.join(", ")}).`,
      };
    case "fanout-merge-primary-count":
      return {
        path: "bindings",
        message:
          reason.primaryCount === 0
            ? "fanout-merge needs a base-object primary — no binding is 'primary'."
            : `fanout-merge must have exactly one primary base object, but ${String(reason.primaryCount)} bindings are 'primary'.`,
      };
    case "depends-on-not-allowed-for-strategy":
      return {
        path: `bindings.${reason.bindingId}.dependsOnBindingId`,
        message: `dependsOnBindingId is only valid under aggregationStrategy '${CHAINING_STRATEGY}', not '${reason.strategy}'.`,
      };
    case "depends-on-self":
      return {
        path: `bindings.${reason.bindingId}.dependsOnBindingId`,
        message: `Binding ${reason.bindingId} cannot depend on itself.`,
      };
    case "depends-on-unknown-binding":
      return {
        path: `bindings.${reason.bindingId}.dependsOnBindingId`,
        message: `dependsOnBindingId ${reason.dependsOnBindingId} is not another binding of this endpoint.`,
      };
    case "depends-on-cycle":
      return {
        path: "bindings",
        message: `dependsOnBindingId forms a cycle among bindings ${reason.bindingIds.join(" -> ")}.`,
      };
    case "chain-dependent-ordered-before-upstream":
      return {
        path: `bindings.${reason.bindingId}.executionOrder`,
        message: `Binding ${reason.bindingId} (executionOrder ${String(reason.executionOrder)}) depends on ${reason.upstreamBindingId} (executionOrder ${String(reason.upstreamExecutionOrder)}) but is ordered before it — a chained binding must be ordered at or after its upstream.`,
      };
    case "chain-inputs-without-dependency":
      return {
        path: `bindings.${reason.bindingId}.chainInputs`,
        message: `Binding ${reason.bindingId} has chainInputs but no dependsOnBindingId — there is no upstream response to read.`,
      };
    case "execution-order-tie-under-first-success":
      return {
        path: "bindings",
        message: `fanout-first-success requires a strict total order; bindings ${reason.bindingIds.join(", ")} share executionOrder ${String(reason.executionOrder)}.`,
      };
    case "chain-input-unknown-upstream-field":
      return {
        path: `bindings.${reason.bindingId}.chainInputs`,
        message: `chainInputs.upstreamFieldPath '${reason.upstreamFieldPath}' is not a consumer-shape response field of upstream binding ${reason.upstreamBindingId}.`,
      };
    case "chain-input-unknown-target-param":
      return {
        path: `bindings.${reason.bindingId}.chainInputs`,
        message: `chainInputs.targetParamRef '${reason.targetParamRef}' is not a parameter of this binding's backend operation.`,
      };
    case "required-parameter-not-composable":
      return {
        path: `bindings.${reason.bindingId}`,
        message: `Required backend parameter '${reason.parameterName}' has no ParameterMapping and no chainInput — the binding is not composable.`,
      };
    case "write-endpoint-not-single":
      return {
        path: "aggregationStrategy",
        message: `A write endpoint must use aggregationStrategy 'single', not '${reason.strategy}'.`,
      };
    case "write-endpoint-not-single-active-binding":
      return {
        path: "bindings",
        message: `A write endpoint must have exactly one active binding, not ${String(reason.activeBindingCount)}.`,
      };
    case "required-consumer-input-unmapped":
      return {
        path:
          reason.inputKind === "parameter" ? "consumerInputs.parameters" : "consumerInputs.body",
        message: `Required consumer ${reason.inputKind === "parameter" ? "parameter" : "body field"} '${reason.inputName}' reaches no backend — a required input that goes nowhere is a mapping defect and cannot be composed around or acknowledged.`,
      };
    case "acknowledged-input-not-unmapped":
      return {
        path: "acknowledgedIgnoredInputs",
        message: `Acknowledged-ignored consumer ${reason.inputKind === "parameter" ? "parameter" : "body field"} '${reason.inputName}' is not an unmapped consumer input of this endpoint — only an input that reaches no backend can be acknowledged.`,
      };
    default:
      // CO-3 union reasons — `reason` is narrowed to `UnionRejectionReason` here (every
      // CO-2 code is handled above), so this delegation is exhaustive and type-safe.
      return formatUnionRejection(reason);
  }
}
