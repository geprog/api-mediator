import type {
  RegisterAppResponse,
  ResourceBindingDto,
  ResourceBindingScopeConstantDto,
  ResourceBindingScopeDto,
  ResourceBindingScopeRecordDerivedDto,
  ResourceBindingScopeScopeLinkDto,
  ResourceBindingsResponse,
  UpdateResourceBindingResponse,
} from "@mediator/contracts";
import { afterEach, describe, expect, it } from "vitest";

import {
  injectAs,
  TEST_OPERATOR,
  TEST_OPERATOR_ALICE,
  TEST_VIEWER,
} from "../../testing/auth.testkit.js";
import { buildTestServer, type TestServer } from "../../testing/fake-persistence.testkit.js";
import {
  providerSpecDocument,
  scopedProviderSpecDocument,
  scopedSourceProviderSpecDocument,
} from "../../testing/sample-specs.testkit.js";

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

/**
 * Registers the Gitea-shaped **scoped** provider (its `issues` resource is reached
 * through `/repos/{owner}/{repo}/issues…`), so the derived `issues` binding
 * carries unconfirmed `owner`/`repo` scope constants — the SS-3 supply/confirm
 * surface.
 */
async function registerScopedAndGetBindings(server: TestServer): Promise<{
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
      specs: [{ role: "PROVIDER", document: scopedProviderSpecDocument() }],
    },
  });
  const specId = registration.json<RegisterAppResponse>().specs[0]?.id ?? "";
  const bindingsResponse = await injectAs(server.app, TEST_OPERATOR, {
    method: "GET",
    url: `/api/specs/${specId}/resource-bindings`,
  });
  return { specId, bindings: bindingsResponse.json<ResourceBindingsResponse>().bindings };
}

function issuesBinding(bindings: ResourceBindingDto[]): ResourceBindingDto {
  const issues = bindings.find((binding) => binding.resourceRef === "issues");
  if (issues === undefined) throw new Error("issues binding not found");
  return issues;
}

function scopeEntry(binding: ResourceBindingDto, parameterName: string): ResourceBindingScopeDto {
  const entry = binding.scopeBindings.find((s) => s.parameterName === parameterName);
  if (entry === undefined) throw new Error(`scope entry '${parameterName}' not found`);
  return entry;
}

/** {@link scopeEntry}, narrowed to the `constant` DTO member (kind-tagged union, SS-9). */
function constantScope(
  binding: ResourceBindingDto,
  parameterName: string,
): ResourceBindingScopeConstantDto {
  const entry = scopeEntry(binding, parameterName);
  if (entry.kind !== "constant") throw new Error(`scope entry '${parameterName}' is not constant`);
  return entry;
}

/** {@link scopeEntry}, narrowed to the `scope-link` DTO member (kind-tagged union, SS-12/SS-18). */
function scopeLinkScope(
  binding: ResourceBindingDto,
  parameterName: string,
): ResourceBindingScopeScopeLinkDto {
  const entry = scopeEntry(binding, parameterName);
  if (entry.kind !== "scope-link") {
    throw new Error(`scope entry '${parameterName}' is not scope-link`);
  }
  return entry;
}

/** {@link scopeEntry}, narrowed to the `record-derived` DTO member (kind-tagged union, SS-9). */
function recordDerivedScope(
  binding: ResourceBindingDto,
  parameterName: string,
): ResourceBindingScopeRecordDerivedDto {
  const entry = scopeEntry(binding, parameterName);
  if (entry.kind !== "record-derived") {
    throw new Error(`scope entry '${parameterName}' is not record-derived`);
  }
  return entry;
}

