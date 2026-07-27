import type { GraphEdgeActivityAdvance, GraphEdgeAppPair } from "@mediator/db";
import type { AuditLogEntry, GraphEdge } from "@mediator/domain";
import { beforeEach, describe, expect, it } from "vitest";

import {
  advanceActivityForAuditEntry,
  advanceAdapterEdgeActivity,
  advanceSyncEdgeActivity,
  type GraphActivityOps,
} from "./activity.js";

/**
 * Unit tests for the GR-4 activity updater **core** over an in-memory {@link FakeActivityOps}
 * that **mirrors** the real {@link DownstreamArtifactRepository} semantics: the **monotonic**
 * conditional advance (`WHERE lastActivityAt IS NULL OR lastActivityAt < $ts` — an older or
 * equal timestamp no-ops, a no-such-edge advance no-ops) and the **jsonb-isolated** write
 * (only `metadata.lastActivityAt` moves; `status` and `direction` are byte-preserved). The
 * "fakes must mirror real repos" discipline, so a bug the real conditional write would show is
 * not masked here. The live-Postgres counterpart is `graph-activity.integration.spec.ts`.
 */
class FakeActivityOps implements GraphActivityOps {
  readonly edges = new Map<string, GraphEdge>();
  readonly rulePairs = new Map<string, GraphEdgeAppPair>();
  readonly bindingPairs = new Map<string, GraphEdgeAppPair>();
  readonly advances: GraphEdgeActivityAdvance[] = [];

