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
} as const;
