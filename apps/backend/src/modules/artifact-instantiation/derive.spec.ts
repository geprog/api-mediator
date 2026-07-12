import { describe, expect, it } from "vitest";

import {
  ADAPTER_GRAPH_EDGE_STATUS,
  INSTANTIATED_ADAPTER_ENDPOINT_STATUS,
  SYNC_GRAPH_EDGE_STATUS,
  canonicalResourcePairRef,
  deriveConsumerProviderArtifacts,
  derivePeerPeerArtifacts,
} from "./derive.js";
import {
  approvedMappingFixture,
  fieldMappingFixture,
  operationMappingFixture,
  sequentialIds,
} from "./fakes.testkit.js";

const APP_A = "app-a";
const APP_B = "app-b";

describe("canonicalResourcePairRef", () => {
  it("orders the two (app, resource) sides by a stable key, direction-agnostically", () => {
    const forward = canonicalResourcePairRef(
      { appId: APP_A, resourceRef: "issues" },
      { appId: APP_B, resourceRef: "tasks" },
    );
    const reverse = canonicalResourcePairRef(
      { appId: APP_B, resourceRef: "tasks" },
      { appId: APP_A, resourceRef: "issues" },
    );
    expect(forward).toBe(reverse);
    expect(forward).toBe("app-a:issues|app-b:tasks");
  });

  it("distinguishes different resources of the same app pair", () => {
    const pair1 = canonicalResourcePairRef(
      { appId: APP_A, resourceRef: "issues" },
      { appId: APP_B, resourceRef: "tasks" },
    );
    const pair2 = canonicalResourcePairRef(
      { appId: APP_A, resourceRef: "users" },
      { appId: APP_B, resourceRef: "members" },
    );
    expect(pair1).not.toBe(pair2);
  });
});

describe("derivePeerPeerArtifacts (AI-1)", () => {
  it("creates one disabled SyncRule per mapped resource pair with a canonical ref and no execution state", () => {
    const mapping = approvedMappingFixture({
      id: "m-1",
      variant: "peer-peer",
      sourceAppId: APP_A,
      targetAppId: APP_B,
    });
    const { syncRules } = derivePeerPeerArtifacts({
      mapping,
      fields: [
        fieldMappingFixture({
          id: "f-1",
          mappingId: "m-1",
          sourcePath: "issues/title",
          targetPath: "tasks/title",
        }),
        fieldMappingFixture({
          id: "f-2",
          mappingId: "m-1",
          sourcePath: "issues/body",
          targetPath: "tasks/description",
        }),
        fieldMappingFixture({
          id: "f-3",
          mappingId: "m-1",
          sourcePath: "users/email",
          targetPath: "members/email",
        }),
      ],
      operations: [],
      newId: sequentialIds("rule"),
    });

    // Two DISTINCT resource pairs (issues↔tasks, users↔members) → two rules, even
    // though issues↔tasks has two field correspondences.
    expect(syncRules).toHaveLength(2);
    expect(syncRules.map((rule) => rule.resourcePairRef).sort()).toStrictEqual([
      "app-a:issues|app-b:tasks",
      "app-a:users|app-b:members",
    ]);
    for (const rule of syncRules) {
      expect(rule.status).toBe("disabled");
      expect(rule.approvedMappingId).toBe("m-1");
      // AM-6 minimal shape: only these keys, no seeded cursor/snapshot/backfill.
      expect(Object.keys(rule).sort()).toStrictEqual([
        "approvedMappingId",
        "id",
        "resourcePairRef",
        "status",
      ]);
    }
  });

  it("also derives a resource pair from an operation-only correspondence", () => {
    const mapping = approvedMappingFixture({
      id: "m-1",
      variant: "peer-peer",
      sourceAppId: APP_A,
      targetAppId: APP_B,
    });
    const { syncRules } = derivePeerPeerArtifacts({
      mapping,
      fields: [],
      operations: [
        operationMappingFixture({
          id: "o-1",
          mappingId: "m-1",
          sourceOperationRef: "issues/listIssues",
          targetOperationRef: "tasks/listTasks",
        }),
      ],
      newId: sequentialIds("rule"),
    });
    expect(syncRules).toHaveLength(1);
    expect(syncRules[0]?.resourcePairRef).toBe("app-a:issues|app-b:tasks");
  });

  it("upserts a sync GraphEdge for the source→target direction reflecting not-yet-executing state", () => {
    const mapping = approvedMappingFixture({
      id: "m-1",
      variant: "peer-peer",
      sourceAppId: APP_A,
      targetAppId: APP_B,
      sourceSpecId: "spec-a",
      targetSpecId: "spec-b",
    });
    const { graphEdge } = derivePeerPeerArtifacts({
      mapping,
      fields: [
        fieldMappingFixture({
          id: "f-1",
          mappingId: "m-1",
          sourcePath: "issues/title",
          targetPath: "tasks/title",
        }),
      ],
      operations: [],
      newId: sequentialIds("id"),
    });
    expect(graphEdge.type).toBe("sync");
    expect(graphEdge.sourceNodeId).toBe(APP_A);
    expect(graphEdge.targetNodeId).toBe(APP_B);
    expect(graphEdge.status).toBe(SYNC_GRAPH_EDGE_STATUS);
    expect(graphEdge.metadata).toStrictEqual({
      direction: { sourceSpecId: "spec-a", targetSpecId: "spec-b" },
      lastActivityAt: null,
    });
  });

  it("a counterpart mapping (B→A) yields the SAME resourcePairRef — two one-way rules, one pair", () => {
    const forward = derivePeerPeerArtifacts({
      mapping: approvedMappingFixture({
        id: "m-fwd",
        variant: "peer-peer",
        sourceAppId: APP_A,
        targetAppId: APP_B,
      }),
      fields: [
        fieldMappingFixture({
          id: "f-1",
          mappingId: "m-fwd",
          sourcePath: "issues/title",
          targetPath: "tasks/title",
        }),
      ],
      operations: [],
      newId: sequentialIds("fwd"),
    });
    const reverse = derivePeerPeerArtifacts({
      mapping: approvedMappingFixture({
        id: "m-rev",
        variant: "peer-peer",
        sourceAppId: APP_B,
        targetAppId: APP_A,
      }),
      fields: [
        fieldMappingFixture({
          id: "f-2",
          mappingId: "m-rev",
          sourcePath: "tasks/title",
          targetPath: "issues/title",
        }),
      ],
      operations: [],
      newId: sequentialIds("rev"),
    });

    // Separate rules (different ids + mapping ids), same canonical pair ref.
    expect(forward.syncRules[0]?.approvedMappingId).toBe("m-fwd");
    expect(reverse.syncRules[0]?.approvedMappingId).toBe("m-rev");
    expect(forward.syncRules[0]?.id).not.toBe(reverse.syncRules[0]?.id);
    expect(forward.syncRules[0]?.resourcePairRef).toBe(reverse.syncRules[0]?.resourcePairRef);
  });
});

