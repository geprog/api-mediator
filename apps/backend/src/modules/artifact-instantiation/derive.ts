import {
  graphEdgeSchema,
  syncRuleSchema,
  type AdapterEndpoint,
  type ApprovedMapping,
  type FieldMapping,
  type GraphEdge,
  type GraphEdgeMetadata,
  type OperationMapping,
  type SyncRule,
} from "@mediator/domain";

/**
 * The **pure** derivation of an approval's disabled downstream artifacts from its
 * persisted `ApprovedMapping` + children (AI-1/AI-2). No I/O, no persistence — the
 * {@link instantiateArtifacts} orchestration feeds the results to the idempotent
 * repository writes. Kept separate so the resource-pair enumeration, the canonical
 * `resourcePairRef`, and the endpoint/binding shaping are unit-testable without a
 * database or a fake.
 */

/**
 * The initial `GraphEdge.status` a Phase-3 edge projects. `GraphEdge.status` is a
 * free-form projection of the underlying rule/binding state (the concept does not
 * enumerate it), so a sync edge — whose rules are all `disabled` — projects
 * `disabled`, and an adapter edge — whose bindings are all `proposed` — projects
 * `proposed`. Both read as "nothing is executing yet". The edge upsert is
 * ensure-exists, so this value is only ever written when the edge is first created.
 */
export const SYNC_GRAPH_EDGE_STATUS = "disabled";
export const ADAPTER_GRAPH_EDGE_STATUS = "proposed";

/**
 * The `AdapterEndpoint.status` a Phase-3 endpoint is created with. There is no
 * Adapter Server Runtime until Phase 5, so an instantiated endpoint is NOT served:
 * `composition-required` is the enum value reflecting "binding(s) attached, an
 * aggregation/serving decision is still owed" (AI-2 criterion 4; the flow's
 * single-binding "activate immediately" is overridden by the requirement's
 * plan-vs-concept reconciliation note).
 */
export const INSTANTIATED_ADAPTER_ENDPOINT_STATUS = "composition-required";

/** One side of a mapped resource pair: a version-agnostic `(app, resource)` identity. */
export interface ResourcePairSide {
  readonly appId: string;
  readonly resourceRef: string;
}

/**
 * The **canonical, direction-agnostic** `resourcePairRef` for a mapped resource
 * pair: the two `(app, resource)` sides serialized and ordered by a stable
 * lexicographic key, never by a rule's direction — so both directions of a
 * bidirectional pair (A→B and its B→A counterpart) name the SAME ref and therefore
 * the same `RecordLink`s / `SyncFieldState` in Phase 4 (`docs/architecture/data-model.md`
 * `SyncRule`/`RecordLink`).
 *
 * The side identity is `(appId, resourceRef)`: `appId` is the version-agnostic
 * spec-lineage identity for a peer-peer sync side (both sides are `PROVIDER`), so
 * the ref survives spec re-pinning (Phase 6). NOTE: this is the single definition
 * of the canonical form; Phase 4's `RecordLink` instantiation must reuse it.
 */
export function canonicalResourcePairRef(a: ResourcePairSide, b: ResourcePairSide): string {
  const tokenA = `${a.appId}:${a.resourceRef}`;
  const tokenB = `${b.appId}:${b.resourceRef}`;
  return tokenA <= tokenB ? `${tokenA}|${tokenB}` : `${tokenB}|${tokenA}`;
}

/** The resource-group ref portion of a serialized IR path/operation ref (leading segment). */
function resourceRefOf(serializedRef: string): string {
  const slash = serializedRef.indexOf("/");
  return slash === -1 ? serializedRef : serializedRef.slice(0, slash);
}

/** The peer-peer artifacts: one disabled `SyncRule` per mapped resource pair + the sync edge. */
export interface PeerPeerArtifacts {
  readonly syncRules: readonly SyncRule[];
  readonly graphEdge: GraphEdge;
}

/**
 * Derive the peer-peer artifacts (AI-1). Enumerates the distinct **directional**
 * resource pairs the mapping covers — from every `FieldMapping` (`sourcePath →
 * targetPath`) and `OperationMapping` (`sourceOperationRef → targetOperationRef`)
 * — maps each to its canonical `resourcePairRef`, and emits ONE disabled
 * `SyncRule` per distinct ref (a mapping covering N resource pairs → N rules). No
 * live execution state is seeded (AI-1 criterion 2). The `sync` `GraphEdge` runs
 * `sourceAppId → targetAppId`, aggregating this direction's rules.
 */
