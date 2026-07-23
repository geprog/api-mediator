import type { FieldMapping, MappingProposal, OperationMapping } from "@mediator/domain";
import { FakeProvider } from "@mediator/llm";
import { describe, expect, it, vi } from "vitest";

import type { CandidateAnalysisResult, DetectionDeps } from "./detection.js";
import { enumerateCandidatePairs } from "./enumerate.js";
import {
  giteaIssues,
  giteaMilestones,
  issuesToTasksPeerPeer,
  makeSpec,
  malformedPeerPeerDetail,
  tasksToIssuesPeerPeer,
  vikunjaTasks,
} from "./fixtures.js";
import {
  createDbPriorProposalSource,
  deriveEstablishedPairs,
  type PriorProposalSource,
  type ProposalStore,
  runScopedAdditiveAnalysis,
  type SpecSource,
} from "./run.js";
import { analyzeAdditiveDelta, analyzeReReview, buildReReviewPriorFeedback } from "./scoped.js";

/**
 * SL-3 — the scoped additive-delta analysis. Every LLM call is the deterministic
 * `FakeProvider` (no live model). The tests lean on the FakeProvider's key discipline
 * to prove *scoping*: a scoped shortlist is keyed by the exact resource summaries it was
 * given, so scripting only `"milestones=>tasks"` fails loudly if `issues` (out of scope)
 * were ever summarized, and scripting no shortlist at all fails loudly if stage 1 ran when
 * it should have been skipped (SL-3.2).
 */

const FIXED_NOW = new Date("2026-07-10T12:00:00.000Z");

function makeDeps(provider: FakeProvider): DetectionDeps {
  let n = 0;
  return {
    provider,
    maxRetries: 1,
    promptVersion: "test-prompt-v1",
    newId: () => `id-${String((n += 1))}`,
    now: () => FIXED_NOW,
  };
}

// A provider whose `issues` gained a new optional field (SL-3.2) — same IR ref.
const newGiteaSpec = makeSpec({
  id: "spec-gitea-v2",
  appId: "app-gitea",
  role: "PROVIDER",
  version: 2,
  parsedIR: [giteaIssues, giteaMilestones],
});
const vikunjaSpec = makeSpec({
  id: "spec-vikunja",
  appId: "app-vikunja",
  role: "PROVIDER",
  parsedIR: [vikunjaTasks],
});

// Scripted stage outputs for the `milestones` new group ↔ `tasks`.
const milestonesTasksShortlist = {
  candidatePairs: [
    {
      sourceResource: "milestones",
      targetResource: "tasks",
      confidence: 0.55,
      rationale: "Both group trackable items.",
    },
  ],
};
const milestonesToTasksDetail = {
  variant: "peer-peer" as const,
  operationMappings: [
    {
      sourceOperationId: "issueListMilestones",
      targetOperationId: "vikunjaListTasks",
      confidence: 0.5,
      rationale: "Both list a collection.",
      ambiguousAlternatives: [],
      unmapped: false,
    },
  ],
  fieldMappings: [
    {
      sourceField: "title",
      targetField: "title",
      transform: "rename" as const,
      transformDetail: "",
      identityCandidate: false,
      confidence: 0.6,
      rationale: "Same title field.",
      ambiguousAlternatives: [],
      unmapped: false,
    },
  ],
};
const tasksToMilestonesDetail = {
  ...milestonesToTasksDetail,
  operationMappings: [
    {
      sourceOperationId: "vikunjaListTasks",
      targetOperationId: "issueListMilestones",
      confidence: 0.5,
      rationale: "Both list a collection.",
      ambiguousAlternatives: [],
      unmapped: false,
    },
  ],
};

function proposalsOf(results: readonly CandidateAnalysisResult[]): MappingProposal[] {
  return results.map((result) => result.proposal);
}

