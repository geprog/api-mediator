import type { ScopeCorrespondence, ScopeLink, SyncRule } from "@mediator/domain";
import { describe, expect, it } from "vitest";

import {
  InMemoryScopeDiscoveryInFlightRegistry,
  RepoScopeDiscoveryReadiness,
  ScopeDiscoveryReconciler,
  type EnabledRuleReader,
  type ScopeDiscoveryReadiness,
  type ScopeDiscoveryRetrigger,
} from "./scope-discovery-reconciler.js";

/** Unit tests for the SS-11.7 scope-discovery sweep re-trigger + its readiness derivation. */

const T0 = new Date("2026-07-18T00:00:00.000Z");

function rule(id: string, resourcePairRef: string): SyncRule {
  return {
    id,
    approvedMappingId: "map-1",
    resourcePairRef,
    status: "enabled",
    deletePropagation: "ignore",
    backfillMode: "link-only",
    backfillStatus: "completed",
  };
}

class FakeReader implements EnabledRuleReader {
  public constructor(private readonly rules: readonly SyncRule[]) {}
  public listEnabledForReconciliation(limit: number): Promise<readonly SyncRule[]> {
    return Promise.resolve(this.rules.slice(0, limit));
  }
}

class RecordingRetrigger implements ScopeDiscoveryRetrigger {
  public readonly triggered: string[] = [];
  public retriggerDiscovery(resourcePairRef: string): Promise<void> {
    this.triggered.push(resourcePairRef);
    return Promise.resolve();
  }
}

/** A readiness stub keyed by pair → needsDiscovery. */
class StubReadiness implements ScopeDiscoveryReadiness {
  public constructor(private readonly needs: Record<string, boolean>) {}
  public needsDiscovery(resourcePairRef: string): Promise<boolean> {
    return Promise.resolve(this.needs[resourcePairRef] ?? false);
  }
}

describe("ScopeDiscoveryReconciler", () => {
  it("re-triggers discovery once per pair for pairs that still need it, deduping rules", async () => {
    const reader = new FakeReader([
      rule("r1", "pair-a"),
      rule("r2", "pair-a"), // same pair — deduped
      rule("r3", "pair-b"),
      rule("r4", "pair-c"), // does not need discovery
    ]);
    const retrigger = new RecordingRetrigger();
    const reconciler = new ScopeDiscoveryReconciler({
      rules: reader,
      retrigger,
      inFlight: new InMemoryScopeDiscoveryInFlightRegistry(),
      readiness: new StubReadiness({ "pair-a": true, "pair-b": true, "pair-c": false }),
    });

    await reconciler.reconcile();
    expect(retrigger.triggered).toStrictEqual(["pair-a", "pair-b"]);
  });

  it("skips a pair whose discovery pass is already in flight (not a double-trigger)", async () => {
    const inFlight = new InMemoryScopeDiscoveryInFlightRegistry();
    inFlight.markInFlight("pair-a");
    const retrigger = new RecordingRetrigger();
    const reconciler = new ScopeDiscoveryReconciler({
      rules: new FakeReader([rule("r1", "pair-a")]),
      retrigger,
      inFlight,
      readiness: new StubReadiness({ "pair-a": true }),
    });

    await reconciler.reconcile();
    expect(retrigger.triggered).toStrictEqual([]);
  });
});

describe("RepoScopeDiscoveryReadiness", () => {
  const PAIR = "pair-a";
  function correspondence(confirmed: boolean): ScopeCorrespondence {
    return {
      id: "corr-1",
      resourcePairRef: PAIR,
      scopeIdentityKey: [{ sourceScopeKey: "name", targetFieldPath: "title" }],
      targetContainerRef: { appId: "app-tgt", resourceRef: "projects" },
      sourceContainerRef: undefined,
      confirmedBy: confirmed ? "op" : null,
      confirmedAt: confirmed ? T0 : null,
    };
  }
  function link(status: ScopeLink["status"]): ScopeLink {
    return {
      id: "link-1",
      scopeCorrespondenceId: "corr-1",
      appAId: "app-a",
      appAScopeKey: { name: "phoenix" },
      appBId: "app-b",
      appBScopeKey: { id: "42" },
      resourcePairRef: PAIR,
      establishedBy: "identity-match",
      status,
      createdAt: T0,
    };
  }

  function readiness(
    corr: ScopeCorrespondence | undefined,
    links: readonly ScopeLink[],
  ): RepoScopeDiscoveryReadiness {
    return new RepoScopeDiscoveryReadiness({
      correspondences: {
        getByResourcePair: (): Promise<ScopeCorrespondence | undefined> => Promise.resolve(corr),
      },
      links: { listByCorrespondence: (): Promise<ScopeLink[]> => Promise.resolve([...links]) },
    });
  }

  it("needs discovery only when confirmed and there are NO links at all (a lost/never-run pass)", async () => {
    expect(await readiness(correspondence(true), []).needsDiscovery(PAIR)).toBe(true);
  });

  it("does NOT re-trigger an operator-severed (all-archived) pair — respects the override (MF-1 coupling)", async () => {
    expect(await readiness(correspondence(true), [link("archived")]).needsDiscovery(PAIR)).toBe(
      false,
    );
  });

  it("does not need discovery once an active link exists, or when unconfirmed / not scoped", async () => {
    expect(await readiness(correspondence(true), [link("active")]).needsDiscovery(PAIR)).toBe(
      false,
    );
    expect(await readiness(correspondence(false), []).needsDiscovery(PAIR)).toBe(false);
    expect(await readiness(undefined, []).needsDiscovery(PAIR)).toBe(false);
  });
});
