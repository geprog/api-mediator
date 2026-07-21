import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
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
  credential,
  fieldMapping,
  operationMapping,
  parameterMapping,
  registeredApp,
  runMigrations,
  AdapterCompositionRepository,
  ApiSpecRepository,
  DownstreamArtifactRepository,
  MappingArtifactsRepository,
  RegisteredAppRepository,
  type Database,
} from "@mediator/db";
import type {
  AdapterBinding,
  AdapterEndpoint,
  ApiSpec,
  FieldMapping,
  Ir,
  MappingPhase,
  OperationMapping,
  ParameterMapping,
  RegisteredApp,
} from "@mediator/domain";
import { AppLoadGovernor } from "@mediator/outbound";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createServerLogger } from "../../../composition-root.js";
import { operatorAccountsEnv } from "../../../testing/auth.testkit.js";
import {
  AdapterCompositionService,
  DbCompositionContextLoader,
} from "../../../modules/adapter-composition/index.js";
import { BadRequestError } from "../../../app-errors.js";
import { buildAdapterServeHandler } from "./build-serve-handler.js";

/**
 * **Real-Postgres proof of CO-5** — the consumer-input coverage + acknowledgement
 * behaviour, against a live database (and, for the serve half, the REAL injected
 * `ServeHandler` + a stub HTTP backend):
 *
 *  - **RP-2 refinement (CO-5.4):** a request supplying an unmapped consumer parameter the
 *    endpoint **acknowledged-ignored** is *served* with the parameter dropped; the same
 *    request with **no** acknowledgement is **rejected** `unmapped-consumer-input` (RP-2.4)
 *    with no backend call.
 *  - **Acknowledgement persistence:** composing with an acknowledgement writes it to the
 *    endpoint and it reads back through the mapper.
 *  - **CO-5.3 blocking:** a *required* consumer input reaching no backend rejects the
 *    composition (nothing activates — the endpoint stays `composition-required`).
 *  - **Resource-pair scoping:** a two-pair mapping's per-binding coverage/supplied-field
 *    facts reflect **only** the binding's own pair — never a foreign pair's mappings.
 *
 * Excluded from `pnpm verify`; run with `pnpm --filter @mediator/backend test:integration`.
 */

const ACTOR = "operator:integration";

