import type { GraphEdge, RegisteredApp } from "@mediator/domain";
import { beforeEach, describe, expect, it } from "vitest";

import { assembleGraph, type GraphReadOps } from "./read.js";

/**
 * Unit tests for the GR-5 read **core** (`assembleGraph`) over an in-memory
 * {@link FakeReadOps} that mirrors the real repo read semantics: `listNodeApps` returns the
 * node-member set (the `active`-spec predicate lives in SQL and is proven in
 * `graph-read.integration.spec.ts`), and `listGraphEdges` applies the same
 * incident-app/status/type filters the repo's `WHERE` does. These tests pin how the service
 * assembles `{ nodes, edges }` and how each filter narrows the result.
 */
class FakeReadOps implements GraphReadOps {
  nodes: RegisteredApp[] = [];
  edges: GraphEdge[] = [];

  listNodeApps(): Promise<RegisteredApp[]> {
    return Promise.resolve([...this.nodes]);
  }

  listGraphEdges(filter: {
    readonly appId?: string;
    readonly status?: string;
    readonly type?: GraphEdge["type"];
  }): Promise<GraphEdge[]> {
    let out = [...this.edges];
    if (filter.appId !== undefined) {
      const appId = filter.appId;
      out = out.filter((e) => e.sourceNodeId === appId || e.targetNodeId === appId);
    }
    if (filter.status !== undefined) {
      out = out.filter((e) => e.status === filter.status);
    }
    if (filter.type !== undefined) {
      out = out.filter((e) => e.type === filter.type);
    }
    return Promise.resolve(out);
  }
}

function app(id: string, status: RegisteredApp["status"] = "active"): RegisteredApp {
  return {
    id,
    name: id,
    status,
    capabilities: {
      supportsPolling: true,
      supportsDeltaQuery: false,
      supportsChangeTimestamps: false,
      defaultPollInterval: 60000,
    },
    createdAt: new Date("2026-07-20T00:00:00.000Z"),
  };
}

function edge(source: string, target: string, type: GraphEdge["type"], status: string): GraphEdge {
  return {
    id: `${source}-${target}-${type}`,
    sourceNodeId: source,
    targetNodeId: target,
    type,
    status,
    metadata: {
      direction: { sourceSpecId: `${source}-spec`, targetSpecId: `${target}-spec` },
      lastActivityAt: null,
    },
  };
}

const ids = (rows: readonly { id: string }[]): string[] => rows.map((row) => row.id).sort();

describe("assembleGraph (GR-5)", () => {
  let ops: FakeReadOps;
  beforeEach(() => {
    ops = new FakeReadOps();
  });

  it("GR-5.1: no filter returns every member node and the whole materialized edge set", async () => {
    ops.nodes = [app("a"), app("b"), app("c")];
    ops.edges = [edge("a", "b", "sync", "active"), edge("c", "b", "adapter-dependency", "paused")];

    const graph = await assembleGraph(ops);

    expect(ids(graph.nodes)).toEqual(["a", "b", "c"]);
    expect(ids(graph.edges)).toEqual(["a-b-sync", "c-b-adapter-dependency"]);
  });

  it("GR-5.4: node membership — a disabled app is present (paused edge), a deregistered app is absent, a consumer-only app is present", async () => {
    // `listNodeApps` returns exactly the ≥1-active-spec members (the SQL predicate): the
    // deregistered app D (0 active specs, edges already removed) is NOT among them; the
    // disabled app A (keeps its active spec) and the consumer-only app C (its active
    // CONSUMER spec) ARE. B is A's still-active peer.
    ops.nodes = [app("a", "disabled"), app("b"), app("c")];
    ops.edges = [edge("a", "b", "sync", "paused")]; // A disabled → its edge renders paused

    const graph = await assembleGraph(ops);

    expect(ids(graph.nodes)).toEqual(["a", "b", "c"]); // disabled + consumer-only present
    expect(graph.nodes.some((n) => n.id === "d")).toBe(false); // deregistered absent
    const disabledEdge = graph.edges.find((e) => e.id === "a-b-sync");
    expect(disabledEdge?.status).toBe("paused"); // disabled app's edge is paused, not gone
  });

  it("GR-5.2: a connection-type filter restricts edges but keeps every member node", async () => {
    ops.nodes = [app("a"), app("b"), app("c")];
    ops.edges = [edge("a", "b", "sync", "active"), edge("a", "c", "adapter-dependency", "active")];

    const graph = await assembleGraph(ops, { type: "sync" });

    expect(ids(graph.nodes)).toEqual(["a", "b", "c"]); // nodes unaffected
    expect(ids(graph.edges)).toEqual(["a-b-sync"]);
  });

  it("GR-5.2: a status filter restricts edges but keeps every member node", async () => {
    ops.nodes = [app("a"), app("b"), app("c")];
    ops.edges = [edge("a", "b", "sync", "active"), edge("a", "c", "sync", "stale")];

    const graph = await assembleGraph(ops, { status: "stale" });

    expect(ids(graph.nodes)).toEqual(["a", "b", "c"]);
    expect(ids(graph.edges)).toEqual(["a-c-sync"]);
  });

  it("GR-5.2: an app filter focuses on the app's neighbourhood (incident edges + endpoints)", async () => {
    ops.nodes = [app("a"), app("b"), app("c"), app("d")];
    ops.edges = [
      edge("a", "b", "sync", "active"),
      edge("a", "c", "adapter-dependency", "active"),
      edge("b", "c", "sync", "active"), // not incident to A
    ];

    const graph = await assembleGraph(ops, { appId: "a" });

    // Edges incident to A; nodes = A + its neighbours (B, C). The isolated D is dropped.
    expect(ids(graph.edges)).toEqual(["a-b-sync", "a-c-adapter-dependency"]);
    expect(ids(graph.nodes)).toEqual(["a", "b", "c"]);
  });

  it("GR-5.2: an app filter combines with a type filter (AND)", async () => {
    ops.nodes = [app("a"), app("b"), app("c")];
    ops.edges = [edge("a", "b", "sync", "active"), edge("a", "c", "adapter-dependency", "active")];

    const graph = await assembleGraph(ops, { appId: "a", type: "sync" });

    expect(ids(graph.edges)).toEqual(["a-b-sync"]);
    expect(ids(graph.nodes)).toEqual(["a", "b"]);
  });

  it("an app filter on a non-member (e.g. deregistered) app returns an empty subgraph", async () => {
    ops.nodes = [app("a"), app("b")];
    ops.edges = [edge("a", "b", "sync", "active")];

    const graph = await assembleGraph(ops, { appId: "gone" });

    expect(graph.nodes).toHaveLength(0);
    expect(graph.edges).toHaveLength(0);
  });
});
