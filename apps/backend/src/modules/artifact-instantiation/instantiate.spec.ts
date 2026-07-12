import { describe, expect, it } from "vitest";

import {
  FakeDownstreamArtifactOps,
  approvedMappingFixture,
  fieldMappingFixture,
  operationMappingFixture,
  sequentialIds,
} from "./fakes.testkit.js";
import { instantiateArtifacts } from "./instantiate.js";

const APP_A = "app-a";
const APP_B = "app-b";

describe("instantiateArtifacts — peer-peer (AI-1)", () => {
  it("creates N disabled SyncRules + a sync GraphEdge and NO adapter artifacts (mutual exclusivity)", async () => {
    const ops = new FakeDownstreamArtifactOps();
    const mapping = approvedMappingFixture({
      id: "m-1",
      variant: "peer-peer",
      sourceAppId: APP_A,
      targetAppId: APP_B,
    });

    const result = await instantiateArtifacts({
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
          sourcePath: "users/email",
          targetPath: "members/email",
        }),
      ],
      operations: [],
      ops,
      newId: sequentialIds("id"),
    });

    expect(result.variant).toBe("peer-peer");
    expect(ops.syncRules).toHaveLength(2);
    expect(ops.edges).toHaveLength(1);
    expect(ops.edges[0]?.type).toBe("sync");
    // Mutual exclusivity + nothing-adapter-shaped touched.
    expect(ops.endpoints).toHaveLength(0);
    expect(ops.bindings).toHaveLength(0);
    expect(ops.calls.ensureAdapterEndpoint).toBe(0);
    expect(ops.calls.insertAdapterBindingIfAbsent).toBe(0);
  });

  it("is idempotent under redelivery: re-running produces the SAME committed rows (existing untouched)", async () => {
    const ops = new FakeDownstreamArtifactOps();
    const mapping = approvedMappingFixture({
      id: "m-1",
      variant: "peer-peer",
      sourceAppId: APP_A,
      targetAppId: APP_B,
    });
    const fields = [
      fieldMappingFixture({
        id: "f-1",
        mappingId: "m-1",
        sourcePath: "issues/title",
        targetPath: "tasks/title",
      }),
    ];

    // First delivery.
    await instantiateArtifacts({ mapping, fields, operations: [], ops, newId: sequentialIds("a") });
    const ruleIdAfterFirst = ops.syncRules[0]?.id;
    const edgeIdAfterFirst = ops.edges[0]?.id;

    // Redelivery re-derives with FRESH ids (a new consumer pass), but the natural-key
    // conflict keeps the original rows — no duplicate, no reset.
    await instantiateArtifacts({ mapping, fields, operations: [], ops, newId: sequentialIds("b") });

    expect(ops.syncRules).toHaveLength(1);
    expect(ops.edges).toHaveLength(1);
    expect(ops.syncRules[0]?.id).toBe(ruleIdAfterFirst);
    expect(ops.edges[0]?.id).toBe(edgeIdAfterFirst);
  });

  it("upserts on an incremental approval: adds a rule for a newly-covered pair, leaves the existing one untouched", async () => {
    const ops = new FakeDownstreamArtifactOps();
    const mapping = approvedMappingFixture({
      id: "m-1",
      variant: "peer-peer",
      sourceAppId: APP_A,
      targetAppId: APP_B,
    });

    // First approval covers only issues↔tasks.
    await instantiateArtifacts({
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
      ops,
      newId: sequentialIds("a"),
    });
    const originalRule = ops.syncRules[0];
    expect(originalRule?.resourcePairRef).toBe("app-a:issues|app-b:tasks");

    // Incremental approval now also covers users↔members.
    await instantiateArtifacts({
      mapping,
      fields: [
        fieldMappingFixture({
          id: "f-1b",
          mappingId: "m-1",
          sourcePath: "issues/title",
          targetPath: "tasks/title",
        }),
        fieldMappingFixture({
          id: "f-2",
          mappingId: "m-1",
          sourcePath: "users/email",
          targetPath: "members/email",
        }),
      ],
      operations: [],
      ops,
      newId: sequentialIds("b"),
    });

    expect(ops.syncRules).toHaveLength(2);
    const bytRef = new Map(ops.syncRules.map((rule) => [rule.resourcePairRef, rule]));
    // The pre-existing rule kept its original id (untouched, not re-created).
    expect(bytRef.get("app-a:issues|app-b:tasks")?.id).toBe(originalRule?.id);
    expect(bytRef.has("app-a:users|app-b:members")).toBe(true);
  });
});

