import { randomUUID } from "node:crypto";

import type {
  AnalyzeResourcePairResponse,
  ApproveProposalResponse,
  MappingProposalDetailResponse,
  MappingProposalListResponse,
  RecordProposalItemDecisionResponse,
} from "@mediator/contracts";
import type {
  ApiSpec,
  ApprovedMapping,
  FieldMapping,
  IrResourceGroup,
  MappingProposal,
} from "@mediator/domain";
import { FakeProvider } from "@mediator/llm";
import { afterEach, describe, expect, it } from "vitest";

import {
  consumerProviderFixture,
  peerPeerFixture,
  type PeerPeerFixture,
} from "../../modules/approval/fixtures.testkit.js";
import { injectAs, TEST_OPERATOR, TEST_VIEWER } from "../../testing/auth.testkit.js";
import { buildTestServer, type TestServer } from "../../testing/fake-persistence.testkit.js";

/**
 * Route tests for the Phase-3 Review & Approval HTTP API (RA-1..RA-5), driven with
 * `fastify.inject()` over the in-memory approval store (`server.approval`) and the
 * **real** Approval Service / read + escape-hatch services. Proves the fixed
 * contract: read/mutate gating, the RA-1 confidence sort + shortlist/exclusion
 * shaping, delegation to the Approval Service, and the escape-hatch exclusion rule.
 */

const BASE = "/api/mapping-proposals";

/** Seed a peer-peer fixture (specs + proposal + items) into the approval store. */
function seedPeerPeer(server: TestServer): PeerPeerFixture {
  const fixture = peerPeerFixture();
  server.approval.seedSpec(fixture.sourceSpec);
  server.approval.seedSpec(fixture.targetSpec);
  server.approval.seedProposal(fixture.proposal, fixture.allItems);
  return fixture;
}

// ── Auth gating (OA-1/OA-2) ──────────────────────────────────────────────────

describe("RA auth gating (OA-1/OA-2)", () => {
  let server: TestServer;
  afterEach(async () => {
    await server.app.close();
  });

  it("rejects unauthenticated reads and mutations with 401", async () => {
    server = buildTestServer();
    const fixture = seedPeerPeer(server);
    const detailUrl = `${BASE}/${fixture.proposal.id}`;

    const read = await server.app.inject({ method: "GET", url: detailUrl });
    const mutate = await server.app.inject({
      method: "POST",
      url: `${detailUrl}/approve`,
      payload: {},
    });

    expect(read.statusCode).toBe(401);
    expect(mutate.statusCode).toBe(401);
  });

  it("allows a viewer to read the list and detail (RA-1)", async () => {
    server = buildTestServer();
    const fixture = seedPeerPeer(server);

    const list = await injectAs(server.app, TEST_VIEWER, {
      method: "GET",
      url: `${BASE}?sourceSpecId=${fixture.sourceSpec.id}`,
    });
    const detail = await injectAs(server.app, TEST_VIEWER, {
      method: "GET",
      url: `${BASE}/${fixture.proposal.id}`,
    });

    expect(list.statusCode).toBe(200);
    expect(detail.statusCode).toBe(200);
  });

  it("forbids a viewer from every mutation with 403 and mutates nothing", async () => {
    server = buildTestServer();
    const fixture = seedPeerPeer(server);
    const id = fixture.proposal.id;
    const itemId = fixture.items.titleField.id;

    const mutations = [
      { url: `${BASE}/${id}/items/${itemId}/decision`, payload: { decision: "accept" } },
      { url: `${BASE}/${id}/identity-key`, payload: { itemId } },
      { url: `${BASE}/${id}/approve`, payload: {} },
      {
        url: `${BASE}/${id}/analyze-pair`,
        payload: { sourceResourceRef: "issues", targetResourceRef: "tasks" },
      },
    ];

    for (const mutation of mutations) {
      const response = await injectAs(server.app, TEST_VIEWER, {
        method: "POST",
        url: mutation.url,
        payload: mutation.payload,
      });
      expect(response.statusCode).toBe(403);
    }

    // Nothing mutated: the item is still pending and no mapping/event exists.
    expect(server.approval.items.get(itemId)?.reviewState).toBe("pending");
    expect(server.approval.approvedMappings.size).toBe(0);
    expect(server.approval.events).toHaveLength(0);
  });
});

