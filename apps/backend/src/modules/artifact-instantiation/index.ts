/**
 * `MappingApproved` artifact instantiation (Phase-3 AI-1..AI-3 + Phase-5 CO-1): the
 * consumer that instantiates an approval's downstream artifacts — disabled
 * `SyncRule`s for a peer-peer mapping, or an `AdapterEndpoint` + `AdapterBinding`(s)
 * for a consumer-provider mapping — plus the projected `GraphEdge` and the reconciler
 * that re-derives a lost reaction. Per CO-1 the first binding of a consumer operation
 * auto-activates (`active` endpoint + `primary`/`active` binding, single/degraded/no
 * cache); a further binding attaches `proposed` and moves the endpoint to
 * `composition-required` for a human composition decision. See
 * `docs/requirements/phase-3-artifact-instantiation.md` and
 * `docs/requirements/phase-5-endpoint-composition.md`.
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
