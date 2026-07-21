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
  formatCompositionRejection,
  validateComposition,
  type CompositionSubmission,
  type CompositionValidation,
} from "./validate.js";

/**
 * **CO-2 application service** — the seam between the thin operator route and the
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
 */
export interface AdapterCompositionServiceDeps {
  readonly db: Database;
  readonly loader?: CompositionContextLoader;
  readonly clock?: () => Date;
  readonly newId: () => string;
  readonly readTraceContext?: () => ActiveTraceContext | null;
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
}

export class AdapterCompositionService {
  readonly #db: Database;
  readonly #loader: CompositionContextLoader;
  readonly #clock: () => Date;
  readonly #newId: () => string;
  readonly #readTraceContext: () => ActiveTraceContext | null;

  public constructor(deps: AdapterCompositionServiceDeps) {
    this.#db = deps.db;
    this.#loader = deps.loader ?? new DbCompositionContextLoader(deps.db);
    this.#clock = deps.clock ?? ((): Date => new Date());
    this.#newId = deps.newId;
    this.#readTraceContext = deps.readTraceContext ?? getActiveTraceContext;
  }

  /**
   * Compose (validate + activate) a `composition-required` endpoint. Throws
   * `NotFoundError` (unknown endpoint), `ConflictError` (not `composition-required`), or
   * `BadRequestError` with the named rejection reasons as `issues` (invalid composition —
   * nothing activated). On success returns the activated endpoint + bindings.
   */
  public async compose(
    endpointId: string,
    submission: CompositionSubmission,
    actor: string,
  ): Promise<ComposeResult> {
    const context = await this.#loader.load(endpointId);
    if (context === undefined) {
      throw new NotFoundError(`Adapter endpoint ${endpointId} not found.`);
    }
    if (context.endpoint.status !== "composition-required") {
      // CO-2 resolves `composition-required` endpoints; recomposing an `active` (or
      // `disabled`) endpoint is CO-6, out of scope here.
      throw new ConflictError(
        `Adapter endpoint ${endpointId} is ${context.endpoint.status}; only a composition-required endpoint can be composed.`,
      );
    }

    const validation = validateComposition({
      submission,
      bindingFacts: context.bindingFacts,
      consumerInputs: context.consumerInputs,
    });
    if (!validation.ok) {
      // Fail loud, before any transaction: nothing is activated and the endpoint keeps
      // serving its previous configuration (CO-2.8). Each reason names the offender.
      throw new BadRequestError(
        `Composition of adapter endpoint ${endpointId} is invalid.`,
        validation.reasons.map(formatCompositionRejection),
      );
    }

    const applyInput = toApplyCompositionInput(endpointId, submission);
    const result = await tx(this.#db, async (txn) => {
      const compositions = new AdapterCompositionRepository(txn);
      const applied = await compositions.applyComposition(applyInput);
      if (!applied.applied) {
        // A concurrent transition moved the endpoint out of `composition-required` after
        // our pre-check — treat as a state conflict; the tx rolls back with no writes.
        throw new ConflictError(
          `Adapter endpoint ${endpointId} is no longer composition-required.`,
        );
      }
      const audit = new AuditLogRepository(txn);
      await audit.insert(this.#attribution(actor, endpointId, submission));
      return applied;
    });

    return { endpoint: result.endpoint, bindings: result.bindings };
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
      }),
    };
  }

  /**
   * The OA-3 attribution row for a completed composition. Recorded as an
   * `adapter-request` audit entry — the adapter family's row type, carrying
   * `relatedEndpointId` — because the concept coins no dedicated operator-action audit
   * type and no migration is in scope to add one (the same reuse the sync operator makes
   * with `sync-execution`). Metadata only: actor + endpoint id + a short `details` note,
   * never credential material or a payload value; no served-request `status`/`cause`/
   * `degraded`, since a composition is not a request outcome.
   */
  #attribution(
    actor: string,
    endpointId: string,
    submission: CompositionSubmission,
  ): AuditLogEntry {
    const trace = this.#readTraceContext();
    return stripUndefined({
      id: this.#newId(),
      type: "adapter-request" as const,
      actor,
      details: `adapter endpoint composed (strategy=${submission.aggregationStrategy}, ${String(submission.bindings.length)} binding(s), ${submission.strictness})`,
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

/** Map the validated submission to the repository's activation payload. */
function toApplyCompositionInput(
  endpointId: string,
  submission: CompositionSubmission,
): ApplyCompositionInput {
  return {
    endpointId,
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
    },
    bindings: submission.bindings.map((binding) => ({
      bindingId: binding.bindingId,
      role: binding.role,
      executionOrder: binding.executionOrder ?? null,
      dependsOnBindingId: binding.dependsOnBindingId ?? null,
      chainInputs: binding.chainInputs ?? null,
    })),
  };
}