describe("analyzeAdditiveDelta — new resource group (SL-3.1)", () => {
  it("runs a scoped shortlist for the new group only, then a detail per shortlisted pair", async () => {
    const provider = new FakeProvider({
      shortlist: { "milestones=>tasks": [milestonesTasksShortlist] },
      detail: {
        "milestones=>tasks@peer-peer": [milestonesToTasksDetail],
        "tasks=>milestones@peer-peer": [tasksToMilestonesDetail],
      },
    });
    const shortlistSpy = vi.spyOn(provider, "shortlistResourcePairs");
    const candidates = enumerateCandidatePairs(newGiteaSpec, [vikunjaSpec]);

    const results = await analyzeAdditiveDelta({
      newSpec: newGiteaSpec,
      counterpart: vikunjaSpec,
      candidates,
      scope: { newResourceGroups: ["milestones"], changedResources: [] },
      establishedPairs: [],
      deps: makeDeps(provider),
    });

    // Peer-peer → both directional delta proposals, both pending (never auto-approved).
    expect(results).toHaveLength(2);
    for (const proposal of proposalsOf(results)) {
      expect(proposal.status).toBe("pending");
      // Only the NEW group's pair is in the delta — `issues` was never shortlisted.
      expect(proposal.shortlistResult?.candidatePairs).toEqual([
        { ...milestonesTasksShortlist.candidatePairs[0], analysisFailed: false },
      ]);
    }

    // Exactly ONE scoped shortlist call, whose source summary is *only* the new group.
    expect(shortlistSpy).toHaveBeenCalledTimes(1);
    const call = shortlistSpy.mock.calls[0]?.[0];
    expect(call?.sourceSpecSummaryIR.map((r) => r.resourceRef)).toEqual(["milestones"]);
    expect(call?.targetSpecSummaryIR.map((r) => r.resourceRef)).toEqual(["tasks"]);

    // Items cover only the new group's resource pair — nothing references `issues`.
    const items = results.flatMap((result) => result.items);
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(item.sourceRef.resourceRef).not.toBe("issues");
      expect(item.targetRef?.resourceRef).not.toBe("issues");
    }
  });

  it("lists a new group with no shortlisted counterpart as no-counterpart (still reviewable)", async () => {
    const provider = new FakeProvider({
      shortlist: { "milestones=>tasks": [{ candidatePairs: [] }] },
    });
    const candidates = enumerateCandidatePairs(newGiteaSpec, [vikunjaSpec]);

    const results = await analyzeAdditiveDelta({
      newSpec: newGiteaSpec,
      counterpart: vikunjaSpec,
      candidates,
      scope: { newResourceGroups: ["milestones"], changedResources: [] },
      establishedPairs: [],
      deps: makeDeps(provider),
    });

    expect(results).toHaveLength(2);
    for (const proposal of proposalsOf(results)) {
      expect(proposal.shortlistResult?.candidatePairs).toEqual([]);
      expect(proposal.shortlistResult?.noCounterpartResources).toEqual([
        { specId: newGiteaSpec.id, resourceRef: "milestones" },
      ]);
    }
    expect(results.flatMap((r) => r.items)).toEqual([]);
  });
});

describe("analyzeAdditiveDelta — new field/op in an already-shortlisted resource (SL-3.2)", () => {
  it("skips stage 1 and runs a detail-only call for the established resource pair", async () => {
    const provider = new FakeProvider({
      // No shortlist scripted at all: a stage-1 call here would throw.
      detail: {
        "issues=>tasks@peer-peer": [issuesToTasksPeerPeer],
        "tasks=>issues@peer-peer": [tasksToIssuesPeerPeer],
      },
    });
    const shortlistSpy = vi.spyOn(provider, "shortlistResourcePairs");
    const changedSpec = makeSpec({
      id: "spec-gitea-v2",
      appId: "app-gitea",
      role: "PROVIDER",
      version: 2,
      parsedIR: [giteaIssues],
    });
    const candidates = enumerateCandidatePairs(changedSpec, [vikunjaSpec]);

    const results = await analyzeAdditiveDelta({
      newSpec: changedSpec,
      counterpart: vikunjaSpec,
      candidates,
      scope: { newResourceGroups: [], changedResources: ["issues"] },
      establishedPairs: [{ newResourceRef: "issues", counterpartResourceRef: "tasks" }],
      deps: makeDeps(provider),
    });

    // Stage 1 was skipped entirely.
    expect(shortlistSpy).not.toHaveBeenCalled();

    expect(results).toHaveLength(2);
    for (const proposal of proposalsOf(results)) {
      expect(proposal.status).toBe("pending");
      const pairs = proposal.shortlistResult?.candidatePairs ?? [];
      expect(pairs).toHaveLength(1);
      expect(pairs[0]?.sourceResource).toBe("issues");
      expect(pairs[0]?.targetResource).toBe("tasks");
      expect(pairs[0]?.rationale).toContain("stage 1 skipped");
    }
    expect(results.flatMap((r) => r.items).length).toBeGreaterThan(0);
  });
});

