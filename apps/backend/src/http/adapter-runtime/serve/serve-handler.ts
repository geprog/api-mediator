import type {
  AdapterRequest,
  ServeHandler,
  ServeInput,
  ServeOutcome,
} from "@mediator/adapter-engine";
import type { AdapterEndpoint, ChainInput, IrOperation } from "@mediator/domain";
import type { JsonValue } from "@mediator/transform";

import { topLevelConsumerFieldName } from "../../../modules/adapter-composition/analysis.js";
import {
  paginationConventionParamRefs,
  pushdownEligibleParamNames,
} from "../../../modules/adapter-composition/union.js";
import {
  aggregateFanoutMerge,
  aggregateSingle,
  type AggregateOutcome,
  type FanoutMergeBindingInfo,
  type FanoutMergeContext,
} from "./aggregator.js";
import type { BackendCaller } from "./backend-call.js";
import {
  validateConsumerResponse,
  validateInboundRequest,
  type UnionServeConfig,
} from "./ir-validation.js";
import { planResolution, type BindingHealthInput } from "./planner.js";
import {
  bindingFailureCause,
  resultFailureCause,
  type BindingFailure,
  type BindingResult,
  type PlanExecutionGroup,
  type PlannedBinding,
  type ResolutionPlan,
} from "./pipeline-types.js";
import {
  mapRequestToBackend,
  mappedConsumerParamNames,
  paramRefBareName,
  resolveChainInputs,
} from "./request-mapping.js";
import { mapBackendResponseToConsumer } from "./response-mapping.js";
import type { ServeContext, ServeContextLoader } from "./serve-context.js";
import {
  aggregateCollectionUnion,
  type CollectionUnionContext,
  type UnionDedupPlan,
} from "./union-aggregate.js";
import {
  confirmedNativeIdFieldPath,
  deriveUnionPagination,
  deriveUnionRecordsPath,
} from "./union-binding.js";
import {
  DEFAULT_UNION_ROW_CEILING,
  RestUnionCollectionReader,
  type UnionCollectionReader,
} from "./union-fetch.js";
import type { UnionLinkContributor, UnionLinkResolver } from "./union-links.js";
import {
  resolvePostMergeFilters,
  resolvePostMergePage,
  resolvePostMergeSort,
} from "./union-request.js";

/** The consumer-shape response of an upstream binding, fed into a chained dependent (TE-3). */
interface ChainSource {
  readonly chainInputs: readonly ChainInput[];
  readonly upstreamConsumerShape: JsonValue;
}

/**
 * **The real `ServeHandler` (RP/TE/AG) injected behind the RT Protocol-Server seam.**
 * It runs the serve pipeline for the `single` (AG-1) and `fanout-merge` (AG-2, with TE-3
 * chained bindings) strategies:
 *
 *   load context → RP-2 validate inbound → RP-3/RP-4 plan → per binding
 *   (TE-1 map request, TE-3 fill chained inputs, TE-2 call backend, TE-4 map response) →
 *   TE-5 envelopes → AG-1/AG-2 aggregate → AG-7 validate response → {@link ServeOutcome}.
 *
 * Bindings run **grouped by `executionOrder`** — a group in parallel, groups in ascending
 * order — and a **chained** binding (`dependsOnBindingId`) waits for its upstream's
 * consumer-shape response regardless of order (TE-3.1); all backend calls hold slots on
 * the **shared** `AppLoadGovernor` (via the injected caller), so adapter fan-out competes
 * with sync for the one per-app ceiling.
 *
 * Everything the pipeline decides is an explicit value passed between pure stages;
 * only the loader (persistence) and the backend caller (the governed/credentialed
 * `ProtocolClient` call) do I/O. The whole thing stays behind the neutral seam — it
 * returns a protocol-neutral {@link ServeOutcome} and touches no HTTP itself.
 *
 * **Fail loud, never plausible-but-wrong.** Every failure path returns its distinct
 * cause; a response that fails the consumer schema is a `mediator-transform-error`
 * (AG-7), never emitted as data; a missing required backend parameter refuses the
 * call (TE-1). Every mediator-side defect is logged as its own signal (AG-7.4), with
 * payload-free details (names/kinds only — never a value, token, or secret).
 */

/** The minimal logger the handler emits mediator-side defect signals through (AG-7.4). */
export interface ServeLogger {
  warn(fields: Record<string, unknown>, message: string): void;
}