export function derivePeerPeerArtifacts(input: {
  readonly mapping: ApprovedMapping;
  readonly fields: readonly FieldMapping[];
  readonly operations: readonly OperationMapping[];
  readonly newId: () => string;
}): PeerPeerArtifacts {
  const { mapping, fields, operations, newId } = input;

  // Distinct directional (source resource, target resource) pairs the mapping covers.
  const directionalPairs = new Map<string, { readonly src: string; readonly tgt: string }>();
  const addPair = (sourceRef: string, targetRef: string): void => {
    const src = resourceRefOf(sourceRef);
    const tgt = resourceRefOf(targetRef);
    // NUL is a collision-free in-memory Map key separator (never persisted — the
    // stored resourcePairRef below uses a printable form; Postgres text rejects NUL).
    directionalPairs.set(`${src}\u0000${tgt}`, { src, tgt });
  };
  for (const field of fields) {
    addPair(field.sourcePath, field.targetPath);
  }
  for (const operation of operations) {
    addPair(operation.sourceOperationRef, operation.targetOperationRef);
  }

  // One disabled SyncRule per distinct canonical resourcePairRef (dedup keeps the
  // count at N mapped resource pairs even if two directional pairs canonicalize equal).
  const rulesByRef = new Map<string, SyncRule>();
  for (const { src, tgt } of directionalPairs.values()) {
    const resourcePairRef = canonicalResourcePairRef(
      { appId: mapping.sourceAppId, resourceRef: src },
      { appId: mapping.targetAppId, resourceRef: tgt },
    );
    if (rulesByRef.has(resourcePairRef)) {
      continue;
    }
    rulesByRef.set(
      resourcePairRef,
      syncRuleSchema.parse({
        id: newId(),
        approvedMappingId: mapping.id,
        resourcePairRef,
        status: "disabled",
      }),
    );
  }

  return {
    syncRules: [...rulesByRef.values()],
    graphEdge: buildGraphEdge(mapping, "sync", SYNC_GRAPH_EDGE_STATUS, newId),
  };
}

/** A consumer operation's endpoint plan: the candidate endpoint + the backends to bind. */
export interface AdapterEndpointPlan {
  readonly candidate: AdapterEndpoint;
  readonly backends: readonly {
    readonly backendAppId: string;
    readonly backendOperationId: string;
  }[];
}

/** The consumer-provider artifacts: one endpoint plan per covered consumer operation + the adapter edge. */
export interface ConsumerProviderArtifacts {
  readonly endpointPlans: readonly AdapterEndpointPlan[];
  readonly graphEdge: GraphEdge;
}

/**
 * Derive the consumer-provider artifacts (AI-2). Groups the mapping's
 * `OperationMapping`s by their **consumer** operation (`sourceOperationRef`) — one
 * `AdapterEndpoint` per covered consumer operation — and, under each, one
 * `proposed` binding per distinct **backend** operation (`targetOperationRef`,
 * chosen from the approved operation mappings, not free-form). Consumer =
 * `sourceAppId`, backend = `targetAppId` (`docs/architecture/data-model.md`
 * `ApprovedMapping`). The `adapter-dependency` `GraphEdge` runs
 * `consumerAppId → backendAppId`. The candidate endpoint id is only USED if the
 * ensure-exists creates the row; a reused endpoint keeps its own id.
 */
export function deriveConsumerProviderArtifacts(input: {
  readonly mapping: ApprovedMapping;
  readonly operations: readonly OperationMapping[];
  readonly newId: () => string;
}): ConsumerProviderArtifacts {
  const { mapping, operations, newId } = input;

  const backendsByConsumerOp = new Map<
    string,
    { backendAppId: string; backendOperationId: string }[]
  >();
  for (const operation of operations) {
    const consumerOperationId = operation.sourceOperationRef;
    const backendOperationId = operation.targetOperationRef;
    const backends = backendsByConsumerOp.get(consumerOperationId) ?? [];
    if (!backends.some((backend) => backend.backendOperationId === backendOperationId)) {
      backends.push({ backendAppId: mapping.targetAppId, backendOperationId });
    }
    backendsByConsumerOp.set(consumerOperationId, backends);
  }

  const endpointPlans: AdapterEndpointPlan[] = [];
  for (const [consumerOperationId, backends] of backendsByConsumerOp) {
    endpointPlans.push({
      candidate: {
        id: newId(),
        consumerAppId: mapping.sourceAppId,
        consumerOperationId,
        status: INSTANTIATED_ADAPTER_ENDPOINT_STATUS,
      },
      backends,
    });
  }

  return {
    endpointPlans,
    graphEdge: buildGraphEdge(mapping, "adapter-dependency", ADAPTER_GRAPH_EDGE_STATUS, newId),
  };
}

/** Build the (ensure-exists) `GraphEdge` projection for the mapping's direction. */
function buildGraphEdge(
  mapping: ApprovedMapping,
  type: GraphEdge["type"],
  status: string,
  newId: () => string,
): GraphEdge {
  const metadata: GraphEdgeMetadata = {
    direction: { sourceSpecId: mapping.sourceSpecId, targetSpecId: mapping.targetSpecId },
    // Nothing has executed at instantiation time — no activity yet.
    lastActivityAt: null,
  };
  return graphEdgeSchema.parse({
    id: newId(),
    sourceNodeId: mapping.sourceAppId,
    targetNodeId: mapping.targetAppId,
    type,
    status,
    metadata,
  });
}
