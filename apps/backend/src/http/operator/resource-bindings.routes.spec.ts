import type {
  RegisterAppResponse,
  ResourceBindingDto,
  ResourceBindingsResponse,
  UpdateResourceBindingResponse,
} from "@mediator/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { buildTestServer, type TestServer } from "../../testing/fake-persistence.testkit.js";
import { providerSpecDocument } from "../../testing/sample-specs.testkit.js";

const CAPS_WITH_TIMESTAMPS = {
  supportsPolling: true,
  supportsDeltaQuery: false,
  supportsChangeTimestamps: true,
  defaultPollInterval: 60000,
};

async function registerAndGetBindings(server: TestServer): Promise<{
  specId: string;
  bindings: ResourceBindingDto[];
}> {
  const registration = await server.app.inject({
    method: "POST",
    url: "/api/apps",
    payload: {
      name: "Gitea",
      baseUrl: "https://gitea.example",
      capabilities: CAPS_WITH_TIMESTAMPS,
      specs: [{ role: "PROVIDER", document: providerSpecDocument() }],
    },
  });
  const specId = registration.json<RegisterAppResponse>().specs[0]?.id ?? "";
  const bindingsResponse = await server.app.inject({
    method: "GET",
    url: `/api/specs/${specId}/resource-bindings`,
  });
  return { specId, bindings: bindingsResponse.json<ResourceBindingsResponse>().bindings };
}

function bindingId(bindings: ResourceBindingDto[]): string {
  const issue = bindings.find((binding) => binding.resourceRef === "issue");
  if (issue === undefined) throw new Error("issue binding not found");
  return issue.id;
}

describe("GET /api/specs/:id/resource-bindings (RB-3)", () => {
  let server: TestServer;
  afterEach(async () => {
    await server.app.close();
  });

  it("reports each ref's value + applicability + confirmed state", async () => {
    server = buildTestServer();
    const { bindings } = await registerAndGetBindings(server);
    const issue = bindings.find((binding) => binding.resourceRef === "issue");
    expect(issue).toBeDefined();

    const nativeId = issue?.refs.find((ref) => ref.kind === "nativeIdRef");
    expect(nativeId?.applicable).toBe(true);
    expect(nativeId?.value).toEqual({ kind: "field", path: "id" });
    expect(nativeId?.confirmedBy).toBeNull();

    // supportsChangeTimestamps=true → changeTimestampRef is applicable + derived.
    const changeTs = issue?.refs.find((ref) => ref.kind === "changeTimestampRef");
    expect(changeTs?.applicable).toBe(true);
    expect(changeTs?.value).toEqual({ kind: "field", path: "updated" });

    // supportsDeltaQuery=false → delta refs are not applicable.
    const deltaCursor = issue?.refs.find((ref) => ref.kind === "deltaCursorRef");
    expect(deltaCursor?.applicable).toBe(false);
  });
});

describe("PATCH /api/resource-bindings/:id (RB-2)", () => {
  let server: TestServer;
  afterEach(async () => {
    await server.app.close();
  });

  it("confirms a ref, stamping confirmedBy (stub identity) + confirmedAt", async () => {
    server = buildTestServer();
    const { bindings } = await registerAndGetBindings(server);

    const response = await server.app.inject({
      method: "PATCH",
      url: `/api/resource-bindings/${bindingId(bindings)}`,
      payload: { refKind: "nativeIdRef" },
    });

    expect(response.statusCode).toBe(200);
    const updated = response.json<UpdateResourceBindingResponse>();
    const nativeId = updated.refs.find((ref) => ref.kind === "nativeIdRef");
    expect(nativeId?.confirmedBy).toBe("operator");
    expect(nativeId?.confirmedAt).not.toBeNull();
    // Per-ref: confirming nativeIdRef leaves collectionReadRef unconfirmed.
    expect(updated.refs.find((ref) => ref.kind === "collectionReadRef")?.confirmedBy).toBeNull();
  });

  it("honors the x-operator-id header for confirmedBy (Phase-3 stub seam)", async () => {
    server = buildTestServer();
    const { bindings } = await registerAndGetBindings(server);

    const response = await server.app.inject({
      method: "PATCH",
      url: `/api/resource-bindings/${bindingId(bindings)}`,
      headers: { "x-operator-id": "alice" },
      payload: { refKind: "nativeIdRef" },
    });

    const updated = response.json<UpdateResourceBindingResponse>();
    expect(updated.refs.find((ref) => ref.kind === "nativeIdRef")?.confirmedBy).toBe("alice");
  });

  it("corrects a ref to a different IR field and confirms it in one action", async () => {
    server = buildTestServer();
    const { bindings } = await registerAndGetBindings(server);

    const response = await server.app.inject({
      method: "PATCH",
      url: `/api/resource-bindings/${bindingId(bindings)}`,
      payload: { refKind: "nativeIdRef", value: { kind: "field", path: "title" } },
    });

    expect(response.statusCode).toBe(200);
    const nativeId = response
      .json<UpdateResourceBindingResponse>()
      .refs.find((ref) => ref.kind === "nativeIdRef");
    expect(nativeId?.value).toEqual({ kind: "field", path: "title" });
    expect(nativeId?.confirmedBy).toBe("operator");
  });

  it("rejects a correction naming a field not in the resource's IR (RB-2 crit 4)", async () => {
    server = buildTestServer();
    const { bindings } = await registerAndGetBindings(server);

    const response = await server.app.inject({
      method: "PATCH",
      url: `/api/resource-bindings/${bindingId(bindings)}`,
      payload: { refKind: "nativeIdRef", value: { kind: "field", path: "does-not-exist" } },
    });
    expect(response.statusCode).toBe(400);
  });

  it("rejects confirming a not-meaningful ref (RB-2 crit 5)", async () => {
    server = buildTestServer();
    // supportsDeltaQuery=false → deltaCursorRef is not applicable.
    const { bindings } = await registerAndGetBindings(server);

    const response = await server.app.inject({
      method: "PATCH",
      url: `/api/resource-bindings/${bindingId(bindings)}`,
      payload: { refKind: "deltaCursorRef" },
    });
    expect(response.statusCode).toBe(400);
  });

  it("404s an unknown binding id", async () => {
    server = buildTestServer();
    const response = await server.app.inject({
      method: "PATCH",
      url: "/api/resource-bindings/00000000-0000-0000-0000-000000000000",
      payload: { refKind: "nativeIdRef" },
    });
    expect(response.statusCode).toBe(404);
  });
});