export interface AdapterServeHandlerDeps {
  readonly loader: ServeContextLoader;
  readonly backendCaller: BackendCaller;
  readonly logger: ServeLogger;
  /**
   * AG-5 — the bounded paged union collection reader. Defaults to a
   * {@link RestUnionCollectionReader} over the shared {@link BackendCaller} (the same
   * governed/credentialed TE-2 path), so a union page competes for the one per-app ceiling.
   */
  readonly unionCollectionReader?: UnionCollectionReader;
  /**
   * AG-3.3 — resolves per-row link-group keys from `RecordLink`s for **record-link** dedup.
   * Required only when a served union endpoint configures that mode; a union served without
   * one under record-link dedup fails loud (a composition-root wiring gap).
   */
  readonly unionLinkResolver?: UnionLinkResolver;
  /** AG-5.1 — the config-defined per-request row ceiling; default {@link DEFAULT_UNION_ROW_CEILING}. */
  readonly unionRowCeiling?: number;
}

/** A union contributor's fetch outcome: a per-binding envelope, or a whole-request fail-loud. */
type UnionContributorOutcome =
  | { readonly kind: "result"; readonly result: BindingResult }
  | {
      readonly kind: "fail-loud";
      readonly failure: BindingFailure;
      /** Present when the fail-loud is the AG-5 row ceiling — its own telemetry signal (AG-5.5). */
      readonly ceiling?: { readonly backendAppId: string };
    };

export class AdapterServeHandler implements ServeHandler {
  private readonly unionReader: UnionCollectionReader;
  private readonly unionRowCeiling: number;

  public constructor(private readonly deps: AdapterServeHandlerDeps) {
    this.unionReader =
      deps.unionCollectionReader ?? new RestUnionCollectionReader(deps.backendCaller);
    this.unionRowCeiling = deps.unionRowCeiling ?? DEFAULT_UNION_ROW_CEILING;
  }

  public async serve(input: ServeInput): Promise<ServeOutcome> {
    const context = await this.deps.loader.load(input);
    const consumerOperation = context.consumerOperation;
    if (consumerOperation === undefined) {
      return this.defect(input.endpoint.id, "consumer operation not found in its CONSUMER spec IR");
    }

    // RP-2 — validate the inbound request against the consumer's own contract before
    // any transform or backend call; a violation is a client rejection, never served. A
    // supplied-but-unmapped input the composer acknowledged-ignored (CO-5.4) is served
    // with that input dropped, not rejected — the acknowledgement makes the drop
    // non-silent; an unacknowledged unmapped input still rejects (RP-2.4).
    const inbound = validateInboundRequest(
      consumerOperation,
      input.request,
      collectMappedConsumerParams(context),
      collectAcknowledgedIgnoredParams(input.endpoint),
      // RP-2.2/2.3 — union serving semantics, only for a collection-union (undefined
      // otherwise, so a non-union endpoint's inbound validation is unchanged).
      buildUnionServeConfig(input.endpoint, context),
    );
    if (!inbound.ok) {
      return { kind: "rejected", reason: inbound.reason, detail: inbound.detail };
    }

    // RP-3 / RP-4 — re-validate binding health and produce the explicit plan.
    const planResult = planResolution({
      endpoint: input.endpoint,
      activeBindings: context.bindings.map((loaded): BindingHealthInput => ({
        binding: loaded.binding,
        mappingStatus: loaded.mappingStatus,
        backendStatus: loaded.backendStatus,
      })),
    });
    if (!planResult.ok) {
      return this.defect(input.endpoint.id, `planning failed: ${planResult.detail}`);
    }
    const plan = planResult.plan;

    // AG-1/AG-2/AG-3 — execute + aggregate per the endpoint's strategy. `collection-union`
    // (AG-3/4/5) runs its own bounded paged fetch + merge/dedup/filter/sort/paginate path;
    // `single`/`fanout-merge` run the per-binding executor + their aggregators.
    const aggregate =
      plan.aggregationStrategy === "collection-union"
        ? await this.serveCollectionUnion(plan, context, consumerOperation, input)
        : this.aggregate(
            plan,
            await this.executePlan(plan, context, consumerOperation, input.request),
            context,
            consumerOperation,
          );
    if (aggregate.kind === "failure") {
      return { kind: "failed", cause: bindingFailureCause(aggregate.failure) };
    }

    // AG-7 — validate the aggregated response against the consumer's response schema; a
    // failure is a mediator-side defect, logged and never returned as data. A degraded
    // response must still pass — it only ever omits genuinely-optional fields (AG-2.3).
    const validation = validateConsumerResponse(consumerOperation, aggregate.payload);
    if (!validation.ok) {
      this.deps.logger.warn(
        {
          endpointId: input.endpoint.id,
          cause: "mediator-transform-error",
          detail: validation.detail,
        },
        "adapter serve: aggregated response failed consumer schema validation (AG-7)",
      );
      return { kind: "failed", cause: "mediator-transform-error" };
    }

    return {
      kind: "served",
      body: aggregate.payload,
      degraded: aggregate.degraded,
      contributingBackendAppIds: aggregate.contributingBackendAppIds,
      // AG-2.3 — name the failed backend(s) out of band; absent on a complete response.
      ...(aggregate.degradedBackendAppIds.length > 0
        ? { degradedBackendAppIds: aggregate.degradedBackendAppIds }
        : {}),
    };
  }

