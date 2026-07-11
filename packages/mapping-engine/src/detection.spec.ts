import type { MappingProposalItem } from "@mediator/domain";
import { FakeProvider, type FakeProviderScript } from "@mediator/llm";
import { describe, expect, it, vi } from "vitest";

import {
  analyzeCandidate,
  type DetectionDeps,
  detectForSpec,
  resolveShortlist,
} from "./detection.js";
import { enumerateCandidatePairs } from "./enumerate.js";
import {
  giteaSpec,
  giteaVikunjaShortlist,
  issuesToTasksPeerPeer,
  makeSpec,
  malformedPeerPeerDetail,
  malformedShortlist,
  tasksToIssuesPeerPeer,
  vikunjaSpec,
} from "./fixtures.js";
import type { LlmCallMetrics } from "./metrics.js";

const FIXED_NOW = new Date("2026-07-10T12:00:00.000Z");

/** Deterministic deps: sequential ids, fixed clock, a small retry cap. */
function makeDeps(provider: FakeProvider, overrides: Partial<DetectionDeps> = {}): DetectionDeps {
  let n = 0;
  return {
    provider,
    maxRetries: 1, // → 2 attempts per stage call, keeps cap tests fast
    promptVersion: "test-prompt-v1",
    newId: () => `id-${String((n += 1))}`,
    now: () => FIXED_NOW,
    ...overrides,
  };
}

/** A FakeProvider that always uses a fixed shortlist key (robust to summary shape). */
function fakeProvider(
  shortlist: readonly unknown[],
  detail: FakeProviderScript["detail"] = {},
): FakeProvider {
  return new FakeProvider({ shortlistKey: () => "sl", shortlist: { sl: shortlist }, detail });
}

const giteaVikunjaDetail: FakeProviderScript["detail"] = {
  "issues=>tasks@peer-peer": [issuesToTasksPeerPeer],
  "tasks=>issues@peer-peer": [tasksToIssuesPeerPeer],
};

describe("stage 1 shared once per unordered pair (TD-1.2)", () => {
  it("calls shortlistResourcePairs exactly once and reuses it for both directions", async () => {
    const provider = fakeProvider([giteaVikunjaShortlist], giteaVikunjaDetail);
    const shortlistSpy = vi.spyOn(provider, "shortlistResourcePairs");
    const detailSpy = vi.spyOn(provider, "generateMappingProposal");

    const results = await detectForSpec(giteaSpec, [vikunjaSpec], makeDeps(provider));

    expect(results).toHaveLength(2);
    expect(shortlistSpy).toHaveBeenCalledTimes(1); // shared across both directions
    expect(detailSpy).toHaveBeenCalledTimes(2); // one shortlisted pair, each direction
  });
});

describe("two-stage happy path (TD-2)", () => {
  it("produces a peer-peer proposal with the ground-truth-shaped items", async () => {
    const provider = fakeProvider([giteaVikunjaShortlist], giteaVikunjaDetail);
    const results = await detectForSpec(giteaSpec, [vikunjaSpec], makeDeps(provider));

    const proposal = results.find((r) => r.proposal.sourceSpecId === "spec-gitea");
    expect(proposal).toBeDefined();
    if (proposal === undefined) return;

    expect(proposal.proposal.status).toBe("pending");
    expect(proposal.proposal.generatedBy).toEqual({
      providerId: "fake",
      model: "fake-model",
      promptVersion: "test-prompt-v1",
    });

    const operations = proposal.items.filter((i) => i.kind === "operation");
    expect(operations).toHaveLength(2);
    expect(operations.every((op) => op.transformSuggestion === null)).toBe(true);

    // The title↔title field (the identity candidate) is present, transform rename, no phase.
    const title = proposal.items.find(
      (i) =>
        i.kind === "field" &&
        i.sourceRef.target.kind === "field" &&
        i.sourceRef.target.path === "title",
    );
    expect(title?.targetRef).toEqual({
      resourceRef: "tasks",
      target: { kind: "field", path: "title" },
    });
    expect(title?.transformSuggestion).toEqual({ transform: "rename" });
    expect(title && "phase" in title).toBe(false);
  });
});

