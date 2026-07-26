import type {
  AppLifecycleTransitionResponse,
  DeregisterAppResponse,
  RegisterAppResponse,
} from "@mediator/contracts";
import { afterEach, describe, expect, it } from "vitest";

import {
  injectAs,
  TEST_OPERATOR,
  TEST_OPERATOR_ALICE,
  TEST_VIEWER,
} from "../../testing/auth.testkit.js";
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
    const response = await injectAs(server.app, TEST_OPERATOR, {
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
    const response = await injectAs(server.app, TEST_OPERATOR, {
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
    const response = await injectAs(server.app, TEST_OPERATOR, {
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
    const response = await injectAs(server.app, TEST_OPERATOR, {
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
    const response = await injectAs(server.app, TEST_OPERATOR, {
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
    const response = await injectAs(server.app, TEST_OPERATOR, {
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
    const response = await injectAs(server.app, TEST_OPERATOR, {
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
    const response = await injectAs(server.app, TEST_OPERATOR, {
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
    const response = await injectAs(server.app, TEST_OPERATOR, {
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

    const response = await injectAs(server.app, TEST_OPERATOR, { method: "GET", url: "/api/apps" });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ apps: unknown[] }>().apps).toHaveLength(2);
  });

  it("returns spec metadata (no rawDocument) for an app", async () => {
    server = buildTestServer();
    const appId = await register("A", "PROVIDER");

    const response = await injectAs(server.app, TEST_OPERATOR, {
      method: "GET",
      url: `/api/apps/${appId}/specs`,
    });
    expect(response.statusCode).toBe(200);
    const { specs } = response.json<{ specs: { role: string }[] }>();
    expect(specs).toHaveLength(1);
    expect(specs[0]?.role).toBe("PROVIDER");
    expect(response.body).not.toContain("rawDocument");
    expect(response.body).not.toContain("openapi");
  });

  it("404s the specs list for an unknown app (AR-2 crit 4)", async () => {
    server = buildTestServer();
    const response = await injectAs(server.app, TEST_OPERATOR, {
      method: "GET",
      url: "/api/apps/00000000-0000-0000-0000-000000000000/specs",
    });
    expect(response.statusCode).toBe(404);
  });

  it("returns the ErrorResponse envelope for an unmatched route", async () => {
    server = buildTestServer();
    const response = await injectAs(server.app, TEST_OPERATOR, {
      method: "GET",
      url: "/api/does-not-exist",
    });
    expect(response.statusCode).toBe(404);
    expect(response.json<{ statusCode: number; error: string; message: string }>()).toEqual({
      statusCode: 404,
      error: "Not Found",
      message: "Route not found.",
    });
  });
});

/**
 * AL-1 route tests — the reversible disable/enable surface, driven with
 * `fastify.inject()` through the **real** operator-auth path (OA-1/OA-2) and the real
 * `AppLifecycleService` over the in-memory `TxStores`. They assert the HTTP contract (the
 * role gate, the actor attribution, how the service's transition errors surface) together
 * with the persistence effects the transition is supposed to have — and, just as
 * important, the ones it must not have.
 */
describe("POST /api/apps/:id/disable | /enable — app lifecycle (AL-1)", () => {
  let server: TestServer;
  afterEach(async () => {
    await server.app.close();
  });

  async function registerApp(name = "Gitea"): Promise<string> {
    const response = await injectAs(server.app, TEST_OPERATOR, {
      method: "POST",
      url: "/api/apps",
      payload: {
        name,
        baseUrl: "https://gitea.example",
        specs: [{ role: "PROVIDER", document: providerSpecDocument() }],
      },
    });
    return response.json<RegisterAppResponse>().app.id;
  }

  it("AL-1.1: an operator disables an active app; the response carries its new status", async () => {
    server = buildTestServer();
    const appId = await registerApp();

    const response = await injectAs(server.app, TEST_OPERATOR, {
      method: "POST",
      url: `/api/apps/${appId}/disable`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<AppLifecycleTransitionResponse>().app).toMatchObject({
      id: appId,
      status: "disabled",
    });
    expect(server.store.apps.get(appId)?.status).toBe("disabled");
    // No credential material, ever (AR-1 crit 10).
    expect(response.body).not.toContain("encryptedPayload");
  });

  it("AL-1.3: re-enabling lifts the condition and returns the app active again", async () => {
    server = buildTestServer();
    const appId = await registerApp();
    await injectAs(server.app, TEST_OPERATOR, {
      method: "POST",
      url: `/api/apps/${appId}/disable`,
    });

    const response = await injectAs(server.app, TEST_OPERATOR, {
      method: "POST",
      url: `/api/apps/${appId}/enable`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<AppLifecycleTransitionResponse>().app.status).toBe("active");
    expect(server.store.apps.get(appId)?.status).toBe("active");
  });

  it("AL-1.4: each transition is attributed to the AUTHENTICATED operator in the audit log", async () => {
    server = buildTestServer();
    const appId = await registerApp();

    await injectAs(server.app, TEST_OPERATOR_ALICE, {
      method: "POST",
      url: `/api/apps/${appId}/disable`,
    });
    await injectAs(server.app, TEST_OPERATOR, {
      method: "POST",
      url: `/api/apps/${appId}/enable`,
    });

    const lifecycleRows = server.store.auditLog.filter((entry) => entry.originAppId === appId);
    expect(lifecycleRows.map((entry) => entry.actor)).toEqual([
      TEST_OPERATOR_ALICE.username,
      TEST_OPERATOR.username,
    ]);
  });

  it("AL-1.4: a viewer is rejected 403 on BOTH transitions and nothing is mutated", async () => {
    server = buildTestServer();
    const appId = await registerApp();

    const disable = await injectAs(server.app, TEST_VIEWER, {
      method: "POST",
      url: `/api/apps/${appId}/disable`,
    });
    expect(disable.statusCode).toBe(403);
    expect(server.store.apps.get(appId)?.status).toBe("active");
    expect(server.store.auditLog.filter((entry) => entry.originAppId === appId)).toHaveLength(0);

    // And the same for enable, from a genuinely disabled starting state.
    await injectAs(server.app, TEST_OPERATOR, {
      method: "POST",
      url: `/api/apps/${appId}/disable`,
    });
    const enable = await injectAs(server.app, TEST_VIEWER, {
      method: "POST",
      url: `/api/apps/${appId}/enable`,
    });
    expect(enable.statusCode).toBe(403);
    expect(server.store.apps.get(appId)?.status).toBe("disabled");
  });

  it("409s an illegal transition (disabling an already-disabled app)", async () => {
    server = buildTestServer();
    const appId = await registerApp();
    await injectAs(server.app, TEST_OPERATOR, {
      method: "POST",
      url: `/api/apps/${appId}/disable`,
    });

    const response = await injectAs(server.app, TEST_OPERATOR, {
      method: "POST",
      url: `/api/apps/${appId}/disable`,
    });
    expect(response.statusCode).toBe(409);
    expect(response.json<{ message: string }>().message).toContain(
      "only an active app can be disabled",
    );
  });

  it("404s an unknown app and 400s a malformed id", async () => {
    server = buildTestServer();

    const unknown = await injectAs(server.app, TEST_OPERATOR, {
      method: "POST",
      url: "/api/apps/00000000-0000-0000-0000-000000000000/disable",
    });
    expect(unknown.statusCode).toBe(404);

    const malformed = await injectAs(server.app, TEST_OPERATOR, {
      method: "POST",
      url: "/api/apps/not-a-uuid/disable",
    });
    expect(malformed.statusCode).toBe(400);
  });
});

/**
 * AL-2 route tests — the **destructive, confirmed** deregistration surface. The cascade
 * itself is covered in `modules/app-deregistration.spec.ts`; these pin the HTTP contract:
 * the `operator` gate (AL-2.8), the confirmation requirement (AL-2.1) — including that a
 * **bare** `POST` cannot deregister anything — and that the response carries the cascade
 * summary and no credential material.
 */
describe("POST /api/apps/:id/deregister — app lifecycle (AL-2)", () => {
  let server: TestServer;
  afterEach(async () => {
    await server.app.close();
  });

  const APP_NAME = "Gitea";

  async function registerApp(): Promise<string> {
    const response = await injectAs(server.app, TEST_OPERATOR, {
      method: "POST",
      url: "/api/apps",
      payload: {
        name: APP_NAME,
        baseUrl: "https://gitea.example",
        specs: [{ role: "PROVIDER", document: providerSpecDocument() }],
        credential: { secret: { type: "apiKey", apiKey: "s3cr3t-value" } },
      },
    });
    return response.json<RegisterAppResponse>().app.id;
  }

  it("AL-2.1: a BARE POST (no body) is rejected 400 and deregisters nothing", async () => {
    server = buildTestServer();
    const appId = await registerApp();

    const response = await injectAs(server.app, TEST_OPERATOR, {
      method: "POST",
      url: `/api/apps/${appId}/deregister`,
    });

    expect(response.statusCode).toBe(400);
    // Not a single cascade effect: the credential is still stored, the spec still active.
    expect(server.store.credentials).toHaveLength(1);
    expect([...server.store.specs.values()][0]?.status).toBe("active");
    expect(server.store.auditLog.filter((entry) => entry.originAppId === appId)).toHaveLength(0);
  });

  it("AL-2.1: a body with the WRONG confirmation is rejected 400 and deregisters nothing", async () => {
    server = buildTestServer();
    const appId = await registerApp();

    const response = await injectAs(server.app, TEST_OPERATOR, {
      method: "POST",
      url: `/api/apps/${appId}/deregister`,
      payload: { confirm: "gitea" },
    });

    expect(response.statusCode).toBe(400);
    expect(server.store.credentials).toHaveLength(1);
  });

  it("AL-2.8: a viewer is rejected 403 BEFORE the handler runs — no cascade starts", async () => {
    server = buildTestServer();
    const appId = await registerApp();

    const response = await injectAs(server.app, TEST_VIEWER, {
      method: "POST",
      url: `/api/apps/${appId}/deregister`,
      payload: { confirm: APP_NAME },
    });

    expect(response.statusCode).toBe(403);
    expect(server.store.apps.get(appId)?.status).toBe("active");
    expect(server.store.credentials).toHaveLength(1);
    expect(server.store.auditLog.filter((entry) => entry.originAppId === appId)).toHaveLength(0);
  });

  it("deregisters on a correct confirmation, returns the cascade summary, and audits the operator", async () => {
    server = buildTestServer();
    const appId = await registerApp();

    const response = await injectAs(server.app, TEST_OPERATOR_ALICE, {
      method: "POST",
      url: `/api/apps/${appId}/deregister`,
      payload: { confirm: APP_NAME },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<DeregisterAppResponse>();
    // The row is RETAINED (archived specs still reference it) and out of service.
    expect(body.app).toMatchObject({ id: appId, status: "disabled" });
    expect(body.cascade).toMatchObject({ apiSpecsArchived: 1, credentialsDeleted: 1 });
    expect(server.store.credentials).toHaveLength(0);
    expect([...server.store.specs.values()][0]?.status).toBe("archived");

    const rows = server.store.auditLog.filter((entry) => entry.originAppId === appId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.actor).toBe(TEST_OPERATOR_ALICE.username);
    expect(rows[0]?.details).toContain("deregistered by operator");

    // No credential material anywhere in the response (AR-1 crit 10).
    expect(response.body).not.toContain("s3cr3t-value");
    expect(response.body).not.toContain("encryptedPayload");
  });

  it("404s an unknown app and 400s a malformed id", async () => {
    server = buildTestServer();

    const unknown = await injectAs(server.app, TEST_OPERATOR, {
      method: "POST",
      url: "/api/apps/00000000-0000-0000-0000-000000000000/deregister",
      payload: { confirm: "whatever" },
    });
    expect(unknown.statusCode).toBe(404);

    const malformed = await injectAs(server.app, TEST_OPERATOR, {
      method: "POST",
      url: "/api/apps/not-a-uuid/deregister",
      payload: { confirm: "whatever" },
    });
    expect(malformed.statusCode).toBe(400);
  });
});