  /**
   * AG-1 / AG-2 — dispatch to the strategy's aggregator. For `fanout-merge` it derives the
   * composed decision the aggregator consumes **at request time** (CO-4.4): per binding the
   * backend it calls and the top-level consumer response fields it supplies, plus the
   * consumer schema's required field names — required-ness read **live from the schema**,
   * never a composition-time snapshot.
   */
  private aggregate(
    plan: ResolutionPlan,
    results: readonly BindingResult[],
    context: ServeContext,
    consumerOperation: IrOperation,
  ): AggregateOutcome {
    if (plan.aggregationStrategy === "fanout-merge") {
      return aggregateFanoutMerge(plan, results, this.fanoutContext(context, consumerOperation));
    }
    return aggregateSingle(plan, results);
  }

  /** Build the request-time {@link FanoutMergeContext} the fanout-merge aggregator consumes (CO-4.4). */
  private fanoutContext(context: ServeContext, consumerOperation: IrOperation): FanoutMergeContext {
    const bindingInfo = new Map<string, FanoutMergeBindingInfo>();
    for (const loaded of context.bindings) {
      const suppliedConsumerResponseFields = new Set<string>();
      for (const field of loaded.responsePhaseFieldMappings) {
        // The consumer response fields this binding supplies — its response-phase targets,
        // already pair-scoped by the loader — matched at the schema's top-level segment.
        suppliedConsumerResponseFields.add(topLevelConsumerFieldName(field.targetPath));
      }
      bindingInfo.set(loaded.binding.id, {
        backendAppId: loaded.binding.backendAppId,
        suppliedConsumerResponseFields,
      });
    }
    const requiredConsumerResponseFieldNames = new Set<string>();
    for (const field of consumerOperation.responseSchema?.fields ?? []) {
      if (field.required) {
        requiredConsumerResponseFieldNames.add(field.name);
      }
    }
    return { bindingInfo, requiredConsumerResponseFieldNames };
  }

