import type {
  AdapterEndpointStateResponse,
  AdapterStateResponse,
  ComposeAdapterEndpointResponse,
  ErrorResponse,
} from "@mediator/contracts";
import type {
  AdapterBinding,
  AdapterEndpoint,
  ApprovedMappingStatus,
  RegisteredAppStatus,
} from "@mediator/domain";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { BadRequestError } from "../../app-errors.js";
import type {
  ComposeResult,
  CompositionSubmission,
} from "../../modules/adapter-composition/index.js";
import type { AdapterStateReader, ConsumerOperationRef } from "../../modules/adapter-state.js";
import {
  TEST_OPERATOR,
  TEST_OPERATOR_ACCOUNTS,
  TEST_VIEWER,
  injectAs,
} from "../../testing/auth.testkit.js";
import { LocalAccountsAuthProvider, installAuthentication } from "../auth/index.js";
import { registerErrorHandler } from "../errors.js";
import {
  registerAdapterEndpointRoutes,
  type CompositionMutator,
} from "./adapter-endpoints.routes.js";

/**
 * Route tests for the Phase-5 adapter endpoint operator surface (AP-1 read state, AP-2
 * compose/recompose dispatch, AP-3 enable/disable), driven with `fastify.inject()` through
 * the **real** operator-auth path (OA-1/OA-2) and in-memory fakes for the composition
 * mutator + state reader. They assert the HTTP contract; the composition invariants
 * themselves are the `AdapterCompositionService`'s own tests.
 */

const CONSUMER_APP = "11111111-1111-4111-8111-111111111111";
const ENDPOINT_ACTIVE = "22222222-2222-4222-8222-222222222222";
const ENDPOINT_COMPREQ = "33333333-3333-4333-8333-333333333333";
const BACKEND_APP = "44444444-4444-4444-8444-444444444444";
const BINDING_ACTIVE = "55555555-5555-4555-8555-555555555555";
const BINDING_PROPOSED = "66666666-6666-4666-8666-666666666666";
const MAPPING = "77777777-7777-4777-8777-777777777777";

function endpoint(
  overrides: Partial<AdapterEndpoint> & Pick<AdapterEndpoint, "id">,
): AdapterEndpoint {
  return {
    consumerAppId: CONSUMER_APP,
    consumerOperationId: "users/getUser",
    status: "active",
    aggregationStrategy: "single",
    strictness: "degraded",
    ...overrides,
  };
}

function binding(overrides: Partial<AdapterBinding> & Pick<AdapterBinding, "id">): AdapterBinding {
  return {
    adapterEndpointId: ENDPOINT_ACTIVE,
    backendAppId: BACKEND_APP,
    backendOperationId: "users/getById",
    approvedMappingId: MAPPING,
    role: "primary",
    status: "active",
    ...overrides,
  };
}

/** An in-memory {@link AdapterStateReader} the routes read through. */
class FakeStateReader implements AdapterStateReader {
  public endpoints: AdapterEndpoint[] = [];
  public readonly bindingsByEndpoint = new Map<string, AdapterBinding[]>();
  public readonly mappingStatus = new Map<string, ApprovedMappingStatus>();
  public readonly backendStatus = new Map<string, RegisteredAppStatus>();
  public consumerOperations: ConsumerOperationRef[] = [];

  public listEndpoints(): Promise<AdapterEndpoint[]> {
    return Promise.resolve(this.endpoints);
  }
  public getEndpointById(id: string): Promise<AdapterEndpoint | undefined> {
    return Promise.resolve(this.endpoints.find((candidate) => candidate.id === id));
  }
  public listBindings(endpointId: string): Promise<AdapterBinding[]> {
    return Promise.resolve(this.bindingsByEndpoint.get(endpointId) ?? []);
  }
  public getMappingStatus(mappingId: string): Promise<ApprovedMappingStatus | undefined> {
    return Promise.resolve(this.mappingStatus.get(mappingId));
  }
  public getBackendAppStatus(appId: string): Promise<RegisteredAppStatus | undefined> {
    return Promise.resolve(this.backendStatus.get(appId));
  }
  public listConsumerOperations(): Promise<ConsumerOperationRef[]> {
    return Promise.resolve(this.consumerOperations);
  }
}

