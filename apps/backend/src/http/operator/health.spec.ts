import Fastify from "fastify";
import { describe, expect, it } from "vitest";

import { registerHealthRoute } from "./health.js";

/**
 * Unit tests for `GET /health` using `fastify.inject()` and a fake DB ping — no
 * real Postgres, so they run in the default `pnpm verify` suite. The live-DB
 * variant lives in `server.integration.spec.ts`.
 */
describe("GET /health", () => {
  it("returns 200 and db: up when the ping resolves", async () => {
    const app = Fastify({ logger: false });
    registerHealthRoute(app, { pingDb: () => Promise.resolve() });

    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok", db: "up" });

    await app.close();
  });

  it("returns 503 and db: down when the ping rejects", async () => {
    const app = Fastify({ logger: false });
    registerHealthRoute(app, {
      pingDb: () => Promise.reject(new Error("connection refused")),
    });

    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: "error", db: "down" });

    await app.close();
  });

  it("never leaks the ping failure detail into the response body", async () => {
    const app = Fastify({ logger: false });
    registerHealthRoute(app, {
      pingDb: () => Promise.reject(new Error('password authentication failed for user "mediator"')),
    });

    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.body).not.toContain("password");
    expect(response.json()).toEqual({ status: "error", db: "down" });

    await app.close();
  });
});
