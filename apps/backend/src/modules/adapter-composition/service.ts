import {
  AdapterCompositionRepository,
  AuditLogRepository,
  tx,
  type ApplyCompositionInput,
  type Database,
} from "@mediator/db";
import {
  stripUndefined,
  type AdapterBinding,
  type AdapterEndpoint,
  type AuditLogEntry,
  type PostMergePagination,
} from "@mediator/domain";
import { getActiveTraceContext, type ActiveTraceContext } from "@mediator/telemetry";

import { BadRequestError, ConflictError, NotFoundError } from "../../app-errors.js";
import {
  analyzeSupplementLoadBearing,
  deriveConsumerInputCoverage,
  type ConsumerInputCoverage,
  type SupplementAnalysisBinding,
  type SupplementLoadBearingAnalysis,
} from "./analysis.js";
import {
  DbCompositionContextLoader,
  type CompositionContext,
  type CompositionContextLoader,
} from "./context.js";
import {
  deriveUnionCompositionAnalysis,
  type UnionCompositionAnalysis,
  type UnionSubmission,
} from "./union.js";
import {
  formatCompositionRejection,
  validateComposition,
  type CompositionSubmission,
  type CompositionValidation,
} from "./validate.js";

/**
 * **CO-2/CO-6 application service** — the seam between the thin operator route and the
 * composition validator + atomic activation. It loads the endpoint's composition
 * context, runs {@link validateComposition}, and — **only** on a passing result and
 * **in one transaction** — activates the composition and attributes the action (OA-3).
 *
 * The transaction boundary is what makes activation atomic (CO-2.8): a rejection is
 * thrown **before** any transaction opens, so nothing is written and the endpoint keeps
 * serving its previous configuration; a passing activation promotes the endpoint and
 * every binding and writes the audit row together, or not at all.
 *
 * Composing is an `operator` mutation (CO-2.9): the route's role guard rejects a viewer
 * `403` before this service runs, and every activation is attributed to the authenticated
 * identity — metadata only, never credential material or a payload value.
 *
 * **CO-6 (recompose + enable/disable) + CH-5 (invalidate on commit):** {@link recompose}
 * re-runs the exact same validation over an already-`active` endpoint and re-activates on
 * success (inert on rejection, exactly like a first `compose`); {@link setEndpointEnabled}
 * flips `AdapterEndpoint.status`; a binding may be marked `disabled` in a recompose
 * submission and its row is retained. **Every committed operation** then drops all of that
 * endpoint's cached entries through the SAME {@link EndpointCacheInvalidator} the adapter
 * runtime serves from, so a change never takes up to `cacheTtl` to become visible (CH-5) —
 * and a rejected recompose (thrown before any transaction) drops nothing.
 */
export interface AdapterCompositionServiceDeps {
  readonly db: Database;
  readonly loader?: CompositionContextLoader;
  readonly clock?: () => Date;
  readonly newId: () => string;
  readonly readTraceContext?: () => ActiveTraceContext | null;
  /**
   * CH-5 — the by-endpoint cache-drop seam. The composition root wires the SAME
   * {@link EndpointCacheInvalidator} instance the adapter runtime holds, so an operator's
   * recompose/disable drops the very cache the runtime serves from. Optional: a service
   * built without it (a Phase-1..3 test, a pure unit test) simply invalidates nothing.
   */
  readonly cacheInvalidator?: EndpointCacheInvalidator;
}

/**
 * The narrow cache-invalidation capability the composition service needs (CH-5): drop one
 * endpoint's cached responses when its serving configuration or a binding's status changes,
 * or it is disabled/re-enabled (CO-6). Deliberately a **local** port — a domain service must
 * not import the HTTP/serve layer — structurally satisfied by the shared
 * `ResponseCacheInvalidator` the adapter runtime owns; the composition root wires that same
 * instance in (CH-5.6: one mechanism, two key kinds).
 */
export interface EndpointCacheInvalidator {
  invalidateEndpoint(endpointId: string): void;
}

