import type {
  RegisterAppResponse,
  ResourceBindingDto,
  ResourceBindingsResponse,
  UpdateResourceBindingResponse,
} from "@mediator/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { injectAs, TEST_OPERATOR, TEST_OPERATOR_ALICE } from "../../testing/auth.testkit.js";
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
  const registration = await injectAs(server.app, TEST_OPERATOR, {
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
  const bindingsResponse = await injectAs(server.app, TEST_OPERATOR, {
    method: "GET",
    url: `/api/specs/${specId}/resource-bindings`,
  });
  return { specId, bindings: bindingsResponse.json<ResourceBindingsResponse>().bindings };
}

function bindingId(bindings: ResourceBindingDto[]): string {
  const issues = bindings.find((binding) => binding.resourceRef === "issues");
  if (issues === undefined) throw new Error("issues binding not found");
  return issues.id;
}

describe("GET /api/specs/:id/resource-bindings (RB-3)", () => {
  let server: TestServer;
  afterEach(async () => {
    await server.app.close();
  });

  it("reports each ref's value + applicability + confirmed state", async () => {
    server = buildTestServer();
    const { bindings } = await registerAndGetBindings(server);
    const issues = bindings.find((binding) => binding.resourceRef === "issues");
    expect(issues).toBeDefined();

    const nativeId = issues?.refs.find((ref) => ref.kind === "nativeIdRef");
    expect(nativeId?.applicable).toBe(true);
    expect(nativeId?.value).toEqual({ kind: "field", path: "id" });
    expect(nativeId?.confirmedBy).toBeNull();

    // supportsChangeTimestamps=true → changeTimestampRef is applicable + derived.
    const changeTs = issues?.refs.find((ref) => ref.kind === "changeTimestampRef");
    expect(changeTs?.applicable).toBe(true);
    expect(changeTs?.value).toEqual({ kind: "field", path: "updated" });

    // supportsDeltaQuery=false → delta refs are not applicable.
    const deltaCursor = issues?.refs.find((ref) => ref.kind === "deltaCursorRef");
    expect(deltaCursor?.applicable).toBe(false);
  });
});

describe("PATCH /api/resource-bindings/:id (RB-2)", () => {
  let server: TestServer;
  afterEach(async () => {
    await server.app.close();
  });

  it("confirms a ref, stamping confirmedBy (authenticated identity) + confirmedAt", async () => {
    server = buildTestServer();
    const { bindings } = await registerAndGetBindings(server);

    const response = await injectAs(server.app, TEST_OPERATOR, {
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

  it("attributes confirmedBy to the authenticated operator identity (OA-3)", async () => {
    server = buildTestServer();
    const { bindings } = await registerAndGetBindings(server);

    // A different operator acts: confirmedBy must follow the authenticated
    // identity, not a fixed value.
    const response = await injectAs(server.app, TEST_OPERATOR_ALICE, {
      method: "PATCH",
      url: `/api/resource-bindings/${bindingId(bindings)}`,
      payload: { refKind: "nativeIdRef" },
    });

    const updated = response.json<UpdateResourceBindingResponse>();
    expect(updated.refs.find((ref) => ref.kind === "nativeIdRef")?.confirmedBy).toBe("alice");
  });

  it("persists a correction of an applicable-but-underived ref (upsert)", async () => {
    server = buildTestServer();
    const { bindings } = await registerAndGetBindings(server);
    const issues = bindings.find((binding) => binding.resourceRef === "issues");
    // paginationRef is always applicable but the sample list op has no paging
    // params, so no ref was derived (no row) — the silent-data-loss scenario.
    const paginationBefore = issues?.refs.find((ref) => ref.kind === "paginationRef");
    expect(paginationBefore?.applicable).toBe(true);
    expect(paginationBefore?.value).toBeNull();

    const response = await injectAs(server.app, TEST_OPERATOR, {
      method: "PATCH",
      url: `/api/resource-bindings/${bindingId(bindings)}`,
      payload: {
        refKind: "paginationRef",
        value: { kind: "parameter", operationId: "getIssue", parameter: "id" },
      },
    });

    expect(response.statusCode).toBe(200);
    const pagination = response
      .json<UpdateResourceBindingResponse>()
      .refs.find((ref) => ref.kind === "paginationRef");
    expect(pagination?.value).toEqual({
      kind: "parameter",
      operationId: "getIssue",
      parameter: "id",
    });
    expect(pagination?.confirmedBy).toBe("operator");
    expect(pagination?.confirmedAt).not.toBeNull();
  });

  it("corrects a ref to a different IR field and confirms it in one action", async () => {
    server = buildTestServer();
    const { bindings } = await registerAndGetBindings(server);

    const response = await injectAs(server.app, TEST_OPERATOR, {
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

    const response = await injectAs(server.app, TEST_OPERATOR, {
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

    const response = await injectAs(server.app, TEST_OPERATOR, {
      method: "PATCH",
      url: `/api/resource-bindings/${bindingId(bindings)}`,
      payload: { refKind: "deltaCursorRef" },
    });
    expect(response.statusCode).toBe(400);
  });

  it("404s a well-formed but unknown binding id", async () => {
    server = buildTestServer();
    const response = await injectAs(server.app, TEST_OPERATOR, {
      method: "PATCH",
      url: "/api/resource-bindings/00000000-0000-0000-0000-000000000000",
      payload: { refKind: "nativeIdRef" },
    });
    expect(response.statusCode).toBe(404);
  });

  it("400s a malformed (non-UUID) binding id at the validation boundary", async () => {
    server = buildTestServer();
    const response = await injectAs(server.app, TEST_OPERATOR, {
      method: "PATCH",
      url: "/api/resource-bindings/not-a-uuid",
      payload: { refKind: "nativeIdRef" },
    });
    expect(response.statusCode).toBe(400);
  });
});
