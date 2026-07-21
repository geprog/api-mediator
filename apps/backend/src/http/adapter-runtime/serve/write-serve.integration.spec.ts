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
import { buildAdapterServeHandler } from "./build-serve-handler.js";

/**
 * The **real-machinery** proof of the Phase-5 write serve path (WR-2/WR-3/WR-5): boots the
 * Adapter Server Runtime with the REAL injected `ServeHandler` + the DB-persisted
 * write-outcome store against live Postgres and a stub HTTP backend, and drives:
 *
 *  - a fresh POST that executes the real backend create and returns the consumer-shape body;
 *  - an identical POST that is deduplicated — the backend is NOT called a second time, and
 *    the recorded outcome (status + body) is replayed;
 *  - the metadata-only audit invariant: two `adapter-request` rows, both carrying the
 *    idempotency key, the replay distinguishable, and **no response body** in either row —
 *    the body lives only in the bounded write-outcome store.
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

/** The distinctive stored title — proves the body lives in the store, never the audit log. */
const STORED_TITLE = "Persisted-Title-Never-In-Audit";

/** A recording stub backend for POST /tasks (create). */
class StubBackend {
  #server: Server | undefined;
  public postCount = 0;

  public async start(): Promise<void> {
    this.#server = createServer((request: IncomingMessage, response: ServerResponse) => {
      const url = request.url ?? "";
      if (request.method === "POST" && url === "/tasks") {
        this.postCount += 1;
        response.writeHead(201, { "content-type": "application/json" });
        response.end(
          JSON.stringify({ task_id: "task-created-1", task_title: STORED_TITLE, completed: false }),
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
        operationId: "createTodo",
        method: "post",
        path: "/todos",
        parameters: [],
        requestSchema: {
          name: "NewTodo",
          fields: [{ name: "title", type: "string", required: true }],
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

const backendIr: Ir = [
  {
    resourceRef: "tasks",
    name: "tasks",
    operations: [
      {
        operationId: "createTask",
        method: "post",
        path: "/tasks",
        parameters: [],
        requestSchema: {
          name: "NewTask",
          fields: [{ name: "task_title", type: "string", required: false }],
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

describe("adapter WRITE serve pipeline integration (requires Postgres)", () => {
  let config: AppConfig;
  let db: Database;
  let adapter: AdapterRuntime;
  const stub = new StubBackend();

  const createdAppIds: string[] = [];
  const createdSpecIds: string[] = [];
  const createdMappingIds: string[] = [];

  let consumerAppId: string;
  let endpointId: string;

  const adapterApp = (): FastifyInstance => adapter.app;

  beforeAll(async () => {
    config = integrationConfig();
    db = createDb(config.database.url);
    await runMigrations(db);
    await stub.start();

    const backendApp = activeApp("write-backend", stub.url());
    createdAppIds.push(backendApp.id);
    await new RegisteredAppRepository(db).create(backendApp);
    const backendSpec = specRow(backendApp.id, "PROVIDER", backendIr);
    createdSpecIds.push(backendSpec.id);
    await new ApiSpecRepository(db).create(backendSpec);

    const consumerApp = activeApp("write-consumer");
    consumerAppId = consumerApp.id;
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
      sourceOperationRef: "todos/createTodo",
      targetOperationRef: "tasks/createTask",
      action: "create",
    };
    await new MappingArtifactsRepository(db).replaceChildren(mappingId, {
      // Request phase: consumer body `title` → backend `task_title`.
      fieldMappings: [
        {
          id: randomUUID(),
          mappingId,
          sourcePath: "todos/title",
          targetPath: "tasks/task_title",
          transform: "rename",
          phase: "request",
        },
        renameField(mappingId, "tasks/task_id", "todos/id"),
        renameField(mappingId, "tasks/task_title", "todos/title"),
        renameField(mappingId, "tasks/completed", "todos/done"),
      ],
      operationMappings: [opMapping],
      parameterMappings: [],
    });

    endpointId = randomUUID();
    const endpoint: AdapterEndpoint = {
      id: endpointId,
      consumerAppId: consumerApp.id,
      consumerOperationId: "todos/createTodo",
      status: "active",
      aggregationStrategy: "single",
    };
    const artifacts = new DownstreamArtifactRepository(db);
    await artifacts.ensureAdapterEndpoint(endpoint);
    const binding: AdapterBinding = {
      id: randomUUID(),
      adapterEndpointId: endpointId,
      backendAppId: backendApp.id,
      backendOperationId: "tasks/createTask",
      approvedMappingId: mappingId,
      role: "primary",
      status: "active",
    };
    await artifacts.insertAdapterBindingIfAbsent(binding);

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
    await db
      .delete(adapterWriteOutcome)
      .where(eq(adapterWriteOutcome.adapterEndpointId, endpointId));
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

  async function postTodo(): Promise<LightMyRequestResponse> {
    return adapterApp().inject({
      method: "POST",
      url: "/todos",
      headers: { [CONSUMER_APP_HEADER]: consumerAppId, "content-type": "application/json" },
      payload: JSON.stringify({ title: "request-title" }),
    });
  }

  it("(a) a fresh write executes the real backend and records the outcome; (b) an identical delivery is deduplicated", async () => {
    // (a) Fresh delivery — the backend create runs once and returns the consumer-shape body.
    const first = await postTodo();
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ id: "task-created-1", title: STORED_TITLE, done: false });
    expect(stub.postCount).toBe(1);

    // (b) Identical delivery — deduplicated: the backend is NOT called again, and the
    // recorded outcome (status + body) is replayed verbatim (WR-3.3).
    const second = await postTodo();
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual(first.json());
    expect(stub.postCount).toBe(1);

    // The write-outcome store holds exactly one row, and it carries the response BODY.
    const outcomeRows = await db
      .select()
      .from(adapterWriteOutcome)
      .where(eq(adapterWriteOutcome.adapterEndpointId, endpointId));
    expect(outcomeRows).toHaveLength(1);
    expect(outcomeRows[0]?.outcome).toBe("success");
    expect(JSON.stringify(outcomeRows[0]?.responseBody)).toContain(STORED_TITLE);

    // WR-5.4 / WR-3.6 — two adapter-request audit rows, both metadata-only:
    const auditRows = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.actor, `consumer-app:${consumerAppId}`));
    const writeRows = auditRows.filter((row) => row.type === "adapter-request");
    expect(writeRows.length).toBe(2);
    // Both succeeded and carry the (opaque) idempotency key.
    expect(writeRows.every((row) => row.status === "success")).toBe(true);
    expect(
      writeRows.every(
        (row) => typeof row.idempotencyKey === "string" && row.idempotencyKey.length > 0,
      ),
    ).toBe(true);
    // The two deliveries share one key; exactly one is distinguishable as a dedup delivery.
    expect(new Set(writeRows.map((row) => row.idempotencyKey)).size).toBe(1);
    const dedupRows = writeRows.filter((row) => row.details === "deduplicated-delivery");
    expect(dedupRows.length).toBe(1);
    // The response BODY never appears in any audit row — it lives only in the store.
    expect(JSON.stringify(writeRows)).not.toContain(STORED_TITLE);
  });
});