/** The activated composition — the now-`active` endpoint and its `active` bindings. */
export interface ComposeResult {
  readonly endpoint: AdapterEndpoint;
  readonly bindings: readonly AdapterBinding[];
}

/**
 * The **derived** composition analysis the composer sees **before** confirming (CO-4 +
 * CO-5) — the "compose-preview". Nothing here is activated or persisted: it informs the
 * decision (derive-then-confirm). The composer submits the *proposed* strategy/roles/
 * acknowledgements and gets back:
 *  - `supplementAnalysis` — per `supplement` of a `fanout-merge`, whether it is
 *    load-bearing, plus that a `primary`'s failure always fails the request (CO-4);
 *  - `coverage` — the consumer inputs reaching no backend, per binding and endpoint-wide
 *    (CO-5.1);
 *  - `validation` — whether the proposed composition would activate, including the
 *    blocking required-unmapped-input findings (CO-5.3) and the acknowledge-or-reject
 *    check, so the composer sees them before confirming.
 */
export interface CompositionPreview {
  readonly endpointId: string;
  readonly supplementAnalysis: SupplementLoadBearingAnalysis;
  readonly coverage: ConsumerInputCoverage;
  readonly validation: CompositionValidation;
  /**
   * CO-3 — the union derivations the composer confirms **before** activating (present
   * only for a proposed `collection-union`): unserviceable filters, sort/pagination
   * parameters still needing a decision, the dedup conflict-precedence rule, and the
   * large-collection size flag. `undefined` for any non-union proposal.
   */
  readonly union?: UnionCompositionAnalysis;
}

export class AdapterCompositionService {
  readonly #db: Database;
  readonly #loader: CompositionContextLoader;
  readonly #clock: () => Date;
  readonly #newId: () => string;
  readonly #readTraceContext: () => ActiveTraceContext | null;
  readonly #cacheInvalidator: EndpointCacheInvalidator;

  public constructor(deps: AdapterCompositionServiceDeps) {
    this.#db = deps.db;
    this.#loader = deps.loader ?? new DbCompositionContextLoader(deps.db);
    this.#clock = deps.clock ?? ((): Date => new Date());
    this.#newId = deps.newId;
    this.#readTraceContext = deps.readTraceContext ?? getActiveTraceContext;
    // No injected invalidator → invalidate nothing (a service wired without the shared cache,
    // e.g. a pure unit test). The real composition root always injects the shared instance.
    this.#cacheInvalidator = deps.cacheInvalidator ?? { invalidateEndpoint: (): void => {} };
  }

