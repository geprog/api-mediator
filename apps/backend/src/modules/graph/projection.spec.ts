import type {
  AdapterEdgeMemberFact,
  GraphEdgeStatusUpdate,
  SyncEdgeMemberFact,
} from "@mediator/db";
import type { GraphEdge, RegisteredAppStatus } from "@mediator/domain";
import { beforeEach, describe, expect, it } from "vitest";

import { projectAdapterEdge, projectSyncEdge, type GraphProjectionOps } from "./projection.js";

/**
 * Unit tests for the incremental projection **core** (`projectSyncEdge` /
 * `projectAdapterEdge`) over an in-memory {@link FakeGraphOps} that mirrors the real
 * {@link DownstreamArtifactRepository} edge semantics (`onConflictDoNothing` create,
 * update-in-place preserving `lastActivityAt`, remove-by-key) — the "fakes must mirror
 * real repos" discipline, so a bug the real repo would show is not masked here. The
 * live-Postgres counterpart is `graph-projection.integration.spec.ts`.
 */
class FakeGraphOps implements GraphProjectionOps {
  readonly edges = new Map<string, GraphEdge>();
  readonly syncFacts = new Map<string, SyncEdgeMemberFact[]>();
  readonly adapterFacts = new Map<string, AdapterEdgeMemberFact[]>();
  /**
   * AL-1.5 — the node app statuses the recompute reads. Mirrors
   * `RegisteredAppRepository.getById(...)?.status`: an app that was never seeded reads
   * back `undefined` (the row does not exist), exactly as the real point read does.
   */
  readonly appStatuses = new Map<string, RegisteredAppStatus>();
  readonly calls = { upsert: 0, update: 0, remove: 0 };

  setAppStatus(appId: string, status: RegisteredAppStatus): void {
    this.appStatuses.set(appId, status);
  }

  readAppStatus(appId: string): Promise<RegisteredAppStatus | undefined> {
    return Promise.resolve(this.appStatuses.get(appId));
  }