  /**
   * **AG-3/AG-4/AG-5 — serve a `collection-union` endpoint.** Each contributor's collection
   * is fetched through the bounded paged reader (AG-5), its rows mapped to consumer shape
   * with per-row backend-native id provenance (TE-4), then merged / deduped / post-merge
   * filtered / sorted / paginated by the pure aggregator. A row-ceiling breach or a
   * mediator-side defect fails the whole request **loud** (never a truncated union); a live
   * backend failure is a **droppable** contributor (AG-3.2, non-strict), named out of band.
   */
  private async serveCollectionUnion(
    plan: ResolutionPlan,
    context: ServeContext,
    consumerOperation: IrOperation,
    input: ServeInput,
  ): Promise<AggregateOutcome> {
    const results: BindingResult[] = plan.eliminated.map((eliminated) => ({
      kind: "not-called",
      bindingId: eliminated.bindingId,
      role: eliminated.role,
      executionOrder: eliminated.executionOrder,
      cause: eliminated.cause,
    }));

    // All contributors run in parallel (a union never chains); each holds a slot on the
    // shared per-app governor via the reader's TE-2 caller.
    const planned = plan.groups.flatMap((group) => group.bindings);
    const fetched = await Promise.all(
      planned.map((binding) =>
        this.fetchUnionContributor(binding, context, consumerOperation, input.request),
      ),
    );
    for (const outcome of fetched) {
      if (outcome.kind === "fail-loud") {
        if (outcome.ceiling !== undefined) {
          // AG-5.5 — the ceiling firing is its OWN telemetry signal, not folded into the
          // generic upstream-error path, so an operator sees the endpoint outgrew its config.
          this.deps.logger.warn(
            {
              endpointId: input.endpoint.id,
              signal: "union-row-ceiling-exceeded",
              backendAppId: outcome.ceiling.backendAppId,
              rowCeiling: this.unionRowCeiling,
              cause: "upstream-error",
            },
            "adapter serve: union row ceiling exceeded (AG-5)",
          );
        }
        return { kind: "failure", failure: outcome.failure };
      }
      results.push(outcome.result);
    }

    const dedup = await this.resolveUnionDedup(input.endpoint, context, results);
    if (!dedup.ok) {
      return { kind: "failure", failure: dedup.failure };
    }

    const unionContext: CollectionUnionContext = {
      backendAppIdByBinding: new Map(
        context.bindings.map((loaded) => [loaded.binding.id, loaded.binding.backendAppId]),
      ),
      dedup: dedup.plan,
      postMergeFilters: resolvePostMergeFilters(input.endpoint, input.request),
      sort: resolvePostMergeSort(input.endpoint, input.request),
      pagination: resolvePostMergePage(input.endpoint, input.request),
    };
    return aggregateCollectionUnion(plan, results, unionContext);
  }

  /**
   * Fetch one union contributor (AG-5) and map its rows to consumer shape (TE-4). A live
   * upstream failure becomes a droppable failure envelope; a ceiling breach or a
   * mediator-side defect is a whole-request fail-loud.
   */
  private async fetchUnionContributor(
    planned: PlannedBinding,
    context: ServeContext,
    consumerOperation: IrOperation,
    request: AdapterRequest,
  ): Promise<UnionContributorOutcome> {
    const loaded = context.bindings.find((entry) => entry.binding.id === planned.bindingId);
    if (loaded === undefined) {
      return this.unionFailLoud(
        planned.bindingId,
        "binding context missing for a union contributor",
      );
    }
    if (
      loaded.backendOperation === undefined ||
      loaded.backendBaseUrl === undefined ||
      loaded.backendResourceBinding === undefined
    ) {
      return this.unionFailLoud(
        planned.bindingId,
        "backend operation, base URL, or ResourceBinding is unresolvable for the union contributor",
      );
    }

    // TE-1 — consumer request → backend request (pushed-down filters, AG-4.1). No chaining.
    const mapped = mapRequestToBackend({
      mappingId: loaded.mappingId,
      consumerOperation,
      backendOperation: loaded.backendOperation,
      parameterMappings: loaded.parameterMappings,
      requestPhaseFieldMappings: loaded.requestPhaseFieldMappings,
      request,
    });
    if (!mapped.ok) {
      return this.unionFailLoud(planned.bindingId, mapped.detail);
    }

    const nativeIdFieldPath = confirmedNativeIdFieldPath(loaded.backendResourceBinding.nativeIdRef);
    const pagination = deriveUnionPagination(
      loaded.backendResourceBinding.paginationRef,
      loaded.backendOperation,
    );
    if (pagination === "unresolved") {
      // CO-3.7 blocks composing a paged read with an unconfirmed paginationRef; loud backstop.
      return this.unionFailLoud(
        planned.bindingId,
        "backend paginationRef is present but unconfirmed (union not composable)",
      );
    }
    const recordsPath = deriveUnionRecordsPath(loaded.backendOperation, nativeIdFieldPath);

    const read = await this.unionReader.read({
      backendAppId: loaded.binding.backendAppId,
      baseUrl: loaded.backendBaseUrl,
      operation: loaded.backendOperation,
      baseRequest: mapped.request,
      pagination,
      recordsPath,
      nativeIdFieldPath,
      rowCeiling: this.unionRowCeiling,
      ...(loaded.backendLimits !== undefined ? { limits: loaded.backendLimits } : {}),
    });

    if (!read.ok) {
      if (read.kind === "upstream-error") {
        // AG-3.2 — a live backend failure is a droppable contributor (dropped when non-strict).
        return {
          kind: "result",
          result: this.failureEnvelope(planned, {
            cause: "upstream-error",
            backendAppId: loaded.binding.backendAppId,
            detail: read.detail,
          }),
        };
      }
      if (read.kind === "ceiling-exceeded") {
        // AG-5.2 — never truncate: the whole request fails, naming the backend + ceiling.
        return {
          kind: "fail-loud",
          failure: {
            cause: "upstream-error",
            backendAppId: loaded.binding.backendAppId,
            detail: read.detail,
          },
          ceiling: { backendAppId: loaded.binding.backendAppId },
        };
      }
      return this.unionFailLoud(planned.bindingId, read.detail);
    }

    // TE-4 — map each raw row to consumer shape; native-id provenance stays index-aligned.
    const shaped = mapBackendResponseToConsumer(loaded.responsePhaseFieldMappings, [...read.rows]);
    if (!shaped.ok) {
      return this.unionFailLoud(planned.bindingId, shaped.detail);
    }
    return {
      kind: "result",
      result: {
        kind: "success",
        bindingId: planned.bindingId,
        role: planned.role,
        executionOrder: planned.executionOrder,
        backendAppId: loaded.binding.backendAppId,
        payload: shaped.payload,
        rowProvenance: read.nativeIds,
      },
    };
  }