  /**
   * Compose (validate + activate) a `composition-required` endpoint (CO-2). Throws
   * `NotFoundError` (unknown endpoint), `ConflictError` (not `composition-required`), or
   * `BadRequestError` with the named rejection reasons as `issues` (invalid composition —
   * nothing activated). On success returns the activated endpoint + bindings and drops the
   * endpoint's cached entries (CH-5.2: `proposed → active`).
   */
  public async compose(
    endpointId: string,
    submission: CompositionSubmission,
    actor: string,
  ): Promise<ComposeResult> {
    const context = await this.#loadOrThrow(endpointId);
    if (context.endpoint.status !== "composition-required") {
      // CO-2 resolves `composition-required` endpoints; changing an already-`active`
      // endpoint's serving semantics is a recompose (CO-6) — use {@link recompose}.
      throw new ConflictError(
        `Adapter endpoint ${endpointId} is ${context.endpoint.status}; only a composition-required endpoint can be composed.`,
      );
    }
    return this.#validateAndActivate({
      endpointId,
      context,
      submission,
      actor,
      allowedFromStatuses: ["composition-required"],
      auditVerb: "composed",
    });
  }

  /**
   * **CO-6.1/6.5 — recompose an `active` endpoint.** Re-runs the **exact same** CO-2/CO-3
   * validation as {@link compose} over the endpoint's current binding facts and, on success,
   * re-activates with the submitted strategy/roles/order/chaining/`postMerge*`/dedup/
   * strictness/`cacheTtl` — recomposition is the same action minus the triggering approval.
   * A binding may be marked `disabled` in the submission (CO-6.2): it is validated as
   * addressed-but-not-served and its row is retained `disabled` so a later recompose can
   * reactivate it.
   *
   * On validation **failure** the recompose is inert — it throws `BadRequestError` before any
   * transaction opens, so nothing is partially applied, the prior active configuration keeps
   * serving, and the cache is **not** dropped (CH-5: a rejected recompose invalidates
   * nothing). A recompose that would leave a **write** endpoint with >1 active binding or a
   * role outside its strategy is rejected by that same validation (CO-6.5 / CO-2 crit 2/7-8).
   *
   * The guard accepts an `active` **or** `composition-required` endpoint (a recompose is
   * robust to a concurrent second-binding attach); a `disabled` endpoint must be re-enabled
   * first ({@link setEndpointEnabled}). Throws `NotFoundError` for an unknown endpoint.
   */
  public async recompose(
    endpointId: string,
    submission: CompositionSubmission,
    actor: string,
  ): Promise<ComposeResult> {
    const context = await this.#loadOrThrow(endpointId);
    if (
      context.endpoint.status !== "active" &&
      context.endpoint.status !== "composition-required"
    ) {
      throw new ConflictError(
        `Adapter endpoint ${endpointId} is ${context.endpoint.status}; a disabled endpoint must be re-enabled before it can be recomposed.`,
      );
    }
    return this.#validateAndActivate({
      endpointId,
      context,
      submission,
      actor,
      allowedFromStatuses: ["active", "composition-required"],
      auditVerb: "recomposed",
    });
  }

  /**
   * **CO-6.3 — enable/disable an endpoint.** Flips `AdapterEndpoint.status` to `disabled`
   * (the resolver then rejects requests with `endpoint-disabled`, RT-3.2) or back to `active`
   * — **retaining every config column and binding row**, so re-enabling restores the stored
   * configuration with nothing lost. Attributes the action (OA-3) and, on commit, drops the
   * endpoint's cached entries (CH-5.5): disabling evicts what was cached under the old
   * configuration, and re-enabling drops again so it serves **no** entry cached before it was
   * disabled. Throws `NotFoundError` for an unknown endpoint.
   */
  public async setEndpointEnabled(
    endpointId: string,
    enabled: boolean,
    actor: string,
  ): Promise<AdapterEndpoint> {
    // Existence check before any write (reusing the injectable loader), so an unknown
    // endpoint is a clean `NotFound` rather than a silent no-op.
    await this.#loadOrThrow(endpointId);
    const targetStatus: AdapterEndpoint["status"] = enabled ? "active" : "disabled";
    const endpoint = await tx(this.#db, async (txn) => {
      const compositions = new AdapterCompositionRepository(txn);
      const updated = await compositions.setEndpointStatus(endpointId, targetStatus);
      if (updated === undefined) {
        // Removed between the existence check and the write — a state conflict; tx rolls back.
        throw new ConflictError(`Adapter endpoint ${endpointId} no longer exists.`);
      }
      const audit = new AuditLogRepository(txn);
      await audit.insert(this.#statusAttribution(actor, endpointId, targetStatus));
      // TODO(Phase 6 graph): once the materialized adapter-dependency GraphEdge projection
      // lands (docs place it in Phase 6), recompute this endpoint's edges here so a disabled
      // endpoint no longer projects a live dependency. The ensure-exists upsert used at
      // instantiation (CO-1) cannot remove an edge, so there is nothing to invoke cheaply now.
      return updated;
    });
    // CH-5.5 — drop on every commit (disable AND re-enable); always correctness-safe.
    this.#cacheInvalidator.invalidateEndpoint(endpointId);
    return endpoint;
  }

  /**
   * **CO-4 + CO-5 preview** — derive the composition analysis the composer sees before
   * confirming, for a *proposed* `submission` (strategy/roles/acknowledgements). Pure
   * read: it loads the endpoint's context, derives the supplement load-bearing analysis
   * and the consumer-input coverage, and runs the same validator `compose` will run — but
   * activates and persists **nothing** (derive-then-confirm). Throws `NotFoundError` for
   * an unknown endpoint.
   */
  public async previewComposition(
    endpointId: string,
    submission: CompositionSubmission,
  ): Promise<CompositionPreview> {
    const context = await this.#loader.load(endpointId);
    if (context === undefined) {
      throw new NotFoundError(`Adapter endpoint ${endpointId} not found.`);
    }
    return {
      endpointId,
      supplementAnalysis: analyzeSupplementLoadBearing({
        aggregationStrategy: submission.aggregationStrategy,
        bindings: supplementAnalysisBindings(context, submission),
        requiredConsumerResponseFieldNames: context.requiredConsumerResponseFieldNames,
      }),
      coverage: deriveConsumerInputCoverage({
        consumerInputs: context.consumerInputs,
        bindings: context.bindingFacts.map((facts) => ({
          bindingId: facts.bindingId,
          mappedConsumerParamNames: facts.mappedConsumerParamNames,
          mappedConsumerBodyFieldNames: facts.mappedConsumerBodyFieldNames,
        })),
      }),
      validation: validateComposition({
        submission,
        bindingFacts: context.bindingFacts,
        consumerInputs: context.consumerInputs,
        unionBindingFacts: context.unionBindingFacts,
        consumerParameters: context.consumerParameters,
        consumerResponseFieldNames: context.consumerResponseFieldNames,
      }),
      // CO-3 — the union derivations, only for a proposed union (derive-then-confirm).
      ...(submission.aggregationStrategy === "collection-union"
        ? {
            union: deriveUnionCompositionAnalysis({
              unionBindingFacts: context.unionBindingFacts,
              consumerParameters: context.consumerParameters,
              submission: unionSubmissionSlice(submission),
              cacheTtlConfigured: submission.cacheTtl !== undefined,
            }),
          }
        : {}),
    };
  }

  /** Load the endpoint's composition context or throw `NotFoundError` (unknown endpoint). */
  async #loadOrThrow(endpointId: string): Promise<CompositionContext> {
    const context = await this.#loader.load(endpointId);
    if (context === undefined) {
      throw new NotFoundError(`Adapter endpoint ${endpointId} not found.`);
    }
    return context;
  }

  /**
   * The shared validate → atomically activate → attribute → invalidate core (CO-2.8 /
   * CO-6.1). Runs the **same** {@link validateComposition} for a first `compose` and a
   * `recompose`; a rejection is thrown **before** any transaction opens, so nothing is
   * activated, the endpoint keeps serving its previous configuration, and — critically for
   * CH-5 — the cache is left untouched (a rejected recompose invalidates nothing). On a
   * passing validation it activates the endpoint + every binding and writes the OA-3 audit
   * row in **one** transaction, then drops the endpoint's cached entries (CH-5.1/5.2) so the
   * committed change never takes up to `cacheTtl` to become visible.
   */
  async #validateAndActivate(params: {
    readonly endpointId: string;
    readonly context: CompositionContext;
    readonly submission: CompositionSubmission;
    readonly actor: string;
    readonly allowedFromStatuses: readonly AdapterEndpoint["status"][];
    readonly auditVerb: "composed" | "recomposed";
  }): Promise<ComposeResult> {
    const { endpointId, context, submission, actor, allowedFromStatuses, auditVerb } = params;
    const validation = validateComposition({
      submission,
      bindingFacts: context.bindingFacts,
      consumerInputs: context.consumerInputs,
      unionBindingFacts: context.unionBindingFacts,
      consumerParameters: context.consumerParameters,
      consumerResponseFieldNames: context.consumerResponseFieldNames,
    });
    if (!validation.ok) {
      // Fail loud, before any transaction: nothing is activated and the endpoint keeps
      // serving its previous configuration (CO-2.8 / CO-6.5). Each reason names the offender.
      throw new BadRequestError(
        `Composition of adapter endpoint ${endpointId} is invalid.`,
        validation.reasons.map(formatCompositionRejection),
      );
    }

    const applyInput = toApplyCompositionInput(
      endpointId,
      submission,
      actor,
      this.#clock(),
      allowedFromStatuses,
    );
    const result = await tx(this.#db, async (txn) => {
      const compositions = new AdapterCompositionRepository(txn);
      const applied = await compositions.applyComposition(applyInput);
      if (!applied.applied) {
        // A concurrent transition moved the endpoint out of an allowed source status after
        // our pre-check (e.g. it was disabled) — a state conflict; the tx rolls back cleanly.
        throw new ConflictError(
          `Adapter endpoint ${endpointId} is no longer in a state that can be ${auditVerb}.`,
        );
      }
      const audit = new AuditLogRepository(txn);
      await audit.insert(this.#compositionAttribution(actor, endpointId, submission, auditVerb));
      // TODO(Phase 6 graph): recompute this endpoint's adapter-dependency GraphEdge(s) here
      // once the materialized graph projection lands (docs place it in Phase 6). The CO-1
      // ensure-exists upsert cannot remove/rewrite an edge, so a disabled-binding set has
      // nothing to invoke cheaply now — the incremental projection is deferred, not built.
      return applied;
    });

    // CH-5.1/5.2 — the committed configuration/binding-status change drops all of this
    // endpoint's cached entries, through the SAME seam CH-3/CH-4 use (CH-5.6). Correctness-
    // safe and outside the tx: a spurious drop only ever costs a re-fetch.
    this.#cacheInvalidator.invalidateEndpoint(endpointId);
    return { endpoint: result.endpoint, bindings: result.bindings };
  }

  /**
   * The OA-3 attribution row for a completed (re)composition. Recorded as an
   * `adapter-request` audit entry — the adapter family's row type, carrying
   * `relatedEndpointId` — because the concept coins no dedicated operator-action audit
   * type and no migration is in scope to add one (the same reuse the sync operator makes
   * with `sync-execution`). Metadata only: actor + endpoint id + a short `details` note,
   * never credential material or a payload value; no served-request `status`/`cause`/
   * `degraded`, since a composition is not a request outcome.
   */
  #compositionAttribution(
    actor: string,
    endpointId: string,
    submission: CompositionSubmission,
    verb: "composed" | "recomposed",
  ): AuditLogEntry {
    const trace = this.#readTraceContext();
    const activeCount = submission.bindings.filter((binding) => binding.disabled !== true).length;
    const disabledCount = submission.bindings.length - activeCount;
    const disabledNote = disabledCount > 0 ? `, ${String(disabledCount)} disabled` : "";
    return stripUndefined({
      id: this.#newId(),
      type: "adapter-request" as const,
      actor,
      details: `adapter endpoint ${verb} (strategy=${submission.aggregationStrategy}, ${String(activeCount)} active binding(s)${disabledNote}, ${submission.strictness})`,
      relatedEndpointId: endpointId,
      traceId: trace?.traceId,
      spanId: trace?.spanId,
      timestamp: this.#clock(),
    });
  }

  /**
   * The OA-3 attribution row for an endpoint enable/disable (CO-6.3). Same
   * `adapter-request` reuse and metadata-only discipline as {@link compositionAttribution}
   * — actor + endpoint id + the new status, never any secret or payload value.
   */
  #statusAttribution(
    actor: string,
    endpointId: string,
    status: AdapterEndpoint["status"],
  ): AuditLogEntry {
    const trace = this.#readTraceContext();
    return stripUndefined({
      id: this.#newId(),
      type: "adapter-request" as const,
      actor,
      details: `adapter endpoint ${status === "disabled" ? "disabled" : "re-enabled"} (status=${status})`,
      relatedEndpointId: endpointId,
      traceId: trace?.traceId,
      spanId: trace?.spanId,
      timestamp: this.#clock(),
    });
  }
}

