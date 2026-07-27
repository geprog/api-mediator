import type { GraphResponse } from "@mediator/contracts";
import type { GraphEdge, RegisteredApp } from "@mediator/domain";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import type { GraphFilter, LandscapeGraph } from "../../modules/graph/index.js";
import {
  TEST_OPERATOR,
  TEST_OPERATOR_ACCOUNTS,
  TEST_VIEWER,
  injectAs,
} from "../../testing/auth.testkit.js";
import { LocalAccountsAuthProvider, installAuthentication } from "../auth/index.js";
import { registerErrorHandler } from "../errors.js";
import { registerGraphRoutes, type GraphReader } from "./graph.routes.js";

/**
 * Route tests for the GR-5 landscape graph read (`GET /api/graph`), driven with
 * `fastify.inject()` through the **real** operator-auth path (OA-1/OA-2) and an in-memory
 * `GraphReader` double. They assert the HTTP contract — that the graph is **viewer-readable**
 * (GR-5.5, no operator-only gate), that the filter reaches the service, that edges serialize
 * their full `type`/`status`/`metadata` (GR-5.3), and that no secret leaks — while the graph
 * assembly itself is the service's own test.
 */
const APP_A = "11111111-1111-4111-8111-111111111111";
const APP_B = "22222222-2222-4222-8222-222222222222";

function nodeApp(id: string): RegisteredApp {
  return {
    id,
    name: `app-${id.slice(0, 4)}`,
    status: "active",
    capabilities: {
      supportsPolling: true,
      supportsDeltaQuery: false,
      supportsChangeTimestamps: false,
      defaultPollInterval: 60000,
    },
    createdAt: new Date("2026-07-20T00:00:00.000Z"),
  };
}

const ACTIVITY_AT = new Date("2026-07-21T08:15:00.000Z");

function syncEdge(): GraphEdge {
  return {
    id: "edge-1",
    sourceNodeId: APP_A,
    targetNodeId: APP_B,
    type: "sync",
    status: "active",
    metadata: {
      direction: { sourceSpecId: "spec-a", targetSpecId: "spec-b" },
      lastActivityAt: ACTIVITY_AT,
    },
  };
}

class FakeGraphReader implements GraphReader {
  public readonly calls: GraphFilter[] = [];
  public result: LandscapeGraph = { nodes: [nodeApp(APP_A), nodeApp(APP_B)], edges: [syncEdge()] };

  public getGraph(filter: GraphFilter): Promise<LandscapeGraph> {
    this.calls.push(filter);
    return Promise.resolve(this.result);
  }
}

function buildApp(reader: GraphReader): FastifyInstance {
  const app = Fastify();
  void app.register((instance) => {
    installAuthentication(instance, new LocalAccountsAuthProvider(TEST_OPERATOR_ACCOUNTS));
    registerGraphRoutes(instance, reader);
    return Promise.resolve();
  });
  registerErrorHandler(app);
  return app;
}

describe("GET /api/graph (GR-5)", () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    if (app !== undefined) await app.close();
    app = undefined;
  });

  it("GR-5.5: a viewer may read the graph (no operator-only gate)", async () => {
    const reader = new FakeGraphReader();
    app = buildApp(reader);

    const response = await injectAs(app, TEST_VIEWER, { method: "GET", url: "/api/graph" });

    expect(response.statusCode).toBe(200);
    const body = response.json<GraphResponse>();
    expect(body.nodes.map((n) => n.id).sort()).toEqual([APP_A, APP_B]);
    // GR-5.3 — each edge carries its full type/status/metadata; no second call needed.
    expect(body.edges).toHaveLength(1);
    const [serialized] = body.edges;
    expect(serialized?.type).toBe("sync");
    expect(serialized?.status).toBe("active");
    expect(serialized?.metadata.direction).toStrictEqual({
      sourceSpecId: "spec-a",
      targetSpecId: "spec-b",
    });
    expect(serialized?.metadata.lastActivityAt).toBe(ACTIVITY_AT.toISOString());
  });

  it("an operator may also read it (read-only for both roles)", async () => {
    app = buildApp(new FakeGraphReader());
    const response = await injectAs(app, TEST_OPERATOR, { method: "GET", url: "/api/graph" });
    expect(response.statusCode).toBe(200);
  });

  it("serializes a never-executed edge's lastActivityAt as null (GR-4.3)", async () => {
    const reader = new FakeGraphReader();
    reader.result = {
      nodes: [nodeApp(APP_A), nodeApp(APP_B)],
      edges: [{ ...syncEdge(), metadata: { ...syncEdge().metadata, lastActivityAt: null } }],
    };
    app = buildApp(reader);

    const response = await injectAs(app, TEST_VIEWER, { method: "GET", url: "/api/graph" });
    expect(response.json<GraphResponse>().edges[0]?.metadata.lastActivityAt).toBeNull();
  });

  it("GR-5.2: passes the app/status/type filter through to the service", async () => {
    const reader = new FakeGraphReader();
    app = buildApp(reader);

    const response = await injectAs(app, TEST_VIEWER, {
      method: "GET",
      url: `/api/graph?appId=${APP_A}&status=active&type=sync`,
    });

    expect(response.statusCode).toBe(200);
    expect(reader.calls).toStrictEqual([{ appId: APP_A, status: "active", type: "sync" }]);
  });

  it("passes an empty filter when no query is supplied", async () => {
    const reader = new FakeGraphReader();
    app = buildApp(reader);

    await injectAs(app, TEST_VIEWER, { method: "GET", url: "/api/graph" });

    expect(reader.calls).toStrictEqual([{}]);
  });

  it("rejects a malformed appId at the boundary (400), never reaching the service", async () => {
    const reader = new FakeGraphReader();
    app = buildApp(reader);

    const response = await injectAs(app, TEST_VIEWER, {
      method: "GET",
      url: "/api/graph?appId=not-a-uuid",
    });

    expect(response.statusCode).toBe(400);
    expect(reader.calls).toHaveLength(0);
  });

  it("an unauthenticated request is rejected (401), never reaching the service", async () => {
    const reader = new FakeGraphReader();
    app = buildApp(reader);

    const response = await app.inject({ method: "GET", url: "/api/graph" });

    expect(response.statusCode).toBe(401);
    expect(reader.calls).toHaveLength(0);
  });

  it("never leaks credential material or payload values", async () => {
    app = buildApp(new FakeGraphReader());
    const response = await injectAs(app, TEST_VIEWER, { method: "GET", url: "/api/graph" });
    expect(response.body).not.toMatch(/secret|password|credential|rawdocument|payload/i);
  });
});
