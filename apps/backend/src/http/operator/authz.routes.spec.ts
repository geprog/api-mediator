import type { RegisterAppResponse, ResourceBindingsResponse } from "@mediator/contracts";
import { afterEach, describe, expect, it } from "vitest";

import {
  authHeaders,
  injectAs,
  operatorHeaders,
  TEST_OPERATOR,
  TEST_VIEWER,
  viewerHeaders,
} from "../../testing/auth.testkit.js";
import { buildTestServer, type TestServer } from "../../testing/fake-persistence.testkit.js";
import { providerSpecDocument } from "../../testing/sample-specs.testkit.js";

/**
 * Operator-API authentication & authorization gating (OA-1, OA-2, OA-3), driven
 * against the *real* Phase-1/2 routes over in-memory fakes. Proves the read/mutate
 * split the earlier phases declared is now enforced: no unauthenticated access,
 * `viewer` may read but not mutate, `operator` may mutate, and a mutation is
 * attributed to the authenticated identity.
 */

const REGISTRATION_PAYLOAD = {
  name: "Gitea",
  baseUrl: "https://gitea.example",
  specs: [{ role: "PROVIDER" as const, document: providerSpecDocument() }],
};

describe("OA-1 — no unauthenticated operator-API access", () => {
  let server: TestServer;
  afterEach(async () => {
    await server.app.close();
  });

  it("rejects a mutation with no credentials as 401 and mutates nothing", async () => {
    server = buildTestServer();
    const response = await server.app.inject({
      method: "POST",
      url: "/api/apps",
      payload: REGISTRATION_PAYLOAD,
    });

    expect(response.statusCode).toBe(401);
    expect(response.json<{ statusCode: number; error: string }>().error).toBe("Unauthorized");
    // No handler side effect ran (OA-1 crit 1).
    expect(server.store.apps.size).toBe(0);
    expect(server.store.events).toHaveLength(0);
  });

  it("rejects a read with no credentials as 401", async () => {
    server = buildTestServer();
    const response = await server.app.inject({ method: "GET", url: "/api/apps" });
    expect(response.statusCode).toBe(401);
  });

  it("rejects invalid credentials (bad password) as 401", async () => {
    server = buildTestServer();
    const response = await server.app.inject({
      method: "GET",
      url: "/api/apps",
      headers: authHeaders({ ...TEST_OPERATOR, password: "wrong-password" }),
    });
    expect(response.statusCode).toBe(401);
  });

  it("rejects an unknown username as 401", async () => {
    server = buildTestServer();
    const response = await server.app.inject({
      method: "GET",
      url: "/api/apps",
      headers: authHeaders({ username: "ghost", password: "whatever", role: "operator" }),
    });
    expect(response.statusCode).toBe(401);
  });

  it("rejects a non-Basic Authorization scheme as 401", async () => {
    server = buildTestServer();
    const response = await server.app.inject({
      method: "GET",
      url: "/api/apps",
      headers: { authorization: "Bearer some.jwt.token" },
    });
    expect(response.statusCode).toBe(401);
  });
});

describe("OA-2 — operator vs. viewer route gating", () => {
  let server: TestServer;
  afterEach(async () => {
    await server.app.close();
  });

  it("allows a viewer to read (GET /api/apps)", async () => {
    server = buildTestServer();
    const response = await server.app.inject({
      method: "GET",
      url: "/api/apps",
      headers: viewerHeaders(),
    });
    expect(response.statusCode).toBe(200);
  });

  it("forbids a viewer from mutating (POST /api/apps) as 403 and mutates nothing", async () => {
    server = buildTestServer();
    const response = await injectAs(server.app, TEST_VIEWER, {
      method: "POST",
      url: "/api/apps",
      payload: REGISTRATION_PAYLOAD,
    });

    expect(response.statusCode).toBe(403);
    expect(response.json<{ error: string }>().error).toBe("Forbidden");
    // Nothing mutated (OA-2 crit 2).
    expect(server.store.apps.size).toBe(0);
    expect(server.store.events).toHaveLength(0);
  });

  it("allows an operator to mutate (POST /api/apps)", async () => {
    server = buildTestServer();
    const response = await injectAs(server.app, TEST_OPERATOR, {
      method: "POST",
      url: "/api/apps",
      payload: REGISTRATION_PAYLOAD,
    });

    expect(response.statusCode).toBe(201);
    expect(server.store.apps.size).toBe(1);
  });

  it("forbids a viewer from confirming a ResourceBinding (403, nothing mutated)", async () => {
    server = buildTestServer();
    const bindingId = await registerAndFirstBindingId(server);

    const before = server.store.bindings.get(bindingId);
    const response = await injectAs(server.app, TEST_VIEWER, {
      method: "PATCH",
      url: `/api/resource-bindings/${bindingId}`,
      payload: { refKind: "nativeIdRef" },
    });

    expect(response.statusCode).toBe(403);
    // The binding row is untouched.
    expect(server.store.bindings.get(bindingId)).toEqual(before);
  });
});

describe("OA-3 — mutations attributed to the authenticated identity", () => {
  let server: TestServer;
  afterEach(async () => {
    await server.app.close();
  });

  it("stamps confirmedBy with the authenticated operator's identity", async () => {
    server = buildTestServer();
    const bindingId = await registerAndFirstBindingId(server);

    const response = await injectAs(server.app, TEST_OPERATOR, {
      method: "PATCH",
      url: `/api/resource-bindings/${bindingId}`,
      payload: { refKind: "nativeIdRef" },
    });

    expect(response.statusCode).toBe(200);
    const nativeId = server.store.bindings.get(bindingId)?.nativeIdRef;
    expect(nativeId?.confirmedBy).toBe(TEST_OPERATOR.username);
    expect(nativeId?.confirmedAt).not.toBeNull();
  });
});

/** Register an app as operator and return the `issues` binding's id. */
async function registerAndFirstBindingId(server: TestServer): Promise<string> {
  const registration = await injectAs(server.app, TEST_OPERATOR, {
    method: "POST",
    url: "/api/apps",
    payload: {
      name: "Gitea",
      baseUrl: "https://gitea.example",
      capabilities: {
        supportsPolling: true,
        supportsDeltaQuery: false,
        supportsChangeTimestamps: true,
        defaultPollInterval: 60000,
      },
      specs: [{ role: "PROVIDER" as const, document: providerSpecDocument() }],
    },
  });
  const specId = registration.json<RegisterAppResponse>().specs[0]?.id ?? "";
  const bindingsResponse = await server.app.inject({
    method: "GET",
    url: `/api/specs/${specId}/resource-bindings`,
    headers: operatorHeaders(),
  });
  const { bindings } = bindingsResponse.json<ResourceBindingsResponse>();
  const issues = bindings.find((binding) => binding.resourceRef === "issues");
  if (issues === undefined) {
    throw new Error("issues binding not found");
  }
  return issues.id;
}
