import type {
  AdapterRequest,
  ServeHandler,
  ServeInput,
  ServeOutcome,
} from "@mediator/adapter-engine";
import type { AdapterEndpoint, IrOperation } from "@mediator/domain";

import { aggregateSingle } from "./aggregator.js";
import type { BackendCaller } from "./backend-call.js";
import { validateConsumerResponse, validateInboundRequest } from "./ir-validation.js";
import { planResolution, type BindingHealthInput } from "./planner.js";
import {
  bindingFailureCause,
  type BindingFailure,
  type BindingResult,
  type PlannedBinding,
} from "./pipeline-types.js";
import { mapRequestToBackend, mappedConsumerParamNames } from "./request-mapping.js";
import { mapBackendResponseToConsumer } from "./response-mapping.js";
import type { ServeContext, ServeContextLoader } from "./serve-context.js";

/**
 * **The real `ServeHandler` (RP/TE/AG) injected behind the RT Protocol-Server seam.**
 * It runs the single-binding serve pipeline the RT slice left as a 501 placeholder:
 *
 *   load context → RP-2 validate inbound → RP-3/RP-4 plan → TE-1 map request →
 *   TE-2 call backend → TE-4 map response → TE-5 envelope → AG-1 aggregate →
 *   AG-7 validate response → {@link ServeOutcome}.
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
}

export class AdapterServeHandler implements ServeHandler {
  public constructor(private readonly deps: AdapterServeHandlerDeps) {}

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

    // TE-1..TE-5 — assemble one envelope per binding: eliminated bindings become
    // `not-called` (their planner cause), executed bindings run the transform pipeline.
    const results: BindingResult[] = plan.eliminated.map((eliminated) => ({
      kind: "not-called",
      bindingId: eliminated.bindingId,
      role: eliminated.role,
      executionOrder: eliminated.executionOrder,
      cause: eliminated.cause,
    }));
    for (const group of plan.groups) {
      for (const planned of group.bindings) {
        results.push(await this.executeBinding(planned, context, consumerOperation, input.request));
      }
    }

    // AG-1 — single aggregation.
    const aggregate = aggregateSingle(plan, results);
    if (aggregate.kind === "failure") {
      return { kind: "failed", cause: bindingFailureCause(aggregate.failure) };
    }

    // AG-7 — validate the aggregated response against the consumer's response schema;
    // a failure is a mediator-side defect, logged and never returned as data.
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
    };
  }

  /** Run one planned binding's TE-1 → TE-2 → TE-4 pipeline into a result envelope. */
  private async executeBinding(
    planned: PlannedBinding,
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

    // TE-1 — consumer request → backend request.
    const mapped = mapRequestToBackend({
      mappingId: loaded.mappingId,
      consumerOperation,
      backendOperation: loaded.backendOperation,
      parameterMappings: loaded.parameterMappings,
      requestPhaseFieldMappings: loaded.requestPhaseFieldMappings,
      request,
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
