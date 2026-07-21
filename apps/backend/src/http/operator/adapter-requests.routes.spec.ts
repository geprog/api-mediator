import type { AdapterHealthResponse, AdapterRequestHistoryResponse } from "@mediator/contracts";
import type { AdapterRequestQuery } from "@mediator/db";
import type {
  AdapterBinding,
  AdapterEndpoint,
  ApprovedMappingStatus,
  AuditLogEntry,
  RegisteredAppStatus,
} from "@mediator/domain";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import type {
  AdapterRequestHistoryReader,
  AdapterStateReader,
  ConsumerOperationRef,
} from "../../modules/adapter-state.js";
import { TEST_OPERATOR_ACCOUNTS, TEST_VIEWER, injectAs } from "../../testing/auth.testkit.js";
import { LocalAccountsAuthProvider, installAuthentication } from "../auth/index.js";
import { registerErrorHandler } from "../errors.js";
import { registerAdapterRequestRoutes } from "./adapter-requests.routes.js";

/**
 * Route tests for the Phase-5 adapter request-history + endpoint-health reads (AP-5), driven
 * with `fastify.inject()` through the real operator-auth path and in-memory fakes. They assert
 * the HTTP contract: filtering, the degraded/success/failure outcome distinction, metadata-only
 * rows, the health conditions, and viewer access.
 */

const CONSUMER_APP = "11111111-1111-4111-8111-111111111111";
const ENDPOINT = "22222222-2222-4222-8222-222222222222";
const ENDPOINT_COMPREQ = "33333333-3333-4333-8333-333333333333";
const BACKEND_APP = "44444444-4444-4444-8444-444444444444";
const BINDING = "55555555-5555-4555-8555-555555555555";
const BINDING_PROPOSED = "66666666-6666-4666-8666-666666666666";
const MAPPING = "77777777-7777-4777-8777-777777777777";

function auditRow(overrides: Partial<AuditLogEntry> & Pick<AuditLogEntry, "id">): AuditLogEntry {
  return {
    type: "adapter-request",
    actor: `consumer-app:${CONSUMER_APP}`,
    relatedEndpointId: ENDPOINT,
    relatedBindingId: BINDING,
    timestamp: new Date("2026-07-21T00:00:00.000Z"),
    ...overrides,
  };
}

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
    adapterEndpointId: ENDPOINT,
    backendAppId: BACKEND_APP,
    backendOperationId: "users/getById",
    approvedMappingId: MAPPING,
    role: "primary",
    status: "active",
    ...overrides,
  };
}

/** An in-memory {@link AdapterRequestHistoryReader} that filters like the real repo + records the query. */
class FakeHistoryReader implements AdapterRequestHistoryReader {
  public rows: AuditLogEntry[] = [];
  public lastQuery: AdapterRequestQuery | undefined;

  public query(query: AdapterRequestQuery): Promise<AuditLogEntry[]> {
    this.lastQuery = query;
    let result = this.rows;
    if (query.relatedEndpointId !== undefined) {
      result = result.filter((row) => row.relatedEndpointId === query.relatedEndpointId);
    }
    if (query.relatedBindingId !== undefined) {
      result = result.filter((row) => row.relatedBindingId === query.relatedBindingId);
    }
    if (query.status !== undefined) {
      result = result.filter((row) => row.status === query.status);
    }
    if (query.cause !== undefined) {
      result = result.filter((row) => row.cause === query.cause);
    }
    const since = query.since;
    if (since !== undefined) {
      result = result.filter((row) => row.timestamp >= since);
    }
    const until = query.until;
    if (until !== undefined) {
      result = result.filter((row) => row.timestamp <= until);
    }
    return Promise.resolve(result.slice(0, query.limit));
  }
}

/** An in-memory {@link AdapterStateReader} for the AP-5.3 health derivation. */
class FakeStateReader implements AdapterStateReader {
  public endpoints: AdapterEndpoint[] = [];
  public readonly bindingsByEndpoint = new Map<string, AdapterBinding[]>();
  public readonly mappingStatus = new Map<string, ApprovedMappingStatus>();
  public readonly backendStatus = new Map<string, RegisteredAppStatus>();

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
    return Promise.resolve([]);
  }
}

function buildApp(
  state: AdapterStateReader,
  history: AdapterRequestHistoryReader,
): FastifyInstance {
  const app = Fastify();
  void app.register((instance) => {
    installAuthentication(instance, new LocalAccountsAuthProvider(TEST_OPERATOR_ACCOUNTS));
    registerAdapterRequestRoutes(instance, state, history);
    return Promise.resolve();
  });
  registerErrorHandler(app);
  return app;
}

