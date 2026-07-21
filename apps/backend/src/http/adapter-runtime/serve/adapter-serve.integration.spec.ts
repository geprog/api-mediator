import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";

import { loadConfig, type AppConfig } from "@mediator/config";
import { CredentialStore, DbCredentialPersistence, EnvKeyProvider } from "@mediator/credentials";
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
  OperationMapping,
  ParameterMapping,
  RegisteredApp,
} from "@mediator/domain";
import { AppLoadGovernor } from "@mediator/outbound";
import { eq, inArray } from "drizzle-orm";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createServerLogger } from "../../../composition-root.js";
import { operatorAccountsEnv } from "../../../testing/auth.testkit.js";
import { buildAdapterRuntime, type AdapterRuntime } from "../build-adapter-runtime.js";
import { CONSUMER_APP_HEADER, headerConsumerAppResolver } from "../consumer-app-resolver.js";
import { CAUSE_HEADER } from "../outcome-http.js";
import { buildAdapterServeHandler } from "./build-serve-handler.js";

/**
 * The **real-machinery** proof of the Phase-5 serve pipeline: boots the Adapter Server
 * Runtime with the REAL injected `ServeHandler` — the real `CredentialStore`
 * `withCredential` path, the real REST `ProtocolClient` (`fetch`), and a real
 * `AppLoadGovernor` — against a live Postgres and a **stub HTTP backend**, and drives
 * an end-to-end read:
 *
 *  - a GET to a `single` endpoint returns the backend's data **transformed into the
 *    consumer shape** and validated against the consumer schema (RP→TE→AG happy path);
 *  - a stale / suspended mapping → the distinct cause, with **no backend call**;
 *  - a disabled backend → `backend-disabled`, no call;
 *  - a response the mapping cannot make schema-valid → `mediator-transform-error`
 *    (never the raw backend body).
 *
 * Excluded from `pnpm verify`; run with `pnpm --filter @mediator/backend test:integration`.
 */

const ADAPTER_PORT = 14902;
const OPERATOR_PORT = 14903;

function integrationConfig(): AppConfig {
  return loadConfig({
    ...process.env,
    HTTP_PORT: String(OPERATOR_PORT),
    ADAPTER_HTTP_PORT: String(ADAPTER_PORT),
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

/** A recorded inbound call to the stub backend (method, url, and the auth header it saw). */
interface StubRequest {
  readonly method: string;
  readonly url: string;
  readonly authorization: string | undefined;
}

/** A recording stub for the backend `GET /tasks/{taskId}` and `GET /workspaces/{workspaceId}`. */
class StubBackend {
  #server: Server | undefined;
  public readonly requests: StubRequest[] = [];

  public async start(): Promise<void> {
    this.#server = createServer((request: IncomingMessage, response: ServerResponse) => {
      const authorization = request.headers.authorization;
      this.requests.push({
        method: request.method ?? "",
        url: request.url ?? "",
        authorization: typeof authorization === "string" ? authorization : undefined,
      });
      const url = request.url ?? "";
      const taskMatch = /^\/tasks\/([^/?]+)/.exec(url);
      if (request.method === "GET" && taskMatch) {
        const taskId = decodeURIComponent(taskMatch[1] ?? "");
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({ task_id: taskId, task_title: `Task ${taskId}`, completed: true }),
        );
        return;
      }
      const workspaceMatch = /^\/workspaces\/([^/?]+)/.exec(url);
      if (request.method === "GET" && workspaceMatch) {
        const workspaceId = decodeURIComponent(workspaceMatch[1] ?? "");
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ ws_id: workspaceId, ws_name: `Workspace ${workspaceId}` }));
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
    if (server === undefined) {
      return;
    }
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
        responseSchema: {
          name: "Todo",
          fields: [
            { name: "id", type: "string", required: true },
            { name: "title", type: "string", required: true },
            { name: "done", type: "boolean", required: true },
          ],
        },
      },
    ],
    schemas: [],
    crossResourceRefs: [],
  },
];

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

