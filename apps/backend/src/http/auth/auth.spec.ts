import type { OperatorAccount } from "@mediator/config";
import { hashSecret } from "@mediator/credentials";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { registerErrorHandler } from "../errors.js";
import {
  getPrincipal,
  installAuthentication,
  LocalAccountsAuthProvider,
  requireOperator,
  requireViewer,
  type Principal,
} from "./index.js";

/**
 * Focused tests for the auth seam itself: the {@link LocalAccountsAuthProvider}
 * (Basic transport, salted-hash verification, no plaintext at rest), the OA-1
 * authentication hook, and the OA-2 role guards — exercised end to end through a
 * minimal Fastify app with two probe routes that echo the resolved principal.
 */

const OPERATOR = { username: "op", password: "op-secret-pw", role: "operator" as const };
const VIEWER = { username: "vw", password: "vw-secret-pw", role: "viewer" as const };

// Seeded accounts hold ONLY salted scrypt hashes — never plaintext (computed once).
const ACCOUNTS: readonly OperatorAccount[] = [
  {
    username: OPERATOR.username,
    role: "operator",
    passwordHash: await hashSecret(OPERATOR.password),
  },
  { username: VIEWER.username, role: "viewer", passwordHash: await hashSecret(VIEWER.password) },
];

function basic(username: string, password: string): { authorization: string } {
  return {
    authorization: `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`,
  };
}

function buildAuthApp(): FastifyInstance {
  const app = Fastify({ logger: false });
  registerErrorHandler(app);
  void app.register((instance) => {
    installAuthentication(instance, new LocalAccountsAuthProvider(ACCOUNTS));
    instance.get("/read", { preHandler: requireViewer }, (request) => getPrincipal(request));
    instance.post("/write", { preHandler: requireOperator }, (request) => getPrincipal(request));
    return Promise.resolve();
  });
  return app;
}

describe("LocalAccountsAuthProvider (local-accounts seam)", () => {
  it("stores passwords only as a salted scrypt hash, never plaintext", () => {
    for (const account of ACCOUNTS) {
      expect(account.passwordHash.startsWith("scrypt$")).toBe(true);
      expect(account.passwordHash).not.toContain(OPERATOR.password);
      expect(account.passwordHash).not.toContain(VIEWER.password);
    }
  });
});

describe("authentication hook (OA-1)", () => {
  let app: FastifyInstance;
  afterEach(async () => {
    await app.close();
  });

  it("rejects a request with no Authorization header as 401", async () => {
    app = buildAuthApp();
    const response = await app.inject({ method: "GET", url: "/read" });
    expect(response.statusCode).toBe(401);
    expect(response.json<{ statusCode: number; error: string }>()).toMatchObject({
      statusCode: 401,
      error: "Unauthorized",
    });
  });

  it("rejects a wrong password as 401", async () => {
    app = buildAuthApp();
    const response = await app.inject({
      method: "GET",
      url: "/read",
      headers: basic(OPERATOR.username, "not-the-password"),
    });
    expect(response.statusCode).toBe(401);
  });

  it("rejects an unknown username as 401", async () => {
    app = buildAuthApp();
    const response = await app.inject({
      method: "GET",
      url: "/read",
      headers: basic("nobody", "whatever"),
    });
    expect(response.statusCode).toBe(401);
  });

  it("rejects a malformed Basic value (no colon) as 401", async () => {
    app = buildAuthApp();
    const response = await app.inject({
      method: "GET",
      url: "/read",
      headers: { authorization: `Basic ${Buffer.from("nocolonhere", "utf8").toString("base64")}` },
    });
    expect(response.statusCode).toBe(401);
  });

  it("resolves a valid credential to its principal (identity + role)", async () => {
    app = buildAuthApp();
    const response = await app.inject({
      method: "GET",
      url: "/read",
      headers: basic(OPERATOR.username, OPERATOR.password),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<Principal>()).toEqual({ identity: "op", role: "operator" });
  });
});

describe("role guards (OA-2)", () => {
  let app: FastifyInstance;
  afterEach(async () => {
    await app.close();
  });

  it("lets a viewer read", async () => {
    app = buildAuthApp();
    const response = await app.inject({
      method: "GET",
      url: "/read",
      headers: basic(VIEWER.username, VIEWER.password),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<Principal>()).toEqual({ identity: "vw", role: "viewer" });
  });

  it("forbids a viewer from a mutation as 403", async () => {
    app = buildAuthApp();
    const response = await app.inject({
      method: "POST",
      url: "/write",
      headers: basic(VIEWER.username, VIEWER.password),
    });
    expect(response.statusCode).toBe(403);
    expect(response.json<{ error: string }>().error).toBe("Forbidden");
  });

  it("lets an operator perform a mutation", async () => {
    app = buildAuthApp();
    const response = await app.inject({
      method: "POST",
      url: "/write",
      headers: basic(OPERATOR.username, OPERATOR.password),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<Principal>()).toEqual({ identity: "op", role: "operator" });
  });
});

describe("encapsulation — unauthenticated sibling routes", () => {
  let app: FastifyInstance;
  afterEach(async () => {
    await app.close();
  });

  it("leaves a root-context route reachable without auth while gating the encapsulated API", async () => {
    // Mirrors the composition root: `/health` lives on the root context, the
    // operator API is mounted inside an authenticated child — so a probe reaches
    // health unauthenticated while the API still demands an identity.
    app = Fastify({ logger: false });
    registerErrorHandler(app);
    app.get("/health", () => ({ status: "ok" }));
    void app.register((instance) => {
      installAuthentication(instance, new LocalAccountsAuthProvider(ACCOUNTS));
      instance.get("/api/thing", { preHandler: requireViewer }, (request) => getPrincipal(request));
      return Promise.resolve();
    });

    const health = await app.inject({ method: "GET", url: "/health" });
    expect(health.statusCode).toBe(200);

    const api = await app.inject({ method: "GET", url: "/api/thing" });
    expect(api.statusCode).toBe(401);
  });
});