describe("analyzeAdditiveDelta — exclusions (SL-3.4)", () => {
  it("never analyzes an excluded new group (no shortlist, no proposal)", async () => {
    const provider = new FakeProvider({}); // any LLM call would throw.
    const shortlistSpy = vi.spyOn(provider, "shortlistResourcePairs");
    const excludingSpec = makeSpec({
      id: "spec-gitea-v2",
      appId: "app-gitea",
      role: "PROVIDER",
      version: 2,
      parsedIR: [giteaIssues, giteaMilestones],
      analysisExclusions: ["milestones"],
    });
    const candidates = enumerateCandidatePairs(excludingSpec, [vikunjaSpec]);

    const results = await analyzeAdditiveDelta({
      newSpec: excludingSpec,
      counterpart: vikunjaSpec,
      candidates,
      scope: { newResourceGroups: ["milestones"], changedResources: [] },
      establishedPairs: [],
      deps: makeDeps(provider),
    });

    expect(results).toEqual([]);
    expect(shortlistSpy).not.toHaveBeenCalled();
  });

  it("never analyzes a changed resource that is excluded (no detail, no proposal)", async () => {
    const provider = new FakeProvider({});
    const detailSpy = vi.spyOn(provider, "generateMappingProposal");
    const excludingSpec = makeSpec({
      id: "spec-gitea-v2",
      appId: "app-gitea",
      role: "PROVIDER",
      version: 2,
      parsedIR: [giteaIssues],
      analysisExclusions: ["issues"],
    });
    const candidates = enumerateCandidatePairs(excludingSpec, [vikunjaSpec]);

    const results = await analyzeAdditiveDelta({
      newSpec: excludingSpec,
      counterpart: vikunjaSpec,
      candidates,
      scope: { newResourceGroups: [], changedResources: ["issues"] },
      establishedPairs: [{ newResourceRef: "issues", counterpartResourceRef: "tasks" }],
      deps: makeDeps(provider),
    });

    expect(results).toEqual([]);
    expect(detailSpy).not.toHaveBeenCalled();
  });
});

describe("deriveEstablishedPairs — orientation from the prior shortlist (SL-3.2)", () => {
  function proposalWith(
    sourceSpecId: string,
    targetSpecId: string,
    candidatePairs: readonly { sourceResource: string; targetResource: string }[],
  ): MappingProposal {
    return {
      id: `prop-${sourceSpecId}-${targetSpecId}`,
      sourceSpecId,
      targetSpecId,
      generatedBy: { providerId: "fake", model: "fake", promptVersion: "v1" },
      shortlistResult: {
        candidatePairs: candidatePairs.map((pair) => ({
          ...pair,
          confidence: 0.8,
          rationale: "prior",
          analysisFailed: false,
        })),
        noCounterpartResources: [],
      },
      status: "pending",
      createdAt: FIXED_NOW,
    };
  }

  it("reads the changed resource off the canonical-source side when the new lineage sorts first", () => {
    // superseded 'a-v1' < counterpart 'z' → canonical source is the new lineage.
    const proposals = [
      proposalWith("a-v1", "z", [{ sourceResource: "issues", targetResource: "tasks" }]),
    ];
    expect(deriveEstablishedPairs(proposals, "a-v1", "z", ["issues"])).toEqual([
      { newResourceRef: "issues", counterpartResourceRef: "tasks" },
    ]);
  });

  it("reads the changed resource off the canonical-target side when the counterpart sorts first", () => {
    // superseded 'z-v1' > counterpart 'a' → canonical source is the counterpart.
    const proposals = [
      proposalWith("a", "z-v1", [{ sourceResource: "tasks", targetResource: "issues" }]),
    ];
    expect(deriveEstablishedPairs(proposals, "z-v1", "a", ["issues"])).toEqual([
      { newResourceRef: "issues", counterpartResourceRef: "tasks" },
    ]);
  });

  it("dedupes across the two directional proposals of a peer pair and skips failed proposals", () => {
    const forward = proposalWith("a-v1", "z", [
      { sourceResource: "issues", targetResource: "tasks" },
    ]);
    const reverse = proposalWith("z", "a-v1", [
      { sourceResource: "issues", targetResource: "tasks" },
    ]);
    const failed: MappingProposal = {
      ...forward,
      id: "failed",
      shortlistResult: null,
      status: "failed",
    };
    expect(deriveEstablishedPairs([forward, reverse, failed], "a-v1", "z", ["issues"])).toEqual([
      { newResourceRef: "issues", counterpartResourceRef: "tasks" },
    ]);
  });

  it("ignores pairs whose new-lineage side is not a changed resource", () => {
    const proposals = [
      proposalWith("a-v1", "z", [{ sourceResource: "issues", targetResource: "tasks" }]),
    ];
    expect(deriveEstablishedPairs(proposals, "a-v1", "z", ["milestones"])).toEqual([]);
  });
});