/**
 * The CO-4 per-binding input: each submitted binding's *proposed* role paired with the
 * consumer response fields the loader derived it supplies (pair-scoped). A submitted
 * binding with no matching facts (a mismatch the validator flags separately) contributes
 * an empty supplied set rather than throwing — the preview stays a total read.
 */
function supplementAnalysisBindings(
  context: CompositionContext,
  submission: CompositionSubmission,
): readonly SupplementAnalysisBinding[] {
  const factsById = new Map(context.bindingFacts.map((facts) => [facts.bindingId, facts]));
  return submission.bindings.map((binding) => ({
    bindingId: binding.bindingId,
    role: binding.role,
    suppliedConsumerResponseFieldPaths:
      factsById.get(binding.bindingId)?.consumerResponseFieldPaths ?? new Set<string>(),
  }));
}

/** The union-config slice of a submission, for the CO-3 analysis derivation. */
function unionSubmissionSlice(submission: CompositionSubmission): UnionSubmission {
  return {
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
  };
}

/**
 * Stamp the composer's proposed pagination convention with its confirmation state
 * (CO-3.5 derive-then-confirm) — `confirmedBy`/`confirmedAt` set to the **authenticated
 * operator** + the service clock when confirmed, both `null` while unconfirmed. The
 * confirmation is never client-supplied, so an unconfirmed convention stays honestly
 * distinguishable from a confirmed one (RP-2 rejects requests using it while unconfirmed).
 */
