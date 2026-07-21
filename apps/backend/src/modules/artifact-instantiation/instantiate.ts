import type { DownstreamArtifactOps } from "@mediator/db";
import {
  adapterBindingSchema,
  type AdapterBinding,
  type AdapterEndpoint,
  type ApprovedMapping,
  type FieldMapping,
  type GraphEdge,
  type OperationMapping,
  type SyncRule,
} from "@mediator/domain";

import { deriveConsumerProviderArtifacts, derivePeerPeerArtifacts } from "./derive.js";

/**
 * The pure-database instantiation core of the `MappingApproved` reaction
 * (AI-1..AI-3). Given a loaded `ApprovedMapping` + its children and a
 * transaction-bound {@link DownstreamArtifactOps}, it derives the disabled
 * downstream artifacts and persists them with idempotent, natural-key writes.
 *
 * **Mutual exclusivity** is a construction-time invariant of the switch on
 * `mapping.variant`: a peer-peer mapping instantiates `SyncRule`(s) + a `sync`
 * `GraphEdge` and NEVER an `AdapterBinding`; a consumer-provider mapping
 * instantiates `AdapterEndpoint`/`AdapterBinding`(s) + an `adapter-dependency`
 * `GraphEdge` and NEVER a `SyncRule` (`docs/architecture/data-model.md` *Modeling
 * notes*; AI-2 criterion 5).
 *
 * **Nothing executes** (AI-1 criterion 5): the only side effects are the injected
 * DB ops — there is no HTTP client, poller, or scheduler in scope here, so
 * instantiation makes no outbound call to any registered app and starts no polling.
 */

/** The result of instantiating a peer-peer mapping — the derived disabled artifacts. */
export interface PeerPeerInstantiation {
  readonly variant: "peer-peer";
  readonly syncRules: readonly SyncRule[];
  readonly graphEdge: GraphEdge;
}

/** The result of instantiating a consumer-provider mapping — the ensured/attached artifacts. */
export interface ConsumerProviderInstantiation {
  readonly variant: "consumer-provider";
  /** The ensured endpoints (a reused endpoint keeps its own id, not the candidate's). */
  readonly adapterEndpoints: readonly AdapterEndpoint[];
  readonly adapterBindings: readonly AdapterBinding[];
  readonly graphEdge: GraphEdge;
}

export type InstantiationResult = PeerPeerInstantiation | ConsumerProviderInstantiation;

export interface InstantiateArtifactsInput {
  readonly mapping: ApprovedMapping;
  readonly fields: readonly FieldMapping[];
  readonly operations: readonly OperationMapping[];
  readonly ops: DownstreamArtifactOps;
  readonly newId: () => string;
}

export async function instantiateArtifacts(
  input: InstantiateArtifactsInput,
): Promise<InstantiationResult> {
  const { mapping, fields, operations, ops, newId } = input;

  if (mapping.variant === "peer-peer") {
    const { syncRules, graphEdge } = derivePeerPeerArtifacts({
      mapping,
      fields,
      operations,
      newId,
    });
    // One disabled SyncRule per mapped resource pair — idempotent by natural key.
    for (const rule of syncRules) {
      await ops.insertSyncRuleIfAbsent(rule);
    }
    await ops.upsertGraphEdge(graphEdge);
    return { variant: "peer-peer", syncRules, graphEdge };
  }

  // consumer-provider (CO-1: derive endpoints + auto-activate the first binding).
  const { endpointPlans, graphEdge } = deriveConsumerProviderArtifacts({
    mapping,
    operations,
    newId,
  });
  const adapterEndpoints: AdapterEndpoint[] = [];
  const adapterBindings: AdapterBinding[] = [];
  for (const plan of endpointPlans) {
    // CO-1.1: find-or-create the one endpoint per (consumerAppId, consumerOperationId).
    // Ensure-exists creates it `composition-required` — the neutral "attached, nothing
    // composed" state — then the first binding below promotes it to `active`.
    let endpoint = await ops.ensureAdapterEndpoint(plan.candidate);
    // "Already has a binding" (CO-1.3) = ANY existing binding row of this endpoint, in
    // any status (`active`/`proposed`/`disabled`). Read once; track locally as this run
    // attaches its own backends so a second backend in the SAME mapping is treated as a
    // further binding, not another first one.
    const existingBindings = await ops.listAdapterBindingsByEndpoint(endpoint.id);
    let endpointHasBinding = existingBindings.length > 0;
    for (const backend of plan.backends) {
      const alreadyAttached = existingBindings.some(
        (binding) =>
          binding.backendAppId === backend.backendAppId &&
          binding.backendOperationId === backend.backendOperationId &&
          binding.approvedMappingId === mapping.id,
      );
      if (alreadyAttached) {
        // Idempotent re-run for THIS binding: its row already exists (CO-1.6). Never
        // re-attach, re-activate, or downgrade it, and never re-run the endpoint
        // transition — leave any operator state (e.g. a `disabled` binding, or an
        // endpoint an operator later composed) exactly as it is.
        continue;
      }
      // CO-1.2: the endpoint's FIRST binding auto-activates `primary`+`active`.
      // CO-1.3: any FURTHER binding attaches `proposed`; the endpoint moves to
      // `composition-required` while its prior active configuration keeps serving.
      const isFirstBinding = !endpointHasBinding;
      const binding = adapterBindingSchema.parse({
        id: newId(),
        adapterEndpointId: endpoint.id,
        backendAppId: backend.backendAppId,
        // CO-1.4: `backendOperationId` is the approved OperationMapping's target side
        // (chosen in `deriveConsumerProviderArtifacts`), never free-form.
        backendOperationId: backend.backendOperationId,
        approvedMappingId: mapping.id,
        role: "primary",
        status: isFirstBinding ? "active" : "proposed",
      });
      adapterBindings.push(binding);
      await ops.insertAdapterBindingIfAbsent(binding);
      endpoint = isFirstBinding
        ? await ops.activateAdapterEndpointForSingleBinding(endpoint.id)
        : await ops.markAdapterEndpointCompositionRequired(endpoint.id);
      endpointHasBinding = true;
    }
    adapterEndpoints.push(endpoint);
  }
  // CO-1.5: upsert the adapter-dependency GraphEdge for the new/changed bindings.
  await ops.upsertGraphEdge(graphEdge);
  return { variant: "consumer-provider", adapterEndpoints, adapterBindings, graphEdge };
}