describe("shortlistResult enrichment (PP-3)", () => {
  it("computes noCounterpartResources by set difference (engine, not LLM)", async () => {
    const provider = fakeProvider([giteaVikunjaShortlist], giteaVikunjaDetail);
    const results = await detectForSpec(giteaSpec, [vikunjaSpec], makeDeps(provider));
    const proposal = results.find((r) => r.proposal.sourceSpecId === "spec-gitea")?.proposal;

    // Gitea `milestones` had no shortlisted counterpart → no-counterpart, keyed by specId.
    expect(proposal?.shortlistResult?.noCounterpartResources).toEqual([
      { specId: "spec-gitea", resourceRef: "milestones" },
    ]);
    // `tasks` participated in a pair → not in the no-counterpart set.
    expect(
      proposal?.shortlistResult?.noCounterpartResources.some((r) => r.resourceRef === "tasks"),
    ).toBe(false);
  });

  it("both directions share identical candidatePairs + noCounterpart (PP-3 crit 5)", async () => {
    const provider = fakeProvider([giteaVikunjaShortlist], giteaVikunjaDetail);
    const results = await detectForSpec(giteaSpec, [vikunjaSpec], makeDeps(provider));
    const forward = results.find((r) => r.proposal.sourceSpecId === "spec-gitea")?.proposal;
    const reverse = results.find((r) => r.proposal.sourceSpecId === "spec-vikunja")?.proposal;

    const stripFailed = (
      pairs: readonly { sourceResource: string; targetResource: string }[] | undefined,
    ): unknown =>
      pairs?.map((p) => ({ sourceResource: p.sourceResource, targetResource: p.targetResource }));
    expect(stripFailed(forward?.shortlistResult?.candidatePairs)).toEqual(
      stripFailed(reverse?.shortlistResult?.candidatePairs),
    );
    expect(forward?.shortlistResult?.noCounterpartResources).toEqual(
      reverse?.shortlistResult?.noCounterpartResources,
    );
  });

  it("excludes analysisExclusions before stage 1 — excluded ≠ no-counterpart", async () => {
    const scopedGitea = makeSpec({
      id: "spec-gitea",
      appId: "app-gitea",
      role: "PROVIDER",
      parsedIR: giteaSpec.parsedIR,
      analysisExclusions: ["milestones"],
    });
    const provider = fakeProvider([giteaVikunjaShortlist], giteaVikunjaDetail);
    const shortlistSpy = vi.spyOn(provider, "shortlistResourcePairs");

    const results = await detectForSpec(scopedGitea, [vikunjaSpec], makeDeps(provider));
    const proposal = results.find((r) => r.proposal.sourceSpecId === "spec-gitea")?.proposal;

    // The excluded resource never reached the shortlist prompt …
    const context = shortlistSpy.mock.calls[0]?.[0];
    expect(context?.sourceSpecSummaryIR.map((r) => r.resourceRef)).toEqual(["issues"]);
    // … and is NOT reported as no-counterpart (excluded is a distinct state).
    expect(
      proposal?.shortlistResult?.noCounterpartResources.some((r) => r.resourceRef === "milestones"),
    ).toBe(false);
  });
});

describe("corrective retry (TD-3)", () => {
  it("malformed-then-valid: retries, uses the valid result, produces no duplicate", async () => {
    const provider = fakeProvider([malformedShortlist, giteaVikunjaShortlist], giteaVikunjaDetail);
    const shortlistSpy = vi.spyOn(provider, "shortlistResourcePairs");
    const metrics: LlmCallMetrics[] = [];

    const results = await detectForSpec(
      giteaSpec,
      [vikunjaSpec],
      makeDeps(provider, { onMetrics: (m) => metrics.push(m) }),
    );

    expect(shortlistSpy).toHaveBeenCalledTimes(2); // one malformed, one valid — shared once
    // The 2nd attempt re-prompted with the prior validation error.
    expect(shortlistSpy.mock.calls[1]?.[0].correctiveFeedback).toBeDefined();

    const proposal = results.find((r) => r.proposal.sourceSpecId === "spec-gitea")?.proposal;
    expect(proposal?.status).toBe("pending");
    // Exactly one candidate pair — the valid result, not duplicated by the retry.
    expect(proposal?.shortlistResult?.candidatePairs).toHaveLength(1);

    const shortlistMetric = metrics.find((m) => m.stage === "shortlist");
    expect(shortlistMetric?.attempts).toBe(2);
    expect(shortlistMetric?.outcome).toBe("success");
  });
});

