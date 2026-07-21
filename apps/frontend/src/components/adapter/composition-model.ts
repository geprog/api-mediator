import type {
  ComposeAdapterEndpointRequest,
  ComposeBindingRequest,
  SupplementLoadBearingAnalysisDto,
} from "@mediator/contracts";
import {
  resolveExecutionOrder,
  type AcknowledgedIgnoredInput,
  type AdapterBindingRole,
  type AggregationStrategy,
  type ChainInput,
  type EndpointStrictness,
  type PostMergeDedup,
  type PostMergeFilter,
  type PostMergePaginationConventionValue,
  type PostMergeSort,
} from "@mediator/domain";

/**
 * Pure derivations behind the CU-1 composition form — kept free of Vue so the
 * role-validity table, the write→single rule, and the `fanout-first-success`
 * order-tie flag are unit-testable without mounting. This layer **mirrors** the
 * server's composition validation so the UI never offers an illegal choice or
 * submits an obviously-invalid one; the **server** still enforces every rule
 * (CO-2/CO-3) and is the authority — a rejection comes back with the exact rule
 * violations, which the form surfaces verbatim.
 *
 * Sources of truth: the role-validity table and the strategy-scoped
 * `executionOrder`/`dependsOnBindingId`/`chainInputs` rules in
 * `docs/architecture/adapter-engine.md` *Role validity per aggregation strategy*;
 * write→single in *Write operations*.
 */

/** The four strategies, in the order the form offers them. */
export const AGGREGATION_STRATEGIES: readonly AggregationStrategy[] = [
  "single",
  "fanout-merge",
  "collection-union",
  "fanout-first-success",
];

/**
 * The role-validity table (authoritative in
 * `docs/architecture/adapter-engine.md`): exactly the roles a given strategy uses.
 * A role outside this set is never offered for that strategy, and the server
 * rejects it if submitted anyway.
 */
export function rolesForStrategy(strategy: AggregationStrategy): readonly AdapterBindingRole[] {
  switch (strategy) {
    case "single":
      return ["primary"];
    case "fanout-merge":
      return ["primary", "supplement"];
    case "collection-union":
      return ["supplement"];
    case "fanout-first-success":
      return ["primary", "fallback"];
  }
}

/** Whether `role` is in the strategy's valid set (mirrors CO-2 criterion role table). */
export function isRoleValidForStrategy(
  strategy: AggregationStrategy,
  role: AdapterBindingRole,
): boolean {
  return rolesForStrategy(strategy).includes(role);
}

/** The role the form defaults a binding to when a strategy is (re)chosen. */
export function defaultRoleForStrategy(strategy: AggregationStrategy): AdapterBindingRole {
  // Every strategy's role set is non-empty; `single`/`collection-union` have one.
  return rolesForStrategy(strategy)[0] ?? "primary";
}

/**
 * Keep a binding's role valid across a strategy change: preserve it when still in
 * the new strategy's set, otherwise fall back to that strategy's default role.
 */
export function coerceRoleForStrategy(
  strategy: AggregationStrategy,
  role: AdapterBindingRole,
): AdapterBindingRole {
  return isRoleValidForStrategy(strategy, role) ? role : defaultRoleForStrategy(strategy);
}

/** The reason a write endpoint is limited to `single` (CU-1.6), stated verbatim to the composer. */
export const WRITE_SINGLE_REASON =
  "This is a write operation, so it can only use the single strategy with exactly one active binding. " +
  "Fanning a write out to several backends is a distributed transaction with no compensation, and a " +
  "first-success retry could duplicate a side effect — both are unsafe for writes.";

/**
 * The strategies the form offers. A write consumer operation offers **only**
 * `single` (CU-1.6); a read offers all four. The write signal is passed in because
 * the AP-1 read state does not expose the consumer operation's HTTP method (see the
 * form's notes) — when it is unknown, all four are offered and the server enforces
 * write→single, surfacing the reason on rejection.
 */
export function availableStrategies(input: {
  readonly writeOperation: boolean;
}): readonly AggregationStrategy[] {
  return input.writeOperation ? ["single"] : AGGREGATION_STRATEGIES;
}

/**
 * Whether `executionOrder` is meaningful for the strategy: the parallel strategies
 * (`fanout-merge`, `collection-union`) use it to group parallel-vs-sequential
 * execution, and `fanout-first-success` uses it as the strict fallback order.
 * `single` never uses it.
 */
export function strategyUsesExecutionOrder(strategy: AggregationStrategy): boolean {
  return strategy !== "single";
}

/**
 * Whether `dependsOnBindingId` (and, with it, `chainInputs`) is meaningful:
 * chaining a binding on another's response is valid under `fanout-merge` **only**.
 */
export function strategyUsesDependsOn(strategy: AggregationStrategy): boolean {
  return strategy === "fanout-merge";
}

/** `chainInputs` are composition state only where `dependsOnBindingId` is valid. */
export function strategyUsesChainInputs(strategy: AggregationStrategy): boolean {
  return strategyUsesDependsOn(strategy);
}

/** Whether a strategy carries the CO-3 `collection-union` post-merge configuration. */
export function strategyIsUnion(strategy: AggregationStrategy): boolean {
  return strategy === "collection-union";
}