describe("runScopedAdditiveAnalysis — the worker-side scoped runner", () => {
  /** A fake SpecSource over an explicit active set. */
  function specSourceOf(active: readonly ReturnType<typeof makeSpec>[]): SpecSource {
    return {
      getById: (id) => Promise.resolve(active.find((spec) => spec.id === id)),
      listActive: () => Promise.resolve([...active]),
    };
  }

  it("combines the new group (shortlist+detail) and the changed resource (detail-only) in one pass", async () => {
    const priorProposal: MappingProposal = {
      id: "prop-v1",
      sourceSpecId: "spec-gitea-v1",
      targetSpecId: "spec-vikunja",
      generatedBy: { providerId: "fake", model: "fake", promptVersion: "v1" },
      shortlistResult: {
        candidatePairs: [
          {
            sourceResource: "issues",
            targetResource: "tasks",
            confidence: 0.8,
            rationale: "prior",
            analysisFailed: false,
          },
        ],
        noCounterpartResources: [],
      },
      status: "pending",
      createdAt: FIXED_NOW,
    };

    const provider = new FakeProvider({
      shortlist: { "milestones=>tasks": [milestonesTasksShortlist] },
      detail: {
        "milestones=>tasks@peer-peer": [milestonesToTasksDetail],
        "tasks=>milestones@peer-peer": [tasksToMilestonesDetail],
        "issues=>tasks@peer-peer": [issuesToTasksPeerPeer],
        "tasks=>issues@peer-peer": [tasksToIssuesPeerPeer],
      },
    });

    const persisted: CandidateAnalysisResult["proposal"][] = [];
    const proposalStore: ProposalStore = {
      persistAll: (proposals) => {
        persisted.push(...proposals.map((entry) => entry.proposal));
        return Promise.resolve();
      },
    };
    const priorProposals: PriorProposalSource = {
      listForSpecPair: (a, b) =>
        Promise.resolve(
          (a === "spec-gitea-v1" && b === "spec-vikunja") ||
            (a === "spec-vikunja" && b === "spec-gitea-v1")
            ? [priorProposal]
            : [],
        ),
    };

    // v1 is superseded → NOT in the active set (so it is never a counterpart).
    const result = await runScopedAdditiveAnalysis(
      {
        newSpecId: "spec-gitea-v2",
        supersededSpecId: "spec-gitea-v1",
        scope: { newResourceGroups: ["milestones"], changedResources: ["issues"] },
      },
      {
        ...makeDeps(provider),
        specSource: specSourceOf([newGiteaSpec, vikunjaSpec]),
        proposalStore,
        priorProposals,
      },
    );

    expect(result.newSpecId).toBe("spec-gitea-v2");
    // Peer-peer → two directional delta proposals, both persisted, both pending.
    expect(persisted).toHaveLength(2);
    for (const proposal of persisted) {
      expect(proposal.status).toBe("pending");
      const refs = (proposal.shortlistResult?.candidatePairs ?? []).map((pair) => ({
        source: pair.sourceResource,
        target: pair.targetResource,
      }));
      // Both the new group (milestones↔tasks) and the changed resource (issues↔tasks).
      expect(refs).toEqual(
        expect.arrayContaining([
          { source: "milestones", target: "tasks" },
          { source: "issues", target: "tasks" },
        ]),
      );
    }
  });
});

