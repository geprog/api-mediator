/**
 * Phase-3 disabled-artifact instantiation (AI-1..AI-3): the `MappingApproved`
 * consumer that instantiates an approval's downstream artifacts in a
 * **non-executing** state — disabled `SyncRule`s for a peer-peer mapping, a
 * `proposed` `AdapterBinding` under an ensured `AdapterEndpoint` for a
 * consumer-provider mapping — plus the projected `GraphEdge` and the reconciler
 * that re-derives a lost reaction. See `docs/requirements/phase-3-artifact-instantiation.md`.
 */
export { buildArtifactInstantiation } from "./background.js";
export type { ArtifactInstantiation, ArtifactInstantiationDeps } from "./background.js";
export {
  ARTIFACT_INSTANTIATION_CONSUMER_NAME,
  MappingApprovedInstantiationConsumer,
} from "./consumer.js";
export type {
  ApprovedMappingLoader,
  DownstreamArtifactOpsFactory,
  LoadedApprovedMapping,
  MappingApprovedInstantiationConsumerDeps,
} from "./consumer.js";
export { ArtifactInstantiationReconciler } from "./reconciler.js";
export type { ArtifactInstantiationReconcilerDeps } from "./reconciler.js";
export {
  instantiateArtifacts,
  type ConsumerProviderInstantiation,
  type InstantiateArtifactsInput,
  type InstantiationResult,
  type PeerPeerInstantiation,
} from "./instantiate.js";
export {
  ADAPTER_GRAPH_EDGE_STATUS,
  INSTANTIATED_ADAPTER_ENDPOINT_STATUS,
  SYNC_GRAPH_EDGE_STATUS,
  canonicalResourcePairRef,
  deriveConsumerProviderArtifacts,
  derivePeerPeerArtifacts,
  type AdapterEndpointPlan,
  type ConsumerProviderArtifacts,
  type PeerPeerArtifacts,
  type ResourcePairSide,
} from "./derive.js";
