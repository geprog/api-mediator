import {
  resolveExecutionOrder,
  type AdapterBindingRole,
  type AggregationStrategy,
  type ChainInput,
  type EndpointStrictness,
} from "@mediator/domain";

import { bareParamName } from "./refs.js";

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
}

/** The whole composition submission for one `composition-required` endpoint (CO-2.1). */
export interface CompositionSubmission {
  readonly aggregationStrategy: AggregationStrategy;
  readonly strictness: EndpointStrictness;
  readonly cacheTtl?: number;
  readonly bindings: readonly SubmittedBindingComposition[];
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
   * `chainInputs[].upstreamFieldPath` must name one of these (CO-2.5).
   */
  readonly consumerResponseFieldPaths: ReadonlySet<string>;
}

/** The full validator input: the submission plus one facts entry per endpoint binding. */
export interface CompositionValidationInput {
  readonly submission: CompositionSubmission;
  readonly bindingFacts: readonly ComposableBindingFacts[];
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
    };

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
  // not a binding of this endpoint.
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

  const validRoles = ROLE_VALIDITY_BY_STRATEGY[strategy];
  const validRoleSet = new Set(validRoles);

  for (const submitted of submission.bindings) {
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

    // CO-2.3 — dependsOnBindingId: only under fanout-merge, only another binding of the
    // same endpoint. (The acyclic check runs once over the whole graph below.)
    if (submitted.dependsOnBindingId !== undefined) {
      if (strategy !== CHAINING_STRATEGY) {
        reasons.push({
          code: "depends-on-not-allowed-for-strategy",
          bindingId: submitted.bindingId,
          strategy,
        });
      } else if (submitted.dependsOnBindingId === submitted.bindingId) {
        reasons.push({ code: "depends-on-self", bindingId: submitted.bindingId });
      } else if (!endpointBindingIds.has(submitted.dependsOnBindingId)) {
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
    const primaryCount = submission.bindings.filter((binding) => binding.role === "primary").length;
    if (primaryCount !== 1) {
      reasons.push({ code: "fanout-merge-primary-count", primaryCount });
    }
  }

  // CO-2.3 — acyclic: chaining is only valid under fanout-merge, so a cycle is only
  // possible (and only worth detecting) there. Detect over the well-formed edges.
  if (strategy === CHAINING_STRATEGY) {
    reasons.push(...detectDependencyCycles(submission.bindings, endpointBindingIds));
  }

  // CO-2.4 — fanout-first-success: executionOrder must be a strict total order (ties
  // rejected). Group by the effective order value; any value shared by ≥2 bindings ties.
  if (strategy === "fanout-first-success") {
    const bindingIdsByOrder = new Map<number, string[]>();
    for (const submitted of submission.bindings) {
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
  for (const submitted of submission.bindings) {
    const chainInputs = submitted.chainInputs;
    if (chainInputs === undefined || chainInputs.length === 0) {
      continue;
    }
    const thisFacts = factsById.get(submitted.bindingId);
    const upstreamFacts =
      submitted.dependsOnBindingId === undefined
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
  for (const submitted of submission.bindings) {
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

  // CO-2.7 — a write endpoint is always `single` with exactly one active binding (WR-1).
  // CO-2 activates every submitted (proposed/active) binding, so the active count is the
  // number of submitted bindings.
  const isWriteEndpoint = bindingFacts.some((facts) => facts.isWriteOperation);
  if (isWriteEndpoint) {
    if (strategy !== "single") {
      reasons.push({ code: "write-endpoint-not-single", strategy });
    }
    if (submission.bindings.length !== 1) {
      reasons.push({
        code: "write-endpoint-not-single-active-binding",
        activeBindingCount: submission.bindings.length,
      });
    }
  }

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
  }
}