/** A fake {@link CompositionMutator} recording each call and returning/raising scripted outcomes. */
class FakeMutator implements CompositionMutator {
  public readonly calls: Array<{
    op: "compose" | "recompose" | "setEndpointEnabled" | "previewComposition";
    endpointId: string;
    actor?: string;
    enabled?: boolean;
    disabledBindingIds?: string[];
  }> = [];
  public composeError: Error | undefined;
  public recomposeError: Error | undefined;
  public result: ComposeResult = {
    endpoint: endpoint({ id: ENDPOINT_ACTIVE, status: "active" }),
    bindings: [binding({ id: BINDING_ACTIVE })],
  };

  public compose(
    endpointId: string,
    _submission: CompositionSubmission,
    actor: string,
  ): Promise<ComposeResult> {
    this.calls.push({ op: "compose", endpointId, actor });
    return this.composeError !== undefined
      ? Promise.reject(this.composeError)
      : Promise.resolve(this.result);
  }
  public recompose(
    endpointId: string,
    submission: CompositionSubmission,
    actor: string,
  ): Promise<ComposeResult> {
    this.calls.push({
      op: "recompose",
      endpointId,
      actor,
      disabledBindingIds: submission.bindings
        .filter((entry) => entry.disabled === true)
        .map((entry) => entry.bindingId),
    });
    return this.recomposeError !== undefined
      ? Promise.reject(this.recomposeError)
      : Promise.resolve(this.result);
  }
  public setEndpointEnabled(
    endpointId: string,
    enabled: boolean,
    actor: string,
  ): Promise<AdapterEndpoint> {
    this.calls.push({ op: "setEndpointEnabled", endpointId, actor, enabled });
    return Promise.resolve(endpoint({ id: endpointId, status: enabled ? "active" : "disabled" }));
  }
  public previewComposition(): Promise<never> {
    this.calls.push({ op: "previewComposition", endpointId: "" });
    return Promise.reject(new Error("not used in these tests"));
  }
}

function buildApp(mutator: CompositionMutator, reader: AdapterStateReader): FastifyInstance {
  const app = Fastify();
  void app.register((instance) => {
    installAuthentication(instance, new LocalAccountsAuthProvider(TEST_OPERATOR_ACCOUNTS));
    registerAdapterEndpointRoutes(instance, mutator, reader);
    return Promise.resolve();
  });
  registerErrorHandler(app);
  return app;
}

/** No response may carry credential material, an adapter token, or a live payload value. */
function assertNoSecretLeak(body: string): void {
  expect(body).not.toMatch(/token|secret|password|payload|rawdocument|credential/i);
}

