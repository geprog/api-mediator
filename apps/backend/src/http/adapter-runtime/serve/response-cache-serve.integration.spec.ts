import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";

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
  IrOperation,
  OperationMapping,
  ParameterMapping,
  RegisteredApp,
} from "@mediator/domain";
import { AppLoadGovernor } from "@mediator/outbound";
import { inArray } from "drizzle-orm";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createServerLogger } from "../../../composition-root.js";
import { operatorAccountsEnv } from "../../../testing/auth.testkit.js";
import { buildAdapterRuntime, type AdapterRuntime } from "../build-adapter-runtime.js";
import { CONSUMER_APP_HEADER, headerConsumerAppResolver } from "../consumer-app-resolver.js";
import { buildAdapterServeHandler } from "./build-serve-handler.js";
import { ResponseCacheInvalidator } from "./cache-invalidator.js";
import { InProcessResponseCache } from "./response-cache.js";

/**
 * **The real-machinery proof of CH-1 (response cache) end to end.** Boots the Adapter
 * Server Runtime with the REAL serve pipeline (real `CredentialStore` path, real REST
 * `ProtocolClient`, real `AppLoadGovernor`, real in-process `ResponseCache`) against a live
 * Postgres and a recording stub backend, over an endpoint composed with a `cacheTtl`, then:
 *
 *  - a first GET is served from the backend (a cache miss) and cached (CH-1);
 *  - a second identical GET is served **from cache** — same body, and the stub records
 *    **no second call** (CH-1.1 short-circuits all backend calls).
 *
 * Excluded from `pnpm verify`; run with `pnpm --filter @mediator/backend test:integration`.
 */

const ADAPTER_PORT = 14912;
const OPERATOR_PORT = 14913;

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

/** A recording stub for the backend `GET /tasks/{taskId}`. */
class StubBackend {
  #server: Server | undefined;
  public readonly requests: string[] = [];

  public async start(): Promise<void> {
    this.#server = createServer((request: IncomingMessage, response: ServerResponse) => {
      const url = request.url ?? "";
      this.requests.push(`${request.method ?? ""} ${url}`);
      // A successful write to the same backend resource (`tasks`) — invalidates the read cache.
      if (request.method === "POST" && (url === "/tasks" || url === "/tasks?")) {
        response.writeHead(201, { "content-type": "application/json" });
        response.end(
          JSON.stringify({ task_id: "created-1", task_title: "Created", completed: false }),
        );
        return;
      }
      const taskMatch = /^\/tasks\/([^/?]+)/.exec(url);
      if (request.method === "GET" && taskMatch) {
        const taskId = decodeURIComponent(taskMatch[1] ?? "");
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

const todoResponseSchema: NonNullable<IrOperation["responseSchema"]> = {
  name: "Todo",
  fields: [
    { name: "id", type: "string", required: true },
    { name: "title", type: "string", required: true },
    { name: "done", type: "boolean", required: true },
  ],
};

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
        responseSchema: todoResponseSchema,
      },
    ],
    schemas: [],
    crossResourceRefs: [],
  },
  {
    // A SEPARATE consumer resource for the write, so its request-phase field mapping is scoped
    // to (drafts, tasks) and never applies to the (todos, tasks) read — while still targeting
    // the same BACKEND resource `tasks`, which is what makes the write invalidate the read.
    resourceRef: "drafts",
    name: "drafts",
    operations: [
      {
        operationId: "createDraft",
        method: "post",
        path: "/drafts",
        parameters: [],
        requestSchema: {
          name: "NewTodo",
          fields: [{ name: "title", type: "string", required: true }],
        },
        responseSchema: todoResponseSchema,
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
      {
        operationId: "createTask",
        method: "post",
        path: "/tasks",
        parameters: [],
      },
    ],
    schemas: [],
    crossResourceRefs: [],
  },
];

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
  phase: FieldMapping["phase"] = "response",
): FieldMapping {
  return {
    id: randomUUID(),
    mappingId,
    sourcePath,
    targetPath,
    transform: "rename",
    phase,
  };
}