describe("instantiateArtifacts — consumer-provider (AI-2)", () => {
  it("ensures endpoints + attaches proposed bindings + an adapter edge, and NO SyncRule", async () => {
    const ops = new FakeDownstreamArtifactOps();
    const mapping = approvedMappingFixture({
      id: "m-1",
      variant: "consumer-provider",
      sourceAppId: APP_A,
      targetAppId: APP_B,
    });

    const result = await instantiateArtifacts({
      mapping,
      fields: [],
      operations: [
        operationMappingFixture({
          id: "o-1",
          mappingId: "m-1",
          sourceOperationRef: "search/searchIssues",
          targetOperationRef: "issues/listIssues",
        }),
      ],
      ops,
      newId: sequentialIds("id"),
    });

    expect(result.variant).toBe("consumer-provider");
    expect(ops.endpoints).toHaveLength(1);
    expect(ops.bindings).toHaveLength(1);
    const binding = ops.bindings[0];
    expect(binding?.status).toBe("proposed");
    expect(binding?.role).toBe("primary");
    expect(binding?.backendAppId).toBe(APP_B);
    expect(binding?.backendOperationId).toBe("issues/listIssues");
    expect(binding?.approvedMappingId).toBe("m-1");
    expect(binding?.adapterEndpointId).toBe(ops.endpoints[0]?.id);
    expect(ops.edges[0]?.type).toBe("adapter-dependency");
    // Mutual exclusivity: no sync-rule write at all.
    expect(ops.syncRules).toHaveLength(0);
    expect(ops.calls.insertSyncRuleIfAbsent).toBe(0);
  });

  it("reuses an existing AdapterEndpoint (never duplicates) and attaches the binding to it", async () => {
    const ops = new FakeDownstreamArtifactOps();
    // A prior mapping already created the endpoint for this consumer operation.
    ops.seedEndpoint({
      id: "existing-endpoint",
      consumerAppId: APP_A,
      consumerOperationId: "search/searchIssues",
      status: "composition-required",
    });

    const mapping = approvedMappingFixture({
      id: "m-2",
      variant: "consumer-provider",
      sourceAppId: APP_A,
      targetAppId: APP_B,
    });
    await instantiateArtifacts({
      mapping,
      fields: [],
      operations: [
        operationMappingFixture({
          id: "o-1",
          mappingId: "m-2",
          sourceOperationRef: "search/searchIssues",
          targetOperationRef: "tickets/listTickets",
        }),
      ],
      ops,
      newId: sequentialIds("new"),
    });

    // No duplicate endpoint; the new binding hangs off the reused endpoint id.
    expect(ops.endpoints).toHaveLength(1);
    expect(ops.endpoints[0]?.id).toBe("existing-endpoint");
    expect(ops.bindings).toHaveLength(1);
    expect(ops.bindings[0]?.adapterEndpointId).toBe("existing-endpoint");
  });

  it("is idempotent under redelivery: same endpoint + binding, no duplicates", async () => {
    const ops = new FakeDownstreamArtifactOps();
    const mapping = approvedMappingFixture({
      id: "m-1",
      variant: "consumer-provider",
      sourceAppId: APP_A,
      targetAppId: APP_B,
    });
    const operations = [
      operationMappingFixture({
        id: "o-1",
        mappingId: "m-1",
        sourceOperationRef: "search/searchIssues",
        targetOperationRef: "issues/listIssues",
      }),
    ];

    await instantiateArtifacts({ mapping, fields: [], operations, ops, newId: sequentialIds("a") });
    const endpointId = ops.endpoints[0]?.id;
    const bindingId = ops.bindings[0]?.id;

    await instantiateArtifacts({ mapping, fields: [], operations, ops, newId: sequentialIds("b") });

    expect(ops.endpoints).toHaveLength(1);
    expect(ops.bindings).toHaveLength(1);
    expect(ops.endpoints[0]?.id).toBe(endpointId);
    expect(ops.bindings[0]?.id).toBe(bindingId);
  });
});