describe("GET /api/adapter-endpoints (AP-1)", () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    if (app !== undefined) {
      await app.close();
      app = undefined;
    }
  });

  function seed(reader: FakeStateReader): void {
    reader.endpoints = [
      endpoint({ id: ENDPOINT_ACTIVE, consumerOperationId: "users/getUser", status: "active" }),
      endpoint({
        id: ENDPOINT_COMPREQ,
        consumerOperationId: "users/listUsers",
        status: "composition-required",
      }),
    ];
    reader.bindingsByEndpoint.set(ENDPOINT_ACTIVE, [
      binding({ id: BINDING_ACTIVE, adapterEndpointId: ENDPOINT_ACTIVE, status: "active" }),
    ]);
    reader.bindingsByEndpoint.set(ENDPOINT_COMPREQ, [
      binding({
        id: BINDING_ACTIVE,
        adapterEndpointId: ENDPOINT_COMPREQ,
        status: "active",
      }),
      binding({
        id: BINDING_PROPOSED,
        adapterEndpointId: ENDPOINT_COMPREQ,
        status: "proposed",
      }),
    ]);
    reader.mappingStatus.set(MAPPING, "active");
    reader.backendStatus.set(BACKEND_APP, "active");
    // A consumer operation with no endpoint at all (AP-1.3 → no-endpoint).
    reader.consumerOperations = [
      { consumerAppId: CONSUMER_APP, consumerOperationId: "users/getUser" },
      { consumerAppId: CONSUMER_APP, consumerOperationId: "users/listUsers" },
      { consumerAppId: CONSUMER_APP, consumerOperationId: "users/deleteUser" },
    ];
  }

  it("lists endpoints + bindings, the composition-required why, and not-yet-mapped needs (viewer allowed)", async () => {
    const reader = new FakeStateReader();
    seed(reader);
    app = buildApp(new FakeMutator(), reader);

    const response = await injectAs(app, TEST_VIEWER, {
      method: "GET",
      url: "/api/adapter-endpoints",
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<AdapterStateResponse>();
    expect(body.endpoints).toHaveLength(2);

    const active = body.endpoints.find((entry) => entry.id === ENDPOINT_ACTIVE);
    expect(active?.status).toBe("active");
    expect(active?.aggregationStrategy).toBe("single");
    expect(active?.bindings).toHaveLength(1);
    expect(active?.bindings[0]?.health).toStrictEqual({ ok: true });
    expect(active?.compositionRequired).toBeNull();

    // AP-1.2 — the composition-required "why": which binding is proposed + old config serving.
    const compReq = body.endpoints.find((entry) => entry.id === ENDPOINT_COMPREQ);
    expect(compReq?.compositionRequired).toStrictEqual({
      proposedBindingIds: [BINDING_PROPOSED],
      previousConfigurationServing: true,
    });

    // AP-1.3 — deleteUser has no endpoint; listUsers has an endpoint with an active binding
    // (so it is NOT listed). getUser is fully served (not listed).
    expect(body.notYetMapped).toStrictEqual([
      {
        consumerAppId: CONSUMER_APP,
        consumerOperationId: "users/deleteUser",
        reason: "no-endpoint",
      },
    ]);
  });

  it("reports per-binding derived health at read time (AP-1.4) and leaks no secret (AP-1.5)", async () => {
    const reader = new FakeStateReader();
    seed(reader);
    // A stale mapping and a disabled backend eliminate their bindings at read time.
    reader.mappingStatus.set(MAPPING, "stale");
    reader.backendStatus.set(BACKEND_APP, "disabled");
    app = buildApp(new FakeMutator(), reader);

    const response = await injectAs(app, TEST_VIEWER, {
      method: "GET",
      url: "/api/adapter-endpoints",
    });

    expect(response.statusCode).toBe(200);
    // Mapping health is checked before backend health (RP-3), so a stale mapping wins.
    const active = response
      .json<AdapterStateResponse>()
      .endpoints.find((entry) => entry.id === ENDPOINT_ACTIVE);
    expect(active?.bindings[0]?.health).toStrictEqual({ ok: false, cause: "mapping-stale" });
    assertNoSecretLeak(response.body);
  });

  it("returns one endpoint's state on GET :id, 404 for an unknown id", async () => {
    const reader = new FakeStateReader();
    seed(reader);
    app = buildApp(new FakeMutator(), reader);

    const found = await injectAs(app, TEST_VIEWER, {
      method: "GET",
      url: `/api/adapter-endpoints/${ENDPOINT_ACTIVE}`,
    });
    expect(found.statusCode).toBe(200);
    expect(found.json<AdapterEndpointStateResponse>().endpoint.id).toBe(ENDPOINT_ACTIVE);

    const missing = await injectAs(app, TEST_VIEWER, {
      method: "GET",
      url: `/api/adapter-endpoints/${BINDING_PROPOSED}`,
    });
    expect(missing.statusCode).toBe(404);
  });
});

