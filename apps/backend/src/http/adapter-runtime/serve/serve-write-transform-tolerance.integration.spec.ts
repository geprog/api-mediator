import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";

import { loadConfig, type AppConfig } from "@mediator/config";
import {
  adapterBinding,
  adapterEndpoint,
  adapterWriteOutcome,
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
import { CAUSE_HEADER } from "../outcome-http.js";
import { buildAdapterServeHandler } from "./build-serve-handler.js";

/**
 * The **real-machinery** proof of the two serve/write request-mapping tolerance fixes the
 * Phase-5 capstone (CU-5) surfaced against a real Vikunja landscape — both driven end to
 * end through the real injected `ServeHandler` + DB-persisted state against live Postgres
 * and a stub HTTP backend:
 *
 *  - **Bug 1** — a READ served through a resource pair (`todos↔tasks`) whose single
 *    `ApprovedMapping` ALSO carries a WRITE (`createTodo↔createTask`) must NOT inherit the
 *    write's request-phase body `FieldMapping`s: `GET /todos/{id}` builds no backend body
 *    and round-trips (it used to 500 `mediator-transform-error` — a bodyless GET applying
 *    the write's `todos/title → tasks/task_title` rename throws `missing-input`).
 *  - **Bug 2** — a WRITE that omits an OPTIONAL consumer body field builds a backend body
 *    WITHOUT that field and succeeds (it used to 500); a WRITE that omits a REQUIRED field
 *    is still rejected upstream by RP-2 (`invalid-request`, no backend call), so the fix
 *    can never drop required data.
 *
 * Excluded from `pnpm verify`; run with `pnpm --filter @mediator/backend test:integration`.
 */

const ADAPTER_PORT = 14922;
const OPERATOR_PORT = 14923;

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

/** A recorded inbound call to the stub backend, including the raw request body seen. */
interface StubRequest {
  readonly method: string;
  readonly url: string;
  readonly body: string;
}

/** A recording stub for the backend `GET /tasks/{taskId}` (read) and `POST /tasks` (create). */
class StubBackend {
  #server: Server | undefined;
  public readonly requests: StubRequest[] = [];

  public async start(): Promise<void> {
    this.#server = createServer((request: IncomingMessage, response: ServerResponse) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const url = request.url ?? "";
        const method = request.method ?? "";
        this.requests.push({ method, url, body: Buffer.concat(chunks).toString("utf8") });

        const taskMatch = /^\/tasks\/([^/?]+)/.exec(url);
        if (method === "GET" && taskMatch) {
          const taskId = decodeURIComponent(taskMatch[1] ?? "");
          response.writeHead(200, { "content-type": "application/json" });
          response.end(
            JSON.stringify({ task_id: taskId, task_title: `Task ${taskId}`, completed: true }),
          );
          return;
        }
        if (method === "POST" && url === "/tasks") {
          // Echo the received title so the response maps back to the consumer shape; the
          // stored id + completed are fixed. The recorded request body is what the tests
          // assert against (the omitted-optional field must NOT appear there).
          const received: unknown = safeJsonParse(Buffer.concat(chunks).toString("utf8"));
          const title =
            typeof received === "object" &&
            received !== null &&
            typeof (received as Record<string, unknown>).task_title === "string"
              ? (received as Record<string, string>).task_title
              : "created";
          response.writeHead(201, { "content-type": "application/json" });
          response.end(
            JSON.stringify({ task_id: "task-created-1", task_title: title, completed: false }),
          );
          return;
        }
        response.writeHead(404, { "content-type": "application/json" });
        response.end("{}");
      });
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

function safeJsonParse(text: string): unknown {
  if (text.length === 0) {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
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

/**
 * ONE consumer resource (`todos`) with BOTH a read (`getTodo`) and a write (`createTodo`) —
 * the exact shape a consumer-provider mapping over a single resource pair produces, and the
 * shape that surfaced Bug 1. `createTodo`'s body has a REQUIRED `title` and an OPTIONAL
 * `description` (Bug 2's optional field).
 */
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
      {
        operationId: "createTodo",
        method: "post",
        path: "/todos",
        parameters: [],
        requestSchema: {
          name: "NewTodo",
          fields: [
            { name: "title", type: "string", required: true },
            { name: "description", type: "string", required: false },
          ],
        },
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

/** The backend `tasks` resource with a matching read + create; both create fields OPTIONAL. */
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
        requestSchema: {
          name: "NewTask",
          fields: [
            { name: "task_title", type: "string", required: false },
            { name: "task_description", type: "string", required: false },
          ],
        },
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

function field(
  mappingId: string,
  sourcePath: string,
  targetPath: string,
  phase: "request" | "response",
): FieldMapping {
  return { id: randomUUID(), mappingId, sourcePath, targetPath, transform: "rename", phase };
}

describe("serve/write request-mapping tolerance integration (requires Postgres)", () => {
  let config: AppConfig;
  let db: Database;
  let adapter: AdapterRuntime;
  const stub = new StubBackend();

  const createdAppIds: string[] = [];
  const createdSpecIds: string[] = [];
  const createdMappingIds: string[] = [];
  const createdEndpointIds: string[] = [];

  let consumerAppId: string;

  const adapterApp = (): FastifyInstance => adapter.app;

  beforeAll(async () => {
    config = integrationConfig();
    db = createDb(config.database.url);
    await runMigrations(db);
    await stub.start();

    const backendApp = activeApp("tolerance-backend", stub.url());
    createdAppIds.push(backendApp.id);
    await new RegisteredAppRepository(db).create(backendApp);
    const backendSpec = specRow(backendApp.id, "PROVIDER", backendIr);
    createdSpecIds.push(backendSpec.id);
    await new ApiSpecRepository(db).create(backendSpec);

    const consumerApp = activeApp("tolerance-consumer");
    consumerAppId = consumerApp.id;
    createdAppIds.push(consumerApp.id);
    await new RegisteredAppRepository(db).create(consumerApp);
    const consumerSpec = specRow(consumerApp.id, "CONSUMER", consumerIr);
    createdSpecIds.push(consumerSpec.id);
    await new ApiSpecRepository(db).create(consumerSpec);

    // ONE ApprovedMapping covering BOTH the read and the write on the todos↔tasks pair.
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

    const readOp: OperationMapping = {
      id: randomUUID(),
      mappingId,
      sourceOperationRef: "todos/getTodo",
      targetOperationRef: "tasks/getTask",
      action: "read",
    };
    const writeOp: OperationMapping = {
      id: randomUUID(),
      mappingId,
      sourceOperationRef: "todos/createTodo",
      targetOperationRef: "tasks/createTask",
      action: "create",
    };
    const readParam: ParameterMapping = {
      id: randomUUID(),
      operationMappingId: readOp.id,
      sourceParamRef: "todos/getTodo#todoId",
      targetParamRef: "tasks/getTask#taskId",
    };
    await new MappingArtifactsRepository(db).replaceChildren(mappingId, {
      fieldMappings: [
        // Request phase — the WRITE's body mappings (todos↔tasks). A READ served on this
        // pair must NOT apply these (Bug 1).
        field(mappingId, "todos/title", "tasks/task_title", "request"),
        field(mappingId, "todos/description", "tasks/task_description", "request"),
        // Response phase — shared by both operations on the pair (backend → consumer).
        field(mappingId, "tasks/task_id", "todos/id", "response"),
        field(mappingId, "tasks/task_title", "todos/title", "response"),
        field(mappingId, "tasks/completed", "todos/done", "response"),
      ],
      operationMappings: [readOp, writeOp],
      parameterMappings: [readParam],
    });

    const artifacts = new DownstreamArtifactRepository(db);
    for (const spec of [
      { op: "todos/getTodo", backendOp: "tasks/getTask" },
      { op: "todos/createTodo", backendOp: "tasks/createTask" },
    ]) {
      const endpoint: AdapterEndpoint = {
        id: randomUUID(),
        consumerAppId: consumerApp.id,
        consumerOperationId: spec.op,
        status: "active",
        aggregationStrategy: "single",
      };
      createdEndpointIds.push(endpoint.id);
      await artifacts.ensureAdapterEndpoint(endpoint);
      const binding: AdapterBinding = {
        id: randomUUID(),
        adapterEndpointId: endpoint.id,
        backendAppId: backendApp.id,
        backendOperationId: spec.backendOp,
        approvedMappingId: mappingId,
        role: "primary",
        status: "active",
      };
      await artifacts.insertAdapterBindingIfAbsent(binding);
    }

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
    if (createdEndpointIds.length > 0) {
      await db
        .delete(adapterWriteOutcome)
        .where(inArray(adapterWriteOutcome.adapterEndpointId, createdEndpointIds));
      await db
        .delete(adapterBinding)
        .where(inArray(adapterBinding.adapterEndpointId, createdEndpointIds));
      await db.delete(adapterEndpoint).where(inArray(adapterEndpoint.id, createdEndpointIds));
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
    await db.delete(apiSpec).where(inArray(apiSpec.id, createdSpecIds));
    await db.delete(registeredApp).where(inArray(registeredApp.id, createdAppIds));
    await closeDb(db);
  });

  function getTodo(): Promise<LightMyRequestResponse> {
    return adapterApp().inject({
      method: "GET",
      url: "/todos/42",
      headers: { [CONSUMER_APP_HEADER]: consumerAppId },
    });
  }

  function postTodo(body: Record<string, unknown>): Promise<LightMyRequestResponse> {
    return adapterApp().inject({
      method: "POST",
      url: "/todos",
      headers: { [CONSUMER_APP_HEADER]: consumerAppId, "content-type": "application/json" },
      payload: JSON.stringify(body),
    });
  }

  it("Bug 1: a READ served through a pair that ALSO has a WRITE mapping builds no body and round-trips", async () => {
    const before = stub.requests.length;
    const response = await getTodo();
    // Used to be 500 mediator-transform-error (the read inherited the write's request-phase
    // `todos/title → tasks/task_title` rename and threw missing-input on the bodyless GET).
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ id: "42", title: "Task 42", done: true });
    // The real backend GET was called exactly once, at its mapped path, with NO body.
    const calls = stub.requests.slice(before);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: "GET", url: "/tasks/42", body: "" });
  });

  it("Bug 2: a WRITE omitting an OPTIONAL body field builds a backend body without it and succeeds", async () => {
    const before = stub.requests.length;
    // `description` is optional and omitted (RP-2 already accepted this — `title` is present).
    const response = await postTodo({ title: "Buy milk" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ id: "task-created-1", title: "Buy milk", done: false });

    const calls = stub.requests.slice(before).filter((call) => call.method === "POST");
    expect(calls).toHaveLength(1);
    const sent: unknown = safeJsonParse(calls[0]?.body ?? "");
    // The omitted optional field is NOT in the backend body — omitted, never defaulted.
    expect(sent).toEqual({ task_title: "Buy milk" });
  });

  it("Bug 2 regression: a full-body WRITE still maps EVERY field", async () => {
    const before = stub.requests.length;
    const response = await postTodo({ title: "Full body", description: "the details" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ id: "task-created-1", title: "Full body", done: false });

    const calls = stub.requests.slice(before).filter((call) => call.method === "POST");
    expect(calls).toHaveLength(1);
    const sent: unknown = safeJsonParse(calls[0]?.body ?? "");
    expect(sent).toEqual({ task_title: "Full body", task_description: "the details" });
  });

  it("Bug 2 required-field guarantee: a WRITE omitting a REQUIRED body field is still rejected by RP-2 (no backend call)", async () => {
    const before = stub.requests.length;
    // `title` is REQUIRED and omitted — RP-2 rejects before any transform or backend call,
    // so Bug 2's per-field tolerance can never drop required data.
    const response = await postTodo({ description: "no title here" });
    expect(response.statusCode).toBe(400);
    expect(response.headers[CAUSE_HEADER]).toBe("invalid-request");
    // No backend POST was issued.
    expect(stub.requests.slice(before).filter((call) => call.method === "POST")).toHaveLength(0);
  });
});