function stampPostMergePagination(
  submission: CompositionSubmission,
  actor: string,
  now: Date,
): PostMergePagination | null {
  if (submission.postMergePagination === undefined) {
    return null;
  }
  const confirmed = submission.confirmPostMergePagination === true;
  return {
    convention: submission.postMergePagination,
    confirmedBy: confirmed ? actor : null,
    confirmedAt: confirmed ? now : null,
  };
}

/**
 * Map the validated submission to the repository's activation payload. The CO-3 union
 * post-merge config is persisted **only** for a `collection-union` (a full overwrite —
 * `null` on every other strategy, so recomposing clears stale union config). Each binding
 * carries its target `status` (CO-6.2): `disabled` when the composer marked it out of
 * service (row retained, planner skips it), `active` otherwise. `allowedFromStatuses` guards
 * the endpoint UPDATE — `composition-required` for a first compose, plus `active` for a
 * recompose.
 */
function toApplyCompositionInput(
  endpointId: string,
  submission: CompositionSubmission,
  actor: string,
  now: Date,
  allowedFromStatuses: readonly AdapterEndpoint["status"][],
): ApplyCompositionInput {
  const isUnion = submission.aggregationStrategy === "collection-union";
  return {
    endpointId,
    allowedFromStatuses: [...allowedFromStatuses],
    endpoint: {
      aggregationStrategy: submission.aggregationStrategy,
      strictness: submission.strictness,
      cacheTtl: submission.cacheTtl ?? null,
      // CO-5.4 — persist the composer's acknowledged-ignored inputs so the runtime can
      // serve an acknowledged input (dropped, non-silent) and reject an unacknowledged
      // one (RP-2.4). Absent = `null` (no acknowledgements — the fail-loud default).
      acknowledgedIgnoredInputs:
        submission.acknowledgedIgnoredInputs === undefined
          ? null
          : [...submission.acknowledgedIgnoredInputs],
      // CO-3 — union post-merge config; `null` for any non-union strategy.
      postMergeDedup: isUnion ? (submission.postMergeDedup ?? null) : null,
      postMergeFilters: isUnion ? (submission.postMergeFilters ?? null) : null,
      postMergeSorts: isUnion ? (submission.postMergeSorts ?? null) : null,
      postMergePagination: isUnion ? stampPostMergePagination(submission, actor, now) : null,
    },
    bindings: submission.bindings.map((binding) => ({
      bindingId: binding.bindingId,
      role: binding.role,
      executionOrder: binding.executionOrder ?? null,
      dependsOnBindingId: binding.dependsOnBindingId ?? null,
      chainInputs: binding.chainInputs ?? null,
      // CO-6.2 — a binding the composer marked `disabled` is persisted `disabled` (row
      // retained, planner skips it); every other binding is activated.
      status: binding.disabled === true ? "disabled" : "active",
    })),
  };
}