// ── RA-1: read proposals, confidence-sorted ──────────────────────────────────

describe("RA-1 — read proposals", () => {
  let server: TestServer;
  afterEach(async () => {
    await server.app.close();
  });

  it("lists proposals filtered by the directional spec pair", async () => {
    server = buildTestServer();
    const fixture = seedPeerPeer(server);

    const response = await injectAs(server.app, TEST_OPERATOR, {
      method: "GET",
      url: `${BASE}?sourceSpecId=${fixture.sourceSpec.id}&targetSpecId=${fixture.targetSpec.id}`,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<MappingProposalListResponse>();
    expect(body.proposals).toHaveLength(1);
    expect(body.proposals[0]?.id).toBe(fixture.proposal.id);
    expect(body.proposals[0]?.sourceSpecId).toBe(fixture.sourceSpec.id);
    expect(typeof body.proposals[0]?.createdAt).toBe("string");
  });

  it("returns no proposals when the target spec does not match", async () => {
    server = buildTestServer();
    const fixture = seedPeerPeer(server);

    const response = await injectAs(server.app, TEST_OPERATOR, {
      method: "GET",
      url: `${BASE}?sourceSpecId=${fixture.sourceSpec.id}&targetSpecId=${randomUUID()}`,
    });

    expect(response.json<MappingProposalListResponse>().proposals).toHaveLength(0);
  });

  it("sorts detail items riskiest-first (reviewRequired, then ascending confidence)", async () => {
    server = buildTestServer();
    const fixture = seedPeerPeer(server);

    const response = await injectAs(server.app, TEST_OPERATOR, {
      method: "GET",
      url: `${BASE}/${fixture.proposal.id}`,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<MappingProposalDetailResponse>();
    // Riskiest first: legacyField (0.2, unmapped, reviewRequired) then stateField
    // (0.6, reviewRequired); highest-confidence titleField (0.95) last.
    expect(body.items[0]?.id).toBe(fixture.items.legacyField.id);
    expect(body.items[0]?.reviewRequired).toBe(true);
    expect(body.items[0]?.unmapped).toBe(true);
    expect(body.items[0]?.targetRef).toBeUndefined();
    expect(body.items[1]?.id).toBe(fixture.items.stateField.id);
    expect(body.items[1]?.reviewRequired).toBe(true);
    expect(body.items.at(-1)?.id).toBe(fixture.items.titleField.id);
    expect(body.items.at(-1)?.reviewRequired).toBe(false);

    // Peer-peer field detection metadata is surfaced on the identity candidate.
    const email = body.items.find((item) => item.id === fixture.items.emailField.id);
    expect(email?.identityCandidate).toBe(true);
    expect(email?.targetLookupParamRef).toBe("email");
  });

  it("surfaces shortlistResult (no-counterpart + analysisFailed) and exclusions separately", async () => {
    server = buildTestServer();
    const fixture = peerPeerFixture();
    // A source spec with an excluded resource, and a proposal whose shortlist has a
    // no-counterpart resource and an analysisFailed candidate pair.
    server.approval.seedSpec({ ...fixture.sourceSpec, analysisExclusions: ["legacyResource"] });
    server.approval.seedSpec(fixture.targetSpec);
    server.approval.seedProposal(
      {
        ...fixture.proposal,
        shortlistResult: {
          candidatePairs: [
            {
              sourceResource: "issues",
              targetResource: "tasks",
              confidence: 0.8,
              rationale: "ok pair",
              analysisFailed: false,
            },
            {
              sourceResource: "labels",
              targetResource: "tags",
              confidence: 0.5,
              rationale: "failed pair",
              analysisFailed: true,
            },
          ],
          noCounterpartResources: [{ specId: fixture.sourceSpec.id, resourceRef: "milestones" }],
        },
      },
      fixture.allItems,
    );

    const response = await injectAs(server.app, TEST_OPERATOR, {
      method: "GET",
      url: `${BASE}/${fixture.proposal.id}`,
    });

    const body = response.json<MappingProposalDetailResponse>();
    expect(body.shortlist?.noCounterpartResources).toEqual([
      { specId: fixture.sourceSpec.id, resourceRef: "milestones" },
    ]);
    expect(body.shortlist?.analysisFailedPairs).toHaveLength(1);
    expect(body.shortlist?.analysisFailedPairs[0]?.sourceResource).toBe("labels");
    // Exclusions are listed separately as excluded (distinct from no-counterpart).
    expect(body.analysisExclusions).toContainEqual({
      specId: fixture.sourceSpec.id,
      resourceRef: "legacyResource",
    });
  });

  it("returns a failed proposal as needing attention with no items and a null shortlist", async () => {
    server = buildTestServer();
    const fixture = peerPeerFixture();
    server.approval.seedSpec(fixture.sourceSpec);
    server.approval.seedSpec(fixture.targetSpec);
    server.approval.seedProposal(
      { ...fixture.proposal, status: "failed", shortlistResult: null },
      [],
    );

    const response = await injectAs(server.app, TEST_OPERATOR, {
      method: "GET",
      url: `${BASE}/${fixture.proposal.id}`,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<MappingProposalDetailResponse>();
    expect(body.proposal.status).toBe("failed");
    expect(body.items).toHaveLength(0);
    expect(body.shortlist).toBeNull();
  });

  it("404s an unknown proposal detail", async () => {
    server = buildTestServer();
    const response = await injectAs(server.app, TEST_OPERATOR, {
      method: "GET",
      url: `${BASE}/${randomUUID()}`,
    });
    expect(response.statusCode).toBe(404);
  });
});

// ── RA-2: per-item decisions ─────────────────────────────────────────────────

describe("RA-2 — per-item decisions", () => {
  let server: TestServer;
  afterEach(async () => {
    await server.app.close();
  });

  it("accepts an item and audits the decision to the authenticated identity", async () => {
    server = buildTestServer();
    const fixture = seedPeerPeer(server);
    const itemId = fixture.items.titleField.id;

    const response = await injectAs(server.app, TEST_OPERATOR, {
      method: "POST",
      url: `${BASE}/${fixture.proposal.id}/items/${itemId}/decision`,
      payload: { decision: "accept" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<RecordProposalItemDecisionResponse>().item.reviewState).toBe("accepted");
    expect(server.approval.items.get(itemId)?.reviewState).toBe("accepted");
    const audit = server.approval.auditEntries.find((entry) => entry.relatedItemId === itemId);
    expect(audit?.decision).toBe("accept");
    expect(audit?.actor).toBe(TEST_OPERATOR.username);
  });

  it("captures an edit's new transform on the item", async () => {
    server = buildTestServer();
    const fixture = seedPeerPeer(server);
    const itemId = fixture.items.stateField.id;

    const response = await injectAs(server.app, TEST_OPERATOR, {
      method: "POST",
      url: `${BASE}/${fixture.proposal.id}/items/${itemId}/decision`,
      payload: { decision: "edit", transform: { transform: "rename" } },
    });

    expect(response.statusCode).toBe(200);
    const item = server.approval.items.get(itemId);
    expect(item?.reviewState).toBe("edited");
    expect(item?.transformSuggestion).toEqual({ transform: "rename" });
  });

  it("404s an item that does not exist", async () => {
    server = buildTestServer();
    const fixture = seedPeerPeer(server);
    const response = await injectAs(server.app, TEST_OPERATOR, {
      method: "POST",
      url: `${BASE}/${fixture.proposal.id}/items/${randomUUID()}/decision`,
      payload: { decision: "accept" },
    });
    expect(response.statusCode).toBe(404);
  });

  it("404s an item that belongs to a different proposal and mutates nothing", async () => {
    server = buildTestServer();
    const fixture = seedPeerPeer(server);
    const itemId = fixture.items.titleField.id;

    const response = await injectAs(server.app, TEST_OPERATOR, {
      method: "POST",
      url: `${BASE}/${randomUUID()}/items/${itemId}/decision`,
      payload: { decision: "reject" },
    });

    expect(response.statusCode).toBe(404);
    expect(server.approval.items.get(itemId)?.reviewState).toBe("pending");
  });
});

// ── RA-3: identity-key confirmation ──────────────────────────────────────────

describe("RA-3 — identity-key confirmation", () => {
  let server: TestServer;
  afterEach(async () => {
    await server.app.close();
  });

  async function accept(server: TestServer, proposalId: string, itemId: string): Promise<void> {
    await injectAs(server.app, TEST_OPERATOR, {
      method: "POST",
      url: `${BASE}/${proposalId}/items/${itemId}/decision`,
      payload: { decision: "accept" },
    });
  }

  it("confirms the identity key on an accepted rename field (delegates AS-5)", async () => {
    server = buildTestServer();
    const fixture = seedPeerPeer(server);
    await accept(server, fixture.proposal.id, fixture.items.emailField.id);

    const response = await injectAs(server.app, TEST_OPERATOR, {
      method: "POST",
      url: `${BASE}/${fixture.proposal.id}/identity-key`,
      payload: { itemId: fixture.items.emailField.id, targetLookupParamRef: "email" },
    });

    expect(response.statusCode).toBe(200);
    const identity = server.approval.fieldMappings.find((field) => field.isIdentityKey === true);
    expect(identity?.sourcePath).toBe("issues/email");
    expect(identity?.transform).toBe("rename");
  });

  it("rejects confirming a non-rename pairing as a validation error (AS-5 crit 3)", async () => {
    server = buildTestServer();
    const fixture = seedPeerPeer(server);
    await accept(server, fixture.proposal.id, fixture.items.stateField.id);

    const response = await injectAs(server.app, TEST_OPERATOR, {
      method: "POST",
      url: `${BASE}/${fixture.proposal.id}/identity-key`,
      payload: { itemId: fixture.items.stateField.id },
    });

    expect(response.statusCode).toBe(400);
    expect(server.approval.fieldMappings.some((field) => field.isIdentityKey === true)).toBe(false);
  });

  it("rejects a conflicting pairing under the shared-pairing lock (AS-5 crit 4)", async () => {
    server = buildTestServer();
    const fixture = seedPeerPeer(server);
    await accept(server, fixture.proposal.id, fixture.items.titleField.id);

    // The reverse-direction mapping already confirmed email↔email as its identity.
    const counterpart: ApprovedMapping = {
      id: randomUUID(),
      sourceSpecId: fixture.targetSpec.id,
      targetSpecId: fixture.sourceSpec.id,
      sourceAppId: fixture.appBId,
      targetAppId: fixture.appAId,
      variant: "peer-peer",
      approvedBy: "someone",
      approvedAt: new Date(),
      status: "active",
    };
    const counterpartIdentity: FieldMapping = {
      id: randomUUID(),
      mappingId: counterpart.id,
      sourcePath: "tasks/email",
      targetPath: "issues/email",
      transform: "rename",
      isIdentityKey: true,
    };
    server.approval.seedApprovedMapping(counterpart, { fieldMappings: [counterpartIdentity] });

    // Confirming title↔title as THIS direction's identity for the issues↔tasks pair
    // conflicts with the counterpart's confirmed email↔email pairing.
    const response = await injectAs(server.app, TEST_OPERATOR, {
      method: "POST",
      url: `${BASE}/${fixture.proposal.id}/identity-key`,
      payload: { itemId: fixture.items.titleField.id },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json<{ message: string }>().message).toMatch(/shared-pairing/i);
  });

  it("rejects an identity-key confirmation on a consumer-provider proposal (AS-5 crit 7)", async () => {
    server = buildTestServer();
    const fixture = consumerProviderFixture();
    server.approval.seedSpec(fixture.sourceSpec);
    server.approval.seedSpec(fixture.targetSpec);
    server.approval.seedProposal(fixture.proposal, fixture.allItems);
    await accept(server, fixture.proposal.id, fixture.items.requestField.id);

    const response = await injectAs(server.app, TEST_OPERATOR, {
      method: "POST",
      url: `${BASE}/${fixture.proposal.id}/identity-key`,
      payload: { itemId: fixture.items.requestField.id },
    });

    expect(response.statusCode).toBe(400);
  });
});

// ── RA-4: approve a selection ────────────────────────────────────────────────

describe("RA-4 — approve a selection", () => {
  let server: TestServer;
  afterEach(async () => {
    await server.app.close();
  });

  async function decide(
    server: TestServer,
    proposalId: string,
    itemId: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await injectAs(server.app, TEST_OPERATOR, {
      method: "POST",
      url: `${BASE}/${proposalId}/items/${itemId}/decision`,
      payload,
    });
  }

  it("reports partially_approved when items remain pending and emits MappingApproved", async () => {
    server = buildTestServer();
    const fixture = seedPeerPeer(server);
    await decide(server, fixture.proposal.id, fixture.items.titleField.id, { decision: "accept" });

    const response = await injectAs(server.app, TEST_OPERATOR, {
      method: "POST",
      url: `${BASE}/${fixture.proposal.id}/approve`,
      payload: {},
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<ApproveProposalResponse>();
    expect(body.outcome).toBe("partially_approved");
    expect(body.mapping?.status).toBe("active");
    expect(body.mapping?.variant).toBe("peer-peer");
    expect(server.approval.approvedMappings.size).toBe(1);
    expect(server.approval.events.some((event) => event.type === "MappingApproved")).toBe(true);
    expect(server.approval.proposals.get(fixture.proposal.id)?.status).toBe("partially_approved");
  });

  it("reports approved when every item is decided", async () => {
    server = buildTestServer();
    const fixture = seedPeerPeer(server);
    for (const item of fixture.allItems) {
      await decide(server, fixture.proposal.id, item.id, { decision: "accept" });
    }

    const response = await injectAs(server.app, TEST_OPERATOR, {
      method: "POST",
      url: `${BASE}/${fixture.proposal.id}/approve`,
      payload: {},
    });

    expect(response.json<ApproveProposalResponse>().outcome).toBe("approved");
    const mappingId = [...server.approval.approvedMappings.keys()][0];
    const audit = server.approval.auditEntries.find(
      (entry) => entry.decision === "approve" && entry.relatedMappingId === mappingId,
    );
    expect(audit?.actor).toBe(TEST_OPERATOR.username);
  });

  it("returns 4xx naming the unresolvable ref and creates/emits nothing (AS-3 atomicity)", async () => {
    server = buildTestServer();
    const fixture = seedPeerPeer(server);
    // Edit an item to a target field that does not exist on the target IR.
    await decide(server, fixture.proposal.id, fixture.items.titleField.id, {
      decision: "edit",
      targetRef: { resourceRef: "tasks", target: { kind: "field", path: "doesNotExist" } },
    });

    const response = await injectAs(server.app, TEST_OPERATOR, {
      method: "POST",
      url: `${BASE}/${fixture.proposal.id}/approve`,
      payload: {},
    });

    expect(response.statusCode).toBe(400);
    expect(response.json<{ message: string }>().message).toMatch(/does not resolve/i);
    // AS-3 atomicity: no ApprovedMapping and no MappingApproved.
    expect(server.approval.approvedMappings.size).toBe(0);
    expect(server.approval.events.some((event) => event.type === "MappingApproved")).toBe(false);
  });
});

// ── RA-5: shortlist-miss escape hatch ────────────────────────────────────────

/** A minimal peer-peer IR resource group. */
function irGroup(resourceRef: string, operationId: string, field: string): IrResourceGroup {
  return {
    resourceRef,
    name: resourceRef,
    operations: [{ operationId, method: "get", path: `/${resourceRef}`, parameters: [] }],
    schemas: [{ name: resourceRef, fields: [{ name: field, type: "string", required: true }] }],
    crossResourceRefs: [],
  };
}

/** A bespoke peer-peer proposal with a no-counterpart resource on each spec. */
function seedEscapeHatchFixture(
  server: TestServer,
  options: { sourceExclusions?: string[] } = {},
): { proposalId: string; sourceSpecId: string; targetSpecId: string } {
  const sourceSpecId = randomUUID();
  const targetSpecId = randomUUID();
  const proposalId = randomUUID();
  const createdAt = new Date("2026-07-11T00:00:00.000Z");

  const sourceSpec: ApiSpec = {
    id: sourceSpecId,
    appId: randomUUID(),
    role: "PROVIDER",
    rawDocument: { openapi: "3.1.0" },
    parsedIR: [irGroup("milestones", "listMilestones", "title")],
    analysisExclusions: options.sourceExclusions ?? [],
    version: 1,
    contentHash: `sha256:${sourceSpecId}`,
    status: "active",
    createdAt,
  };
  const targetSpec: ApiSpec = {
    id: targetSpecId,
    appId: randomUUID(),
    role: "PROVIDER",
    rawDocument: { openapi: "3.1.0" },
    parsedIR: [irGroup("sprints", "listSprints", "name")],
    analysisExclusions: [],
    version: 1,
    contentHash: `sha256:${targetSpecId}`,
    status: "active",
    createdAt,
  };
  const proposal: MappingProposal = {
    id: proposalId,
    sourceSpecId,
    targetSpecId,
    generatedBy: { providerId: "fixture", model: "fixture", promptVersion: "v1" },
    shortlistResult: {
      candidatePairs: [],
      noCounterpartResources: [
        { specId: sourceSpecId, resourceRef: "milestones" },
        { specId: targetSpecId, resourceRef: "sprints" },
      ],
    },
    status: "pending",
    createdAt,
  };

  server.approval.seedSpec(sourceSpec);
  server.approval.seedSpec(targetSpec);
  server.approval.seedProposal(proposal, []);
  return { proposalId, sourceSpecId, targetSpecId };
}

const MILESTONES_TO_SPRINTS = {
  variant: "peer-peer" as const,
  operationMappings: [
    {
      sourceOperationId: "listMilestones",
      targetOperationId: "listSprints",
      confidence: 0.9,
      rationale: "both list the collection",
      ambiguousAlternatives: [],
      unmapped: false,
    },
  ],
  fieldMappings: [
    {
      sourceField: "title",
      targetField: "name",
      transform: "rename" as const,
      transformDetail: "",
      confidence: 0.8,
      rationale: "title maps to name",
      ambiguousAlternatives: [],
      unmapped: false,
    },
  ],
};

const DETAIL_KEY = "milestones=>sprints@peer-peer";

describe("RA-5 — shortlist-miss escape hatch", () => {
  let server: TestServer;
  afterEach(async () => {
    await server.app.close();
  });

  it("attaches the scoped analysis items and leaves the no-counterpart set", async () => {
    const provider = new FakeProvider({ detail: { [DETAIL_KEY]: [MILESTONES_TO_SPRINTS] } });
    server = buildTestServer(300000, { provider });
    const { proposalId, sourceSpecId, targetSpecId } = seedEscapeHatchFixture(server);

    const response = await injectAs(server.app, TEST_OPERATOR, {
      method: "POST",
      url: `${BASE}/${proposalId}/analyze-pair`,
      payload: { sourceResourceRef: "milestones", targetResourceRef: "sprints" },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<AnalyzeResourcePairResponse>();
    expect(body.outcome).toBe("attached");
    expect(body.attachedItemCount).toBeGreaterThan(0);
    expect(body.shortlist.noCounterpartResources).toHaveLength(0);

    // The produced items are attached to the EXISTING proposal.
    const attached = [...server.approval.items.values()].filter(
      (item) => item.proposalId === proposalId,
    );
    expect(attached.length).toBe(body.attachedItemCount);
    // The analyzed pair is recorded on the proposal's shortlistResult (not failed).
    const proposal = server.approval.proposals.get(proposalId);
    expect(proposal?.shortlistResult?.candidatePairs).toHaveLength(1);
    expect(proposal?.shortlistResult?.candidatePairs[0]?.analysisFailed).toBe(false);
    expect(proposal?.shortlistResult?.noCounterpartResources).toEqual([]);
    expect([sourceSpecId, targetSpecId]).toHaveLength(2);
  });

  it("refuses to analyze an excluded resource (scope edit, not a review override)", async () => {
    const provider = new FakeProvider({ detail: { [DETAIL_KEY]: [MILESTONES_TO_SPRINTS] } });
    server = buildTestServer(300000, { provider });
    const { proposalId } = seedEscapeHatchFixture(server, { sourceExclusions: ["milestones"] });
    const itemsBefore = server.approval.items.size;

    const response = await injectAs(server.app, TEST_OPERATOR, {
      method: "POST",
      url: `${BASE}/${proposalId}/analyze-pair`,
      payload: { sourceResourceRef: "milestones", targetResourceRef: "sprints" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json<{ message: string }>().message).toMatch(/excluded/i);
    // No analysis ran and no items were attached.
    expect(server.approval.items.size).toBe(itemsBefore);
  });

  it("marks the pair analysisFailed when the detail call hits its retry ceiling", async () => {
    // A malformed detail output fails validation; with maxRetries 0 that is the ceiling.
    const provider = new FakeProvider({ detail: { [DETAIL_KEY]: [{ not: "a suggestion set" }] } });
    server = buildTestServer(300000, { provider });
    const { proposalId } = seedEscapeHatchFixture(server);

    const response = await injectAs(server.app, TEST_OPERATOR, {
      method: "POST",
      url: `${BASE}/${proposalId}/analyze-pair`,
      payload: { sourceResourceRef: "milestones", targetResourceRef: "sprints" },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<AnalyzeResourcePairResponse>();
    expect(body.outcome).toBe("analysis_failed");
    expect(body.attachedItemCount).toBe(0);
    // The failed pair is surfaced; the resource stays in the no-counterpart set.
    expect(body.shortlist.analysisFailedPairs).toHaveLength(1);
    const proposal = server.approval.proposals.get(proposalId);
    expect(proposal?.shortlistResult?.noCounterpartResources).toHaveLength(2);
  });

  it("rejects analyzing a pair with neither side in the no-counterpart set", async () => {
    const provider = new FakeProvider({ detail: { [DETAIL_KEY]: [MILESTONES_TO_SPRINTS] } });
    server = buildTestServer(300000, { provider });
    const { proposalId } = seedEscapeHatchFixture(server);
    // Empty the no-counterpart set so neither side qualifies.
    const seeded = server.approval.proposals.get(proposalId);
    if (seeded?.shortlistResult != null) {
      server.approval.proposals.set(proposalId, {
        ...seeded,
        shortlistResult: { ...seeded.shortlistResult, noCounterpartResources: [] },
      });
    }

    const response = await injectAs(server.app, TEST_OPERATOR, {
      method: "POST",
      url: `${BASE}/${proposalId}/analyze-pair`,
      payload: { sourceResourceRef: "milestones", targetResourceRef: "sprints" },
    });

    expect(response.statusCode).toBe(400);
  });
});