  /**
   * AG-3.3/3.4/3.5 — the executed dedup plan for a union. `record-link` resolves per-row
   * link-group keys from `RecordLink`s over the successful contributors' native-id provenance
   * (the union only READS links). `dedup-key` binds a consumer field; `none` is the honest
   * default. A record-link union served without a link resolver wired is a fail-loud defect.
   */
  private async resolveUnionDedup(
    endpoint: AdapterEndpoint,
    context: ServeContext,
    results: readonly BindingResult[],
  ): Promise<
    | { readonly ok: true; readonly plan: UnionDedupPlan }
    | { readonly ok: false; readonly failure: BindingFailure }
  > {
    const dedup = endpoint.postMergeDedup ?? { mode: "none" };
    if (dedup.mode === "dedup-key") {
      return {
        ok: true,
        plan: { mode: "dedup-key", fieldName: topLevelConsumerFieldName(dedup.dedupKeyFieldPath) },
      };
    }
    if (dedup.mode !== "record-link") {
      return { ok: true, plan: { mode: "none" } };
    }
    const resolver = this.deps.unionLinkResolver;
    if (resolver === undefined) {
      const detail = "record-link dedup requires a union link resolver, which is not wired";
      this.deps.logger.warn(
        { endpointId: endpoint.id, cause: "mediator-transform-error", detail },
        "adapter serve: mediator-side union defect",
      );
      return { ok: false, failure: { cause: "mediator-transform-error", detail } };
    }
    const loadedById = new Map(context.bindings.map((loaded) => [loaded.binding.id, loaded]));
    const contributors: UnionLinkContributor[] = [];
    for (const result of results) {
      if (result.kind !== "success") {
        continue;
      }
      const loaded = loadedById.get(result.bindingId);
      contributors.push({
        bindingId: result.bindingId,
        backendAppId: result.backendAppId,
        backendResourceRef:
          loaded === undefined ? "" : backendResourceRefOf(loaded.binding.backendOperationId),
        nativeIds: result.rowProvenance ?? [],
      });
    }
    const linkGroupKeyByBinding = await resolver.resolve(contributors);
    return { ok: true, plan: { mode: "record-link", linkGroupKeyByBinding } };
  }

  /** A whole-request fail-loud (mediator-side union defect), logged as its own signal (AG-7.4). */
  private unionFailLoud(bindingId: string, detail: string): UnionContributorOutcome {
    this.deps.logger.warn(
      { bindingId, cause: "mediator-transform-error", detail },
      "adapter serve: mediator-side union defect",
    );
    return { kind: "fail-loud", failure: { cause: "mediator-transform-error", detail } };
  }

