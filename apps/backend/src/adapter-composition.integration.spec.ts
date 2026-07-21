import { randomUUID } from "node:crypto";

import type { ComposeAdapterEndpointResponse } from "@mediator/contracts";
import {
  ApiSpecRepository,
  ApprovedMappingRepository,
  MappingArtifactsRepository,
  RegisteredAppRepository,
  adapterBinding,
  adapterEndpoint,
  apiSpec,
  approvedMapping,
  auditLog,
  createDb,
  graphEdge,
  registeredApp,
  resolveDatabaseUrl,
  runMigrations,
  toAdapterBindingInsert,
  toAdapterEndpointInsert,
  tx,
  type Database,
} from "@mediator/db";
import type {
  AdapterBinding,
  AdapterEndpoint,
  ApiSpec,
  ApprovedMapping,
  Ir,
  IrParameter,
  OperationMapping,
  RegisteredApp,
} from "@mediator/domain";
import { and, eq } from "drizzle-orm";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AdapterCompositionService } from "./modules/adapter-composition/index.js";
import { LocalAccountsAuthProvider, installAuthentication } from "./http/auth/index.js";
import { registerErrorHandler } from "./http/errors.js";
import { registerAdapterEndpointRoutes } from "./http/operator/adapter-endpoints.routes.js";
import {
  TEST_OPERATOR_ACCOUNTS,
  TEST_OPERATOR_ALICE,
  TEST_VIEWER,
  injectAs,
} from "./testing/auth.testkit.js";

/**
 * Live-Postgres integration test for Phase-5 **CO-2** — the composition decision and its
 * validation — driven through the **real** operator-auth path, the **real**
 * {@link AdapterCompositionService} (validation + atomic activation + OA-3 attribution),
 * and the **real** `@mediator/db` transaction over a live Postgres. Excluded from
 * `pnpm verify`; run with `pnpm --filter @mediator/backend test:integration`. Self-skips
 * when `DATABASE_URL` is unresolvable; the only external dependency is the database.
 *
 * It proves the CO-2 crux end to end: a `viewer` is `403` and nothing changes (CO-2.9); a
 * composition with an invalid role (CO-2.2) or a non-composable required parameter
 * (CO-2.6, the scenario-4 `{owner}` case) is rejected **loudly by name** and is **inert**
 * — the endpoint stays `composition-required` with its previous configuration untouched
 * (CO-2.8); and a valid composition activates **atomically** — the endpoint returns to
 * `active`, every `proposed` binding becomes `active`, and the action is attributed to the
 * authenticated identity (CO-2.8/2.9).
 */
let databaseUrl: string | undefined;
try {
  databaseUrl = resolveDatabaseUrl(process.env);
} catch {
  databaseUrl = undefined;
}
const suite = databaseUrl === undefined ? describe.skip : describe;

const CREATED_AT = new Date("2026-07-21T00:00:00.000Z");

const CONSUMER_APP = randomUUID();
const CONSUMER_SPEC = randomUUID();

// Endpoint A — a read endpoint whose two backends have no required parameters. Used for
// viewer-403, the invalid-role rejection, and the valid activation.
const A_BACKEND1_APP = randomUUID();
const A_BACKEND1_SPEC = randomUUID();
const A_BACKEND2_APP = randomUUID();
const A_BACKEND2_SPEC = randomUUID();
const A_MAPPING1 = randomUUID();
const A_MAPPING2 = randomUUID();
const ENDPOINT_A = randomUUID();
const A_BINDING1 = randomUUID();
const A_BINDING2 = randomUUID();
const A_CONSUMER_OP = "search/searchIssues";

// Endpoint B — a read endpoint whose first backend operation has a REQUIRED path
// parameter `owner` with no ParameterMapping (the scenario-4 non-composable case).
const B_BACKEND1_APP = randomUUID();
const B_BACKEND1_SPEC = randomUUID();
const B_BACKEND2_APP = randomUUID();
const B_BACKEND2_SPEC = randomUUID();
const B_MAPPING1 = randomUUID();
const B_MAPPING2 = randomUUID();
const ENDPOINT_B = randomUUID();
const B_BINDING1 = randomUUID();
const B_BINDING2 = randomUUID();
const B_CONSUMER_OP = "detail/getIssue";

// Endpoints in a non-`composition-required` state — CO-2 only composes
// `composition-required` endpoints; recomposing an `active`/`disabled` one is CO-6, so the
// service rejects it as a state conflict without touching the endpoint.
const ENDPOINT_ACTIVE = randomUUID();
const ENDPOINT_DISABLED = randomUUID();
const ACTIVE_CONSUMER_OP = "active/getActive";
const DISABLED_CONSUMER_OP = "disabled/getDisabled";
const UNKNOWN_ENDPOINT = randomUUID();

