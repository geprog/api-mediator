import { randomUUID } from "node:crypto";

import type { AdapterRequest, ServeHandler, ServeInput } from "@mediator/adapter-engine";
import { loadConfig, type AppConfig } from "@mediator/config";
import {
  adapterBinding,
  adapterEndpoint,
  apiSpec,
  approvedMapping,
  auditLog,
  closeDb,
  createDb,
  fieldMapping,
  operationMapping,
  parameterMapping,
  registeredApp,
  resourceBinding as resourceBindingTable,
  resourceBindingRef,
  runMigrations,
  AdapterCompositionRepository,
  ApiSpecRepository,
  DownstreamArtifactRepository,
  MappingArtifactsRepository,
  RegisteredAppRepository,
  ResourceBindingRepository,
  type Database,
} from "@mediator/db";
import type {
  AdapterEndpoint,
  ApiSpec,
  Ir,
  OperationMapping,
  ParameterMapping,
  RegisteredApp,
  ResourceBinding,
} from "@mediator/domain";
import { AppLoadGovernor } from "@mediator/outbound";
import { inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { BadRequestError } from "../../../app-errors.js";
import { createServerLogger } from "../../../composition-root.js";
import {
  AdapterCompositionService,
  DbCompositionContextLoader,
} from "../../../modules/adapter-composition/index.js";
import { operatorAccountsEnv } from "../../../testing/auth.testkit.js";
import { buildAdapterServeHandler } from "./build-serve-handler.js";

/**
 * **Real-Postgres proof of CO-3 (union composition).** Against a live database and the
 * REAL composition service + serve handler:
 *
 *  - **Persist + activate:** composing a `collection-union` writes `postMergeDedup` /
 *    `postMergeFilters` / `postMergeSorts` / `postMergePagination` and activates the
 *    endpoint; the config reads back through the mapper.
 *  - **CO-3.2:** `link-based` dedup with a contributing backend whose `nativeIdRef` is
 *    unconfirmed is **rejected** (nothing activates).
 *  - **CO-3.7:** a paged backend whose `paginationRef` is present-but-unconfirmed makes the
 *    union **not composable** (rejected).
 *  - **CO-3↔RP-2 contract:** a served union request using a sort parameter with no
 *    configured `postMergeSorts` is **rejected** (`union-parameter-unconfigured`), while one
 *    whose sort/filter/pagination params are all configured **passes RP-2** (it reaches
 *    planning — which is unimplemented for union, AG-3 — and fails there, not at RP-2).
 *  - **Resource-pair scoping:** a binding's pushdown-eligibility facts use ONLY its own
 *    resource pair, never a foreign operationMapping's parameter.
 *
 * Excluded from `pnpm verify`; run with `pnpm --filter @mediator/backend test:integration`.
 */

const ACTOR = "operator:union-integration";

function integrationConfig(): AppConfig {
  return loadConfig({
    ...process.env,
    HTTP_PORT: "14982",
    ADAPTER_HTTP_PORT: "14983",
    DATABASE_URL:
      process.env.DATABASE_URL ?? "postgres://mediator:mediator@localhost:5432/api_mediator",
    CREDENTIAL_MASTER_KEY:
      process.env.CREDENTIAL_MASTER_KEY ?? Buffer.alloc(32, 7).toString("base64"),
    OLLAMA_BASE_URL: process.env.OLLAMA_BASE_URL ?? "http://localhost:11434",
    MAPPING_LLM_MODEL: process.env.MAPPING_LLM_MODEL ?? "test-model",
    MAPPING_LLM_THINKING: process.env.MAPPING_LLM_THINKING ?? "false",
    MAPPING_LLM_REQUEST_TIMEOUT_MS: process.env.MAPPING_LLM_REQUEST_TIMEOUT_MS ?? "300000",
    OTEL_EXPORTER_OTLP_ENDPOINT: process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "",
    OPERATOR_ACCOUNTS: process.env.OPERATOR_ACCOUNTS ?? operatorAccountsEnv(),
  });
}

function activeApp(name: string, baseUrl?: string): RegisteredApp {
  return {
    id: randomUUID(),
    name,
    status: "active",
    ...(baseUrl !== undefined ? { baseUrl } : {}),
    capabilities: {
      supportsPolling: false,
      supportsDeltaQuery: false,
      supportsChangeTimestamps: false,
      defaultPollInterval: 60_000,
    },
    createdAt: new Date(),
  };
}

function specRow(appId: string, role: ApiSpec["role"], ir: Ir): ApiSpec {
  return {
    id: randomUUID(),
    appId,
    role,
    rawDocument: { openapi: "3.1.0", info: { title: role, version: "1" }, paths: {} },
    parsedIR: ir,
    analysisExclusions: [],
    version: 1,
    contentHash: `hash-${randomUUID()}`,
    status: "active",
    createdAt: new Date(),
  };
}

/** A backend list resource with an optional query param (never required — so CO-2.6 is not tripped). */
function backendListResource(resourceRef: string, queryParam?: string): Ir[number] {
  return {
    resourceRef,
    name: resourceRef,
    operations: [
      {
        operationId: `list_${resourceRef}`,
        method: "get",
        path: `/${resourceRef}`,
        parameters:
          queryParam === undefined
            ? []
            : [{ name: queryParam, location: "query", required: false, type: "string" }],
      },
    ],
    schemas: [],
    crossResourceRefs: [],
  };
}

const CONSUMER_LIST_IR: Ir = [
  {
    resourceRef: "todos",
    name: "todos",
    operations: [
      {
        operationId: "listTodos",
        method: "get",
        path: "/todos",
        parameters: [
          { name: "status", location: "query", required: false, type: "string" },
          { name: "sort", location: "query", required: false, type: "string" },
          { name: "order", location: "query", required: false, type: "string" },
          { name: "page", location: "query", required: false, type: "string" },
          { name: "size", location: "query", required: false, type: "string" },
        ],
        responseSchema: {
          name: "Todo",
          fields: [
            { name: "id", type: "string", required: true },
            { name: "title", type: "string", required: true },
            { name: "state", type: "string", required: true },
          ],
        },
      },
    ],
    schemas: [],
    crossResourceRefs: [],
  },
];

const createdAppIds: string[] = [];
const createdSpecIds: string[] = [];
const createdMappingIds: string[] = [];
const createdBindingIds: string[] = [];

describe("adapter union composition (CO-3) — requires Postgres", () => {
  let db: Database;
  let serveHandler: ServeHandler;
  let service: AdapterCompositionService;

  let backendAppId: string;
  let backendSpecId: string;

  let happyEndpointId: string;
  let happyConsumerAppId: string;
  let happyTasksBindingId: string;
  let linkEndpointId: string;
  let pagEndpointId: string;

  async function seedConsumer(appName: string): Promise<{ appId: string; specId: string }> {
    const app = activeApp(appName);
    createdAppIds.push(app.id);
    await new RegisteredAppRepository(db).create(app);
    const spec = specRow(app.id, "CONSUMER", CONSUMER_LIST_IR);
    createdSpecIds.push(spec.id);
    await new ApiSpecRepository(db).create(spec);
    return { appId: app.id, specId: spec.id };
  }

  async function insertMapping(consumerAppId: string, consumerSpecId: string): Promise<string> {
    const mappingId = randomUUID();
    createdMappingIds.push(mappingId);
    await db.insert(approvedMapping).values({
      id: mappingId,
      sourceSpecId: consumerSpecId,
      targetSpecId: backendSpecId,
      sourceAppId: consumerAppId,
      targetAppId: backendAppId,
      variant: "consumer-provider",
      approvedBy: "integration-test",
      approvedAt: new Date(),
      status: "active",
    });
    return mappingId;
  }

  async function seedUnionEndpoint(input: {
    consumerAppName: string;
    backendResources: readonly string[]; // one binding per backend resource
    statusMappedFor?: readonly string[]; // backend resources that map `status`
    withForeignPair?: boolean; // add a foreign-pair ParameterMapping (scoping proof)
  }): Promise<{ endpointId: string; consumerAppId: string; bindingIds: string[] }> {
    const { appId, specId } = await seedConsumer(input.consumerAppName);
    const mappingId = await insertMapping(appId, specId);

    const operationMappings: OperationMapping[] = input.backendResources.map((resource) => ({
      id: randomUUID(),
      mappingId,
      sourceOperationRef: "todos/listTodos",
      targetOperationRef: `${resource}/list_${resource}`,
      action: "read",
    }));
    const parameterMappings: ParameterMapping[] = [];
    input.backendResources.forEach((resource, index) => {
      const op = operationMappings[index];
      if (op !== undefined && (input.statusMappedFor ?? []).includes(resource)) {
        parameterMappings.push({
          id: randomUUID(),
          operationMappingId: op.id,
          sourceParamRef: "todos/listTodos#status",
          targetParamRef: `${resource}/list_${resource}#${resource}Status`,
        });
      }
    });
    if (input.withForeignPair === true) {
      // A foreign-pair operationMapping + parameterMapping that MUST NOT leak into any
      // binding's pushdown facts (resource-pair / operationMapping scoping).
      const foreignOp: OperationMapping = {
        id: randomUUID(),
        mappingId,
        sourceOperationRef: "projects/getProject",
        targetOperationRef: "boards/list_boards",
        action: "read",
      };
      operationMappings.push(foreignOp);
      parameterMappings.push({
        id: randomUUID(),
        operationMappingId: foreignOp.id,
        sourceParamRef: "projects/getProject#foreignFilter",
        targetParamRef: "boards/list_boards#bf",
      });
    }
    await new MappingArtifactsRepository(db).replaceChildren(mappingId, {
      operationMappings,
      parameterMappings,
      fieldMappings: [],
    });

    const artifacts = new DownstreamArtifactRepository(db);
    const endpoint: AdapterEndpoint = {
      id: randomUUID(),
      consumerAppId: appId,
      consumerOperationId: "todos/listTodos",
      status: "composition-required",
    };
    await artifacts.ensureAdapterEndpoint(endpoint);
    const bindingIds: string[] = [];
    for (const resource of input.backendResources) {
      const bindingId = randomUUID();
      bindingIds.push(bindingId);
      createdBindingIds.push(bindingId);
      await artifacts.insertAdapterBindingIfAbsent({
        id: bindingId,
        adapterEndpointId: endpoint.id,
        backendAppId,
        backendOperationId: `${resource}/list_${resource}`,
        approvedMappingId: mappingId,
        role: "supplement",
        status: "proposed",
      });
    }
    return { endpointId: endpoint.id, consumerAppId: appId, bindingIds };
  }

  beforeAll(async () => {
    const config = integrationConfig();
    db = createDb(config.database.url);
    await runMigrations(db);
    serveHandler = buildAdapterServeHandler({
      db,
      logger: createServerLogger(config),
      credentialMasterKey: config.credentials.masterKey,
      loadGovernor: new AppLoadGovernor(),
    });
    service = new AdapterCompositionService({ db, newId: () => randomUUID() });

    // One backend PROVIDER app with four list resources in different ref-confirmation states.
    const backendApp = activeApp("union-backend", "http://127.0.0.1:1");
    backendAppId = backendApp.id;
    createdAppIds.push(backendApp.id);
    await new RegisteredAppRepository(db).create(backendApp);
    const backendSpec = specRow(backendApp.id, "PROVIDER", [
      backendListResource("tasks", "tasksStatus"),
      backendListResource("labels", "labelsStatus"),
      backendListResource("cards"),
      backendListResource("boards"),
    ]);
    backendSpecId = backendSpec.id;
    createdSpecIds.push(backendSpec.id);
    await new ApiSpecRepository(db).create(backendSpec);

    const now = new Date();
    const confirmedOp = (operationId: string): ResourceBinding["collectionReadRef"] => ({
      value: { kind: "operation", operationId },
      confirmedBy: ACTOR,
      confirmedAt: now,
    });
    const bindings: ResourceBinding[] = [
      {
        id: randomUUID(),
        apiSpecId: backendSpecId,
        resourceRef: "tasks",
        nativeIdRef: { value: { kind: "field", path: "id" }, confirmedBy: ACTOR, confirmedAt: now },
        collectionReadRef: confirmedOp("list_tasks"),
        scopePathBindings: [],
      },
      {
        id: randomUUID(),
        apiSpecId: backendSpecId,
        resourceRef: "labels",
        nativeIdRef: { value: { kind: "field", path: "id" }, confirmedBy: ACTOR, confirmedAt: now },
        collectionReadRef: confirmedOp("list_labels"),
        scopePathBindings: [],
      },
      {
        // nativeIdRef DERIVED but UNCONFIRMED — link-based dedup must reject over this.
        id: randomUUID(),
        apiSpecId: backendSpecId,
        resourceRef: "cards",
        nativeIdRef: { value: { kind: "field", path: "id" }, confirmedBy: null, confirmedAt: null },
        collectionReadRef: confirmedOp("list_cards"),
        scopePathBindings: [],
      },
      {
        // paginationRef PRESENT but UNCONFIRMED — the union is not composable over this.
        id: randomUUID(),
        apiSpecId: backendSpecId,
        resourceRef: "boards",
        nativeIdRef: { value: { kind: "field", path: "id" }, confirmedBy: ACTOR, confirmedAt: now },
        collectionReadRef: confirmedOp("list_boards"),
        paginationRef: {
          value: { kind: "parameter", operationId: "list_boards", parameter: "page" },
          confirmedBy: null,
          confirmedAt: null,
        },
        scopePathBindings: [],
      },
    ];
    await new ResourceBindingRepository(db).createMany(bindings);

    const happy = await seedUnionEndpoint({
      consumerAppName: "union-happy-consumer",
      backendResources: ["tasks", "labels"],
      statusMappedFor: ["tasks", "labels"],
      withForeignPair: true,
    });
    happyEndpointId = happy.endpointId;
    happyConsumerAppId = happy.consumerAppId;
    happyTasksBindingId = happy.bindingIds[0] ?? "";

    const link = await seedUnionEndpoint({
      consumerAppName: "union-link-consumer",
      backendResources: ["tasks", "cards"],
      statusMappedFor: ["tasks"],
    });
    linkEndpointId = link.endpointId;

    const pag = await seedUnionEndpoint({
      consumerAppName: "union-pag-consumer",
      backendResources: ["tasks", "boards"],
      statusMappedFor: ["tasks"],
    });
    pagEndpointId = pag.endpointId;
  });

  afterAll(async () => {
    if (createdBindingIds.length > 0) {
      await db.delete(adapterBinding).where(inArray(adapterBinding.id, createdBindingIds));
    }
    const endpointRows = await db
      .select({ id: adapterEndpoint.id })
      .from(adapterEndpoint)
      .where(inArray(adapterEndpoint.consumerAppId, createdAppIds));
    const endpointIds = endpointRows.map((row) => row.id);
    if (endpointIds.length > 0) {
      await db.delete(adapterBinding).where(inArray(adapterBinding.adapterEndpointId, endpointIds));
      await db.delete(adapterEndpoint).where(inArray(adapterEndpoint.id, endpointIds));
    }
    if (createdMappingIds.length > 0) {
      const opRows = await db
        .select({ id: operationMapping.id })
        .from(operationMapping)
        .where(inArray(operationMapping.mappingId, createdMappingIds));
      const opIds = opRows.map((row) => row.id);
      if (opIds.length > 0) {
        await db
          .delete(parameterMapping)
          .where(inArray(parameterMapping.operationMappingId, opIds));
      }
      await db
        .delete(operationMapping)
        .where(inArray(operationMapping.mappingId, createdMappingIds));
      await db.delete(fieldMapping).where(inArray(fieldMapping.mappingId, createdMappingIds));
      await db.delete(approvedMapping).where(inArray(approvedMapping.id, createdMappingIds));
    }
    const rbRows = await db
      .select({ id: resourceBindingTable.id })
      .from(resourceBindingTable)
      .where(inArray(resourceBindingTable.apiSpecId, createdSpecIds));
    const rbIds = rbRows.map((row) => row.id);
    if (rbIds.length > 0) {
      await db
        .delete(resourceBindingRef)
        .where(inArray(resourceBindingRef.resourceBindingId, rbIds));
      await db.delete(resourceBindingTable).where(inArray(resourceBindingTable.id, rbIds));
    }
    await db.delete(auditLog).where(inArray(auditLog.actor, [ACTOR]));
    await db.delete(apiSpec).where(inArray(apiSpec.id, createdSpecIds));
    await db.delete(registeredApp).where(inArray(registeredApp.id, createdAppIds));
    await closeDb(db);
  });

  const validPagination = {
    convention: "page-number" as const,
    pageParamRef: "todos/listTodos#page",
    sizeParamRef: "todos/listTodos#size",
    firstPageNumber: 1,
  };

  it("persists postMerge* config and activates a valid collection-union", async () => {
    const bindings = await new AdapterCompositionRepository(db).listBindings(happyEndpointId);
    const result = await service.compose(
      happyEndpointId,
      {
        aggregationStrategy: "collection-union",
        strictness: "degraded",
        bindings: bindings.map((binding) => ({
          bindingId: binding.id,
          role: "supplement" as const,
        })),
        postMergeDedup: { mode: "none" },
        postMergeFilters: [
          {
            consumerParamRef: "todos/listTodos#status",
            consumerFieldPath: "todos/state",
            operator: "eq",
          },
        ],
        postMergeSorts: [
          {
            consumerParamRef: "todos/listTodos#sort",
            paramValue: "title",
            consumerFieldPath: "todos/title",
            direction: "asc",
          },
        ],
        postMergePagination: validPagination,
        confirmPostMergePagination: true,
        cacheTtl: 30_000,
      },
      ACTOR,
    );
    expect(result.endpoint.status).toBe("active");

    const reloaded = await new AdapterCompositionRepository(db).getEndpointById(happyEndpointId);
    expect(reloaded?.aggregationStrategy).toBe("collection-union");
    expect(reloaded?.postMergeDedup).toEqual({ mode: "none" });
    expect(reloaded?.postMergeFilters).toHaveLength(1);
    expect(reloaded?.postMergeSorts?.[0]?.paramValue).toBe("title");
    expect(reloaded?.postMergePagination?.convention.convention).toBe("page-number");
    // The confirmation was stamped server-side to the operator (never client-supplied).
    expect(reloaded?.postMergePagination?.confirmedBy).toBe(ACTOR);
    expect(reloaded?.postMergePagination?.confirmedAt).toBeInstanceOf(Date);
  });

  it("resource-pair scoping: a binding's pushdown facts use ONLY its own operationMapping's params", async () => {
    const context = await new DbCompositionContextLoader(db).load(happyEndpointId);
    expect(context).toBeDefined();
    if (context === undefined) return;
    const tasksFacts = context.unionBindingFacts.find(
      (facts) => facts.bindingId === happyTasksBindingId,
    );
    expect(tasksFacts).toBeDefined();
    // `status` is mapped for the tasks pair; the foreign pair's `foreignFilter` must NOT leak.
    expect([...(tasksFacts?.pushdownConsumerParamNames ?? [])]).toEqual(["status"]);
  });

  it("CO-3.2: link-based dedup over a backend with an unconfirmed nativeIdRef is rejected (nothing activates)", async () => {
    const bindings = await new AdapterCompositionRepository(db).listBindings(linkEndpointId);
    let rejected: BadRequestError | undefined;
    try {
      await service.compose(
        linkEndpointId,
        {
          aggregationStrategy: "collection-union",
          strictness: "degraded",
          bindings: bindings.map((b) => ({ bindingId: b.id, role: "supplement" as const })),
          postMergeDedup: { mode: "record-link" },
        },
        ACTOR,
      );
    } catch (error) {
      if (error instanceof BadRequestError) rejected = error;
      else throw error;
    }
    expect(rejected).toBeDefined();
    expect(JSON.stringify(rejected?.issues)).toContain("nativeIdRef");
    const endpoint = await new AdapterCompositionRepository(db).getEndpointById(linkEndpointId);
    expect(endpoint?.status).toBe("composition-required");
    expect(endpoint?.postMergeDedup).toBeUndefined();
  });

  it("CO-3.7: a paged backend with an unconfirmed paginationRef makes the union not composable (rejected)", async () => {
    const bindings = await new AdapterCompositionRepository(db).listBindings(pagEndpointId);
    let rejected: BadRequestError | undefined;
    try {
      await service.compose(
        pagEndpointId,
        {
          aggregationStrategy: "collection-union",
          strictness: "degraded",
          bindings: bindings.map((b) => ({ bindingId: b.id, role: "supplement" as const })),
          postMergeDedup: { mode: "none" },
        },
        ACTOR,
      );
    } catch (error) {
      if (error instanceof BadRequestError) rejected = error;
      else throw error;
    }
    expect(rejected).toBeDefined();
    expect(JSON.stringify(rejected?.issues)).toContain("paginationRef");
    const endpoint = await new AdapterCompositionRepository(db).getEndpointById(pagEndpointId);
    expect(endpoint?.status).toBe("composition-required");
  });

  async function serveTodos(query: Record<string, string>): Promise<ServeInput> {
    const compositions = new AdapterCompositionRepository(db);
    const endpoint = await compositions.getEndpointById(happyEndpointId);
    if (endpoint === undefined) throw new Error("happy endpoint missing");
    const bindings = await compositions.listBindings(happyEndpointId);
    const request: AdapterRequest = {
      consumerAppId: happyConsumerAppId,
      operationKey: "todos/listTodos",
      pathParameters: {},
      query,
      headers: {},
      body: undefined,
    };
    return { request, endpoint, activeBindings: bindings.filter((b) => b.status === "active") };
  }

  it("CO-3↔RP-2: a served union request using an unconfigured sort parameter is rejected (distinct cause)", async () => {
    // `order` classifies as a sort parameter with no postMergeSorts entry → rejected at RP-2.
    const outcome = await serveHandler.serve(await serveTodos({ order: "asc" }));
    expect(outcome).toMatchObject({ kind: "rejected", reason: "union-parameter-unconfigured" });
  });

  it("CO-3↔RP-2: a request whose sort/filter/pagination params are all configured passes RP-2", async () => {
    // `sort=title` (configured), `status` (postMergeFilters), `page`/`size` (confirmed
    // pagination) all pass RP-2; the request then reaches planning + the AG-3 union serve,
    // where both contributors' backend (an unreachable base URL) fails the read. Non-strict,
    // both contributors are dropped → no authoritative answer → the request fails as
    // `upstream-error` — proving RP-2 did NOT reject it (it reached execution).
    const outcome = await serveHandler.serve(
      await serveTodos({ sort: "title", status: "open", page: "1", size: "10" }),
    );
    expect(outcome.kind).toBe("failed");
    if (outcome.kind === "failed") {
      expect(outcome.cause).toBe("upstream-error");
    }
  });
});