describe("detail blast radius (TD-4): one failed pair, proposal stays pending", () => {
  it("marks only the failed pair analysisFailed and keeps the rest reviewable", async () => {
    // Two shortlisted pairs: issues↔tasks succeeds, milestones↔tasks fails to the cap.
    const twoPairShortlist = {
      candidatePairs: [
        { sourceResource: "issues", targetResource: "tasks", confidence: 0.8, rationale: "a" },
        { sourceResource: "milestones", targetResource: "tasks", confidence: 0.5, rationale: "b" },
      ],
    };
    const provider = fakeProvider([twoPairShortlist], {
      "issues=>tasks@peer-peer": [issuesToTasksPeerPeer],
      "milestones=>tasks@peer-peer": [malformedPeerPeerDetail], // malformed on every attempt
    });
    const deps = makeDeps(provider);

    const [candidate] = enumerateCandidatePairs(giteaSpec, [vikunjaSpec]).filter(
      (c) => c.sourceSpecId === "spec-gitea",
    );
    expect(candidate).toBeDefined();
    if (candidate === undefined) return;

    const shortlist = await resolveShortlist(giteaSpec, vikunjaSpec, deps);
    const result = await analyzeCandidate(
      candidate,
      { source: giteaSpec, target: vikunjaSpec },
      shortlist,
      deps,
    );

    expect(result.proposal.status).toBe("pending"); // NOT failed
    const pairs = result.proposal.shortlistResult?.candidatePairs ?? [];
    expect(pairs.find((p) => p.sourceResource === "issues")?.analysisFailed).toBe(false);
    expect(pairs.find((p) => p.sourceResource === "milestones")?.analysisFailed).toBe(true);
    // Items come only from the pair that succeeded.
    const sourceRefs = new Set(
      result.items.map((i: MappingProposalItem) => i.sourceRef.resourceRef),
    );
    expect(sourceRefs.has("issues")).toBe(true);
    expect(sourceRefs.has("milestones")).toBe(false);

    const detailMetrics = result.metrics.filter((m) => m.stage === "detail");
    const failed = detailMetrics.find((m) => m.outcome === "failed");
    expect(failed?.attempts).toBe(2); // 1 + maxRetries, then gives up
  });
});

describe("shortlist blast radius (TD-4): whole spec pair fails, both directions", () => {
  it("fails both peer directions with null shortlistResult and no items, no detail calls", async () => {
    const provider = fakeProvider([malformedShortlist], giteaVikunjaDetail);
    const detailSpy = vi.spyOn(provider, "generateMappingProposal");

    const results = await detectForSpec(giteaSpec, [vikunjaSpec], makeDeps(provider));

    expect(results).toHaveLength(2);
    for (const result of results) {
      expect(result.proposal.status).toBe("failed");
      expect(result.proposal.shortlistResult).toBeNull();
      expect(result.items).toEqual([]);
    }
    expect(detailSpy).not.toHaveBeenCalled(); // nothing reviewable → no detail budget spent
  });
});

describe("consumer-provider single-direction analysis (TD-2)", () => {
  it("resolves one directional analysis, consumer as source", async () => {
    const consumer = makeSpec({
      id: "spec-todo",
      appId: "app-todo",
      role: "CONSUMER",
      parsedIR: [
        {
          resourceRef: "todos",
          name: "Todos",
          operations: [{ operationId: "listTodos", method: "get", path: "/todos", parameters: [] }],
          schemas: [{ name: "Todo", fields: [{ name: "title", type: "string", required: true }] }],
          crossResourceRefs: [],
        },
      ],
    });
    const provider = fakeProvider([{ candidatePairs: [] }]); // empty shortlist is still a valid run
    const results = await detectForSpec(consumer, [vikunjaSpec], makeDeps(provider));

    expect(results).toHaveLength(1);
    expect(results[0]?.proposal.sourceSpecId).toBe("spec-todo");
    expect(results[0]?.proposal.status).toBe("pending");
    // Empty shortlist → zero detail calls, every in-scope resource is no-counterpart.
    expect(results[0]?.items).toEqual([]);
    const noCounterpart = results[0]?.proposal.shortlistResult?.noCounterpartResources ?? [];
    expect(noCounterpart.some((r) => r.resourceRef === "todos")).toBe(true);
    expect(noCounterpart.some((r) => r.resourceRef === "tasks")).toBe(true);
  });
});