  /**
   * Execute the plan into one envelope per binding (TE-1..TE-5). Eliminated bindings are
   * `not-called` envelopes (their planner cause); planned bindings run **grouped by
   * `executionOrder`** — each group in parallel, groups in ascending order (TE-2.1/2.2) —
   * with a chained binding waiting for its upstream regardless of order (TE-3.1).
   */
  private async executePlan(
    plan: ResolutionPlan,
    context: ServeContext,
    consumerOperation: IrOperation,
    request: AdapterRequest,
  ): Promise<BindingResult[]> {
    const results: BindingResult[] = plan.eliminated.map((eliminated) => ({
      kind: "not-called",
      bindingId: eliminated.bindingId,
      role: eliminated.role,
      executionOrder: eliminated.executionOrder,
      cause: eliminated.cause,
    }));
    // An eliminated binding is a settled (non-success) upstream: a dependent of it becomes
    // a dependent failure (TE-3.5), never dispatched with a hole.
    const settled = new Map<string, BindingResult>(
      results.map((result) => [result.bindingId, result]),
    );

    for (const group of plan.groups) {
      const groupResults = await this.executeGroup(
        group,
        settled,
        context,
        consumerOperation,
        request,
      );
      for (const [bindingId, result] of groupResults) {
        settled.set(bindingId, result);
        results.push(result);
      }
    }
    return results;
  }

  /**
   * Execute one `executionOrder` group's bindings **in parallel** (TE-2.1). All group
   * promises are registered before any body proceeds (a microtask start-gate), so a
   * chained binding whose upstream is in the same group can await that upstream's promise
   * (TE-3.1); an upstream in an earlier group is already `settled`.
   */
  private async executeGroup(
    group: PlanExecutionGroup,
    settled: ReadonlyMap<string, BindingResult>,
    context: ServeContext,
    consumerOperation: IrOperation,
    request: AdapterRequest,
  ): Promise<Map<string, BindingResult>> {
    const inFlight = new Map<string, Promise<BindingResult>>();
    const startGate = Promise.resolve();
    for (const planned of group.bindings) {
      inFlight.set(
        planned.bindingId,
        (async (): Promise<BindingResult> => {
          // Yield once so every group promise is registered before any dependency await.
          await startGate;
          return this.executeChainAware(
            planned,
            settled,
            inFlight,
            context,
            consumerOperation,
            request,
          );
        })(),
      );
    }
    const out = new Map<string, BindingResult>();
    for (const planned of group.bindings) {
      const promise = inFlight.get(planned.bindingId);
      if (promise !== undefined) {
        out.set(planned.bindingId, await promise);
      }
    }
    return out;
  }

  /**
   * Run one planned binding, honoring its dependency (TE-3). A non-chained binding runs
   * directly; a chained binding waits for its upstream's envelope, then either fails as a
   * dependent (upstream failed → not called, TE-3.5) or runs with its `chainInputs` filled
   * from the upstream's **consumer-shape** response (TE-3.2).
   */
  private async executeChainAware(
    planned: PlannedBinding,
    settled: ReadonlyMap<string, BindingResult>,
    inFlight: ReadonlyMap<string, Promise<BindingResult>>,
    context: ServeContext,
    consumerOperation: IrOperation,
    request: AdapterRequest,
  ): Promise<BindingResult> {
    const upstreamId = planned.dependsOnBindingId;
    if (upstreamId === undefined) {
      return this.executeBinding(planned, undefined, context, consumerOperation, request);
    }

    const upstream = await this.awaitUpstream(upstreamId, settled, inFlight);
    if (upstream === undefined) {
      // The upstream is neither settled (earlier group / eliminated) nor in this group —
      // it must be ordered *after* the dependent, an ordering CO-2 should forbid. Fail loud
      // rather than deadlock a live caller (a defensible runtime backstop).
      return this.transformFailure(
        planned,
        `chained binding depends on '${upstreamId}', which is not resolved in an earlier or same execution group`,
      );
    }
    if (upstream.kind !== "success") {
      // TE-3.5 — the upstream failed, so the dependent is not called; propagate the
      // upstream's specific cause so the request's fate keeps its root reason (AG-2).
      return this.failureEnvelope(planned, resultFailureCause(upstream));
    }
    return this.executeBinding(
      planned,
      { chainInputs: planned.chainInputs ?? [], upstreamConsumerShape: upstream.payload },
      context,
      consumerOperation,
      request,
    );
  }

  /** Resolve an upstream binding's already-available envelope: a settled result, else its in-flight promise. */
  private async awaitUpstream(
    upstreamId: string,
    settled: ReadonlyMap<string, BindingResult>,
    inFlight: ReadonlyMap<string, Promise<BindingResult>>,
  ): Promise<BindingResult | undefined> {
    const already = settled.get(upstreamId);
    if (already !== undefined) {
      return already;
    }
    const promise = inFlight.get(upstreamId);
    return promise === undefined ? undefined : promise;
  }

