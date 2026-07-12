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

  // consumer-provider
  const { endpointPlans, graphEdge } = deriveConsumerProviderArtifacts({
    mapping,
    operations,
    newId,
  });
  const adapterEndpoints: AdapterEndpoint[] = [];
  const adapterBindings: AdapterBinding[] = [];
  for (const plan of endpointPlans) {
    // Ensure-exists: create on first coverage, reuse (never duplicate) after.
    const endpoint = await ops.ensureAdapterEndpoint(plan.candidate);
    adapterEndpoints.push(endpoint);
    for (const backend of plan.backends) {
      const binding = adapterBindingSchema.parse({
        id: newId(),
        adapterEndpointId: endpoint.id,
        backendAppId: backend.backendAppId,
        backendOperationId: backend.backendOperationId,
        approvedMappingId: mapping.id,
        // A freshly-attached binding is `proposed` (not composed/served — Phase 5),
        // with the default single-binding role.
        role: "primary",
        status: "proposed",
      });
      adapterBindings.push(binding);
      await ops.insertAdapterBindingIfAbsent(binding);
    }
  }
  await ops.upsertGraphEdge(graphEdge);
  return { variant: "consumer-provider", adapterEndpoints, adapterBindings, graphEdge };
}
