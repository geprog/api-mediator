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

/** A recording stub for the backend `GET /tasks/{taskId}`. */
class StubBackend {
  #server: Server | undefined;
  public readonly requests: { readonly method: string; readonly url: string }[] = [];

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

  const adapterApp = (): FastifyInstance => adapter.app;

  async function seedConsumer(
    name: string,
    includeDone: boolean,
  ): Promise<{
    appId: string;
    mappingId: string;
  }> {
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
      targetSpecId: backendSpecId,
      sourceAppId: consumerApp.id,
      targetAppId: backendAppId,
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
      backendAppId,
      backendOperationId: "tasks/getTask",
      approvedMappingId: mappingId,
      role: "primary",
      status: "active",
    };
    await artifacts.insertAdapterBindingIfAbsent(binding);

    return { appId: consumerApp.id, mappingId };
  }

  let backendSpecId: string;

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
    expect(stub.requests.at(-1)).toEqual({ method: "GET", url: "/tasks/42" });
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
});
