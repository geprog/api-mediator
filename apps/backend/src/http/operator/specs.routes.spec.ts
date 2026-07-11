import type { IrResponse, PreviewParseResponse, RegisterAppResponse } from "@mediator/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildTestServer, type TestServer } from "../../testing/fake-persistence.testkit.js";
import { providerSpecDocument } from "../../testing/sample-specs.testkit.js";

async function registerProvider(server: TestServer): Promise<RegisterAppResponse> {
  const response = await server.app.inject({
    method: "POST",
    url: "/api/apps",
    payload: {
      name: "Gitea",
      baseUrl: "https://gitea.example",
      specs: [{ role: "PROVIDER", document: providerSpecDocument(), analysisExclusions: [] }],
    },
  });
  return response.json<RegisterAppResponse>();
}

describe("GET /api/specs/:id/ir (SI-3)", () => {
  let server: TestServer;
  afterEach(async () => {
    await server.app.close();
  });

  it("returns the parsed IR of a stored spec", async () => {
    server = buildTestServer();
    const registered = await registerProvider(server);
    const specId = registered.specs[0]?.id ?? "";

    const response = await server.app.inject({ method: "GET", url: `/api/specs/${specId}/ir` });
    expect(response.statusCode).toBe(200);
    const body = response.json<IrResponse>();
    expect(body.apiSpecId).toBe(specId);
    expect(body.ir.some((group) => group.resourceRef === "issues")).toBe(true);
  });

  it("404s a well-formed but unknown spec id", async () => {
    server = buildTestServer();
    const response = await server.app.inject({
      method: "GET",
      url: "/api/specs/00000000-0000-0000-0000-000000000000/ir",
    });
    expect(response.statusCode).toBe(404);
  });

  it("400s a malformed (non-UUID) spec id at the validation boundary", async () => {
    server = buildTestServer();
    const response = await server.app.inject({ method: "GET", url: "/api/specs/not-a-uuid/ir" });
    expect(response.statusCode).toBe(400);
  });
});

describe("PATCH /api/specs/:id/analysis-exclusions (SI-4)", () => {
  let server: TestServer;
  afterEach(async () => {
    await server.app.close();
  });

  it("replaces the exclusion list with a valid resourceRef", async () => {
    server = buildTestServer();
    const registered = await registerProvider(server);
    const specId = registered.specs[0]?.id ?? "";

    const response = await server.app.inject({
      method: "PATCH",
      url: `/api/specs/${specId}/analysis-exclusions`,
      payload: { analysisExclusions: ["issues"] },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ analysisExclusions: string[] }>().analysisExclusions).toEqual([
      "issues",
    ]);
    expect(server.store.specs.get(specId)?.analysisExclusions).toEqual(["issues"]);
  });

  it("rejects a resourceRef not in the spec's IR (SI-4 crit 4)", async () => {
    server = buildTestServer();
    const registered = await registerProvider(server);
    const specId = registered.specs[0]?.id ?? "";

    const response = await server.app.inject({
      method: "PATCH",
      url: `/api/specs/${specId}/analysis-exclusions`,
      payload: { analysisExclusions: ["does-not-exist"] },
    });
    expect(response.statusCode).toBe(400);
    expect(server.store.specs.get(specId)?.analysisExclusions).toEqual([]);
  });
});

describe("POST /api/specs/preview (AR-3/SI-4)", () => {
  let server: TestServer;
  afterEach(async () => {
    vi.restoreAllMocks();
    await server.app.close();
  });

  it("returns IR + resource groups without persisting anything", async () => {
    server = buildTestServer();
    const response = await server.app.inject({
      method: "POST",
      url: "/api/specs/preview",
      payload: { document: providerSpecDocument() },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<PreviewParseResponse>();
    expect(body.resourceGroups.some((group) => group.resourceRef === "issues")).toBe(true);
    // Stateless: no RegisteredApp / ApiSpec / binding / event created.
    expect(server.store.apps.size).toBe(0);
    expect(server.store.specs.size).toBe(0);
    expect(server.store.bindings.size).toBe(0);
    expect(server.store.events).toHaveLength(0);
  });

  it("400s an unparseable document", async () => {
    server = buildTestServer();
    const response = await server.app.inject({
      method: "POST",
      url: "/api/specs/preview",
      payload: { document: { not: "openapi" } },
    });
    expect(response.statusCode).toBe(400);
  });

  it("does not fetch an external $ref while previewing (egress hardening)", async () => {
    server = buildTestServer();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const document = {
      openapi: "3.0.0",
      info: { title: "ext", version: "1" },
      paths: {
        "/things": {
          get: {
            operationId: "listThings",
            tags: ["thing"],
            responses: {
              "200": {
                description: "ok",
                content: {
                  "application/json": {
                    schema: { $ref: "http://169.254.169.254/latest/meta-data#/Secret" },
                  },
                },
              },
            },
          },
        },
      },
    };

    const response = await server.app.inject({
      method: "POST",
      url: "/api/specs/preview",
      payload: { document },
    });

    expect(response.statusCode).toBe(200);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(response.body).not.toContain("169.254.169.254");
  });
});
