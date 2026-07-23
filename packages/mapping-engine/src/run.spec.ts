import type {
  ApiSpec,
  ApprovedMapping,
  FieldMapping,
  MappingProposal,
  MappingProposalItem,
  OperationMapping,
} from "@mediator/domain";
import { FakeProvider } from "@mediator/llm";
import { describe, expect, it } from "vitest";

import type { DetectionDeps } from "./detection.js";
import {
  giteaSpec,
  giteaVikunjaShortlist,
  issuesToTasksPeerPeer,
  tasksToIssuesPeerPeer,
  vikunjaSpec,
} from "./fixtures.js";
import {
  type ProposalStore,
  runDetectionForSpec,
  runScopedReReviewAnalysis,
  type SpecSource,
  type StaleMappingSource,
} from "./run.js";

/**
 * In-memory fakes that mirror the real repo semantics ([[fakes-must-mirror-real-repos]]):
 * `listActive` filters to `status = active` exactly as `ApiSpecRepository.listActive`,
 * and the store keeps proposal + items together as `MappingProposalRepository.create`
 * persists them. The real-DB counterpart is `mapping-engine.integration.spec.ts`.
 */
class InMemorySpecSource implements SpecSource {
  private readonly specs: ApiSpec[];
  public constructor(specs: readonly ApiSpec[]) {
    this.specs = [...specs];
  }
  public getById(id: string): Promise<ApiSpec | undefined> {
    return Promise.resolve(this.specs.find((s) => s.id === id));
  }
  public listActive(): Promise<ApiSpec[]> {
    return Promise.resolve(this.specs.filter((s) => s.status === "active"));
  }
}

class InMemoryProposalStore implements ProposalStore {
  public readonly rows: { proposal: MappingProposal; items: readonly MappingProposalItem[] }[] = [];
  // Mirrors the real store: all of a run's proposals persist together (one batch).
  public persistAll(
    proposals: readonly { proposal: MappingProposal; items: readonly MappingProposalItem[] }[],
  ): Promise<void> {
    for (const { proposal, items } of proposals) {
      this.rows.push({ proposal, items });
    }
    return Promise.resolve();
  }
}

function detectionDeps(provider: FakeProvider): DetectionDeps {
  let n = 0;
  return {
    provider,
    maxRetries: 1,
    promptVersion: "test-prompt-v1",
    newId: () => `id-${String((n += 1))}`,
    now: () => new Date("2026-07-10T12:00:00.000Z"),
  };
}

describe("runDetectionForSpec — persistence orchestration", () => {
  it("persists both directional peer-peer proposals for a newly ingested spec", async () => {
    const provider = new FakeProvider({
      shortlistKey: () => "sl",
      shortlist: { sl: [giteaVikunjaShortlist] },
      detail: {
        "issues=>tasks@peer-peer": [issuesToTasksPeerPeer],
        "tasks=>issues@peer-peer": [tasksToIssuesPeerPeer],
      },
    });
    const specSource = new InMemorySpecSource([giteaSpec, vikunjaSpec]);
    const proposalStore = new InMemoryProposalStore();

    const result = await runDetectionForSpec("spec-gitea", {
      ...detectionDeps(provider),
      specSource,
      proposalStore,
    });

    expect(result.newSpecId).toBe("spec-gitea");
    expect(result.analyses).toHaveLength(2);
    expect(proposalStore.rows).toHaveLength(2);

    const forward = proposalStore.rows.find((r) => r.proposal.sourceSpecId === "spec-gitea");
    expect(forward?.proposal.targetSpecId).toBe("spec-vikunja");
    expect(forward?.proposal.status).toBe("pending");
    expect(forward?.items.length).toBeGreaterThan(0);
    // Every persisted item belongs to its proposal.
    expect(forward?.items.every((i) => i.proposalId === forward.proposal.id)).toBe(true);
  });

  it("ignores non-active counterpart specs when listing the landscape", async () => {
    const superseded: ApiSpec = { ...vikunjaSpec, id: "spec-vikunja", status: "superseded" };
    const provider = new FakeProvider({
      shortlistKey: () => "sl",
      shortlist: { sl: [{ candidatePairs: [] }] },
    });
    const specSource = new InMemorySpecSource([giteaSpec, superseded]);
    const proposalStore = new InMemoryProposalStore();

    const result = await runDetectionForSpec("spec-gitea", {
      ...detectionDeps(provider),
      specSource,
      proposalStore,
    });

    // The only other spec is superseded → no candidates, nothing persisted.
    expect(result.analyses).toEqual([]);
    expect(proposalStore.rows).toEqual([]);
  });

  it("throws when the target spec does not exist", async () => {
    const provider = new FakeProvider();
    const specSource = new InMemorySpecSource([]);
    const proposalStore = new InMemoryProposalStore();
    await expect(
      runDetectionForSpec("missing", { ...detectionDeps(provider), specSource, proposalStore }),
    ).rejects.toThrow(/no ApiSpec with id missing/);
  });
});

