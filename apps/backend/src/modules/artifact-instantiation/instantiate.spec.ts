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

describe("instantiateArtifacts — consumer-provider first-binding auto-activation (CO-1)", () => {
  it("attaches the first binding active/primary and activates the endpoint with the safe defaults", async () => {
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
    // CO-1.1: one endpoint for the consumer operation. CO-1.2: it is live.
    expect(ops.endpoints).toHaveLength(1);
    const endpoint = ops.endpoints[0];
    expect(endpoint?.status).toBe("active");
    expect(endpoint?.aggregationStrategy).toBe("single");
    expect(endpoint?.strictness).toBe("degraded");
    expect(endpoint?.cacheTtl).toBeUndefined(); // no caching
    // CO-1.2/1.4: the first binding is primary + active, its backend op the target side.
    expect(ops.bindings).toHaveLength(1);
    const binding = ops.bindings[0];
    expect(binding?.status).toBe("active");
    expect(binding?.role).toBe("primary");
    expect(binding?.backendAppId).toBe(APP_B);
    expect(binding?.backendOperationId).toBe("issues/listIssues");
    expect(binding?.approvedMappingId).toBe("m-1");
    expect(binding?.adapterEndpointId).toBe(endpoint?.id);
    // CO-1.5: the adapter-dependency edge fired. Mutual exclusivity: no sync-rule write.
    expect(ops.edges[0]?.type).toBe("adapter-dependency");
    expect(ops.syncRules).toHaveLength(0);
    expect(ops.calls.insertSyncRuleIfAbsent).toBe(0);
  });

  it("a further backend in the SAME mapping attaches proposed and moves the endpoint to composition-required", async () => {
    const ops = new FakeDownstreamArtifactOps();
    const mapping = approvedMappingFixture({
      id: "m-1",
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
          mappingId: "m-1",
          sourceOperationRef: "search/searchIssues",
          targetOperationRef: "issues/listIssues",
        }),
        // A second distinct backend operation for the SAME consumer operation.
        operationMappingFixture({
          id: "o-2",
          mappingId: "m-1",
          sourceOperationRef: "search/searchIssues",
          targetOperationRef: "tickets/listTickets",
        }),
      ],
      ops,
      newId: sequentialIds("id"),
    });

    // Two backends for one consumer op is a composition decision: the first serves,
    // the second requires composition.
    expect(ops.endpoints).toHaveLength(1);
    expect(ops.endpoints[0]?.status).toBe("composition-required");
    const byOp = new Map(ops.bindings.map((b) => [b.backendOperationId, b]));
    expect(byOp.get("issues/listIssues")?.status).toBe("active");
    expect(byOp.get("tickets/listTickets")?.status).toBe("proposed");
    // The first (active) binding keeps its serving config — endpoint still single/degraded.
    expect(ops.endpoints[0]?.aggregationStrategy).toBe("single");
    expect(ops.endpoints[0]?.strictness).toBe("degraded");
  });
});

describe("instantiateArtifacts — consumer-provider second-mapping composition (CO-1.3)", () => {
  it("a further mapping attaches proposed + composition-required, leaving the prior active binding untouched", async () => {
    const ops = new FakeDownstreamArtifactOps();
    // A prior mapping already made this endpoint live with an active primary binding.
    ops.seedEndpoint({
      id: "existing-endpoint",
      consumerAppId: APP_A,
      consumerOperationId: "search/searchIssues",
      status: "active",
      aggregationStrategy: "single",
      strictness: "degraded",
    });
    ops.seedBinding({
      id: "binding-1",
      adapterEndpointId: "existing-endpoint",
      backendAppId: APP_B,
      backendOperationId: "issues/listIssues",
      approvedMappingId: "m-1",
      role: "primary",
      status: "active",
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

    // No duplicate endpoint; it transitioned to composition-required.
    expect(ops.endpoints).toHaveLength(1);
    expect(ops.endpoints[0]?.id).toBe("existing-endpoint");
    expect(ops.endpoints[0]?.status).toBe("composition-required");
    // The prior active binding is untouched (still serving, RT-3.3).
    const prior = ops.bindings.find((b) => b.id === "binding-1");
    expect(prior?.status).toBe("active");
    expect(prior?.role).toBe("primary");
    // The new binding is proposed under the same endpoint.
    const added = ops.bindings.find((b) => b.approvedMappingId === "m-2");
    expect(added?.status).toBe("proposed");
    expect(added?.adapterEndpointId).toBe("existing-endpoint");
  });
});

describe("instantiateArtifacts — consumer-provider idempotency (CO-1.6)", () => {
  it("redelivery keeps the same endpoint + binding, and never re-activates or downgrades", async () => {
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

    // Redelivery re-derives with FRESH ids; the natural-key conflict keeps the rows.
    await instantiateArtifacts({ mapping, fields: [], operations, ops, newId: sequentialIds("b") });

    expect(ops.endpoints).toHaveLength(1);
    expect(ops.bindings).toHaveLength(1);
    expect(ops.endpoints[0]?.id).toBe(endpointId);
    expect(ops.endpoints[0]?.status).toBe("active");
    expect(ops.bindings[0]?.id).toBe(bindingId);
    expect(ops.bindings[0]?.status).toBe("active");
    // The redelivery attached nothing new → no endpoint transition ran.
    expect(ops.calls.activateAdapterEndpointForSingleBinding).toBe(1);
    expect(ops.calls.markAdapterEndpointCompositionRequired).toBe(0);
  });

  it("an operator-disabled binding stays disabled on re-approval; the endpoint is not re-activated", async () => {
    const ops = new FakeDownstreamArtifactOps();
    // The endpoint's only binding was disabled by an operator; the endpoint itself was
    // left disabled too (RT-3.2 rejects it).
    ops.seedEndpoint({
      id: "existing-endpoint",
      consumerAppId: APP_A,
      consumerOperationId: "search/searchIssues",
      status: "disabled",
    });
    ops.seedBinding({
      id: "binding-1",
      adapterEndpointId: "existing-endpoint",
      backendAppId: APP_B,
      backendOperationId: "issues/listIssues",
      approvedMappingId: "m-1",
      role: "primary",
      status: "disabled",
    });

    const mapping = approvedMappingFixture({
      id: "m-1",
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
          mappingId: "m-1",
          sourceOperationRef: "search/searchIssues",
          targetOperationRef: "issues/listIssues",
        }),
      ],
      ops,
      newId: sequentialIds("re"),
    });

    // The disabled binding is untouched; no new binding; the endpoint stays disabled.
    expect(ops.bindings).toHaveLength(1);
    expect(ops.bindings[0]?.id).toBe("binding-1");
    expect(ops.bindings[0]?.status).toBe("disabled");
    expect(ops.endpoints[0]?.status).toBe("disabled");
    expect(ops.calls.activateAdapterEndpointForSingleBinding).toBe(0);
    expect(ops.calls.markAdapterEndpointCompositionRequired).toBe(0);
  });
});