describe("deriveConsumerProviderArtifacts (AI-2)", () => {
  it("plans one endpoint per covered consumer operation with proposed-binding backends", () => {
    const mapping = approvedMappingFixture({
      id: "m-1",
      variant: "consumer-provider",
      sourceAppId: APP_A, // consumer
      targetAppId: APP_B, // backend
    });
    const { endpointPlans } = deriveConsumerProviderArtifacts({
      mapping,
      operations: [
        operationMappingFixture({
          id: "o-1",
          mappingId: "m-1",
          sourceOperationRef: "search/searchIssues",
          targetOperationRef: "issues/listIssues",
        }),
        operationMappingFixture({
          id: "o-2",
          mappingId: "m-1",
          sourceOperationRef: "detail/getIssue",
          targetOperationRef: "issues/getIssue",
        }),
      ],
      newId: sequentialIds("id"),
    });

    expect(endpointPlans).toHaveLength(2);
    const byConsumerOp = new Map(
      endpointPlans.map((plan) => [plan.candidate.consumerOperationId, plan]),
    );
    const search = byConsumerOp.get("search/searchIssues");
    expect(search?.candidate.consumerAppId).toBe(APP_A);
    expect(search?.candidate.status).toBe(INSTANTIATED_ADAPTER_ENDPOINT_STATUS);
    expect(search?.backends).toStrictEqual([
      { backendAppId: APP_B, backendOperationId: "issues/listIssues" },
    ]);
  });

  it("groups multiple backends under one consumer operation and dedups identical backend ops", () => {
    const mapping = approvedMappingFixture({
      id: "m-1",
      variant: "consumer-provider",
      sourceAppId: APP_A,
      targetAppId: APP_B,
    });
    const { endpointPlans } = deriveConsumerProviderArtifacts({
      mapping,
      operations: [
        operationMappingFixture({
          id: "o-1",
          mappingId: "m-1",
          sourceOperationRef: "search/searchIssues",
          targetOperationRef: "issues/listIssues",
        }),
        operationMappingFixture({
          id: "o-2",
          mappingId: "m-1",
          sourceOperationRef: "search/searchIssues",
          targetOperationRef: "tickets/listTickets",
        }),
        // Duplicate consumer+backend op pairing → deduped to one backend.
        operationMappingFixture({
          id: "o-3",
          mappingId: "m-1",
          sourceOperationRef: "search/searchIssues",
          targetOperationRef: "issues/listIssues",
        }),
      ],
      newId: sequentialIds("id"),
    });

    expect(endpointPlans).toHaveLength(1);
    expect(endpointPlans[0]?.backends).toStrictEqual([
      { backendAppId: APP_B, backendOperationId: "issues/listIssues" },
      { backendAppId: APP_B, backendOperationId: "tickets/listTickets" },
    ]);
  });

  it("upserts an adapter-dependency GraphEdge for consumer→backend", () => {
    const mapping = approvedMappingFixture({
      id: "m-1",
      variant: "consumer-provider",
      sourceAppId: APP_A,
      targetAppId: APP_B,
      sourceSpecId: "consumer-spec",
      targetSpecId: "backend-spec",
    });
    const { graphEdge } = deriveConsumerProviderArtifacts({
      mapping,
      operations: [
        operationMappingFixture({
          id: "o-1",
          mappingId: "m-1",
          sourceOperationRef: "search/searchIssues",
          targetOperationRef: "issues/listIssues",
        }),
      ],
      newId: sequentialIds("id"),
    });
    expect(graphEdge.type).toBe("adapter-dependency");
    expect(graphEdge.sourceNodeId).toBe(APP_A);
    expect(graphEdge.targetNodeId).toBe(APP_B);
    expect(graphEdge.status).toBe(ADAPTER_GRAPH_EDGE_STATUS);
    expect(graphEdge.metadata.direction).toStrictEqual({
      sourceSpecId: "consumer-spec",
      targetSpecId: "backend-spec",
    });
  });
});