describe("PATCH /api/resource-bindings/:id — scope constant (SS-3)", () => {
  let server: TestServer;
  afterEach(async () => {
    await server.app.close();
  });

  it("GET reports each scope entry's parameter, kind, value, and confirmed state (SS-3.6)", async () => {
    server = buildTestServer();
    const { bindings } = await registerScopedAndGetBindings(server);
    const issues = issuesBinding(bindings);

    // Two derived scope constants (owner, repo); the record id {index} is none.
    expect(issues.scopeBindings.map((s) => s.parameterName).sort()).toStrictEqual([
      "owner",
      "repo",
    ]);
    expect(issues.scopeBindings.some((s) => s.parameterName === "index")).toBe(false);

    const owner = constantScope(issues, "owner");
    expect(owner.kind).toBe("constant");
    expect(owner.value).toBe(""); // no single-value hint → empty, awaiting supply
    expect(owner.confirmedBy).toBeNull();
    expect(owner.confirmedAt).toBeNull();
  });

  it("confirms a scope constant: sets value + stamps confirmedBy/confirmedAt in one action (SS-3.1)", async () => {
    server = buildTestServer();
    const { bindings } = await registerScopedAndGetBindings(server);

    const response = await injectAs(server.app, TEST_OPERATOR, {
      method: "PATCH",
      url: `/api/resource-bindings/${bindingId(bindings)}`,
      payload: { parameterName: "owner", value: "alice" },
    });

    expect(response.statusCode).toBe(200);
    const owner = constantScope(response.json<UpdateResourceBindingResponse>(), "owner");
    expect(owner.value).toBe("alice");
    expect(owner.confirmedBy).toBe("operator");
    expect(owner.confirmedAt).not.toBeNull();
  });

  it("is per-parameter: confirming owner leaves repo unconfirmed and operational refs untouched (SS-3.2)", async () => {
    server = buildTestServer();
    const { bindings } = await registerScopedAndGetBindings(server);

    const response = await injectAs(server.app, TEST_OPERATOR, {
      method: "PATCH",
      url: `/api/resource-bindings/${bindingId(bindings)}`,
      payload: { parameterName: "owner", value: "alice" },
    });

    const updated = response.json<UpdateResourceBindingResponse>();
    expect(scopeEntry(updated, "owner").confirmedBy).toBe("operator");
    // The sibling scope entry is untouched.
    const repo = constantScope(updated, "repo");
    expect(repo.value).toBe("");
    expect(repo.confirmedBy).toBeNull();
    expect(repo.confirmedAt).toBeNull();
    // No operational ref was touched by a scope confirm.
    expect(updated.refs.find((ref) => ref.kind === "nativeIdRef")?.confirmedBy).toBeNull();
    expect(updated.refs.find((ref) => ref.kind === "collectionReadRef")?.confirmedBy).toBeNull();
  });

  it("rejects confirming a scope constant with an empty value (SS-3.3)", async () => {
    server = buildTestServer();
    const { bindings } = await registerScopedAndGetBindings(server);

    const response = await injectAs(server.app, TEST_OPERATOR, {
      method: "PATCH",
      url: `/api/resource-bindings/${bindingId(bindings)}`,
      payload: { parameterName: "owner", value: "" },
    });
    expect(response.statusCode).toBe(400);
  });

  it("rejects a parameterName not in the resource's derived scope set, but accepts a free-literal value (SS-3.4)", async () => {
    server = buildTestServer();
    const { bindings } = await registerScopedAndGetBindings(server);

    // 'tenant' is not a scope parameter of this resource → rejected.
    const rejected = await injectAs(server.app, TEST_OPERATOR, {
      method: "PATCH",
      url: `/api/resource-bindings/${bindingId(bindings)}`,
      payload: { parameterName: "tenant", value: "acme" },
    });
    expect(rejected.statusCode).toBe(400);

    // A value that is NOT an IR element is accepted — a scope value is a free
    // literal, never IR-validated (contrast an operational ref's IR pointer).
    const accepted = await injectAs(server.app, TEST_OPERATOR, {
      method: "PATCH",
      url: `/api/resource-bindings/${bindingId(bindings)}`,
      payload: { parameterName: "owner", value: "not-an-ir-field-42" },
    });
    expect(accepted.statusCode).toBe(200);
    expect(constantScope(accepted.json<UpdateResourceBindingResponse>(), "owner").value).toBe(
      "not-an-ir-field-42",
    );
  });

  it("forbids a viewer from confirming a scope constant (OA-2, SS-3.5)", async () => {
    server = buildTestServer();
    const { bindings } = await registerScopedAndGetBindings(server);

    const response = await injectAs(server.app, TEST_VIEWER, {
      method: "PATCH",
      url: `/api/resource-bindings/${bindingId(bindings)}`,
      payload: { parameterName: "owner", value: "alice" },
    });
    expect(response.statusCode).toBe(403);
  });

  it("attributes confirmedBy to the authenticated operator identity (OA-3, SS-3.5)", async () => {
    server = buildTestServer();
    const { bindings } = await registerScopedAndGetBindings(server);

    // A second operator acts: confirmedBy must follow the authenticated identity.
    const response = await injectAs(server.app, TEST_OPERATOR_ALICE, {
      method: "PATCH",
      url: `/api/resource-bindings/${bindingId(bindings)}`,
      payload: { parameterName: "repo", value: "phoenix" },
    });

    const repo = constantScope(response.json<UpdateResourceBindingResponse>(), "repo");
    expect(repo.confirmedBy).toBe("alice");
    expect(repo.value).toBe("phoenix");
  });

  it("rejects a payload carrying both a refKind and a parameterName (mutually exclusive patches)", async () => {
    server = buildTestServer();
    const { bindings } = await registerScopedAndGetBindings(server);

    const response = await injectAs(server.app, TEST_OPERATOR, {
      method: "PATCH",
      url: `/api/resource-bindings/${bindingId(bindings)}`,
      payload: { refKind: "nativeIdRef", parameterName: "owner", value: "alice" },
    });
    expect(response.statusCode).toBe(400);
  });
});