function appOf(id: string, name: string): RegisteredApp {
  return {
    id,
    name,
    status: "active",
    baseUrl: `https://${name}.example.test`,
    capabilities: {
      supportsPolling: true,
      supportsDeltaQuery: false,
      supportsChangeTimestamps: false,
      defaultPollInterval: 60000,
    },
    createdAt: CREATED_AT,
  };
}

function providerSpecOf(id: string, appId: string, ir: Ir): ApiSpec {
  return {
    id,
    appId,
    role: "PROVIDER",
    rawDocument: { openapi: "3.1.0" },
    parsedIR: ir,
    analysisExclusions: [],
    version: 1,
    contentHash: `sha256:${id}`,
    status: "active",
    createdAt: CREATED_AT,
  };
}

function consumerSpecOf(id: string, appId: string): ApiSpec {
  return { ...providerSpecOf(id, appId, []), role: "CONSUMER" };
}

/** A one-operation PROVIDER IR: resource `resourceRef` with a single GET `operationId`. */
function irOf(resourceRef: string, operationId: string, parameters: IrParameter[]): Ir {
  return [
    {
      resourceRef,
      name: resourceRef,
      operations: [{ operationId, method: "get", path: `/${resourceRef}`, parameters }],
      schemas: [],
      crossResourceRefs: [],
    },
  ];
}

function mappingOf(input: {
  readonly id: string;
  readonly targetSpecId: string;
  readonly targetAppId: string;
}): ApprovedMapping {
  return {
    id: input.id,
    sourceSpecId: CONSUMER_SPEC,
    targetSpecId: input.targetSpecId,
    sourceAppId: CONSUMER_APP,
    targetAppId: input.targetAppId,
    variant: "consumer-provider",
    approvedBy: "operator",
    approvedAt: CREATED_AT,
    status: "active",
  };
}

function opMappingOf(
  mappingId: string,
  sourceOperationRef: string,
  targetOperationRef: string,
): OperationMapping {
  return { id: randomUUID(), mappingId, sourceOperationRef, targetOperationRef, action: "read" };
}

function endpointOf(
  id: string,
  consumerOperationId: string,
  status: AdapterEndpoint["status"] = "composition-required",
): AdapterEndpoint {
  // A realistic `composition-required` endpoint: it was auto-activated single/degraded on
  // its first binding (CO-1), then a second binding flipped only its status. The
  // non-`composition-required` variants (active/disabled) carry the same single/degraded
  // serving config, so the boundary tests can assert it survives a rejected recomposition.
  return {
    id,
    consumerAppId: CONSUMER_APP,
    consumerOperationId,
    status,
    aggregationStrategy: "single",
    strictness: "degraded",
  };
}

function bindingOf(input: {
  readonly id: string;
  readonly endpointId: string;
  readonly backendAppId: string;
  readonly backendOperationId: string;
  readonly approvedMappingId: string;
  readonly status: AdapterBinding["status"];
}): AdapterBinding {
  return {
    id: input.id,
    adapterEndpointId: input.endpointId,
    backendAppId: input.backendAppId,
    backendOperationId: input.backendOperationId,
    approvedMappingId: input.approvedMappingId,
    role: "primary",
    status: input.status,
  };
}

async function cleanup(db: Database): Promise<void> {
  await db.delete(auditLog);
  await db.delete(adapterBinding);
  await db.delete(adapterEndpoint);
  await db.delete(graphEdge);
  await db.delete(approvedMapping); // cascades operation/parameter/field mappings
  await db.delete(apiSpec);
  await db.delete(registeredApp);
}