describe("POST /api/adapter-endpoints/:id/compose (AP-2 dispatch)", () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    if (app !== undefined) {
      await app.close();
      app = undefined;
    }
  });

  const validBody = {
    aggregationStrategy: "single",
    strictness: "degraded",
    bindings: [{ bindingId: BINDING_ACTIVE, role: "primary" }],
  };

  it("routes an active endpoint to recompose and activates (AP-2.1)", async () => {
    const reader = new FakeStateReader();
    reader.endpoints = [endpoint({ id: ENDPOINT_ACTIVE, status: "active" })];
    const mutator = new FakeMutator();
    app = buildApp(mutator, reader);

    const response = await injectAs(app, TEST_OPERATOR, {
      method: "POST",
      url: `/api/adapter-endpoints/${ENDPOINT_ACTIVE}/compose`,
      payload: validBody,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<ComposeAdapterEndpointResponse>().endpoint.id).toBe(ENDPOINT_ACTIVE);
    expect(mutator.calls).toStrictEqual([
      { op: "recompose", endpointId: ENDPOINT_ACTIVE, actor: "operator", disabledBindingIds: [] },
    ]);
  });

  it("routes a composition-required endpoint to compose (AP-2.1)", async () => {
    const reader = new FakeStateReader();
    reader.endpoints = [endpoint({ id: ENDPOINT_COMPREQ, status: "composition-required" })];
    const mutator = new FakeMutator();
    app = buildApp(mutator, reader);

    const response = await injectAs(app, TEST_OPERATOR, {
      method: "POST",
      url: `/api/adapter-endpoints/${ENDPOINT_COMPREQ}/compose`,
      payload: validBody,
    });

    expect(response.statusCode).toBe(200);
    expect(mutator.calls.map((call) => call.op)).toStrictEqual(["compose"]);
  });

  it("returns 400 with the named violated rules and changes nothing on an invalid composition (AP-2.2)", async () => {
    const reader = new FakeStateReader();
    reader.endpoints = [endpoint({ id: ENDPOINT_ACTIVE, status: "active" })];
    const mutator = new FakeMutator();
    mutator.recomposeError = new BadRequestError("Composition is invalid.", [
      { path: "bindings.0.role", message: "role 'supplement' is invalid for strategy 'single'" },
    ]);
    app = buildApp(mutator, reader);

    const response = await injectAs(app, TEST_OPERATOR, {
      method: "POST",
      url: `/api/adapter-endpoints/${ENDPOINT_ACTIVE}/compose`,
      payload: validBody,
    });

    expect(response.statusCode).toBe(400);
    const body = response.json<ErrorResponse>();
    expect(body.issues).toStrictEqual([
      { path: "bindings.0.role", message: "role 'supplement' is invalid for strategy 'single'" },
    ]);
    // The service raised before any activation — the route surfaced it, nothing else ran.
    expect(mutator.calls.map((call) => call.op)).toStrictEqual(["recompose"]);
  });

  it("forbids a viewer (403) with no composition attempt (AP-2.5)", async () => {
    const reader = new FakeStateReader();
    reader.endpoints = [endpoint({ id: ENDPOINT_ACTIVE, status: "active" })];
    const mutator = new FakeMutator();
    app = buildApp(mutator, reader);

    const response = await injectAs(app, TEST_VIEWER, {
      method: "POST",
      url: `/api/adapter-endpoints/${ENDPOINT_ACTIVE}/compose`,
      payload: validBody,
    });

    expect(response.statusCode).toBe(403);
    expect(mutator.calls).toHaveLength(0);
  });
});