  /**
   * Run one planned binding's TE-1 → TE-3 → TE-2 → TE-4 pipeline into a result envelope.
   * `chain` is present only for a chained (dependent) binding — its `chainInputs` are
   * resolved against the upstream's consumer-shape response before the request is composed.
   */
  private async executeBinding(
    planned: PlannedBinding,
    chain: ChainSource | undefined,
    context: ServeContext,
    consumerOperation: IrOperation,
    request: AdapterRequest,
  ): Promise<BindingResult> {
    const loaded = context.bindings.find((entry) => entry.binding.id === planned.bindingId);
    if (loaded === undefined) {
      return this.transformFailure(planned, "binding context missing for a planned binding");
    }
    if (loaded.backendOperation === undefined || loaded.backendBaseUrl === undefined) {
      // A non-servable binding (unresolvable backend operation / base URL) is a
      // composition/config defect (CO-2 should have caught it), not a live failure.
      return this.transformFailure(
        planned,
        "backend operation or base URL is unresolvable for the binding",
      );
    }

    // TE-3 — fill chained parameters from the upstream's consumer-shape response. An absent
    // chain value (or a transform defect) refuses the call, named, rather than dispatching
    // with the parameter unfilled or guessed (TE-3.4).
    let chainedParams: ReadonlyMap<string, string> | undefined;
    if (chain !== undefined) {
      const resolved = resolveChainInputs(
        loaded.mappingId,
        chain.chainInputs,
        chain.upstreamConsumerShape,
      );
      if (!resolved.ok) {
        return this.transformFailure(planned, resolved.detail);
      }
      chainedParams = resolved.params;
    }

    // TE-1 — consumer request → backend request.
    const mapped = mapRequestToBackend({
      mappingId: loaded.mappingId,
      consumerOperation,
      backendOperation: loaded.backendOperation,
      parameterMappings: loaded.parameterMappings,
      requestPhaseFieldMappings: loaded.requestPhaseFieldMappings,
      request,
      ...(chainedParams !== undefined ? { chainedParams } : {}),
    });
    if (!mapped.ok) {
      return this.transformFailure(planned, mapped.detail);
    }

    // TE-2 — execute via the governed, credentialed ProtocolClient.
    const call = await this.deps.backendCaller.call({
      targetAppId: loaded.binding.backendAppId,
      baseUrl: loaded.backendBaseUrl,
      operation: loaded.backendOperation,
      mapped: mapped.request,
      ...(loaded.backendLimits !== undefined ? { limits: loaded.backendLimits } : {}),
    });
    if (!call.ok) {
      if (call.kind === "upstream-error") {
        return this.failureEnvelope(planned, {
          cause: "upstream-error",
          backendAppId: loaded.binding.backendAppId,
          detail: call.detail,
        });
      }
      return this.transformFailure(planned, call.detail);
    }

    // TE-4 — backend response → consumer shape.
    const shaped = mapBackendResponseToConsumer(loaded.responsePhaseFieldMappings, call.body);
    if (!shaped.ok) {
      return this.transformFailure(planned, shaped.detail);
    }

    return {
      kind: "success",
      bindingId: planned.bindingId,
      role: planned.role,
      executionOrder: planned.executionOrder,
      backendAppId: loaded.binding.backendAppId,
      payload: shaped.payload,
    };
  }

  /** A mediator-transform-error failure envelope, logged as a defect signal (AG-7.4). */
  private transformFailure(planned: PlannedBinding, detail: string): BindingResult {
    this.deps.logger.warn(
      { bindingId: planned.bindingId, cause: "mediator-transform-error", detail },
      "adapter serve: mediator-side transform/composition defect",
    );
    return this.failureEnvelope(planned, { cause: "mediator-transform-error", detail });
  }

  private failureEnvelope(planned: PlannedBinding, failure: BindingFailure): BindingResult {
    return {
      kind: "failure",
      bindingId: planned.bindingId,
      role: planned.role,
      executionOrder: planned.executionOrder,
      failure,
    };
  }