describe("createDbPriorProposalSource surface", () => {
  it("is exported (wired in the worker background over MappingProposalRepository)", () => {
    expect(typeof createDbPriorProposalSource).toBe("function");
  });
});

// ── SL-6 — the scoped breaking re-review analysis ─────────────────────────────

const STALE_MAPPING_ID = "mapping-issues-tasks-v1";

/** The `issues → tasks` stale mapping's approved content (peer-peer). */
const staleFields: FieldMapping[] = [
  {
    id: "fm-title",
    mappingId: STALE_MAPPING_ID,
    sourcePath: "issues/title",
    targetPath: "tasks/title",
    transform: "rename",
    isIdentityKey: true,
  },
  {
    id: "fm-body",
    mappingId: STALE_MAPPING_ID,
    sourcePath: "issues/body",
    targetPath: "tasks/description",
    transform: "rename",
  },
];
const staleOperations: OperationMapping[] = [
  {
    id: "om-list",
    mappingId: STALE_MAPPING_ID,
    sourceOperationRef: "issues/issueListIssues",
    targetOperationRef: "tasks/vikunjaListTasks",
    action: "read",
  },
];

describe("buildReReviewPriorFeedback (SL-6.2)", () => {
  it("groups a peer-peer mapping's fields + operations by proposal-oriented resource pair", () => {
    const byPair = buildReReviewPriorFeedback({ fields: staleFields, operations: staleOperations });

    const entries = byPair.get(JSON.stringify(["issues", "tasks"])) ?? [];
    expect(entries).toHaveLength(3);
    const title = entries.find((entry) => entry.sourceRef === "issues/title");
    expect(title?.targetRef).toBe("tasks/title");
    expect(title?.note).toContain("identity-key");
    const operation = entries.find((entry) => entry.sourceRef === "issues/issueListIssues");
    expect(operation?.targetRef).toBe("tasks/vikunjaListTasks");
    expect(operation?.note).toContain("action=read");
  });

  it("inverts a consumer-provider response-phase field's source/target orientation", () => {
    const responseField: FieldMapping = {
      id: "fm-resp",
      mappingId: "m",
      // Response phase: sourcePath is the backend (target-spec) field, targetPath the consumer.
      sourcePath: "tasks/title",
      targetPath: "todos/title",
      phase: "response",
      transform: "rename",
    };

    const byPair = buildReReviewPriorFeedback({ fields: [responseField], operations: [] });

    // The pair is oriented consumer(source-spec) → backend(target-spec): ["todos","tasks"].
    const entries = byPair.get(JSON.stringify(["todos", "tasks"])) ?? [];
    expect(entries).toHaveLength(1);
    expect(entries[0]?.sourceRef).toBe("todos/title");
    expect(entries[0]?.targetRef).toBe("tasks/title");
    expect(entries[0]?.note).toContain("phase=response");
  });
});

