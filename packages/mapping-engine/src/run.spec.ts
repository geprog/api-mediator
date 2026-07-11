import type { ApiSpec, MappingProposal, MappingProposalItem } from "@mediator/domain";
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
import { type ProposalStore, runDetectionForSpec, type SpecSource } from "./run.js";

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
