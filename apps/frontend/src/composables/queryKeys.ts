/**
 * Centralized `@tanstack/vue-query` cache keys, so a mutation can invalidate the
 * exact queries it affects without stringly-typed drift. Per-entity keys are
 * functions of the entity id; the app-list key is a constant.
 */
export const queryKeys = {
  apps: ["apps"] as const,
  appSpecs: (appId: string): readonly string[] => ["apps", appId, "specs"],
  specIr: (specId: string): readonly string[] => ["specs", specId, "ir"],
  specBindings: (specId: string): readonly string[] => ["specs", specId, "resource-bindings"],
  /** Root of the mapping-proposal cache — invalidated wholesale on approve. */
  mappingProposals: ["mapping-proposals"] as const,
  mappingProposalList: (sourceSpecId: string, targetSpecId: string | null): readonly string[] => [
    "mapping-proposals",
    "list",
    sourceSpecId,
    targetSpecId ?? "",
  ],
  mappingProposal: (proposalId: string): readonly string[] => [
    "mapping-proposals",
    "detail",
    proposalId,
  ],
  /** Root of the sync-rules cache — invalidated wholesale after enable/disable/config. */
  syncRules: ["sync-rules"] as const,
  /** The sync audit log, keyed by its (serialized) filter. */
  syncEvents: (filterKey: string): readonly string[] => ["sync-events", filterKey],
  /** The ambiguous-match queue (SA-3.3). */
  ambiguousMatches: ["record-links", "ambiguous-matches"] as const,
  /** The open parked-conflict queue (SA-4.1). */
  parkedConflicts: ["parked-conflicts"] as const,
  /** The dead-letter (parked-write) queue (SA-5.1). */
  deadLetterWrites: ["dead-letter-writes"] as const,
  /** The parked container-link queue (SS-11.5 / SS-15.5). */
  parkedContainerLinks: ["scope-links", "parked"] as const,
  /** The per-pair scope identity key derivation (SS-15.4), keyed by resource pair. */
  scopeIdentityKey: (resourcePairRef: string): readonly string[] => [
    "scope-identity-key",
    resourcePairRef,
  ],
  /** Root of the adapter-endpoint state cache — invalidated wholesale after a mutation (AP-1..AP-3). */
  adapterEndpoints: ["adapter-endpoints"] as const,
  /** One adapter endpoint's read state (AP-1), keyed by id. */
  adapterEndpoint: (endpointId: string): readonly string[] => ["adapter-endpoints", endpointId],
  /** The adapter request history (AP-5.1), keyed by its (serialized) filter. */
  adapterRequests: (filterKey: string): readonly string[] => ["adapter-requests", filterKey],
  /** The adapter endpoint-health read (AP-5.3). */
  adapterHealth: ["adapter-requests", "health"] as const,
} as const;