describe("GET /api/adapter-requests (AP-5.1/5.2)", () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    if (app !== undefined) {
      await app.close();
      app = undefined;
    }
  });

  function seedRows(history: FakeHistoryReader): void {
    history.rows = [
      auditRow({
        id: "req-success",
        status: "success",
        traceId: "trace-1",
        spanId: "span-1",
      }),
      auditRow({ id: "req-degraded", status: "success", degraded: true }),
      auditRow({ id: "req-failure", status: "failure", cause: "upstream-error" }),
      auditRow({ id: "req-operator", details: "adapter endpoint composed" }),
    ];
  }

  it("returns the history with outcome, cause, and trace ids; degraded is distinguishable (AP-5.1/5.2)", async () => {
    const history = new FakeHistoryReader();
    seedRows(history);
    app = buildApp(new FakeStateReader(), history);

    const response = await injectAs(app, TEST_VIEWER, {
      method: "GET",
      url: "/api/adapter-requests",
    });

    expect(response.statusCode).toBe(200);
    const rows = response.json<AdapterRequestHistoryResponse>().requests;
    const byId = new Map(rows.map((row) => [row.id, row]));

    expect(byId.get("req-success")?.outcome).toBe("success");
    expect(byId.get("req-success")?.degraded).toBe(false);
    expect(byId.get("req-success")?.traceId).toBe("trace-1");
    expect(byId.get("req-success")?.spanId).toBe("span-1");

    // A degraded response is a success WITH the degraded flag — distinct from a clean success.
    expect(byId.get("req-degraded")?.outcome).toBe("degraded");
    expect(byId.get("req-degraded")?.degraded).toBe(true);

    expect(byId.get("req-failure")?.outcome).toBe("failure");
    expect(byId.get("req-failure")?.cause).toBe("upstream-error");

    // An operator-action row (no execution status) is distinguishable as `other`.
    expect(byId.get("req-operator")?.outcome).toBe("other");
    expect(byId.get("req-operator")?.status).toBeNull();

    // AP-5.4 — metadata only.
    expect(response.body).not.toMatch(/token|secret|password|payload|credential/i);
  });

  it("pushes endpoint/binding/time filters + a bounded limit down to the reader (AP-5.1)", async () => {
    const history = new FakeHistoryReader();
    seedRows(history);
    app = buildApp(new FakeStateReader(), history);

    const response = await injectAs(app, TEST_VIEWER, {
      method: "GET",
      url: `/api/adapter-requests?endpointId=${ENDPOINT}&bindingId=${BINDING}&since=2026-07-20T00:00:00.000Z&until=2026-07-22T00:00:00.000Z&status=failure&limit=50`,
    });

    expect(response.statusCode).toBe(200);
    expect(history.lastQuery).toStrictEqual({
      relatedEndpointId: ENDPOINT,
      relatedBindingId: BINDING,
      since: new Date("2026-07-20T00:00:00.000Z"),
      until: new Date("2026-07-22T00:00:00.000Z"),
      status: "failure",
      limit: 50,
    });
    // Only the failure row matches the pushed-down status filter.
    expect(
      response.json<AdapterRequestHistoryResponse>().requests.map((row) => row.id),
    ).toStrictEqual(["req-failure"]);
  });

  it("defaults to a bounded limit when none is given (AP-5.1)", async () => {
    const history = new FakeHistoryReader();
    app = buildApp(new FakeStateReader(), history);

    const response = await injectAs(app, TEST_VIEWER, {
      method: "GET",
      url: "/api/adapter-requests",
    });

    expect(response.statusCode).toBe(200);
    expect(history.lastQuery?.limit).toBe(100);
  });
});

describe("GET /api/adapter-requests/health (AP-5.3/5.5)", () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    if (app !== undefined) {
      await app.close();
      app = undefined;
    }
  });

  it("surfaces composition-required (age-structural), stale active bindings, and transform errors (AP-5.3)", async () => {
    const state = new FakeStateReader();
    state.endpoints = [
      endpoint({ id: ENDPOINT, status: "active" }),
      endpoint({
        id: ENDPOINT_COMPREQ,
        consumerOperationId: "users/listUsers",
        status: "composition-required",
      }),
    ];
    state.bindingsByEndpoint.set(ENDPOINT, [
      binding({ id: BINDING, adapterEndpointId: ENDPOINT, status: "active" }),
    ]);
    state.bindingsByEndpoint.set(ENDPOINT_COMPREQ, [
      binding({ id: BINDING, adapterEndpointId: ENDPOINT_COMPREQ, status: "active" }),
      binding({ id: BINDING_PROPOSED, adapterEndpointId: ENDPOINT_COMPREQ, status: "proposed" }),
    ]);
    // The active binding's mapping is stale → an unhealthy active binding (AP-5.3).
    state.mappingStatus.set(MAPPING, "stale");
    state.backendStatus.set(BACKEND_APP, "active");

    const history = new FakeHistoryReader();
    history.rows = [
      auditRow({ id: "req-transform", status: "failure", cause: "mediator-transform-error" }),
      auditRow({ id: "req-upstream", status: "failure", cause: "upstream-error" }),
    ];
    app = buildApp(state, history);

    const response = await injectAs(app, TEST_VIEWER, {
      method: "GET",
      url: "/api/adapter-requests/health",
    });

    expect(response.statusCode).toBe(200);
    const health = response.json<AdapterHealthResponse>();

    expect(health.compositionRequired).toStrictEqual([
      {
        endpointId: ENDPOINT_COMPREQ,
        consumerAppId: CONSUMER_APP,
        consumerOperationId: "users/listUsers",
        proposedBindingIds: [BINDING_PROPOSED],
        previousConfigurationServing: true,
      },
    ]);

    // Every active binding whose mapping is stale is surfaced, with its derived cause.
    expect(health.unhealthyBindings).toContainEqual({
      endpointId: ENDPOINT,
      bindingId: BINDING,
      backendAppId: BACKEND_APP,
      cause: "mapping-stale",
    });

    // Only the mediator-transform-error occurrence is surfaced (a mapping/composition defect).
    expect(health.transformErrors.map((row) => row.id)).toStrictEqual(["req-transform"]);
    expect(history.lastQuery?.cause).toBe("mediator-transform-error");
  });

  it("allows a viewer (AP-5.5)", async () => {
    const state = new FakeStateReader();
    app = buildApp(state, new FakeHistoryReader());

    const response = await injectAs(app, TEST_VIEWER, {
      method: "GET",
      url: "/api/adapter-requests/health",
    });

    expect(response.statusCode).toBe(200);
  });
});