suite("Phase-5 CO-2 endpoint composition integration (requires Postgres)", () => {
  let db: Database;
  let app: FastifyInstance;

  beforeAll(async () => {
    db = createDb(databaseUrl ?? "");
    await runMigrations(db);
    await cleanup(db);

    await tx(db, async (txn) => {
      const apps = new RegisteredAppRepository(txn);
      await apps.create(appOf(CONSUMER_APP, "consumer"));
      await apps.create(appOf(A_BACKEND1_APP, "a-backend-1"));
      await apps.create(appOf(A_BACKEND2_APP, "a-backend-2"));
      await apps.create(appOf(B_BACKEND1_APP, "b-backend-1"));
      await apps.create(appOf(B_BACKEND2_APP, "b-backend-2"));

      const specs = new ApiSpecRepository(txn);
      await specs.create(consumerSpecOf(CONSUMER_SPEC, CONSUMER_APP));
      await specs.create(
        providerSpecOf(A_BACKEND1_SPEC, A_BACKEND1_APP, irOf("issues", "listIssues", [])),
      );
      await specs.create(
        providerSpecOf(A_BACKEND2_SPEC, A_BACKEND2_APP, irOf("tickets", "listTickets", [])),
      );
      // B's first backend op has a REQUIRED path parameter with no consumer counterpart.
      await specs.create(
        providerSpecOf(
          B_BACKEND1_SPEC,
          B_BACKEND1_APP,
          irOf("repos", "getRepo", [{ name: "owner", location: "path", required: true }]),
        ),
      );
      await specs.create(
        providerSpecOf(B_BACKEND2_SPEC, B_BACKEND2_APP, irOf("mirror", "getMirror", [])),
      );

      const mappings = new ApprovedMappingRepository(txn);
      const artifacts = new MappingArtifactsRepository(txn);

      await mappings.insert(
        mappingOf({ id: A_MAPPING1, targetSpecId: A_BACKEND1_SPEC, targetAppId: A_BACKEND1_APP }),
      );
      await artifacts.replaceChildren(A_MAPPING1, {
        fieldMappings: [],
        operationMappings: [opMappingOf(A_MAPPING1, A_CONSUMER_OP, "issues/listIssues")],
        parameterMappings: [],
      });
      await mappings.insert(
        mappingOf({ id: A_MAPPING2, targetSpecId: A_BACKEND2_SPEC, targetAppId: A_BACKEND2_APP }),
      );
      await artifacts.replaceChildren(A_MAPPING2, {
        fieldMappings: [],
        operationMappings: [opMappingOf(A_MAPPING2, A_CONSUMER_OP, "tickets/listTickets")],
        parameterMappings: [],
      });

      await mappings.insert(
        mappingOf({ id: B_MAPPING1, targetSpecId: B_BACKEND1_SPEC, targetAppId: B_BACKEND1_APP }),
      );
      await artifacts.replaceChildren(B_MAPPING1, {
        fieldMappings: [],
        // No ParameterMapping → the required `owner` path parameter is uncovered.
        operationMappings: [opMappingOf(B_MAPPING1, B_CONSUMER_OP, "repos/getRepo")],
        parameterMappings: [],
      });
      await mappings.insert(
        mappingOf({ id: B_MAPPING2, targetSpecId: B_BACKEND2_SPEC, targetAppId: B_BACKEND2_APP }),
      );
      await artifacts.replaceChildren(B_MAPPING2, {
        fieldMappings: [],
        operationMappings: [opMappingOf(B_MAPPING2, B_CONSUMER_OP, "mirror/getMirror")],
        parameterMappings: [],
      });

      // Endpoint A: composition-required, one active + one proposed binding.
      await txn
        .insert(adapterEndpoint)
        .values(toAdapterEndpointInsert(endpointOf(ENDPOINT_A, A_CONSUMER_OP)));
      await txn.insert(adapterBinding).values(
        toAdapterBindingInsert(
          bindingOf({
            id: A_BINDING1,
            endpointId: ENDPOINT_A,
            backendAppId: A_BACKEND1_APP,
            backendOperationId: "issues/listIssues",
            approvedMappingId: A_MAPPING1,
            status: "active",
          }),
        ),
      );
      await txn.insert(adapterBinding).values(
        toAdapterBindingInsert(
          bindingOf({
            id: A_BINDING2,
            endpointId: ENDPOINT_A,
            backendAppId: A_BACKEND2_APP,
            backendOperationId: "tickets/listTickets",
            approvedMappingId: A_MAPPING2,
            status: "proposed",
          }),
        ),
      );

      // Endpoint B: composition-required, one active (uncovered required param) + one proposed.
      await txn
        .insert(adapterEndpoint)
        .values(toAdapterEndpointInsert(endpointOf(ENDPOINT_B, B_CONSUMER_OP)));
      await txn.insert(adapterBinding).values(
        toAdapterBindingInsert(
          bindingOf({
            id: B_BINDING1,
            endpointId: ENDPOINT_B,
            backendAppId: B_BACKEND1_APP,
            backendOperationId: "repos/getRepo",
            approvedMappingId: B_MAPPING1,
            status: "active",
          }),
        ),
      );
      await txn.insert(adapterBinding).values(
        toAdapterBindingInsert(
          bindingOf({
            id: B_BINDING2,
            endpointId: ENDPOINT_B,
            backendAppId: B_BACKEND2_APP,
            backendOperationId: "mirror/getMirror",
            approvedMappingId: B_MAPPING2,
            status: "proposed",
          }),
        ),
      );

      // Non-composition-required endpoints for the CO-2 state-boundary tests (no bindings
      // needed — the status pre-check rejects before any validation).
      await txn
        .insert(adapterEndpoint)
        .values(toAdapterEndpointInsert(endpointOf(ENDPOINT_ACTIVE, ACTIVE_CONSUMER_OP, "active")));
      await txn
        .insert(adapterEndpoint)
        .values(
          toAdapterEndpointInsert(endpointOf(ENDPOINT_DISABLED, DISABLED_CONSUMER_OP, "disabled")),
        );
    });

    app = Fastify();
    const service = new AdapterCompositionService({ db, newId: randomUUID });
    void app.register((instance) => {
      installAuthentication(instance, new LocalAccountsAuthProvider(TEST_OPERATOR_ACCOUNTS));
      registerAdapterEndpointRoutes(instance, service);
      return Promise.resolve();
    });
    registerErrorHandler(app);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await cleanup(db);
    await db.$client.end();
  });

  /** Read the endpoint + its bindings (by mapping) straight from the db. */
  async function readEndpointA(): Promise<{
    readonly status: AdapterEndpoint["status"];
    readonly strategy: string | null;
    readonly binding1Status: string | undefined;
    readonly binding2Status: string | undefined;
  }> {
    const [endpointRow] = await db
      .select()
      .from(adapterEndpoint)
      .where(eq(adapterEndpoint.id, ENDPOINT_A));
    const bindings = await db
      .select()
      .from(adapterBinding)
      .where(eq(adapterBinding.adapterEndpointId, ENDPOINT_A));
    const byId = new Map(bindings.map((b) => [b.id, b]));
    return {
      status: endpointRow?.status ?? "disabled",
      strategy: endpointRow?.aggregationStrategy ?? null,
      binding1Status: byId.get(A_BINDING1)?.status,
      binding2Status: byId.get(A_BINDING2)?.status,
    };
  }

  const validEndpointABody = {
    aggregationStrategy: "fanout-merge",
    strictness: "degraded",
    cacheTtl: 60000,
    bindings: [
      { bindingId: A_BINDING1, role: "primary" },
      { bindingId: A_BINDING2, role: "supplement" },
    ],
  };

  it("CO-2.9: a viewer is 403 and nothing changes", async () => {
    const response = await injectAs(app, TEST_VIEWER, {
      method: "POST",
      url: `/api/adapter-endpoints/${ENDPOINT_A}/compose`,
      payload: validEndpointABody,
    });
    expect(response.statusCode).toBe(403);

    const after = await readEndpointA();
    expect(after.status).toBe("composition-required");
    expect(after.strategy).toBe("single");
    expect(after.binding1Status).toBe("active");
    expect(after.binding2Status).toBe("proposed");
    // No composition audit row was written.
    const audits = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.relatedEndpointId, ENDPOINT_A));
    expect(audits).toHaveLength(0);
  });

  it("CO-2.2 + CO-2.8: an invalid role is rejected 400 by name and the composition is inert", async () => {
    const response = await injectAs(app, TEST_OPERATOR_ALICE, {
      method: "POST",
      url: `/api/adapter-endpoints/${ENDPOINT_A}/compose`,
      // collection-union permits `supplement` only — `primary` is invalid (CO-2.2).
      payload: {
        aggregationStrategy: "collection-union",
        strictness: "degraded",
        bindings: [
          { bindingId: A_BINDING1, role: "primary" },
          { bindingId: A_BINDING2, role: "supplement" },
        ],
      },
    });
    expect(response.statusCode).toBe(400);
    const messages = JSON.stringify(response.json());
    expect(messages).toContain("collection-union");
    expect(messages).toContain("primary");

    // Inert: the endpoint keeps serving its previous configuration.
    const after = await readEndpointA();
    expect(after.status).toBe("composition-required");
    expect(after.strategy).toBe("single");
    expect(after.binding1Status).toBe("active");
    expect(after.binding2Status).toBe("proposed");
  });

  it("CO-2.6 + CO-2.8: a non-composable required parameter is rejected 400 by name and inert", async () => {
    const response = await injectAs(app, TEST_OPERATOR_ALICE, {
      method: "POST",
      url: `/api/adapter-endpoints/${ENDPOINT_B}/compose`,
      payload: {
        aggregationStrategy: "fanout-merge",
        strictness: "degraded",
        bindings: [
          { bindingId: B_BINDING1, role: "primary" },
          { bindingId: B_BINDING2, role: "supplement" },
        ],
      },
    });
    expect(response.statusCode).toBe(400);
    // The offending parameter is named (CO-2.6).
    expect(JSON.stringify(response.json())).toContain("owner");

    const [endpointRow] = await db
      .select()
      .from(adapterEndpoint)
      .where(eq(adapterEndpoint.id, ENDPOINT_B));
    expect(endpointRow?.status).toBe("composition-required");
    const proposedStill = await db
      .select()
      .from(adapterBinding)
      .where(and(eq(adapterBinding.id, B_BINDING2), eq(adapterBinding.status, "proposed")));
    expect(proposedStill).toHaveLength(1);
  });

  it("CO-2.8 + CO-2.9: a valid composition activates atomically and is attributed", async () => {
    const response = await injectAs(app, TEST_OPERATOR_ALICE, {
      method: "POST",
      url: `/api/adapter-endpoints/${ENDPOINT_A}/compose`,
      payload: validEndpointABody,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<ComposeAdapterEndpointResponse>();
    expect(body.endpoint.status).toBe("active");
    expect(body.endpoint.aggregationStrategy).toBe("fanout-merge");
    expect(body.endpoint.strictness).toBe("degraded");
    expect(body.endpoint.cacheTtl).toBe(60000);
    expect(body.bindings.every((binding) => binding.status === "active")).toBe(true);
    const rolesById = new Map(body.bindings.map((binding) => [binding.id, binding.role]));
    expect(rolesById.get(A_BINDING1)).toBe("primary");
    expect(rolesById.get(A_BINDING2)).toBe("supplement");

    // Persisted state: every proposed binding is now active, endpoint active (CO-2.8).
    const after = await readEndpointA();
    expect(after.status).toBe("active");
    expect(after.strategy).toBe("fanout-merge");
    expect(after.binding1Status).toBe("active");
    expect(after.binding2Status).toBe("active");
    const [endpointRow] = await db
      .select()
      .from(adapterEndpoint)
      .where(eq(adapterEndpoint.id, ENDPOINT_A));
    expect(endpointRow?.cacheTtl).toBe(60000);

    // Attributed to the authenticated identity, metadata only (OA-3 / CO-2.9).
    const audits = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.relatedEndpointId, ENDPOINT_A));
    expect(audits).toHaveLength(1);
    expect(audits[0]?.type).toBe("adapter-request");
    expect(audits[0]?.actor).toBe(TEST_OPERATOR_ALICE.username);
    expect(audits[0]?.details).toContain("composed");
    // Metadata only — no request/response status or degraded flag on a composition row.
    expect(audits[0]?.status).toBeNull();
  });

  // The state boundary (service.ts): CO-2 composes only `composition-required` endpoints.
  const anyValidBody = {
    aggregationStrategy: "single",
    strictness: "degraded",
    bindings: [{ bindingId: randomUUID(), role: "primary" }],
  };

  it("state boundary: composing an active endpoint is 409 and writes nothing (recomposition is CO-6)", async () => {
    const response = await injectAs(app, TEST_OPERATOR_ALICE, {
      method: "POST",
      url: `/api/adapter-endpoints/${ENDPOINT_ACTIVE}/compose`,
      payload: anyValidBody,
    });
    expect(response.statusCode).toBe(409);

    const [endpointRow] = await db
      .select()
      .from(adapterEndpoint)
      .where(eq(adapterEndpoint.id, ENDPOINT_ACTIVE));
    expect(endpointRow?.status).toBe("active");
    expect(endpointRow?.aggregationStrategy).toBe("single");
    const audits = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.relatedEndpointId, ENDPOINT_ACTIVE));
    expect(audits).toHaveLength(0);
  });

  it("state boundary: composing a disabled endpoint is 409 and writes nothing", async () => {
    const response = await injectAs(app, TEST_OPERATOR_ALICE, {
      method: "POST",
      url: `/api/adapter-endpoints/${ENDPOINT_DISABLED}/compose`,
      payload: anyValidBody,
    });
    expect(response.statusCode).toBe(409);

    const [endpointRow] = await db
      .select()
      .from(adapterEndpoint)
      .where(eq(adapterEndpoint.id, ENDPOINT_DISABLED));
    expect(endpointRow?.status).toBe("disabled");
    const audits = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.relatedEndpointId, ENDPOINT_DISABLED));
    expect(audits).toHaveLength(0);
  });

  it("state boundary: composing an unknown endpoint id is 404", async () => {
    const response = await injectAs(app, TEST_OPERATOR_ALICE, {
      method: "POST",
      url: `/api/adapter-endpoints/${UNKNOWN_ENDPOINT}/compose`,
      payload: anyValidBody,
    });
    expect(response.statusCode).toBe(404);
  });
});