function integrationConfig(): AppConfig {
  return loadConfig({
    ...process.env,
    HTTP_PORT: "14980",
    ADAPTER_HTTP_PORT: "14981",
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

/** A recording stub backend for `GET /tasks/{taskId}`. */
class StubBackend {
  #server: Server | undefined;
  public readonly requests: { method: string; url: string }[] = [];

  public async start(): Promise<void> {
    this.#server = createServer((request: IncomingMessage, response: ServerResponse) => {
      this.requests.push({ method: request.method ?? "", url: request.url ?? "" });
      const match = /^\/tasks\/([^/?]+)/.exec(request.url ?? "");
      if (request.method === "GET" && match) {
        const taskId = decodeURIComponent(match[1] ?? "");
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({ task_id: taskId, task_title: `Task ${taskId}`, completed: true }),
        );
        return;
      }
      response.writeHead(404, { "content-type": "application/json" });
      response.end("{}");
    });
    await new Promise<void>((resolve) => this.#server?.listen(0, "127.0.0.1", resolve));
  }

  public url(): string {
    const address = this.#server?.address();
    if (address === null || address === undefined || typeof address === "string") {
      throw new Error("stub backend is not listening");
    }
    return `http://127.0.0.1:${String(address.port)}`;
  }

  public async stop(): Promise<void> {
    const server = this.#server;
    if (server === undefined) return;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }
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

function renameField(
  mappingId: string,
  sourcePath: string,
  targetPath: string,
  phase: MappingPhase,
): FieldMapping {
  return { id: randomUUID(), mappingId, sourcePath, targetPath, transform: "rename", phase };
}

const backendIr: Ir = [
  {
    resourceRef: "tasks",
    name: "tasks",
    operations: [
      {
        operationId: "getTask",
        method: "get",
        path: "/tasks/{taskId}",
        parameters: [{ name: "taskId", location: "path", required: true, type: "string" }],
      },
    ],
    schemas: [],
    crossResourceRefs: [],
  },
  {
    resourceRef: "workspaces",
    name: "workspaces",
    operations: [
      {
        operationId: "getWorkspace",
        method: "get",
        path: "/workspaces/{workspaceId}",
        parameters: [{ name: "workspaceId", location: "path", required: true, type: "string" }],
      },
    ],
    schemas: [],
    crossResourceRefs: [],
  },
];

const todoResponseSchema = {
  name: "Todo",
  fields: [
    { name: "id", type: "string", required: true },
    { name: "title", type: "string", required: true },
    { name: "done", type: "boolean", required: true },
  ],
};

describe("adapter composition coverage + acknowledgement (requires Postgres)", () => {
  let db: Database;
  let serveHandler: ServeHandler;
  const stub = new StubBackend();

  const createdAppIds: string[] = [];
  const createdSpecIds: string[] = [];
  const createdMappingIds: string[] = [];

  let backendAppId: string;
  let backendSpecId: string;

  // Serve scenario (RP-2 refinement).
  let serveConsumerAppId: string;
  let serveEndpointId: string;

  // Composition-service scenarios.
  let blockingEndpointId: string;
  let ackEndpointId: string;
  let twoPairTodosEndpointId: string;

  async function seedConsumerSpec(
    appName: string,
    ir: Ir,
  ): Promise<{ appId: string; specId: string }> {
    const app = activeApp(appName);
    createdAppIds.push(app.id);
    await new RegisteredAppRepository(db).create(app);
    const spec = specRow(app.id, "CONSUMER", ir);
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

  beforeAll(async () => {
    const config = integrationConfig();
    db = createDb(config.database.url);
    await runMigrations(db);
    await stub.start();
    serveHandler = buildAdapterServeHandler({
      db,
      logger: createServerLogger(config),
      credentialMasterKey: config.credentials.masterKey,
      loadGovernor: new AppLoadGovernor(),
    });

    const backendApp = activeApp("coverage-backend", stub.url());
    backendAppId = backendApp.id;
    createdAppIds.push(backendApp.id);
    await new RegisteredAppRepository(db).create(backendApp);
    const backendSpec = specRow(backendApp.id, "PROVIDER", backendIr);
    backendSpecId = backendSpec.id;
    createdSpecIds.push(backendSpec.id);
    await new ApiSpecRepository(db).create(backendSpec);

    const artifacts = new DownstreamArtifactRepository(db);

    // ── Serve scenario: getTodo with an unmapped optional query param `note`. ──
    {
      const consumerIr: Ir = [
        {
          resourceRef: "todos",
          name: "todos",
          operations: [
            {
              operationId: "getTodo",
              method: "get",
              path: "/todos/{todoId}",
              parameters: [
                { name: "todoId", location: "path", required: true, type: "string" },
                { name: "note", location: "query", required: false, type: "string" },
              ],
              responseSchema: todoResponseSchema,
            },
          ],
          schemas: [],
          crossResourceRefs: [],
        },
      ];
      const { appId, specId } = await seedConsumerSpec("coverage-serve-consumer", consumerIr);
      serveConsumerAppId = appId;
      const mappingId = await insertMapping(appId, specId);
      const op: OperationMapping = {
        id: randomUUID(),
        mappingId,
        sourceOperationRef: "todos/getTodo",
        targetOperationRef: "tasks/getTask",
        action: "read",
      };
      const param: ParameterMapping = {
        id: randomUUID(),
        operationMappingId: op.id,
        sourceParamRef: "todos/getTodo#todoId",
        targetParamRef: "tasks/getTask#taskId",
      };
      await new MappingArtifactsRepository(db).replaceChildren(mappingId, {
        operationMappings: [op],
        parameterMappings: [param],
        fieldMappings: [
          renameField(mappingId, "tasks/task_id", "todos/id", "response"),
          renameField(mappingId, "tasks/task_title", "todos/title", "response"),
          renameField(mappingId, "tasks/completed", "todos/done", "response"),
        ],
      });
      const endpoint: AdapterEndpoint = {
        id: randomUUID(),
        consumerAppId: appId,
        consumerOperationId: "todos/getTodo",
        status: "active",
        aggregationStrategy: "single",
      };
      serveEndpointId = endpoint.id;
      await artifacts.ensureAdapterEndpoint(endpoint);
      await artifacts.insertAdapterBindingIfAbsent({
        id: randomUUID(),
        adapterEndpointId: endpoint.id,
        backendAppId,
        backendOperationId: "tasks/getTask",
        approvedMappingId: mappingId,
        role: "primary",
        status: "active",
      });
    }

    // ── Blocking scenario: getTodo with a REQUIRED unmapped query param `tenant`. ──
    {
      const consumerIr: Ir = [
        {
          resourceRef: "todos",
          name: "todos",
          operations: [
            {
              operationId: "getTodo",
              method: "get",
              path: "/todos/{todoId}",
              parameters: [
                { name: "todoId", location: "path", required: true, type: "string" },
                { name: "tenant", location: "query", required: true, type: "string" },
              ],
              responseSchema: todoResponseSchema,
            },
          ],
          schemas: [],
          crossResourceRefs: [],
        },
      ];
      const { appId, specId } = await seedConsumerSpec("coverage-blocking-consumer", consumerIr);
      const mappingId = await insertMapping(appId, specId);
      const op: OperationMapping = {
        id: randomUUID(),
        mappingId,
        sourceOperationRef: "todos/getTodo",
        targetOperationRef: "tasks/getTask",
        action: "read",
      };
      const param: ParameterMapping = {
        id: randomUUID(),
        operationMappingId: op.id,
        sourceParamRef: "todos/getTodo#todoId",
        targetParamRef: "tasks/getTask#taskId",
      };
      await new MappingArtifactsRepository(db).replaceChildren(mappingId, {
        operationMappings: [op],
        parameterMappings: [param],
        fieldMappings: [renameField(mappingId, "tasks/task_id", "todos/id", "response")],
      });
      const endpoint: AdapterEndpoint = {
        id: randomUUID(),
        consumerAppId: appId,
        consumerOperationId: "todos/getTodo",
        status: "composition-required",
        aggregationStrategy: "single",
      };
      blockingEndpointId = endpoint.id;
      await artifacts.ensureAdapterEndpoint(endpoint);
      await artifacts.insertAdapterBindingIfAbsent({
        id: randomUUID(),
        adapterEndpointId: endpoint.id,
        backendAppId,
        backendOperationId: "tasks/getTask",
        approvedMappingId: mappingId,
        role: "primary",
        status: "proposed",
      });
    }

    // ── Ack-persistence scenario: getTodo with an optional unmapped query param `note`. ──
    {
      const consumerIr: Ir = [
        {
          resourceRef: "todos",
          name: "todos",
          operations: [
            {
              operationId: "getTodo",
              method: "get",
              path: "/todos/{todoId}",
              parameters: [
                { name: "todoId", location: "path", required: true, type: "string" },
                { name: "note", location: "query", required: false, type: "string" },
              ],
              responseSchema: todoResponseSchema,
            },
          ],
          schemas: [],
          crossResourceRefs: [],
        },
      ];
      const { appId, specId } = await seedConsumerSpec("coverage-ack-consumer", consumerIr);
      const mappingId = await insertMapping(appId, specId);
      const op: OperationMapping = {
        id: randomUUID(),
        mappingId,
        sourceOperationRef: "todos/getTodo",
        targetOperationRef: "tasks/getTask",
        action: "read",
      };
      const param: ParameterMapping = {
        id: randomUUID(),
        operationMappingId: op.id,
        sourceParamRef: "todos/getTodo#todoId",
        targetParamRef: "tasks/getTask#taskId",
      };
      await new MappingArtifactsRepository(db).replaceChildren(mappingId, {
        operationMappings: [op],
        parameterMappings: [param],
        fieldMappings: [renameField(mappingId, "tasks/task_id", "todos/id", "response")],
      });
      const endpoint: AdapterEndpoint = {
        id: randomUUID(),
        consumerAppId: appId,
        consumerOperationId: "todos/getTodo",
        status: "composition-required",
        aggregationStrategy: "single",
      };
      ackEndpointId = endpoint.id;
      await artifacts.ensureAdapterEndpoint(endpoint);
      await artifacts.insertAdapterBindingIfAbsent({
        id: randomUUID(),
        adapterEndpointId: endpoint.id,
        backendAppId,
        backendOperationId: "tasks/getTask",
        approvedMappingId: mappingId,
        role: "primary",
        status: "proposed",
      });
    }

    // ── Two-pair scenario: one mapping over todos↔tasks and projects↔workspaces. ──
    {
      const consumerIr: Ir = [
        {
          resourceRef: "todos",
          name: "todos",
          operations: [
            {
              operationId: "getTodo",
              method: "get",
              path: "/todos/{todoId}",
              parameters: [{ name: "todoId", location: "path", required: true, type: "string" }],
              requestSchema: {
                name: "TodoBody",
                fields: [{ name: "title", type: "string", required: false }],
              },
              responseSchema: todoResponseSchema,
            },
          ],
          schemas: [],
          crossResourceRefs: [],
        },
        {
          resourceRef: "projects",
          name: "projects",
          operations: [
            {
              operationId: "getProject",
              method: "get",
              path: "/projects/{projectId}",
              parameters: [{ name: "projectId", location: "path", required: true, type: "string" }],
              requestSchema: {
                name: "ProjectBody",
                fields: [{ name: "name", type: "string", required: false }],
              },
              responseSchema: {
                name: "Project",
                fields: [
                  { name: "id", type: "string", required: true },
                  { name: "name", type: "string", required: true },
                ],
              },
            },
          ],
          schemas: [],
          crossResourceRefs: [],
        },
      ];
      const { appId, specId } = await seedConsumerSpec("coverage-twopair-consumer", consumerIr);
      const mappingId = await insertMapping(appId, specId);
      const todosOp: OperationMapping = {
        id: randomUUID(),
        mappingId,
        sourceOperationRef: "todos/getTodo",
        targetOperationRef: "tasks/getTask",
        action: "read",
      };
      const projectsOp: OperationMapping = {
        id: randomUUID(),
        mappingId,
        sourceOperationRef: "projects/getProject",
        targetOperationRef: "workspaces/getWorkspace",
        action: "read",
      };
      await new MappingArtifactsRepository(db).replaceChildren(mappingId, {
        operationMappings: [todosOp, projectsOp],
        parameterMappings: [
          {
            id: randomUUID(),
            operationMappingId: todosOp.id,
            sourceParamRef: "todos/getTodo#todoId",
            targetParamRef: "tasks/getTask#taskId",
          },
          {
            id: randomUUID(),
            operationMappingId: projectsOp.id,
            sourceParamRef: "projects/getProject#projectId",
            targetParamRef: "workspaces/getWorkspace#workspaceId",
          },
        ],
        fieldMappings: [
          // pair 1 (todos↔tasks): response + request phase.
          renameField(mappingId, "tasks/task_id", "todos/id", "response"),
          renameField(mappingId, "tasks/task_title", "todos/title", "response"),
          renameField(mappingId, "tasks/completed", "todos/done", "response"),
          renameField(mappingId, "todos/title", "tasks/task_title", "request"),
          // pair 2 (projects↔workspaces): response + request phase — must NOT leak into pair 1.
          renameField(mappingId, "workspaces/ws_id", "projects/id", "response"),
          renameField(mappingId, "workspaces/ws_name", "projects/name", "response"),
          renameField(mappingId, "projects/name", "workspaces/ws_name", "request"),
        ],
      });
      for (const pair of [
        { op: "todos/getTodo", backendOp: "tasks/getTask" },
        { op: "projects/getProject", backendOp: "workspaces/getWorkspace" },
      ]) {
        const endpoint: AdapterEndpoint = {
          id: randomUUID(),
          consumerAppId: appId,
          consumerOperationId: pair.op,
          status: "active",
          aggregationStrategy: "single",
        };
        if (pair.op === "todos/getTodo") twoPairTodosEndpointId = endpoint.id;
        await artifacts.ensureAdapterEndpoint(endpoint);
        await artifacts.insertAdapterBindingIfAbsent({
          id: randomUUID(),
          adapterEndpointId: endpoint.id,
          backendAppId,
          backendOperationId: pair.backendOp,
          approvedMappingId: mappingId,
          role: "primary",
          status: "active",
        });
      }
    }
  });

  afterAll(async () => {
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
    await db.delete(auditLog).where(inArray(auditLog.actor, [ACTOR]));
    await db.delete(credential).where(inArray(credential.appId, createdAppIds));
    await db.delete(apiSpec).where(inArray(apiSpec.id, createdSpecIds));
    await db.delete(registeredApp).where(inArray(registeredApp.id, createdAppIds));
    await stub.stop();
    await closeDb(db);
  });

  function serveInputFor(
    endpoint: AdapterEndpoint,
    bindings: readonly AdapterBinding[],
    query: Record<string, string>,
  ): ServeInput {
    const request: AdapterRequest = {
      consumerAppId: serveConsumerAppId,
      operationKey: "todos/getTodo",
      pathParameters: { todoId: "42" },
      query,
      headers: {},
      body: undefined,
    };
    return { request, endpoint, activeBindings: bindings.filter((b) => b.status === "active") };
  }

  async function loadServeState(): Promise<{
    endpoint: AdapterEndpoint;
    bindings: AdapterBinding[];
  }> {
    const compositions = new AdapterCompositionRepository(db);
    const endpoint = await compositions.getEndpointById(serveEndpointId);
    if (endpoint === undefined) throw new Error("serve endpoint missing");
    const bindings = await compositions.listBindings(serveEndpointId);
    return { endpoint, bindings };
  }

  it("RP-2.4: a supplied unmapped parameter with NO acknowledgement rejects, with no backend call", async () => {
    const { endpoint, bindings } = await loadServeState();
    expect(endpoint.acknowledgedIgnoredInputs).toBeUndefined();
    const before = stub.requests.length;
    const outcome = await serveHandler.serve(serveInputFor(endpoint, bindings, { note: "hi" }));
    expect(outcome).toMatchObject({ kind: "rejected", reason: "unmapped-consumer-input" });
    expect(stub.requests.length).toBe(before);
  });

  it("CO-5.4: after acknowledging the input, the same request is served with the input dropped", async () => {
    // Persist the acknowledgement on the endpoint (round-trips through the jsonb mapper).
    await db
      .update(adapterEndpoint)
      .set({ acknowledgedIgnoredInputs: [{ kind: "parameter", consumerParamName: "note" }] })
      .where(eq(adapterEndpoint.id, serveEndpointId));

    const { endpoint, bindings } = await loadServeState();
    expect(endpoint.acknowledgedIgnoredInputs).toEqual([
      { kind: "parameter", consumerParamName: "note" },
    ]);

    const before = stub.requests.length;
    const outcome = await serveHandler.serve(serveInputFor(endpoint, bindings, { note: "hi" }));
    expect(outcome).toMatchObject({
      kind: "served",
      body: { id: "42", title: "Task 42", done: true },
    });
    // The backend was called WITHOUT the dropped `note` — exactly the mapped path.
    expect(stub.requests.length).toBe(before + 1);
    expect(stub.requests.at(-1)?.url).toBe("/tasks/42");
  });

  it("CO-5.3: composing an endpoint whose required consumer input reaches no backend is rejected (nothing activates)", async () => {
    const service = new AdapterCompositionService({ db, newId: () => randomUUID() });
    const bindings = await new AdapterCompositionRepository(db).listBindings(blockingEndpointId);
    const bindingId = bindings[0]?.id ?? "";

    let rejected: BadRequestError | undefined;
    try {
      await service.compose(
        blockingEndpointId,
        {
          aggregationStrategy: "single",
          strictness: "degraded",
          bindings: [{ bindingId, role: "primary" }],
        },
        ACTOR,
      );
    } catch (error) {
      if (error instanceof BadRequestError) rejected = error;
      else throw error;
    }
    expect(rejected).toBeDefined();
    expect(JSON.stringify(rejected?.issues)).toContain("tenant");

    // Nothing activated — the endpoint keeps its composition-required state (CO-2.8 / CO-5.3).
    const endpoint = await new AdapterCompositionRepository(db).getEndpointById(blockingEndpointId);
    expect(endpoint?.status).toBe("composition-required");
  });

  it("CO-5.3: acknowledging the required input does NOT let it through (still rejected)", async () => {
    const service = new AdapterCompositionService({ db, newId: () => randomUUID() });
    const bindings = await new AdapterCompositionRepository(db).listBindings(blockingEndpointId);
    const bindingId = bindings[0]?.id ?? "";
    let rejected: BadRequestError | undefined;
    try {
      await service.compose(
        blockingEndpointId,
        {
          aggregationStrategy: "single",
          strictness: "degraded",
          bindings: [{ bindingId, role: "primary" }],
          acknowledgedIgnoredInputs: [{ kind: "parameter", consumerParamName: "tenant" }],
        },
        ACTOR,
      );
    } catch (error) {
      if (error instanceof BadRequestError) rejected = error;
      else throw error;
    }
    expect(rejected).toBeDefined();
    expect(JSON.stringify(rejected?.issues)).toContain("required");
  });

  it("CO-5.4: composing with an acknowledgement persists it on the endpoint", async () => {
    const service = new AdapterCompositionService({ db, newId: () => randomUUID() });
    const bindings = await new AdapterCompositionRepository(db).listBindings(ackEndpointId);
    const bindingId = bindings[0]?.id ?? "";

    const result = await service.compose(
      ackEndpointId,
      {
        aggregationStrategy: "single",
        strictness: "degraded",
        bindings: [{ bindingId, role: "primary" }],
        acknowledgedIgnoredInputs: [{ kind: "parameter", consumerParamName: "note" }],
      },
      ACTOR,
    );
    expect(result.endpoint.status).toBe("active");

    // Read back through the repository/mapper — the acknowledgement persisted.
    const reloaded = await new AdapterCompositionRepository(db).getEndpointById(ackEndpointId);
    expect(reloaded?.acknowledgedIgnoredInputs).toEqual([
      { kind: "parameter", consumerParamName: "note" },
    ]);
  });

  it("resource-pair scoping: a two-pair binding's coverage/supplied-field facts use ONLY its own pair", async () => {
    const context = await new DbCompositionContextLoader(db).load(twoPairTodosEndpointId);
    expect(context).toBeDefined();
    if (context === undefined) return;
    const facts = context.bindingFacts[0];
    expect(facts).toBeDefined();
    if (facts === undefined) return;

    // CO-4 supplied consumer response fields — todos pair only, never the projects pair.
    expect([...facts.consumerResponseFieldPaths].sort()).toEqual(
      ["todos/done", "todos/id", "todos/title"].sort(),
    );
    // CO-5 mapped consumer body fields — the todos pair's `title`, never the projects `name`.
    expect([...facts.mappedConsumerBodyFieldNames]).toEqual(["title"]);
    // CO-5 mapped consumer params — the todos pair's `todoId`, never the projects `projectId`.
    expect([...facts.mappedConsumerParamNames]).toEqual(["todoId"]);
  });
});