/** A consumer spec covering TWO resource pairs under one mapping (the multi-pair leak case). */
const multiPairConsumerIr: Ir = [
  ...consumerIr,
  {
    resourceRef: "projects",
    name: "projects",
    operations: [
      {
        operationId: "getProject",
        method: "get",
        path: "/projects/{projectId}",
        parameters: [{ name: "projectId", location: "path", required: true, type: "string" }],
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

/** A fixed seeded backend credential (never a live secret) for the credential-apply test. */
const CRED_TOKEN = "stub-secret-token-1234567890";

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

function renameField(mappingId: string, sourcePath: string, targetPath: string): FieldMapping {
  return {
    id: randomUUID(),
    mappingId,
    sourcePath,
    targetPath,
    transform: "rename",
    phase: "response",
  };
}

describe("adapter serve pipeline integration (requires Postgres)", () => {
  let config: AppConfig;
  let db: Database;
  let adapter: AdapterRuntime;
  const stub = new StubBackend();

  const createdAppIds: string[] = [];
  const createdSpecIds: string[] = [];
  const createdMappingIds: string[] = [];

  let happyAppId: string;
  let brokenAppId: string;
  let happyMappingId: string;
  let backendAppId: string;
  let backendSpecId: string;
  let availabilityAppId: string;
  let leakAppId: string;
  let credConsumerAppId: string;

  const adapterApp = (): FastifyInstance => adapter.app;

  interface BackendRef {
    readonly appId: string;
    readonly specId: string;
  }

  /** Seed a single-pair `todos↔tasks` consumer scenario against the given backend. */
  async function seedConsumer(
    name: string,
    includeDone: boolean,
    backend?: BackendRef,
  ): Promise<{ appId: string; mappingId: string }> {
    const target = backend ?? { appId: backendAppId, specId: backendSpecId };
    const consumerApp = activeApp(name);
    createdAppIds.push(consumerApp.id);
    await new RegisteredAppRepository(db).create(consumerApp);

    const consumerSpec = specRow(consumerApp.id, "CONSUMER", consumerIr);
    createdSpecIds.push(consumerSpec.id);
    await new ApiSpecRepository(db).create(consumerSpec);

    const mappingId = randomUUID();
    createdMappingIds.push(mappingId);
    await db.insert(approvedMapping).values({
      id: mappingId,
      sourceSpecId: consumerSpec.id,
      targetSpecId: target.specId,
      sourceAppId: consumerApp.id,
      targetAppId: target.appId,
      variant: "consumer-provider",
      approvedBy: "integration-test",
      approvedAt: new Date(),
      status: "active",
    });

    const opMapping: OperationMapping = {
      id: randomUUID(),
      mappingId,
      sourceOperationRef: "todos/getTodo",
      targetOperationRef: "tasks/getTask",
      action: "read",
    };
    const paramMapping: ParameterMapping = {
      id: randomUUID(),
      operationMappingId: opMapping.id,
      sourceParamRef: "todos/getTodo#todoId",
      targetParamRef: "tasks/getTask#taskId",
    };
    const fieldMappings: FieldMapping[] = [
      renameField(mappingId, "tasks/task_id", "todos/id"),
      renameField(mappingId, "tasks/task_title", "todos/title"),
      ...(includeDone ? [renameField(mappingId, "tasks/completed", "todos/done")] : []),
    ];
    await new MappingArtifactsRepository(db).replaceChildren(mappingId, {
      fieldMappings,
      operationMappings: [opMapping],
      parameterMappings: [paramMapping],
    });

    const endpoint: AdapterEndpoint = {
      id: randomUUID(),
      consumerAppId: consumerApp.id,
      consumerOperationId: "todos/getTodo",
      status: "active",
      aggregationStrategy: "single",
    };
    const artifacts = new DownstreamArtifactRepository(db);
    await artifacts.ensureAdapterEndpoint(endpoint);
    const binding: AdapterBinding = {
      id: randomUUID(),
      adapterEndpointId: endpoint.id,
      backendAppId: target.appId,
      backendOperationId: "tasks/getTask",
      approvedMappingId: mappingId,
      role: "primary",
      status: "active",
    };
    await artifacts.insertAdapterBindingIfAbsent(binding);

    return { appId: consumerApp.id, mappingId };
  }

  /**
   * Seed a consumer whose **single** `ApprovedMapping` covers TWO resource pairs
   * (`todos↔tasks` and `projects↔workspaces`), both endpoints auto-activated — the
   * shape that a mapping between two real specs produces. `pair2` chooses whether the
   * second pair's field mappings source fields that are **absent** in the served
   * `tasks` response (the availability shape — a foreign source is `missing-input`)
   * or **present** (the leak shape — a foreign field is written into the `todos` body).
   */
  async function seedMultiPair(
    name: string,
    pair2: "absent-source" | "present-source",
  ): Promise<string> {
    const consumerApp = activeApp(name);
    createdAppIds.push(consumerApp.id);
    await new RegisteredAppRepository(db).create(consumerApp);
    const consumerSpec = specRow(consumerApp.id, "CONSUMER", multiPairConsumerIr);
    createdSpecIds.push(consumerSpec.id);
    await new ApiSpecRepository(db).create(consumerSpec);

    const mappingId = randomUUID();
    createdMappingIds.push(mappingId);
    await db.insert(approvedMapping).values({
      id: mappingId,
      sourceSpecId: consumerSpec.id,
      targetSpecId: backendSpecId,
      sourceAppId: consumerApp.id,
      targetAppId: backendAppId,
      variant: "consumer-provider",
      approvedBy: "integration-test",
      approvedAt: new Date(),
      status: "active",
    });

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
    const parameterMappings: ParameterMapping[] = [
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
    ];
    // Pair 2's response mappings — foreign to the todos serve. Under `absent-source`
    // they read `ws_*` (absent in the tasks response → missing-input); under
    // `present-source` they read `completed` (present) and write an extra `leaked` field.
    const pair2Fields: FieldMapping[] =
      pair2 === "absent-source"
        ? [
            renameField(mappingId, "workspaces/ws_id", "projects/id"),
            renameField(mappingId, "workspaces/ws_name", "projects/name"),
          ]
        : [renameField(mappingId, "workspaces/completed", "projects/leaked")];
    await new MappingArtifactsRepository(db).replaceChildren(mappingId, {
      fieldMappings: [
        renameField(mappingId, "tasks/task_id", "todos/id"),
        renameField(mappingId, "tasks/task_title", "todos/title"),
        renameField(mappingId, "tasks/completed", "todos/done"),
        ...pair2Fields,
      ],
      operationMappings: [todosOp, projectsOp],
      parameterMappings,
    });

    const artifacts = new DownstreamArtifactRepository(db);
    for (const pair of [
      { op: "todos/getTodo", backendOp: "tasks/getTask" },
      { op: "projects/getProject", backendOp: "workspaces/getWorkspace" },
    ]) {
      const endpoint: AdapterEndpoint = {
        id: randomUUID(),
        consumerAppId: consumerApp.id,
        consumerOperationId: pair.op,
        status: "active",
        aggregationStrategy: "single",
      };
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
    return consumerApp.id;
  }

  beforeAll(async () => {
    config = integrationConfig();
    db = createDb(config.database.url);
    await runMigrations(db);
    await stub.start();

    const backendApp = activeApp("vikunja-backend", stub.url());
    backendAppId = backendApp.id;
    createdAppIds.push(backendApp.id);
    await new RegisteredAppRepository(db).create(backendApp);
    const backendSpec = specRow(backendApp.id, "PROVIDER", backendIr);
    backendSpecId = backendSpec.id;
    createdSpecIds.push(backendSpec.id);
    await new ApiSpecRepository(db).create(backendSpec);

    const happy = await seedConsumer("todo-widget-happy", true);
    happyAppId = happy.appId;
    happyMappingId = happy.mappingId;
    const broken = await seedConsumer("todo-widget-broken", false);
    brokenAppId = broken.appId;

    // Multi-pair consumers: one mapping over two resource pairs, both endpoints active.
    availabilityAppId = await seedMultiPair("todo-widget-multipair-availability", "absent-source");
    leakAppId = await seedMultiPair("todo-widget-multipair-leak", "present-source");

    // A separate backend WITH a seeded credential, exercising the credential-apply path.
    const credBackendApp = activeApp("vikunja-backend-cred", stub.url());
    createdAppIds.push(credBackendApp.id);
    await new RegisteredAppRepository(db).create(credBackendApp);
    const credBackendSpec = specRow(credBackendApp.id, "PROVIDER", backendIr);
    createdSpecIds.push(credBackendSpec.id);
    await new ApiSpecRepository(db).create(credBackendSpec);
    await new CredentialStore(
      new DbCredentialPersistence(db),
      new EnvKeyProvider(config.credentials.masterKey),
      { info: () => undefined },
    ).store(credBackendApp.id, { secret: { type: "apiKey", apiKey: CRED_TOKEN } });
    const credConsumer = await seedConsumer("todo-widget-cred", true, {
      appId: credBackendApp.id,
      specId: credBackendSpec.id,
    });
    credConsumerAppId = credConsumer.appId;

    const serveHandler = buildAdapterServeHandler({
      db,
      logger: createServerLogger(config),
      credentialMasterKey: config.credentials.masterKey,
      loadGovernor: new AppLoadGovernor(),
    });
    adapter = buildAdapterRuntime({
      db,
      logger: createServerLogger(config),
      serveHandler,
      resolveConsumerApp: headerConsumerAppResolver,
    });
    await adapter.mountManager.reconcile();
  });

  afterAll(async () => {
    await stub.stop();
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
      await db.delete(parameterMapping).where(
        inArray(
          parameterMapping.operationMappingId,
          (
            await db
              .select({ id: operationMapping.id })
              .from(operationMapping)
              .where(inArray(operationMapping.mappingId, createdMappingIds))
          ).map((row) => row.id),
        ),
      );
      await db
        .delete(operationMapping)
        .where(inArray(operationMapping.mappingId, createdMappingIds));
      await db.delete(fieldMapping).where(inArray(fieldMapping.mappingId, createdMappingIds));
      await db.delete(approvedMapping).where(inArray(approvedMapping.id, createdMappingIds));
    }
    await db.delete(auditLog).where(
      inArray(
        auditLog.actor,
        createdAppIds.map((id) => `consumer-app:${id}`),
      ),
    );
    await db.delete(credential).where(inArray(credential.appId, createdAppIds));
    await db.delete(apiSpec).where(inArray(apiSpec.id, createdSpecIds));
    await db.delete(registeredApp).where(inArray(registeredApp.id, createdAppIds));
    await closeDb(db);
  });

  async function get(appId: string): Promise<LightMyRequestResponse> {
    return adapterApp().inject({
      method: "GET",
      url: "/todos/42",
      headers: { [CONSUMER_APP_HEADER]: appId },
    });
  }

  it("serves a GET, calling the real backend and returning the consumer-shape body (AG-1 + AG-7 pass)", async () => {
    const before = stub.requests.length;
    const response = await get(happyAppId);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ id: "42", title: "Task 42", done: true });
    // The real backend was called at its mapped path.
    expect(stub.requests.length).toBe(before + 1);
    expect(stub.requests.at(-1)).toMatchObject({ method: "GET", url: "/tasks/42" });
  });

  it("a stale mapping fails as mapping-stale with NO backend call", async () => {
    await db
      .update(approvedMapping)
      .set({ status: "stale" })
      .where(eq(approvedMapping.id, happyMappingId));
    const before = stub.requests.length;
    const response = await get(happyAppId);
    expect(response.headers[CAUSE_HEADER]).toBe("mapping-stale");
    expect(stub.requests.length).toBe(before);
    await db
      .update(approvedMapping)
      .set({ status: "active" })
      .where(eq(approvedMapping.id, happyMappingId));
  });

  it("a suspended mapping fails as mapping-suspended with NO backend call", async () => {
    await db
      .update(approvedMapping)
      .set({ status: "suspended" })
      .where(eq(approvedMapping.id, happyMappingId));
    const before = stub.requests.length;
    const response = await get(happyAppId);
    expect(response.headers[CAUSE_HEADER]).toBe("mapping-suspended");
    expect(stub.requests.length).toBe(before);
    await db
      .update(approvedMapping)
      .set({ status: "active" })
      .where(eq(approvedMapping.id, happyMappingId));
  });

  it("a disabled backend app fails as backend-disabled with NO backend call", async () => {
    await db
      .update(registeredApp)
      .set({ status: "disabled" })
      .where(eq(registeredApp.id, backendAppId));
    const before = stub.requests.length;
    const response = await get(happyAppId);
    expect(response.headers[CAUSE_HEADER]).toBe("backend-disabled");
    expect(stub.requests.length).toBe(before);
    await db
      .update(registeredApp)
      .set({ status: "active" })
      .where(eq(registeredApp.id, backendAppId));
  });

  it("AG-7: a response the mapping cannot make schema-valid → mediator-transform-error (never the raw body)", async () => {
    const response = await get(brokenAppId);
    expect(response.headers[CAUSE_HEADER]).toBe("mediator-transform-error");
    const body = response.json<{ cause?: string }>();
    expect(body.cause).toBe("mediator-transform-error");
    // The raw backend representation never leaks into the failure body.
    expect(response.body).not.toContain("task_title");
    expect(response.body).not.toContain("Task 42");
  });

  it("multi-pair (availability): serving one pair applies ONLY that pair's field mappings", async () => {
    // Without the resource-pair scoping, the foreign pair's `workspaces/ws_*` mappings
    // read fields absent in the tasks response → missing-input → the endpoint could
    // NEVER serve. With scoping, only the todos↔tasks pair applies.
    const response = await get(availabilityAppId);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ id: "42", title: "Task 42", done: true });
  });

  it("multi-pair (wrong data): a foreign pair's field never leaks into the served body", async () => {
    // Without scoping, the foreign `workspaces/completed → projects/leaked` mapping reads
    // the (present) `completed` field and writes an extra `leaked` key that AG-7 permits —
    // silently-wrong consumer data. With scoping, the body is exactly the todos pair.
    const response = await get(leakAppId);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ id: "42", title: "Task 42", done: true });
    expect(response.body).not.toContain("leaked");
  });

  it("credential-apply: the seeded token reaches the backend request and never leaks", async () => {
    const response = await get(credConsumerAppId);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ id: "42", title: "Task 42", done: true });
    // (a) the credential-derived Authorization header was applied inside withCredential.
    const last = stub.requests.at(-1);
    expect(last?.url).toBe("/tasks/42");
    expect(last?.authorization).toBe(`Bearer ${CRED_TOKEN}`);
    // (b) the token never appears in the consumer response body...
    expect(response.body).not.toContain(CRED_TOKEN);
    // ...nor in any audit row for this request (metadata only — RT-5.5).
    const rows = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.actor, `consumer-app:${credConsumerAppId}`));
    expect(rows.length).toBeGreaterThan(0);
    expect(JSON.stringify(rows)).not.toContain(CRED_TOKEN);
  });
});