/** One binding's composition choices as edited in the form. */
export interface CompositionBindingDraft {
  readonly bindingId: string;
  readonly role: AdapterBindingRole;
  readonly executionOrder?: number;
  readonly dependsOnBindingId?: string;
  readonly chainInputs?: readonly ChainInput[];
}

/** The whole composition draft the form edits and previews before submitting. */
export interface CompositionDraft {
  readonly aggregationStrategy: AggregationStrategy;
  readonly strictness: EndpointStrictness;
  readonly cacheTtl?: number;
  readonly bindings: readonly CompositionBindingDraft[];
  readonly acknowledgedIgnoredInputs?: readonly AcknowledgedIgnoredInput[];
  readonly postMergeDedup?: PostMergeDedup;
  readonly postMergeFilters?: readonly PostMergeFilter[];
  readonly postMergeSorts?: readonly PostMergeSort[];
  readonly postMergePagination?: PostMergePaginationConventionValue;
  readonly confirmPostMergePagination?: boolean;
}

/**
 * Under `fanout-first-success`, `executionOrder` is a **strict total order** over
 * the fallback chain — equal orders are invalid ("try two in parallel and take the
 * first" is a different, unsupported semantic). Returns the order values shared by
 * two or more bindings, so the form can flag them **before** submission (CU-1.3).
 * An absent order resolves to the default (`0`), so two unordered bindings tie.
 */
export function firstSuccessTiedOrders(
  bindings: readonly CompositionBindingDraft[],
): readonly number[] {
  const counts = new Map<number, number>();
  for (const binding of bindings) {
    const order = resolveExecutionOrder(binding);
    counts.set(order, (counts.get(order) ?? 0) + 1);
  }
  return [...counts.entries()].filter(([, count]) => count > 1).map(([order]) => order);
}

/** Whether the `fanout-first-success` draft has an order tie the server would reject (CU-1.3). */
export function hasFirstSuccessOrderTie(draft: CompositionDraft): boolean {
  return (
    draft.aggregationStrategy === "fanout-first-success" &&
    firstSuccessTiedOrders(draft.bindings).length > 0
  );
}

/**
 * The consumer-shape response fields an upstream binding supplies, from the CO-4
 * supplement analysis — the **only** valid source options for a chained binding's
 * `chainInputs` (CU-1.4). Deliberately the upstream's *consumer-shape* response
 * fields, never the upstream backend's native schema. Empty when the upstream is a
 * `primary` (its CO-4 entry supplies no field list) or when no analysis is loaded.
 */
export function upstreamConsumerResponseFields(
  supplementAnalysis: SupplementLoadBearingAnalysisDto | null,
  upstreamBindingId: string,
): readonly string[] {
  if (supplementAnalysis === null || !supplementAnalysis.applicable) {
    return [];
  }
  const entry = supplementAnalysis.entries.find(
    (candidate) => candidate.bindingId === upstreamBindingId,
  );
  return entry !== undefined && entry.kind === "supplement"
    ? entry.suppliedConsumerResponseFields
    : [];
}

/**
 * Serialize the draft to the AP-2 request body, presence-preserving for
 * `exactOptionalPropertyTypes` and **strategy-scoped**: `executionOrder`/
 * `dependsOnBindingId`/`chainInputs` are emitted only where the strategy uses them,
 * and the `collection-union` post-merge fields only for a union — so a value left
 * over from a since-changed strategy never rides along into the submission (the
 * server would reject an off-strategy field, which this mirror avoids up front).
 */
export function buildComposeRequest(draft: CompositionDraft): ComposeAdapterEndpointRequest {
  const strategy = draft.aggregationStrategy;
  const withOrder = strategyUsesExecutionOrder(strategy);
  const withDepends = strategyUsesDependsOn(strategy);
  const withChain = strategyUsesChainInputs(strategy);

  const bindings: ComposeBindingRequest[] = draft.bindings.map((binding) => ({
    bindingId: binding.bindingId,
    role: binding.role,
    ...(withOrder && binding.executionOrder !== undefined
      ? { executionOrder: binding.executionOrder }
      : {}),
    ...(withDepends && binding.dependsOnBindingId !== undefined
      ? { dependsOnBindingId: binding.dependsOnBindingId }
      : {}),
    ...(withChain && binding.chainInputs !== undefined
      ? { chainInputs: [...binding.chainInputs] }
      : {}),
  }));

  const union = strategyIsUnion(strategy);
  return {
    aggregationStrategy: strategy,
    strictness: draft.strictness,
    ...(draft.cacheTtl !== undefined ? { cacheTtl: draft.cacheTtl } : {}),
    ...(draft.acknowledgedIgnoredInputs !== undefined
      ? { acknowledgedIgnoredInputs: [...draft.acknowledgedIgnoredInputs] }
      : {}),
    ...(union && draft.postMergeDedup !== undefined
      ? { postMergeDedup: draft.postMergeDedup }
      : {}),
    ...(union && draft.postMergeFilters !== undefined
      ? { postMergeFilters: [...draft.postMergeFilters] }
      : {}),
    ...(union && draft.postMergeSorts !== undefined
      ? { postMergeSorts: [...draft.postMergeSorts] }
      : {}),
    ...(union && draft.postMergePagination !== undefined
      ? { postMergePagination: draft.postMergePagination }
      : {}),
    ...(union && draft.confirmPostMergePagination !== undefined
      ? { confirmPostMergePagination: draft.confirmPostMergePagination }
      : {}),
    bindings,
  };
}
