import type { SessionResponse } from "@mediator/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { injectAs, TEST_OPERATOR, TEST_VIEWER } from "../../testing/auth.testkit.js";
import { buildTestServer, type TestServer } from "../../testing/fake-persistence.testkit.js";

/**
 * Route tests for `GET /api/session` — the role probe the SPA uses to render the
 * review screen read-only for a `viewer` up front. Driven with `fastify.inject()`
 * through the real auth path (OA-1/OA-2), same harness as the RA routes.
 */
describe("GET /api/session", () => {
  let server: TestServer;
  afterEach(async () => {
    await server.app.close();
  });

  it("rejects an unauthenticated probe with 401", async () => {
    server = buildTestServer();
    const response = await server.app.inject({ method: "GET", url: "/api/session" });
    expect(response.statusCode).toBe(401);
  });

  it("resolves an operator's identity and role", async () => {
    server = buildTestServer();
    const response = await injectAs(server.app, TEST_OPERATOR, {
      method: "GET",
      url: "/api/session",
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<SessionResponse>()).toEqual({ identity: "operator", role: "operator" });
  });

  it("resolves a viewer's identity and role", async () => {
    server = buildTestServer();
    const response = await injectAs(server.app, TEST_VIEWER, {
      method: "GET",
      url: "/api/session",
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<SessionResponse>()).toEqual({ identity: "viewer", role: "viewer" });
  });
});