describe("POST enable/disable endpoint + binding (AP-3)", () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    if (app !== undefined) {
      await app.close();
      app = undefined;
    }
  });

  function seedEndpoint(reader: FakeStateReader, bindings: AdapterBinding[]): void {
    reader.endpoints = [endpoint({ id: ENDPOINT_ACTIVE, status: "active" })];
    reader.bindingsByEndpoint.set(ENDPOINT_ACTIVE, bindings);
    reader.mappingStatus.set(MAPPING, "active");
    reader.backendStatus.set(BACKEND_APP, "active");
  }

  it("disables an endpoint → status disabled, attributed to the operator (AP-3.1)", async () => {
    const reader = new FakeStateReader();
    seedEndpoint(reader, [binding({ id: BINDING_ACTIVE })]);
    const mutator = new FakeMutator();
    app = buildApp(mutator, reader);

    const response = await injectAs(app, TEST_OPERATOR, {
      method: "POST",
      url: `/api/adapter-endpoints/${ENDPOINT_ACTIVE}/disable`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<AdapterEndpointStateResponse>().endpoint.status).toBe("disabled");
    expect(mutator.calls).toStrictEqual([
      { op: "setEndpointEnabled", endpointId: ENDPOINT_ACTIVE, actor: "operator", enabled: false },
    ]);
  });

  it("re-enables an endpoint → status active (AP-3.1)", async () => {
    const reader = new FakeStateReader();
    seedEndpoint(reader, [binding({ id: BINDING_ACTIVE })]);
    const mutator = new FakeMutator();
    app = buildApp(mutator, reader);

    const response = await injectAs(app, TEST_OPERATOR, {
      method: "POST",
      url: `/api/adapter-endpoints/${ENDPOINT_ACTIVE}/enable`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<AdapterEndpointStateResponse>().endpoint.status).toBe("active");
    expect(mutator.calls[0]?.enabled).toBe(true);
  });

  it("disables one binding by recomposing with that binding's disabled flag flipped (AP-3.2)", async () => {
    const reader = new FakeStateReader();
    seedEndpoint(reader, [
      binding({ id: BINDING_ACTIVE, status: "active" }),
      binding({ id: BINDING_PROPOSED, status: "active", backendOperationId: "users/getByEmail" }),
    ]);
    const mutator = new FakeMutator();
    app = buildApp(mutator, reader);

    const response = await injectAs(app, TEST_OPERATOR, {
      method: "POST",
      url: `/api/adapter-endpoints/${ENDPOINT_ACTIVE}/bindings/${BINDING_ACTIVE}/disable`,
    });

    expect(response.statusCode).toBe(200);
    expect(mutator.calls).toHaveLength(1);
    const call = mutator.calls[0];
    expect(call?.op).toBe("recompose");
    // Only the target binding is flipped to disabled; the other active binding stays served.
    expect(call?.disabledBindingIds).toStrictEqual([BINDING_ACTIVE]);
  });

  it("rejects a binding-disable that would break the endpoint, with the reason, changing nothing (AP-3.3)", async () => {
    const reader = new FakeStateReader();
    seedEndpoint(reader, [binding({ id: BINDING_ACTIVE, status: "active" })]);
    const mutator = new FakeMutator();
    mutator.recomposeError = new BadRequestError("Composition is invalid.", [
      { path: "bindings", message: "a write endpoint needs exactly one active binding (found 0)" },
    ]);
    app = buildApp(mutator, reader);

    const response = await injectAs(app, TEST_OPERATOR, {
      method: "POST",
      url: `/api/adapter-endpoints/${ENDPOINT_ACTIVE}/bindings/${BINDING_ACTIVE}/disable`,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json<ErrorResponse>().issues?.[0]?.message).toContain(
      "exactly one active binding",
    );
  });

  it("forbids a viewer from disabling an endpoint or a binding (403), nothing changes (AP-3.5)", async () => {
    const reader = new FakeStateReader();
    seedEndpoint(reader, [binding({ id: BINDING_ACTIVE })]);
    const mutator = new FakeMutator();
    app = buildApp(mutator, reader);

    const endpointResponse = await injectAs(app, TEST_VIEWER, {
      method: "POST",
      url: `/api/adapter-endpoints/${ENDPOINT_ACTIVE}/disable`,
    });
    const bindingResponse = await injectAs(app, TEST_VIEWER, {
      method: "POST",
      url: `/api/adapter-endpoints/${ENDPOINT_ACTIVE}/bindings/${BINDING_ACTIVE}/disable`,
    });

    expect(endpointResponse.statusCode).toBe(403);
    expect(bindingResponse.statusCode).toBe(403);
    expect(mutator.calls).toHaveLength(0);
  });
});