describe("analyzeReReview — detail-only re-review with priorFeedback (SL-6)", () => {
  // Gitea v2 (issues) — the successor's source spec; vikunja (tasks) the counterpart.
  const successorSource = makeSpec({
    id: "spec-gitea-v2",
    appId: "app-gitea",
    role: "PROVIDER",
    version: 2,
    parsedIR: [giteaIssues, giteaMilestones],
  });
  const counterpart = makeSpec({
    id: "spec-vikunja",
    appId: "app-vikunja",
    role: "PROVIDER",
    parsedIR: [vikunjaTasks],
  });

  it("skips stage 1, threads priorFeedback into the detail call, and tags reReviewOf (SL-6.1/6.2/6.4)", async () => {
    const provider = new FakeProvider({
      // No shortlist scripted at all: a stage-1 call here would throw loudly.
      detail: { "issues=>tasks@peer-peer": [issuesToTasksPeerPeer] },
    });
    const shortlistSpy = vi.spyOn(provider, "shortlistResourcePairs");
    const detailSpy = vi.spyOn(provider, "generateMappingProposal");

    const result = await analyzeReReview({
      staleMappingId: STALE_MAPPING_ID,
      source: successorSource,
      target: counterpart,
      variant: "peer-peer",
      affectedPairs: [{ sourceResource: "issues", targetResource: "tasks" }],
      priorContent: { fields: staleFields, operations: staleOperations },
      deps: makeDeps(provider),
    });

    // SL-6.1 — stage 1 was never called; the correspondence is already established.
    expect(shortlistSpy).not.toHaveBeenCalled();

    // SL-6.2 — the one detail call carried the stale mapping's approved content as priorFeedback.
    expect(detailSpy).toHaveBeenCalledTimes(1);
    const context = detailSpy.mock.calls[0]?.[0];
    expect((context?.priorFeedback ?? []).map((f) => f.sourceRef).sort()).toEqual([
      "issues/body",
      "issues/issueListIssues",
      "issues/title",
    ]);

    // SL-6.3/6.4 — an ordinary pending proposal, pinned to the new version, tagged re-review.
    expect(result.proposal.status).toBe("pending");
    expect(result.proposal.reReviewOf).toBe(STALE_MAPPING_ID);
    expect(result.proposal.sourceSpecId).toBe("spec-gitea-v2");
    expect(result.proposal.targetSpecId).toBe("spec-vikunja");
    const pairs = result.proposal.shortlistResult?.candidatePairs ?? [];
    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toMatchObject({
      sourceResource: "issues",
      targetResource: "tasks",
      analysisFailed: false,
    });
    expect(pairs[0]?.rationale).toContain("stage 1 skipped");
    expect(result.items.length).toBeGreaterThan(0);
  });

  it("dedupes repeated affected pairs into one detail call", async () => {
    const provider = new FakeProvider({
      detail: { "issues=>tasks@peer-peer": [issuesToTasksPeerPeer] },
    });
    const detailSpy = vi.spyOn(provider, "generateMappingProposal");

    await analyzeReReview({
      staleMappingId: STALE_MAPPING_ID,
      source: successorSource,
      target: counterpart,
      variant: "peer-peer",
      affectedPairs: [
        { sourceResource: "issues", targetResource: "tasks" },
        { sourceResource: "issues", targetResource: "tasks" },
      ],
      priorContent: { fields: staleFields, operations: staleOperations },
      deps: makeDeps(provider),
    });

    expect(detailSpy).toHaveBeenCalledTimes(1);
  });

  it("marks the pair analysisFailed when its detail call exhausts the retry ceiling (SL-6.5)", async () => {
    const provider = new FakeProvider({
      // Malformed to the ceiling — the corrective retry never succeeds.
      detail: { "issues=>tasks@peer-peer": [malformedPeerPeerDetail] },
    });

    const result = await analyzeReReview({
      staleMappingId: STALE_MAPPING_ID,
      source: successorSource,
      target: counterpart,
      variant: "peer-peer",
      affectedPairs: [{ sourceResource: "issues", targetResource: "tasks" }],
      priorContent: { fields: staleFields, operations: staleOperations },
      deps: makeDeps(provider),
    });

    // The proposal survives; the pair surfaces distinctly (not silently lost).
    expect(result.proposal.status).toBe("pending");
    expect(result.proposal.reReviewOf).toBe(STALE_MAPPING_ID);
    const pairs = result.proposal.shortlistResult?.candidatePairs ?? [];
    expect(pairs).toHaveLength(1);
    expect(pairs[0]?.analysisFailed).toBe(true);
    expect(result.items).toEqual([]);
  });

  it("surfaces a removed resource as analysisFailed rather than crashing (SL-6.5)", async () => {
    const provider = new FakeProvider({}); // any detail call would be for a resolvable pair
    const result = await analyzeReReview({
      staleMappingId: STALE_MAPPING_ID,
      source: successorSource,
      target: counterpart,
      variant: "peer-peer",
      // `gone` no longer exists in the new IR — the correspondence's resource was removed.
      affectedPairs: [{ sourceResource: "gone", targetResource: "tasks" }],
      priorContent: { fields: [], operations: [] },
      deps: makeDeps(provider),
    });

    const pairs = result.proposal.shortlistResult?.candidatePairs ?? [];
    expect(pairs).toHaveLength(1);
    expect(pairs[0]?.analysisFailed).toBe(true);
    expect(result.proposal.reReviewOf).toBe(STALE_MAPPING_ID);
  });
});