describe("adapter response cache integration (requires Postgres)", () => {
  let config: AppConfig;
  let db: Database;
  let adapter: AdapterRuntime;
  const stub = new StubBackend();

  const createdAppIds: string[] = [];
  const createdSpecIds: string[] = [];
  const createdMappingIds: string[] = [];
  let consumerAppId: string;

  const adapterApp = (): FastifyInstance => adapter.app;

  beforeAll(async () => {
    config = integrationConfig();
    db = createDb(config.database.url);
    await runMigrations(db);
    await stub.start();

    // Backend app + PROVIDER spec.
    const backendApp = activeApp("cache-backend", stub.url());
    createdAppIds.push(backendApp.id);
    await new RegisteredAppRepository(db).create(backendApp);
    const backendSpec = specRow(backendApp.id, "PROVIDER", backendIr);
    createdSpecIds.push(backendSpec.id);
    await new ApiSpecRepository(db).create(backendSpec);

    // Consumer app + CONSUMER spec.
    const consumerApp = activeApp("cache-consumer");
    consumerAppId = consumerApp.id;
    createdAppIds.push(consumerApp.id);
    await new RegisteredAppRepository(db).create(consumerApp);
    const consumerSpec = specRow(consumerApp.id, "CONSUMER", consumerIr);
    createdSpecIds.push(consumerSpec.id);
    await new ApiSpecRepository(db).create(consumerSpec);

    // The approved consumer↔provider mapping + its artifacts.
    const mappingId = randomUUID();
    createdMappingIds.push(mappingId);
    await db.insert(approvedMapping).values({
      id: mappingId,
      sourceSpecId: consumerSpec.id,
      targetSpecId: backendSpec.id,
      sourceAppId: consumerApp.id,
      targetAppId: backendApp.id,
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
    // The SAME consumer↔backend mapping also covers the write createDraft→createTask (a second
    // ACTIVE mapping over the same spec pair violates the unique-direction index). The write is
    // on its OWN (drafts, tasks) resource pair, so its request-phase field mapping never touches
    // the (todos, tasks) read; both write to the same BACKEND resource `tasks`.
    const writeOpMapping: OperationMapping = {
      id: randomUUID(),
      mappingId,
      sourceOperationRef: "drafts/createDraft",
      targetOperationRef: "tasks/createTask",
      action: "create",
    };
    await new MappingArtifactsRepository(db).replaceChildren(mappingId, {
      fieldMappings: [
        // read (tasks → todos), response phase
        renameField(mappingId, "tasks/task_id", "todos/id"),
        renameField(mappingId, "tasks/task_title", "todos/title"),
        renameField(mappingId, "tasks/completed", "todos/done"),
        // write request (drafts → tasks) + response (tasks → drafts)
        renameField(mappingId, "drafts/title", "tasks/task_title", "request"),
        renameField(mappingId, "tasks/task_id", "drafts/id"),
        renameField(mappingId, "tasks/task_title", "drafts/title"),
        renameField(mappingId, "tasks/completed", "drafts/done"),
      ],
      operationMappings: [opMapping, writeOpMapping],
      parameterMappings: [paramMapping],
    });

    // A single-binding endpoint composed WITH a cacheTtl (CH-1: caching enabled).
    const artifacts = new DownstreamArtifactRepository(db);
    const endpoint: AdapterEndpoint = {
      id: randomUUID(),
      consumerAppId: consumerApp.id,
      consumerOperationId: "todos/getTodo",
      status: "active",
      aggregationStrategy: "single",
      cacheTtl: 60_000,
    };
    await artifacts.ensureAdapterEndpoint(endpoint);
    const binding: AdapterBinding = {
      id: randomUUID(),
      adapterEndpointId: endpoint.id,
      backendAppId: backendApp.id,
      backendOperationId: "tasks/getTask",
      approvedMappingId: mappingId,
      role: "primary",
      status: "active",
    };
    await artifacts.insertAdapterBindingIfAbsent(binding);

    // CH-4.2 — a WRITE endpoint over the SAME backend resource (`tasks`): createTodo→createTask.
    // A successful write through it must drop the read endpoint's cached entry for `tasks`.
    const writeEndpoint: AdapterEndpoint = {
      id: randomUUID(),
      consumerAppId: consumerApp.id,
      consumerOperationId: "drafts/createDraft",
      status: "active",
      aggregationStrategy: "single",
    };
    await artifacts.ensureAdapterEndpoint(writeEndpoint);
    await artifacts.insertAdapterBindingIfAbsent({
      id: randomUUID(),
      adapterEndpointId: writeEndpoint.id,
      backendAppId: backendApp.id,
      backendOperationId: "tasks/createTask",
      approvedMappingId: mappingId,
      role: "primary",
      status: "active",
    });

    // CH-3/CH-4 — the ONE shared cache + the single invalidation seam over it, exactly as the
    // composition root wires them: the serve handler reads from and (on a successful write)
    // invalidates this cache through `cacheInvalidator`.
    const responseCache = new InProcessResponseCache();
    const serveHandler = buildAdapterServeHandler({
      db,
      logger: createServerLogger(config),
      credentialMasterKey: config.credentials.masterKey,
      loadGovernor: new AppLoadGovernor(),
      responseCache,
      cacheInvalidator: new ResponseCacheInvalidator(responseCache),
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
    await db.delete(auditLog).where(
      inArray(
        auditLog.actor,
        createdAppIds.map((id) => `consumer-app:${id}`),
      ),
    );
    await db.delete(apiSpec).where(inArray(apiSpec.id, createdSpecIds));
    await db.delete(registeredApp).where(inArray(registeredApp.id, createdAppIds));
    await closeDb(db);
  });

  function get(todoId = "42"): Promise<LightMyRequestResponse> {
    return adapterApp().inject({
      method: "GET",
      url: `/todos/${todoId}`,
      headers: { [CONSUMER_APP_HEADER]: consumerAppId },
    });
  }

  function createDraft(): Promise<LightMyRequestResponse> {
    return adapterApp().inject({
      method: "POST",
      url: "/drafts",
      headers: { [CONSUMER_APP_HEADER]: consumerAppId, "content-type": "application/json" },
      payload: { title: "Ship it" },
    });
  }

  /** Count only the backend GETs (a write also hits the stub, via POST). */
  const backendGets = (): number => stub.requests.filter((r) => r.startsWith("GET /tasks")).length;

  it("CH-1.1: a first read is served + cached; a second identical read is served from cache with NO second backend call", async () => {
    const before = stub.requests.length;

    const first = await get();
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ id: "42", title: "Task 42", done: true });
    // The real backend was called exactly once for the first (miss) request.
    expect(stub.requests.length).toBe(before + 1);

    const second = await get();
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual({ id: "42", title: "Task 42", done: true });
    // CH-1.1 — the second request short-circuited the backend: still exactly one call.
    expect(stub.requests.length).toBe(before + 1);
  });

  it("CH-4.2: a successful write to the same backend resource makes the next read a MISS that re-calls the backend", async () => {
    // A fresh id so this test does not depend on CH-1.1's cached /todos/42 entry.
    const beforeGets = backendGets();

    const first = await get("77");
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ id: "77", title: "Task 77", done: true });
    expect(backendGets()).toBe(beforeGets + 1); // miss → one backend GET, now cached

    const cached = await get("77");
    expect(cached.statusCode).toBe(200);
    expect(backendGets()).toBe(beforeGets + 1); // hit → still no new backend GET

    // A successful adapter write to `tasks/createTask` (backend resource `tasks`) — the same
    // resource the read endpoint is bound to.
    const written = await createDraft();
    expect(written.statusCode).toBe(200);
    expect(written.json()).toEqual({ id: "created-1", title: "Created", done: false });

    // CH-4.2 — the write invalidated the read's cached `tasks` entry, so the next equivalent
    // read is a MISS and re-calls the backend.
    const afterWrite = await get("77");
    expect(afterWrite.statusCode).toBe(200);
    expect(afterWrite.json()).toEqual({ id: "77", title: "Task 77", done: true });
    expect(backendGets()).toBe(beforeGets + 2);
  });
});