  /** A request-level mediator defect (no binding executed): logged and failed loud. */
  private defect(endpointId: string, detail: string): ServeOutcome {
    this.deps.logger.warn(
      { endpointId, cause: "mediator-transform-error", detail },
      "adapter serve: mediator-side defect before execution",
    );
    return { kind: "failed", cause: "mediator-transform-error" };
  }
}

/** The backend resource ref (leading segment) of a `resourceRef/operationId` operation ref. */
function backendResourceRefOf(operationRef: string): string {
  const slash = operationRef.indexOf("/");
  return slash <= 0 ? operationRef : operationRef.slice(0, slash);
}

/** The union of consumer parameter names any active binding maps (for RP-2.4). */
function collectMappedConsumerParams(context: ServeContext): ReadonlySet<string> {
  const names = new Set<string>();
  for (const loaded of context.bindings) {
    for (const name of mappedConsumerParamNames(loaded.parameterMappings)) {
      names.add(name);
    }
  }
  return names;
}

/**
 * The consumer **parameter** names the composer acknowledged as ignored on this endpoint
 * (CO-5.4) — a supplied one is served with the value dropped rather than rejected.
 * `body-field` acknowledgements are not consulted here: the request pipeline already
 * drops an unmapped consumer body field via the request-phase transform, so a body-field
 * acknowledgement is a composition-time record only, not an RP-2 parameter decision.
 */
function collectAcknowledgedIgnoredParams(endpoint: AdapterEndpoint): ReadonlySet<string> {
  const names = new Set<string>();
  for (const acknowledgement of endpoint.acknowledgedIgnoredInputs ?? []) {
    if (acknowledgement.kind === "parameter") {
      names.add(acknowledgement.consumerParamName);
    }
  }
  return names;
}

/**
 * The RP-2.2/2.3 union serving config, built from the endpoint's persisted `postMerge*`
 * state plus the active bindings' `ParameterMapping`s — or `undefined` for any non-union
 * endpoint (so its inbound validation is entirely unaffected, RP-2 criterion). A filter is
 * pushdown-eligible only when mapped in **every** contributing binding; pagination is only
 * honored when its convention is **confirmed** (an unconfirmed convention counts as
 * unconfigured — derive-then-confirm, so requests using it still reject).
 */
function buildUnionServeConfig(
  endpoint: AdapterEndpoint,
  context: ServeContext,
): UnionServeConfig | undefined {
  if (endpoint.aggregationStrategy !== "collection-union") {
    return undefined;
  }

  // Pushdown-eligible = the consumer params (a ParameterMapping's source) mapped in EVERY
  // active binding. Reuses the SHARED `pushdownEligibleParamNames` (unit-tested in
  // `union.spec.ts`) over the same bare-name basis the composition side uses, so RP-2 and
  // CO-3 can never drift on what "pushed down" means (the CO-3↔RP-2 contract).
  const pushdownEligible = pushdownEligibleParamNames(
    context.bindings.map((loaded) => ({
      pushdownConsumerParamNames: new Set(
        loaded.parameterMappings.map((param) => paramRefBareName(param.sourceParamRef)),
      ),
    })),
  );

  const postMergeFilterParamNames = new Set(
    (endpoint.postMergeFilters ?? []).map((filter) => paramRefBareName(filter.consumerParamRef)),
  );

  // A pagination convention is honored only once confirmed (both stamps set).
  const pagination = endpoint.postMergePagination;
  const paginationConfirmed =
    pagination !== undefined && pagination.confirmedBy !== null && pagination.confirmedAt !== null;
  const paginationParamNames = new Set(
    paginationConfirmed
      ? paginationConventionParamRefs(pagination.convention).map(paramRefBareName)
      : [],
  );

  const sortConfigByParam = new Map<string, { fixed: boolean; values: Set<string> }>();
  for (const sort of endpoint.postMergeSorts ?? []) {
    const name = paramRefBareName(sort.consumerParamRef);
    const entry = sortConfigByParam.get(name) ?? { fixed: false, values: new Set<string>() };
    if (sort.paramValue === undefined) {
      entry.fixed = true;
    } else {
      entry.values.add(sort.paramValue);
    }
    sortConfigByParam.set(name, entry);
  }

  return {
    pushdownEligibleParamNames: pushdownEligible,
    postMergeFilterParamNames,
    paginationParamNames,
    sortConfigByParam,
  };
}