  #key(source: string, target: string, type: GraphEdge["type"]): string {
    return `${source}|${target}|${type}`;
  }

  seedEdge(edge: GraphEdge): void {
    this.edges.set(this.#key(edge.sourceNodeId, edge.targetNodeId, edge.type), edge);
  }

  edge(source: string, target: string, type: GraphEdge["type"]): GraphEdge | undefined {
    return this.edges.get(this.#key(source, target, type));
  }

  resolveSyncEdgeKeyForRule(ruleId: string): Promise<GraphEdgeAppPair | undefined> {
    return Promise.resolve(this.rulePairs.get(ruleId));
  }

  resolveAdapterEdgeKeyForBinding(bindingId: string): Promise<GraphEdgeAppPair | undefined> {
    return Promise.resolve(this.bindingPairs.get(bindingId));
  }

  advanceGraphEdgeActivity(advance: GraphEdgeActivityAdvance): Promise<void> {
    this.advances.push(advance);
    const key = this.#key(advance.sourceNodeId, advance.targetNodeId, advance.type);
    const existing = this.edges.get(key);
    // UPDATE ... WHERE (source,target,type): a no-such-edge advance writes nothing.
    if (existing === undefined) {
      return Promise.resolve();
    }
    // Monotonic guard: advance only past a NULL or STRICTLY-older stamp (an older or equal
    // redelivery no-ops — exactly the SQL `lastActivityAt < $ts`).
    const current = existing.metadata.lastActivityAt;
    if (current !== null && current.getTime() >= advance.activityAt.getTime()) {
      return Promise.resolve();
    }
    // jsonb-isolated: replace ONLY lastActivityAt; status + direction are preserved.
    this.edges.set(key, {
      ...existing,
      metadata: { direction: existing.metadata.direction, lastActivityAt: advance.activityAt },
    });
    return Promise.resolve();
  }
}

const APP_A = "app-a";
const APP_B = "app-b";
const CONSUMER = "consumer-app";
const BACKEND = "backend-app";
const SPEC_A = "spec-a";
const SPEC_B = "spec-b";

const T1 = new Date("2026-07-20T09:00:00.000Z");
const T2 = new Date("2026-07-20T10:00:00.000Z");
const T3 = new Date("2026-07-20T11:00:00.000Z");

function syncEdge(status: string, lastActivityAt: Date | null): GraphEdge {
  return {
    id: "sync-edge",
    sourceNodeId: APP_A,
    targetNodeId: APP_B,
    type: "sync",
    status,
    metadata: { direction: { sourceSpecId: SPEC_A, targetSpecId: SPEC_B }, lastActivityAt },
  };
}

function adapterEdge(status: string, lastActivityAt: Date | null): GraphEdge {
  return {
    id: "adapter-edge",
    sourceNodeId: CONSUMER,
    targetNodeId: BACKEND,
    type: "adapter-dependency",
    status,
    metadata: { direction: { sourceSpecId: SPEC_A, targetSpecId: SPEC_B }, lastActivityAt },
  };
}

function syncExecution(relatedRuleId: string | undefined, timestamp: Date): AuditLogEntry {
  return {
    id: "evt",
    type: "sync-execution",
    actor: "sync-engine",
    status: "success",
    timestamp,
    ...(relatedRuleId !== undefined ? { relatedRuleId } : {}),
  };
}

function adapterRequest(relatedBindingId: string | undefined, timestamp: Date): AuditLogEntry {
  return {
    id: "evt",
    type: "adapter-request",
    actor: "consumer-app:x",
    status: "success",
    timestamp,
    ...(relatedBindingId !== undefined ? { relatedBindingId } : {}),
  };
}

describe("GR-4 monotonic activity advance", () => {
  let ops: FakeActivityOps;
  beforeEach(() => {
    ops = new FakeActivityOps();
    ops.rulePairs.set("rule-1", { sourceNodeId: APP_A, targetNodeId: APP_B });
    ops.bindingPairs.set("binding-1", { sourceNodeId: CONSUMER, targetNodeId: BACKEND });
  });

  it("GR-4.3: a null lastActivityAt is first-stamped by the first event", async () => {
    ops.seedEdge(syncEdge("active", null));
    await advanceSyncEdgeActivity(ops, "rule-1", T2);
    expect(ops.edge(APP_A, APP_B, "sync")?.metadata.lastActivityAt).toStrictEqual(T2);
  });

  it("GR-4.2: a newer event advances lastActivityAt forward", async () => {
    ops.seedEdge(syncEdge("active", T1));
    await advanceSyncEdgeActivity(ops, "rule-1", T2);
    expect(ops.edge(APP_A, APP_B, "sync")?.metadata.lastActivityAt).toStrictEqual(T2);
  });

  it("GR-4.2: an older (out-of-order/redelivered) event never moves lastActivityAt backwards", async () => {
    ops.seedEdge(syncEdge("active", T2));
    await advanceSyncEdgeActivity(ops, "rule-1", T1); // stale redelivery
    expect(ops.edge(APP_A, APP_B, "sync")?.metadata.lastActivityAt).toStrictEqual(T2);
  });

  it("GR-4.2: an equal-timestamp redelivery is a no-op (idempotent)", async () => {
    ops.seedEdge(syncEdge("active", T2));
    await advanceSyncEdgeActivity(ops, "rule-1", T2);
    expect(ops.edge(APP_A, APP_B, "sync")?.metadata.lastActivityAt).toStrictEqual(T2);
  });

  it("GR-4.1: the advance touches ONLY lastActivityAt — status + direction preserved", async () => {
    ops.seedEdge(syncEdge("degraded", null));
    await advanceSyncEdgeActivity(ops, "rule-1", T2);
    const edge = ops.edge(APP_A, APP_B, "sync");
    expect(edge?.status).toBe("degraded"); // status untouched (GR-1.5 disjoint field)
    expect(edge?.metadata.direction).toStrictEqual({ sourceSpecId: SPEC_A, targetSpecId: SPEC_B });
    expect(edge?.metadata.lastActivityAt).toStrictEqual(T2);
  });

  it("advancing a non-existent edge is a safe no-op (no row, nothing stamped)", async () => {
    // No edge seeded — the resolve succeeds but the conditional UPDATE matches no row.
    await advanceSyncEdgeActivity(ops, "rule-1", T2);
    expect(ops.edge(APP_A, APP_B, "sync")).toBeUndefined();
    expect(ops.advances).toHaveLength(1); // the advance ran; it simply matched nothing
  });

  it("an unresolvable rule advances nothing (never invents an edge key)", async () => {
    await advanceSyncEdgeActivity(ops, "unknown-rule", T2);
    expect(ops.advances).toHaveLength(0);
  });
});

describe("GR-4 edge resolution from an audit entry", () => {
  let ops: FakeActivityOps;
  beforeEach(() => {
    ops = new FakeActivityOps();
    ops.rulePairs.set("rule-1", { sourceNodeId: APP_A, targetNodeId: APP_B });
    ops.bindingPairs.set("binding-1", { sourceNodeId: CONSUMER, targetNodeId: BACKEND });
  });

  it("a SyncEvent (sync-execution) advances its rule's sync edge", async () => {
    ops.seedEdge(syncEdge("active", null));
    await advanceActivityForAuditEntry(ops, syncExecution("rule-1", T3));
    expect(ops.advances).toStrictEqual([
      { sourceNodeId: APP_A, targetNodeId: APP_B, type: "sync", activityAt: T3 },
    ]);
    expect(ops.edge(APP_A, APP_B, "sync")?.metadata.lastActivityAt).toStrictEqual(T3);
  });

  it("an adapter-request advances its binding's adapter-dependency edge", async () => {
    ops.seedEdge(adapterEdge("active", null));
    await advanceActivityForAuditEntry(ops, adapterRequest("binding-1", T3));
    expect(ops.advances).toStrictEqual([
      { sourceNodeId: CONSUMER, targetNodeId: BACKEND, type: "adapter-dependency", activityAt: T3 },
    ]);
    expect(
      ops.edge(CONSUMER, BACKEND, "adapter-dependency")?.metadata.lastActivityAt,
    ).toStrictEqual(T3);
  });

  it("advances the adapter edge directly from a binding id", async () => {
    ops.seedEdge(adapterEdge("active", T1));
    await advanceAdapterEdgeActivity(ops, "binding-1", T2);
    expect(
      ops.edge(CONSUMER, BACKEND, "adapter-dependency")?.metadata.lastActivityAt,
    ).toStrictEqual(T2);
  });

  it("a non-activity audit type (poll-run) advances nothing", async () => {
    ops.seedEdge(syncEdge("active", null));
    await advanceActivityForAuditEntry(ops, {
      id: "evt",
      type: "poll-run",
      actor: "sync-engine",
      status: "success",
      timestamp: T3,
      relatedRuleId: "rule-1",
    });
    expect(ops.advances).toHaveLength(0);
    expect(ops.edge(APP_A, APP_B, "sync")?.metadata.lastActivityAt).toBeNull();
  });

  it("a sync-execution with no relatedRuleId advances nothing", async () => {
    await advanceActivityForAuditEntry(ops, syncExecution(undefined, T3));
    expect(ops.advances).toHaveLength(0);
  });

  it("an adapter-request with no relatedBindingId advances nothing", async () => {
    await advanceActivityForAuditEntry(ops, adapterRequest(undefined, T3));
    expect(ops.advances).toHaveLength(0);
  });
});