describe("runScopedReReviewAnalysis — the worker-side scoped re-review runner (SL-6)", () => {
  const STALE_ID = "mapping-issues-tasks-v1";
  // Gitea advances v1 → v2 (a breaking change); vikunja is the unchanged counterpart.
  const giteaV2: ApiSpec = { ...giteaSpec, id: "spec-gitea-v2", version: 2 };
  const staleMapping: ApprovedMapping = {
    id: STALE_ID,
    // Stays pinned to the reviewed (superseded) version on the changed side (SL-4.3).
    sourceSpecId: "spec-gitea-v1",
    targetSpecId: "spec-vikunja",
    sourceAppId: "app-gitea",
    targetAppId: "app-vikunja",
    variant: "peer-peer",
    approvedBy: "operator@example.test",
    approvedAt: new Date("2026-07-01T00:00:00.000Z"),
    status: "stale",
  };
  const staleFields: FieldMapping[] = [
    {
      id: "fm-title",
      mappingId: STALE_ID,
      sourcePath: "issues/title",
      targetPath: "tasks/title",
      transform: "rename",
      isIdentityKey: true,
    },
  ];
  const staleOps: OperationMapping[] = [
    {
      id: "om-list",
      mappingId: STALE_ID,
      sourceOperationRef: "issues/issueListIssues",
      targetOperationRef: "tasks/vikunjaListTasks",
      action: "read",
    },
  ];

  class InMemoryStaleMappingSource implements StaleMappingSource {
    public constructor(private readonly present: boolean = true) {}
    public getById(id: string): Promise<ApprovedMapping | undefined> {
      return Promise.resolve(this.present && id === STALE_ID ? staleMapping : undefined);
    }
    public listFieldMappings(id: string): Promise<FieldMapping[]> {
      return Promise.resolve(id === STALE_ID ? staleFields : []);
    }
    public listOperationMappings(id: string): Promise<OperationMapping[]> {
      return Promise.resolve(id === STALE_ID ? staleOps : []);
    }
  }

  it("produces a successor proposal pinned to the new version, linked to the stale predecessor", async () => {
    const provider = new FakeProvider({
      // No shortlist scripted → a stage-1 call would throw loudly (detail-only path).
      detail: { "issues=>tasks@peer-peer": [issuesToTasksPeerPeer] },
    });
    // v1 is superseded → NOT in the active set; the successor pins the active v2 + counterpart.
    const specSource = new InMemorySpecSource([giteaV2, vikunjaSpec]);
    const proposalStore = new InMemoryProposalStore();

    const result = await runScopedReReviewAnalysis(
      {
        newSpecId: "spec-gitea-v2",
        supersededSpecId: "spec-gitea-v1",
        staleMappings: [
          {
            staleMappingId: STALE_ID,
            affectedPairs: [{ sourceResource: "issues", targetResource: "tasks" }],
          },
        ],
      },
      {
        ...detectionDeps(provider),
        specSource,
        proposalStore,
        staleMappings: new InMemoryStaleMappingSource(),
      },
    );

    expect(result.newSpecId).toBe("spec-gitea-v2");
    expect(proposalStore.rows).toHaveLength(1);
    const proposal = proposalStore.rows[0]?.proposal;
    expect(proposal?.status).toBe("pending");
    // The successor is a distinct proposal pinned to the NEW version on the changed side …
    expect(proposal?.sourceSpecId).toBe("spec-gitea-v2");
    expect(proposal?.targetSpecId).toBe("spec-vikunja");
    // … tagged with the stale predecessor so approval yields the successor's predecessor link.
    expect(proposal?.reReviewOf).toBe(STALE_ID);
    expect(proposalStore.rows[0]?.items.length).toBeGreaterThan(0);
  });

  it("skips a stale descriptor whose mapping row no longer exists (defensive)", async () => {
    const provider = new FakeProvider({});
    const specSource = new InMemorySpecSource([giteaV2, vikunjaSpec]);
    const proposalStore = new InMemoryProposalStore();

    const result = await runScopedReReviewAnalysis(
      {
        newSpecId: "spec-gitea-v2",
        supersededSpecId: "spec-gitea-v1",
        staleMappings: [
          {
            staleMappingId: STALE_ID,
            affectedPairs: [{ sourceResource: "issues", targetResource: "tasks" }],
          },
        ],
      },
      {
        ...detectionDeps(provider),
        specSource,
        proposalStore,
        staleMappings: new InMemoryStaleMappingSource(false),
      },
    );

    expect(result.analyses).toEqual([]);
    expect(proposalStore.rows).toEqual([]);
  });

  it("throws when the newly-ingested spec does not exist", async () => {
    const provider = new FakeProvider({});
    await expect(
      runScopedReReviewAnalysis(
        { newSpecId: "missing", supersededSpecId: "spec-gitea-v1", staleMappings: [] },
        {
          ...detectionDeps(provider),
          specSource: new InMemorySpecSource([]),
          proposalStore: new InMemoryProposalStore(),
          staleMappings: new InMemoryStaleMappingSource(),
        },
      ),
    ).rejects.toThrow(/no ApiSpec with id missing/);
  });
});