  #key(source: string, target: string, type: GraphEdge["type"]): string {
    return `${source}|${target}|${type}`;
  }

  setSyncMembers(source: string, target: string, facts: SyncEdgeMemberFact[]): void {
    this.syncFacts.set(`${source}|${target}`, facts);
  }

  setAdapterMembers(consumer: string, backend: string, facts: AdapterEdgeMemberFact[]): void {
    this.adapterFacts.set(`${consumer}|${backend}`, facts);
  }

  readSyncEdgeMembers(source: string, target: string): Promise<SyncEdgeMemberFact[]> {
    return Promise.resolve(this.syncFacts.get(`${source}|${target}`) ?? []);
  }

  readAdapterEdgeMembers(consumer: string, backend: string): Promise<AdapterEdgeMemberFact[]> {
    return Promise.resolve(this.adapterFacts.get(`${consumer}|${backend}`) ?? []);
  }

  upsertGraphEdge(edge: GraphEdge): Promise<void> {
    this.calls.upsert += 1;
    const key = this.#key(edge.sourceNodeId, edge.targetNodeId, edge.type);
    // Ensure-exists: onConflictDoNothing — a present edge (its id + lastActivityAt) is
    // left exactly as it was.
    if (!this.edges.has(key)) {
      this.edges.set(key, edge);
    }
    return Promise.resolve();
  }

  updateGraphEdge(update: GraphEdgeStatusUpdate): Promise<void> {
    this.calls.update += 1;
    const key = this.#key(update.sourceNodeId, update.targetNodeId, update.type);
    const existing = this.edges.get(key);
    // UPDATE ... WHERE (source,target,type): a no-such-edge update writes nothing.
    if (existing === undefined) {
      return Promise.resolve();
    }
    this.edges.set(key, {
      ...existing,
      status: update.status,
      // Replace only direction; lastActivityAt (GR-4's disjoint field) is preserved.
      metadata: { direction: update.direction, lastActivityAt: existing.metadata.lastActivityAt },
    });
    return Promise.resolve();
  }

  removeGraphEdge(source: string, target: string, type: GraphEdge["type"]): Promise<void> {
    this.calls.remove += 1;
    this.edges.delete(this.#key(source, target, type));
    return Promise.resolve();
  }

  edge(source: string, target: string, type: GraphEdge["type"]): GraphEdge | undefined {
    return this.edges.get(this.#key(source, target, type));
  }
}

let sequence = 0;
const newId = (): string => `edge-${(sequence += 1).toString()}`;

const APP_A = "app-a";
const APP_B = "app-b";
const CONSUMER = "consumer-app";
const BACKEND = "backend-app";
const SPEC_A = "spec-a";
const SPEC_B = "spec-b";

function syncFact(
  ruleStatus: SyncEdgeMemberFact["ruleStatus"],
  mappingStatus: SyncEdgeMemberFact["mappingStatus"] = "active",
): SyncEdgeMemberFact {
  return { ruleStatus, mappingStatus, sourceSpecId: SPEC_A, targetSpecId: SPEC_B };
}

function adapterFact(
  bindingStatus: AdapterEdgeMemberFact["bindingStatus"],
  endpointStatus: AdapterEdgeMemberFact["endpointStatus"] = "active",
  mappingStatus: AdapterEdgeMemberFact["mappingStatus"] = "active",
): AdapterEdgeMemberFact {
  return {
    bindingStatus,
    endpointStatus,
    mappingStatus,
    sourceSpecId: SPEC_A,
    targetSpecId: SPEC_B,
  };
}

describe("projectSyncEdge (GR-2)", () => {
  let ops: FakeGraphOps;
  beforeEach(() => {
    ops = new FakeGraphOps();
  });

  it("GR-2.1: aggregates the pair's rules into exactly ONE sync edge, keyed (source→target, sync)", async () => {
    ops.setSyncMembers(APP_A, APP_B, [syncFact("disabled"), syncFact("disabled")]);
    await projectSyncEdge(ops, newId, APP_A, APP_B);

    expect(ops.edges.size).toBe(1);
    const edge = ops.edge(APP_A, APP_B, "sync");
    expect(edge?.type).toBe("sync");
    expect(edge?.sourceNodeId).toBe(APP_A);
    expect(edge?.targetNodeId).toBe(APP_B);
    // All rules disabled → the whole aggregate is paused.
    expect(edge?.status).toBe("paused");
    expect(edge?.metadata.direction).toStrictEqual({ sourceSpecId: SPEC_A, targetSpecId: SPEC_B });
  });

  it("GR-2.2: a rule status change recomputes the existing edge in place (same id), not a new one", async () => {
    ops.setSyncMembers(APP_A, APP_B, [syncFact("disabled"), syncFact("disabled")]);
    await projectSyncEdge(ops, newId, APP_A, APP_B);
    const created = ops.edge(APP_A, APP_B, "sync");
    expect(created?.status).toBe("paused");

    // Both rules now enabled → recompute → active, on the SAME edge row.
    ops.setSyncMembers(APP_A, APP_B, [syncFact("enabled"), syncFact("enabled")]);
    await projectSyncEdge(ops, newId, APP_A, APP_B);

    expect(ops.edges.size).toBe(1);
    const recomputed = ops.edge(APP_A, APP_B, "sync");
    expect(recomputed?.id).toBe(created?.id);
    expect(recomputed?.status).toBe("active");
  });

  it("GR-2.3: a mixed aggregate (some enabled, some disabled) is degraded, never active", async () => {
    ops.setSyncMembers(APP_A, APP_B, [syncFact("enabled"), syncFact("disabled")]);
    await projectSyncEdge(ops, newId, APP_A, APP_B);
    expect(ops.edge(APP_A, APP_B, "sync")?.status).toBe("degraded");
  });

  it("GR-2.4: a status recompute preserves the edge's lastActivityAt (a SyncEvent's activity is never rewritten)", async () => {
    // Seed an edge that already has a stamped activity (as if GR-4 had run).
    const activityAt = new Date("2026-07-20T10:00:00.000Z");
    ops.edges.set("app-a|app-b|sync", {
      id: "seeded",
      sourceNodeId: APP_A,
      targetNodeId: APP_B,
      type: "sync",
      status: "paused",
      metadata: {
        direction: { sourceSpecId: SPEC_A, targetSpecId: SPEC_B },
        lastActivityAt: activityAt,
      },
    });

    ops.setSyncMembers(APP_A, APP_B, [syncFact("enabled")]);
    await projectSyncEdge(ops, newId, APP_A, APP_B);

    const edge = ops.edge(APP_A, APP_B, "sync");
    expect(edge?.status).toBe("active"); // status recomputed
    expect(edge?.metadata.lastActivityAt).toStrictEqual(activityAt); // activity untouched
  });

  it("GR-2.5: the last rule of the direction gone (empty aggregate) removes the edge", async () => {
    ops.setSyncMembers(APP_A, APP_B, [syncFact("enabled")]);
    await projectSyncEdge(ops, newId, APP_A, APP_B);
    expect(ops.edge(APP_A, APP_B, "sync")).toBeDefined();

    ops.setSyncMembers(APP_A, APP_B, []);
    await projectSyncEdge(ops, newId, APP_A, APP_B);

    expect(ops.edge(APP_A, APP_B, "sync")).toBeUndefined();
    expect(ops.calls.remove).toBe(1);
  });

  it("a stale mapping stales the edge (SL-4)", async () => {
    ops.setSyncMembers(APP_A, APP_B, [syncFact("enabled", "stale"), syncFact("enabled", "stale")]);
    await projectSyncEdge(ops, newId, APP_A, APP_B);
    expect(ops.edge(APP_A, APP_B, "sync")?.status).toBe("stale");
  });

  it("GR-2.6: idempotent redelivery — a repeat recompute over the same aggregate yields the same edge", async () => {
    ops.setSyncMembers(APP_A, APP_B, [syncFact("enabled")]);
    await projectSyncEdge(ops, newId, APP_A, APP_B);
    const first = ops.edge(APP_A, APP_B, "sync");
    await projectSyncEdge(ops, newId, APP_A, APP_B);
    const second = ops.edge(APP_A, APP_B, "sync");

    expect(ops.edges.size).toBe(1);
    expect(second?.id).toBe(first?.id);
    expect(second?.status).toBe("active");
  });

  it("takes metadata.direction from the active mapping, not a stale one's older specs", async () => {
    ops.setSyncMembers(APP_A, APP_B, [
      {
        ruleStatus: "enabled",
        mappingStatus: "stale",
        sourceSpecId: "spec-old-src",
        targetSpecId: "spec-old-tgt",
      },
      {
        ruleStatus: "enabled",
        mappingStatus: "active",
        sourceSpecId: SPEC_A,
        targetSpecId: SPEC_B,
      },
    ]);
    await projectSyncEdge(ops, newId, APP_A, APP_B);
    expect(ops.edge(APP_A, APP_B, "sync")?.metadata.direction).toStrictEqual({
      sourceSpecId: SPEC_A,
      targetSpecId: SPEC_B,
    });
  });
});

describe("projectAdapterEdge (GR-3)", () => {
  let ops: FakeGraphOps;
  beforeEach(() => {
    ops = new FakeGraphOps();
  });

  it("GR-3.1: aggregates the pair's bindings into ONE adapter-dependency edge, keyed (consumer→backend)", async () => {
    ops.setAdapterMembers(CONSUMER, BACKEND, [adapterFact("active")]);
    await projectAdapterEdge(ops, newId, CONSUMER, BACKEND);

    expect(ops.edges.size).toBe(1);
    const edge = ops.edge(CONSUMER, BACKEND, "adapter-dependency");
    expect(edge?.type).toBe("adapter-dependency");
    expect(edge?.sourceNodeId).toBe(CONSUMER);
    expect(edge?.targetNodeId).toBe(BACKEND);
    expect(edge?.status).toBe("active");
  });

  it("GR-3.2: disabling the endpoint recomputes the edge to paused (the CO-6 marker now does something)", async () => {
    ops.setAdapterMembers(CONSUMER, BACKEND, [adapterFact("active", "active")]);
    await projectAdapterEdge(ops, newId, CONSUMER, BACKEND);
    expect(ops.edge(CONSUMER, BACKEND, "adapter-dependency")?.status).toBe("active");

    // Endpoint disabled: the binding rows are retained, but the edge reflects the pause.
    ops.setAdapterMembers(CONSUMER, BACKEND, [adapterFact("active", "disabled")]);
    await projectAdapterEdge(ops, newId, CONSUMER, BACKEND);
    expect(ops.edge(CONSUMER, BACKEND, "adapter-dependency")?.status).toBe("paused");
  });

  it("GR-3.2: a recompose activating a 2nd proposed binding recomputes active → degraded", async () => {
    ops.setAdapterMembers(CONSUMER, BACKEND, [adapterFact("active")]);
    await projectAdapterEdge(ops, newId, CONSUMER, BACKEND);
    expect(ops.edge(CONSUMER, BACKEND, "adapter-dependency")?.status).toBe("active");

    ops.setAdapterMembers(CONSUMER, BACKEND, [adapterFact("active"), adapterFact("proposed")]);
    await projectAdapterEdge(ops, newId, CONSUMER, BACKEND);
    expect(ops.edge(CONSUMER, BACKEND, "adapter-dependency")?.status).toBe("degraded");
  });

  it("GR-3.4: adoption keeps the edge present and recomputes it (never torn down) while a binding still backs it", async () => {
    ops.setAdapterMembers(CONSUMER, BACKEND, [adapterFact("active")]);
    await projectAdapterEdge(ops, newId, CONSUMER, BACKEND);
    const before = ops.edge(CONSUMER, BACKEND, "adapter-dependency");

    // After adoption the binding still exists (re-pointed to the active successor).
    ops.setAdapterMembers(CONSUMER, BACKEND, [adapterFact("active", "active", "active")]);
    await projectAdapterEdge(ops, newId, CONSUMER, BACKEND);

    const after = ops.edge(CONSUMER, BACKEND, "adapter-dependency");
    expect(after).toBeDefined();
    expect(after?.id).toBe(before?.id);
    expect(ops.calls.remove).toBe(0); // not removed
  });

  it("GR-3.5: the last binding of the pair gone (empty aggregate) removes the edge", async () => {
    ops.setAdapterMembers(CONSUMER, BACKEND, [adapterFact("active")]);
    await projectAdapterEdge(ops, newId, CONSUMER, BACKEND);
    expect(ops.edge(CONSUMER, BACKEND, "adapter-dependency")).toBeDefined();

    ops.setAdapterMembers(CONSUMER, BACKEND, []);
    await projectAdapterEdge(ops, newId, CONSUMER, BACKEND);
    expect(ops.edge(CONSUMER, BACKEND, "adapter-dependency")).toBeUndefined();
  });

  it("GR-3.6: idempotent — a repeat recompute over the same aggregate yields the same edge", async () => {
    ops.setAdapterMembers(CONSUMER, BACKEND, [adapterFact("active")]);
    await projectAdapterEdge(ops, newId, CONSUMER, BACKEND);
    const first = ops.edge(CONSUMER, BACKEND, "adapter-dependency");
    await projectAdapterEdge(ops, newId, CONSUMER, BACKEND);
    const second = ops.edge(CONSUMER, BACKEND, "adapter-dependency");
    expect(ops.edges.size).toBe(1);
    expect(second?.id).toBe(first?.id);
  });
});

describe("the app-lifecycle condition on a recompute (AL-1.5 / GR-5.4)", () => {
  let ops: FakeGraphOps;
  beforeEach(() => {
    ops = new FakeGraphOps();
  });

  it("AL-1.5: disabling either app of a sync pair pauses the edge, and re-enabling restores it", async () => {
    ops.setSyncMembers(APP_A, APP_B, [syncFact("enabled"), syncFact("enabled")]);
    ops.setAppStatus(APP_A, "active");
    ops.setAppStatus(APP_B, "active");
    await projectSyncEdge(ops, newId, APP_A, APP_B);
    const created = ops.edge(APP_A, APP_B, "sync");
    expect(created?.status).toBe("active");

    // Source disabled → every rule of the pair is paused, though no rule row moved.
    ops.setAppStatus(APP_A, "disabled");
    await projectSyncEdge(ops, newId, APP_A, APP_B);
    expect(ops.edge(APP_A, APP_B, "sync")?.status).toBe("paused");

    // Target disabled instead → same, a rule stops when EITHER of its apps is out.
    ops.setAppStatus(APP_A, "active");
    ops.setAppStatus(APP_B, "disabled");
    await projectSyncEdge(ops, newId, APP_A, APP_B);
    expect(ops.edge(APP_A, APP_B, "sync")?.status).toBe("paused");

    // Re-enabled → the same edge row (never removed — the app stayed a node) goes active.
    ops.setAppStatus(APP_B, "active");
    await projectSyncEdge(ops, newId, APP_A, APP_B);
    const restored = ops.edge(APP_A, APP_B, "sync");
    expect(restored?.status).toBe("active");
    expect(restored?.id).toBe(created?.id);
    expect(ops.calls.remove).toBe(0);
  });

  it("AL-1.5: a disabled BACKEND app pauses the adapter edge (the backend-disabled condition)", async () => {
    ops.setAdapterMembers(CONSUMER, BACKEND, [adapterFact("active")]);
    ops.setAppStatus(CONSUMER, "active");
    ops.setAppStatus(BACKEND, "disabled");
    await projectAdapterEdge(ops, newId, CONSUMER, BACKEND);
    expect(ops.edge(CONSUMER, BACKEND, "adapter-dependency")?.status).toBe("paused");

    ops.setAppStatus(BACKEND, "active");
    await projectAdapterEdge(ops, newId, CONSUMER, BACKEND);
    expect(ops.edge(CONSUMER, BACKEND, "adapter-dependency")?.status).toBe("active");
  });

  it("AL-1.5: a disabled CONSUMER app leaves the adapter edge alone (its surface keeps serving)", async () => {
    ops.setAdapterMembers(CONSUMER, BACKEND, [adapterFact("active")]);
    ops.setAppStatus(CONSUMER, "disabled");
    ops.setAppStatus(BACKEND, "active");
    await projectAdapterEdge(ops, newId, CONSUMER, BACKEND);
    expect(ops.edge(CONSUMER, BACKEND, "adapter-dependency")?.status).toBe("active");
  });

  it("an unresolvable app status is treated as active — never an invented pause", async () => {
    // Neither app seeded: the point read returns undefined, exactly as for a missing row.
    ops.setSyncMembers(APP_A, APP_B, [syncFact("enabled")]);
    await projectSyncEdge(ops, newId, APP_A, APP_B);
    expect(ops.edge(APP_A, APP_B, "sync")?.status).toBe("active");
  });
});