/**
 * Registers the source-scoped provider (its `issues` records self-carry their
 * container via `repository.owner`/`repository.name`), so the derived `issues`
 * binding carries an unconfirmed `sourceScopeRef` — the SS-7 confirm/correct
 * surface.
 */
async function registerSourceScopedAndGetBindings(server: TestServer): Promise<{
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
      specs: [{ role: "PROVIDER", document: scopedSourceProviderSpecDocument() }],
    },
  });
  const specId = registration.json<RegisterAppResponse>().specs[0]?.id ?? "";
  const bindingsResponse = await injectAs(server.app, TEST_OPERATOR, {
    method: "GET",
    url: `/api/specs/${specId}/resource-bindings`,
  });
  return { specId, bindings: bindingsResponse.json<ResourceBindingsResponse>().bindings };
}

describe("PATCH /api/resource-bindings/:id — sourceScopeRef (SS-7)", () => {
  let server: TestServer;
  afterEach(async () => {
    await server.app.close();
  });

  it("GET reports the derived sourceScopeRef state — components + unconfirmed (SS-7.1)", async () => {
    server = buildTestServer();
    const { bindings } = await registerSourceScopedAndGetBindings(server);
    const issues = issuesBinding(bindings);

    expect(issues.sourceScopeRef).not.toBeNull();
    expect(issues.sourceScopeRef?.components).toStrictEqual([
      { key: "owner", fieldPath: "repository.owner" },
      { key: "name", fieldPath: "repository.name" },
    ]);
    expect(issues.sourceScopeRef?.confirmedBy).toBeNull();
    expect(issues.sourceScopeRef?.confirmedAt).toBeNull();
  });

  it("reports sourceScopeRef = null for a resource with no container field (SS-7.3)", async () => {
    server = buildTestServer();
    // The plain provider's `issues` records carry no container field.
    const { bindings } = await registerAndGetBindings(server);
    const issues = bindings.find((binding) => binding.resourceRef === "issues");
    expect(issues?.sourceScopeRef).toBeNull();
  });

  it("confirms/corrects sourceScopeRef: sets the component set + stamps confirmation (SS-7.2)", async () => {
    server = buildTestServer();
    const { bindings } = await registerSourceScopedAndGetBindings(server);

    // Correct: rename `name`'s component key to `slug`, keep both field paths.
    const response = await injectAs(server.app, TEST_OPERATOR, {
      method: "PATCH",
      url: `/api/resource-bindings/${bindingId(bindings)}`,
      payload: {
        components: [
          { key: "owner", fieldPath: "repository.owner" },
          { key: "slug", fieldPath: "repository.name" },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    const updated = response.json<UpdateResourceBindingResponse>();
    expect(updated.sourceScopeRef?.components).toStrictEqual([
      { key: "owner", fieldPath: "repository.owner" },
      { key: "slug", fieldPath: "repository.name" },
    ]);
    expect(updated.sourceScopeRef?.confirmedBy).toBe("operator");
    expect(updated.sourceScopeRef?.confirmedAt).not.toBeNull();
  });

  it("attributes confirmedBy to the authenticated operator identity (OA-3)", async () => {
    server = buildTestServer();
    const { bindings } = await registerSourceScopedAndGetBindings(server);

    const response = await injectAs(server.app, TEST_OPERATOR_ALICE, {
      method: "PATCH",
      url: `/api/resource-bindings/${bindingId(bindings)}`,
      payload: { components: [{ key: "owner", fieldPath: "repository.owner" }] },
    });
    expect(response.json<UpdateResourceBindingResponse>().sourceScopeRef?.confirmedBy).toBe(
      "alice",
    );
  });

  it("rejects a component fieldPath that is not in the response schema (SS-7.2)", async () => {
    server = buildTestServer();
    const { bindings } = await registerSourceScopedAndGetBindings(server);

    const response = await injectAs(server.app, TEST_OPERATOR, {
      method: "PATCH",
      url: `/api/resource-bindings/${bindingId(bindings)}`,
      payload: {
        components: [
          { key: "owner", fieldPath: "repository.owner" },
          { key: "ghost", fieldPath: "repository.does_not_exist" },
        ],
      },
    });
    expect(response.statusCode).toBe(400);
  });

  it("rejects an empty component set (absent, not confirmed-empty — SS-7.3)", async () => {
    server = buildTestServer();
    const { bindings } = await registerSourceScopedAndGetBindings(server);

    const response = await injectAs(server.app, TEST_OPERATOR, {
      method: "PATCH",
      url: `/api/resource-bindings/${bindingId(bindings)}`,
      payload: { components: [] },
    });
    expect(response.statusCode).toBe(400);
  });

  it("rejects duplicate component keys", async () => {
    server = buildTestServer();
    const { bindings } = await registerSourceScopedAndGetBindings(server);

    const response = await injectAs(server.app, TEST_OPERATOR, {
      method: "PATCH",
      url: `/api/resource-bindings/${bindingId(bindings)}`,
      payload: {
        components: [
          { key: "owner", fieldPath: "repository.owner" },
          { key: "owner", fieldPath: "repository.name" },
        ],
      },
    });
    expect(response.statusCode).toBe(400);
  });

  it("forbids a viewer from confirming sourceScopeRef (OA-2)", async () => {
    server = buildTestServer();
    const { bindings } = await registerSourceScopedAndGetBindings(server);

    const response = await injectAs(server.app, TEST_VIEWER, {
      method: "PATCH",
      url: `/api/resource-bindings/${bindingId(bindings)}`,
      payload: { components: [{ key: "owner", fieldPath: "repository.owner" }] },
    });
    expect(response.statusCode).toBe(403);
  });

  it("leaves operational refs and scope bindings untouched (no RB-2 / SS-3 regression)", async () => {
    server = buildTestServer();
    const { bindings } = await registerSourceScopedAndGetBindings(server);

    const response = await injectAs(server.app, TEST_OPERATOR, {
      method: "PATCH",
      url: `/api/resource-bindings/${bindingId(bindings)}`,
      payload: { components: [{ key: "owner", fieldPath: "repository.owner" }] },
    });

    const updated = response.json<UpdateResourceBindingResponse>();
    // A sourceScopeRef confirm touches no operational ref…
    expect(updated.refs.find((ref) => ref.kind === "nativeIdRef")?.confirmedBy).toBeNull();
    // …and no scope path-parameter binding (owner/repo stay unconfirmed constants).
    for (const scope of updated.scopeBindings) {
      expect(scope.confirmedBy).toBeNull();
      expect(scope.kind).toBe("constant");
      expect(scope.kind === "constant" ? scope.value : undefined).toBe("");
    }
  });

  it("still accepts a ref patch and a scope patch after adding the sourceScopeRef branch", async () => {
    server = buildTestServer();
    const { bindings } = await registerSourceScopedAndGetBindings(server);
    const id = bindingId(bindings);

    // RB-2 ref patch still works.
    const refResp = await injectAs(server.app, TEST_OPERATOR, {
      method: "PATCH",
      url: `/api/resource-bindings/${id}`,
      payload: { refKind: "nativeIdRef" },
    });
    expect(refResp.statusCode).toBe(200);
    expect(
      refResp.json<UpdateResourceBindingResponse>().refs.find((r) => r.kind === "nativeIdRef")
        ?.confirmedBy,
    ).toBe("operator");

    // SS-3 scope patch still works.
    const scopeResp = await injectAs(server.app, TEST_OPERATOR, {
      method: "PATCH",
      url: `/api/resource-bindings/${id}`,
      payload: { parameterName: "owner", value: "alice" },
    });
    expect(scopeResp.statusCode).toBe(200);
    expect(constantScope(scopeResp.json<UpdateResourceBindingResponse>(), "owner").value).toBe(
      "alice",
    );
  });
});

describe("PATCH /api/resource-bindings/:id — scope record-derived (SS-8)", () => {
  let server: TestServer;
  afterEach(async () => {
    await server.app.close();
  });

  it("confirms a scope entry record-derived: flips kind, sets sourceScopeKey + value-preserving transform, stamps confirmation (SS-8.1/8.3/8.4)", async () => {
    server = buildTestServer();
    const { bindings } = await registerScopedAndGetBindings(server);

    const response = await injectAs(server.app, TEST_OPERATOR, {
      method: "PATCH",
      url: `/api/resource-bindings/${bindingId(bindings)}`,
      payload: {
        parameterName: "owner",
        kind: "record-derived",
        sourceScopeKey: "owner",
        transform: { kind: "rename" },
      },
    });

    expect(response.statusCode).toBe(200);
    const owner = recordDerivedScope(response.json<UpdateResourceBindingResponse>(), "owner");
    expect(owner.kind).toBe("record-derived");
    expect(owner.sourceScopeKey).toBe("owner");
    expect(owner.transform).toStrictEqual({ kind: "rename" });
    expect(owner.confirmedBy).toBe("operator");
    expect(owner.confirmedAt).not.toBeNull();
    // A record-derived entry carries no constant literal (SS-9 kind-tagged DTO).
    expect("value" in owner).toBe(false);
  });

  it("confirms record-derived without a transform (the key is simply absent)", async () => {
    server = buildTestServer();
    const { bindings } = await registerScopedAndGetBindings(server);

    const response = await injectAs(server.app, TEST_OPERATOR, {
      method: "PATCH",
      url: `/api/resource-bindings/${bindingId(bindings)}`,
      payload: { parameterName: "owner", kind: "record-derived", sourceScopeKey: "owner" },
    });

    expect(response.statusCode).toBe(200);
    const owner = recordDerivedScope(response.json<UpdateResourceBindingResponse>(), "owner");
    expect(owner.kind).toBe("record-derived");
    expect(owner.sourceScopeKey).toBe("owner");
    expect(owner.transform).toBeUndefined();
  });

  it("is per-parameter: confirming owner record-derived leaves the repo constant + operational refs untouched (SS-3.2 discipline)", async () => {
    server = buildTestServer();
    const { bindings } = await registerScopedAndGetBindings(server);

    const response = await injectAs(server.app, TEST_OPERATOR, {
      method: "PATCH",
      url: `/api/resource-bindings/${bindingId(bindings)}`,
      payload: { parameterName: "owner", kind: "record-derived", sourceScopeKey: "owner" },
    });

    const updated = response.json<UpdateResourceBindingResponse>();
    // The sibling scope entry stays an unconfirmed constant.
    const repo = constantScope(updated, "repo");
    expect(repo.kind).toBe("constant");
    expect(repo.value).toBe("");
    expect(repo.confirmedBy).toBeNull();
    // No operational ref was touched by a scope confirm.
    expect(updated.refs.find((ref) => ref.kind === "nativeIdRef")?.confirmedBy).toBeNull();
    expect(updated.refs.find((ref) => ref.kind === "collectionReadRef")?.confirmedBy).toBeNull();
  });

  it("GET reports a confirmed record-derived entry's kind/sourceScopeKey/transform/confirmed state (SS-8.1)", async () => {
    server = buildTestServer();
    const { specId, bindings } = await registerScopedAndGetBindings(server);

    await injectAs(server.app, TEST_OPERATOR, {
      method: "PATCH",
      url: `/api/resource-bindings/${bindingId(bindings)}`,
      payload: {
        parameterName: "owner",
        kind: "record-derived",
        sourceScopeKey: "owner",
        transform: { kind: "rename" },
      },
    });

    // Re-read via GET to prove the state is reported by the read endpoint, not just
    // the PATCH response DTO.
    const reread = await injectAs(server.app, TEST_OPERATOR, {
      method: "GET",
      url: `/api/specs/${specId}/resource-bindings`,
    });
    const issues = issuesBinding(reread.json<ResourceBindingsResponse>().bindings);
    const owner = recordDerivedScope(issues, "owner");
    expect(owner.kind).toBe("record-derived");
    expect(owner.sourceScopeKey).toBe("owner");
    expect(owner.transform).toStrictEqual({ kind: "rename" });
    expect(owner.confirmedBy).toBe("operator");
    expect(owner.confirmedAt).not.toBeNull();
  });

  it("rejects confirming record-derived with an empty sourceScopeKey (SS-8.1)", async () => {
    server = buildTestServer();
    const { bindings } = await registerScopedAndGetBindings(server);

    const response = await injectAs(server.app, TEST_OPERATOR, {
      method: "PATCH",
      url: `/api/resource-bindings/${bindingId(bindings)}`,
      payload: { parameterName: "owner", kind: "record-derived", sourceScopeKey: "" },
    });
    expect(response.statusCode).toBe(400);
  });

  it("rejects confirming record-derived with a value-altering transform (SS-8.3 — the value-preserving rule)", async () => {
    server = buildTestServer();
    const { bindings } = await registerScopedAndGetBindings(server);

    const response = await injectAs(server.app, TEST_OPERATOR, {
      method: "PATCH",
      url: `/api/resource-bindings/${bindingId(bindings)}`,
      payload: {
        parameterName: "owner",
        kind: "record-derived",
        sourceScopeKey: "owner",
        transform: { kind: "coerce", config: { coerce: { to: "string", from: "number" } } },
      },
    });
    expect(response.statusCode).toBe(400);
  });

  it("rejects a parameterName not in the resource's derived scope set (SS-8 / SS-3.4)", async () => {
    server = buildTestServer();
    const { bindings } = await registerScopedAndGetBindings(server);

    const response = await injectAs(server.app, TEST_OPERATOR, {
      method: "PATCH",
      url: `/api/resource-bindings/${bindingId(bindings)}`,
      payload: { parameterName: "tenant", kind: "record-derived", sourceScopeKey: "owner" },
    });
    expect(response.statusCode).toBe(400);
  });

  it("forbids a viewer from confirming a record-derived binding (OA-2)", async () => {
    server = buildTestServer();
    const { bindings } = await registerScopedAndGetBindings(server);

    const response = await injectAs(server.app, TEST_VIEWER, {
      method: "PATCH",
      url: `/api/resource-bindings/${bindingId(bindings)}`,
      payload: { parameterName: "owner", kind: "record-derived", sourceScopeKey: "owner" },
    });
    expect(response.statusCode).toBe(403);
  });

  it("attributes confirmedBy to the authenticated operator identity (OA-3)", async () => {
    server = buildTestServer();
    const { bindings } = await registerScopedAndGetBindings(server);

    const response = await injectAs(server.app, TEST_OPERATOR_ALICE, {
      method: "PATCH",
      url: `/api/resource-bindings/${bindingId(bindings)}`,
      payload: { parameterName: "repo", kind: "record-derived", sourceScopeKey: "name" },
    });

    const repo = recordDerivedScope(response.json<UpdateResourceBindingResponse>(), "repo");
    expect(repo.confirmedBy).toBe("alice");
    expect(repo.sourceScopeKey).toBe("name");
  });
});

describe("PATCH /api/resource-bindings/:id — scope-link (SS-18.4)", () => {
  let server: TestServer;
  afterEach(async () => {
    await server.app.close();
  });

  it("SELECTING scope-link writes the entry UNCONFIRMED — nothing is auto-confirmed (SS-18.4/18.8)", async () => {
    server = buildTestServer();
    const { bindings } = await registerScopedAndGetBindings(server);

    const response = await injectAs(server.app, TEST_OPERATOR, {
      method: "PATCH",
      url: `/api/resource-bindings/${bindingId(bindings)}`,
      payload: { parameterName: "owner", kind: "scope-link", scopeKeyRef: "id" },
    });

    expect(response.statusCode).toBe(200);
    const owner = scopeLinkScope(response.json<UpdateResourceBindingResponse>(), "owner");
    expect(owner.kind).toBe("scope-link");
    expect(owner.scopeKeyRef).toBe("id");
    // The choice is recorded; the confirmation is NOT stamped.
    expect(owner.confirmedBy).toBeNull();
    expect(owner.confirmedAt).toBeNull();
    // The stale `constant` literal is dropped by the member rewrite (kind-tagged DTO).
    expect("value" in owner).toBe(false);
  });

  it("an explicit confirm stamps the confirmation (SS-18.4)", async () => {
    server = buildTestServer();
    const { bindings } = await registerScopedAndGetBindings(server);

    const response = await injectAs(server.app, TEST_OPERATOR, {
      method: "PATCH",
      url: `/api/resource-bindings/${bindingId(bindings)}`,
      payload: { parameterName: "owner", kind: "scope-link", scopeKeyRef: "id", confirm: true },
    });

    expect(response.statusCode).toBe(200);
    const owner = scopeLinkScope(response.json<UpdateResourceBindingResponse>(), "owner");
    expect(owner.confirmedBy).toBe("operator");
    expect(owner.confirmedAt).not.toBeNull();
  });

  it("rejects a scope-link without a scopeKeyRef — a confirmed entry always names its container key", async () => {
    server = buildTestServer();
    const { bindings } = await registerScopedAndGetBindings(server);

    const response = await injectAs(server.app, TEST_OPERATOR, {
      method: "PATCH",
      url: `/api/resource-bindings/${bindingId(bindings)}`,
      payload: { parameterName: "owner", kind: "scope-link", scopeKeyRef: "" },
    });

    expect(response.statusCode).toBe(400);
  });

  it("rejects a parameterName that is not a derived scope entry of the resource (SS-3.4)", async () => {
    server = buildTestServer();
    const { bindings } = await registerScopedAndGetBindings(server);

    const response = await injectAs(server.app, TEST_OPERATOR, {
      method: "PATCH",
      url: `/api/resource-bindings/${bindingId(bindings)}`,
      payload: { parameterName: "nope", kind: "scope-link", scopeKeyRef: "id" },
    });

    expect(response.statusCode).toBe(400);
  });

  it("is per-parameter: a scope-link select leaves the sibling constant untouched (SS-3.2)", async () => {
    server = buildTestServer();
    const { bindings } = await registerScopedAndGetBindings(server);

    const response = await injectAs(server.app, TEST_OPERATOR, {
      method: "PATCH",
      url: `/api/resource-bindings/${bindingId(bindings)}`,
      payload: { parameterName: "owner", kind: "scope-link", scopeKeyRef: "id" },
    });

    const updated = response.json<UpdateResourceBindingResponse>();
    const repo = constantScope(updated, "repo");
    expect(repo.kind).toBe("constant");
    expect(repo.value).toBe("");
    expect(repo.confirmedBy).toBeNull();
    expect(updated.refs.find((ref) => ref.kind === "nativeIdRef")?.confirmedBy).toBeNull();
  });

  it("is a mutation: a viewer is refused (OA-2 / SS-18.8)", async () => {
    server = buildTestServer();
    const { bindings } = await registerScopedAndGetBindings(server);

    const response = await injectAs(server.app, TEST_VIEWER, {
      method: "PATCH",
      url: `/api/resource-bindings/${bindingId(bindings)}`,
      payload: { parameterName: "owner", kind: "scope-link", scopeKeyRef: "id" },
    });

    expect(response.statusCode).toBe(403);
  });

  it("reports scope-link UNAVAILABLE while the pair has no proposed ScopeCorrespondence (SS-18.4)", async () => {
    server = buildTestServer();
    const { bindings } = await registerScopedAndGetBindings(server);

    const issues = bindings.find((binding) => binding.resourceRef === "issues");
    expect(issues?.scopeLinkAvailable).toBe(false);
    expect(issues?.scopeKeyRefCandidates).toStrictEqual({});
  });

  it("reports scope-link AVAILABLE, with the derived scopeKeyRef, once one is proposed (SS-18.4)", async () => {
    server = buildTestServer();
    const { specId, bindings } = await registerScopedAndGetBindings(server);
    const appId = server.store.specs.get(specId)?.appId ?? "";

    // The SS-18.1 proposal has run for this pair. `issues` is the TARGET side here, so the
    // derived `scopeKeyRef` is the leaf of the CONTAINER resource's `nativeIdRef` — the
    // component SS-11 discovery keys a target `ScopeLink.appXScopeKey` by. This sample spec
    // exposes only one resource, so it doubles as the container: what the case proves is the
    // route -> resolver -> container-binding wiring, not the heuristic (covered in
    // `scope-authoring.spec.ts` against purpose-built IR).
    server.store.scopeCorrespondences.set("pair", {
      id: "corr-1",
      resourcePairRef: `app-other:tasks|${appId}:issues`,
      scopeIdentityKey: [{ sourceScopeKey: "name", targetFieldPath: "title" }],
      targetContainerRef: { appId, resourceRef: "issues" },
      confirmedBy: null,
      confirmedAt: null,
    });

    const refreshed = await injectAs(server.app, TEST_OPERATOR, {
      method: "GET",
      url: `/api/specs/${specId}/resource-bindings`,
    });
    const issues = refreshed
      .json<ResourceBindingsResponse>()
      .bindings.find((binding) => binding.resourceRef === "issues");

    expect(issues?.scopeLinkAvailable).toBe(true);
    // Per PARAMETER: this scoped spec reaches `issues` through `{owner}` and `{repo}`, and
    // `issues` is the TARGET side here, whose scope key has exactly one component.
    expect(issues?.scopeKeyRefCandidates).toStrictEqual({ owner: "id", repo: "id" });
    // A resource with NO scope path parameter is unaffected — no correspondence claims it.
    const others = bindings.filter((binding) => binding.scopeBindings.length === 0);
    expect(others.every((binding) => !binding.scopeLinkAvailable)).toBe(true);
  });
});
