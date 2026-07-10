import type { RegisterAppResponse } from "@mediator/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { buildTestServer, type TestServer } from "../../testing/fake-persistence.testkit.js";
import { malformedDocument, providerSpecDocument } from "../../testing/sample-specs.testkit.js";

/**
 * Unit tests for the registration + browse routes (AR-1, AR-2), driven with
 * `fastify.inject()` over in-memory fakes and the real `buildIr`/orchestration.
 */
describe("POST /api/apps — registration (AR-1)", () => {
  let server: TestServer;
  afterEach(async () => {
    await server.app.close();
  });

  const apiKeyCredential = { secret: { type: "apiKey", apiKey: "s3cr3t-value" } };

  it("registers an app + PROVIDER spec and returns app + spec metadata with no secret", async () => {
    server = buildTestServer();
    const response = await server.app.inject({
      method: "POST",
      url: "/api/apps",
      payload: {
        name: "Gitea",
        baseUrl: "https://gitea.example",
        specs: [{ role: "PROVIDER", document: providerSpecDocument() }],
        credential: apiKeyCredential,
      },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json<RegisterAppResponse>();
    expect(body.app.name).toBe("Gitea");
    expect(body.app.status).toBe("active");
    expect(body.app.baseUrl).toBe("https://gitea.example");
    expect(body.specs).toHaveLength(1);
    expect(body.specs[0]?.role).toBe("PROVIDER");
    expect(body.specs[0]?.version).toBe(1);
    expect(body.specs[0]?.contentHash).toMatch(/^[0-9a-f]{64}$/);

    // Persistence effects: one app, one spec (v1), >=1 binding, one SpecIngested.
    expect(server.store.apps.size).toBe(1);
    expect(server.store.specs.size).toBe(1);
    expect(server.store.bindings.size).toBeGreaterThan(0);
    expect(server.store.events).toHaveLength(1);
    expect(server.store.events[0]?.type).toBe("SpecIngested");

    // Credential stored (metadata only); no secret anywhere in the response.
    expect(server.store.credentials).toEqual([
      { appId: body.app.id, type: "apiKey", scopeCount: 0 },
    ]);
    expect(response.body).not.toContain("s3cr3t-value");
    expect(response.body).not.toContain("encryptedPayload");
    expect(response.body).not.toContain("rawDocument");
  });

  it("rejects a spec that fails to parse with 400 and persists nothing (AR-1 crit 7)", async () => {
    server = buildTestServer();
    const response = await server.app.inject({
      method: "POST",
      url: "/api/apps",
      payload: {
        name: "Bad",
        baseUrl: "https://bad.example",
        specs: [
          { role: "PROVIDER", document: providerSpecDocument() },
          { role: "PROVIDER", document: malformedDocument() },
        ],
        credential: apiKeyCredential,
      },
    });

    expect(response.statusCode).toBe(400);
    // The orchestration never opened the transaction: no app, spec, binding,
    // credential, or event was created — parse-all-first (AR-1 crit 7).
    expect(server.store.apps.size).toBe(0);
    expect(server.store.specs.size).toBe(0);
    expect(server.store.bindings.size).toBe(0);
    expect(server.store.credentials).toHaveLength(0);
    expect(server.store.events).toHaveLength(0);
  });

  it("requires baseUrl when any spec is a PROVIDER (AR-1 crit 3, OQ1)", async () => {
    server = buildTestServer();
    const response = await server.app.inject({
      method: "POST",
      url: "/api/apps",
      payload: { name: "NoBase", specs: [{ role: "PROVIDER", document: providerSpecDocument() }] },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json<{ issues?: { path: string }[] }>().issues?.[0]?.path).toBe("baseUrl");
    expect(server.store.apps.size).toBe(0);
  });

  it("allows a consumer-only registration with no baseUrl (AR-1 crit 4)", async () => {
    server = buildTestServer();
    const response = await server.app.inject({
      method: "POST",
      url: "/api/apps",
      payload: {
        name: "ConsumerOnly",
        specs: [{ role: "CONSUMER", document: providerSpecDocument() }],
      },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json<RegisterAppResponse>();
    expect(body.app.baseUrl).toBeUndefined();
    expect(body.specs[0]?.role).toBe("CONSUMER");
  });

  it("defaults capabilities conservatively when omitted (AR-1 crit 2, OQ2)", async () => {
    server = buildTestServer(123456);
    const response = await server.app.inject({
      method: "POST",
      url: "/api/apps",
      payload: {
        name: "Defaults",
        baseUrl: "https://d.example",
        specs: [{ role: "PROVIDER", document: providerSpecDocument() }],
      },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json<RegisterAppResponse>();
    expect(body.app.capabilities).toEqual({
      supportsPolling: false,
      supportsDeltaQuery: false,
      supportsChangeTimestamps: false,
      defaultPollInterval: 123456,
    });
  });

  it("rejects a credential of type adapterToken (CR-1 crit 5)", async () => {
    server = buildTestServer();
    const response = await server.app.inject({
      method: "POST",
      url: "/api/apps",
      payload: {
        name: "AdapterToken",
        baseUrl: "https://a.example",
        specs: [{ role: "PROVIDER", document: providerSpecDocument() }],
        credential: { secret: { type: "adapterToken", token: "t" } },
      },
    });

    expect(response.statusCode).toBe(400);
    expect(server.store.apps.size).toBe(0);
    expect(server.store.credentials).toHaveLength(0);
  });

  it("rejects a request with no name (AR-1 crit 8)", async () => {
    server = buildTestServer();
    const response = await server.app.inject({
      method: "POST",
      url: "/api/apps",
      payload: {
        baseUrl: "https://x.example",
        specs: [{ role: "PROVIDER", document: providerSpecDocument() }],
      },
    });
    expect(response.statusCode).toBe(400);
  });

  it("rejects registration-time analysisExclusions referencing a non-IR resource (SI-4 crit 4)", async () => {
    server = buildTestServer();
    const response = await server.app.inject({
      method: "POST",
      url: "/api/apps",
      payload: {
        name: "BadExclusion",
        baseUrl: "https://x.example",
        specs: [
          {
            role: "PROVIDER",
            document: providerSpecDocument(),
            analysisExclusions: ["does-not-exist"],
          },
        ],
      },
    });
    expect(response.statusCode).toBe(400);
    // Atomic: nothing persisted when the exclusion is invalid.
    expect(server.store.apps.size).toBe(0);
    expect(server.store.specs.size).toBe(0);
    expect(server.store.events).toHaveLength(0);
  });
});

describe("GET /api/apps and /api/apps/:id/specs (AR-2)", () => {
  let server: TestServer;
  afterEach(async () => {
    await server.app.close();
  });

  async function register(name: string, role: "PROVIDER" | "CONSUMER"): Promise<string> {
    const response = await server.app.inject({
      method: "POST",
      url: "/api/apps",
      payload: {
        name,
        baseUrl: "https://x.example",
        specs: [{ role, document: providerSpecDocument() }],
      },
    });
    return response.json<RegisterAppResponse>().app.id;
  }

  it("lists all registered apps", async () => {
    server = buildTestServer();
    await register("A", "PROVIDER");
    await register("B", "PROVIDER");

    const response = await server.app.inject({ method: "GET", url: "/api/apps" });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ apps: unknown[] }>().apps).toHaveLength(2);
  });

  it("returns spec metadata (no rawDocument) for an app", async () => {
    server = buildTestServer();
    const appId = await register("A", "PROVIDER");

    const response = await server.app.inject({ method: "GET", url: `/api/apps/${appId}/specs` });
    expect(response.statusCode).toBe(200);
    const { specs } = response.json<{ specs: { role: string }[] }>();
    expect(specs).toHaveLength(1);
    expect(specs[0]?.role).toBe("PROVIDER");
    expect(response.body).not.toContain("rawDocument");
    expect(response.body).not.toContain("openapi");
  });

  it("404s the specs list for an unknown app (AR-2 crit 4)", async () => {
    server = buildTestServer();
    const response = await server.app.inject({
      method: "GET",
      url: "/api/apps/00000000-0000-0000-0000-000000000000/specs",
    });
    expect(response.statusCode).toBe(404);
  });

  it("returns the ErrorResponse envelope for an unmatched route", async () => {
    server = buildTestServer();
    const response = await server.app.inject({ method: "GET", url: "/api/does-not-exist" });
    expect(response.statusCode).toBe(404);
    expect(response.json<{ statusCode: number; error: string; message: string }>()).toEqual({
      statusCode: 404,
      error: "Not Found",
      message: "Route not found.",
    });
  });
});
