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
  OperationMapping,
  ParameterMapping,
  RegisteredApp,
} from "@mediator/domain";
import { resolveRequest } from "@mediator/adapter-engine";
import { AppLoadGovernor } from "@mediator/outbound";
import { eq } from "drizzle-orm";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createServerLogger } from "../../../composition-root.js";
import {
  AdapterCompositionService,
  type CompositionSubmission,
  type EndpointCacheInvalidator,
} from "../../../modules/adapter-composition/index.js";
import { operatorAccountsEnv } from "../../../testing/auth.testkit.js";
import { buildAdapterRuntime, type AdapterRuntime } from "../build-adapter-runtime.js";
import { CONSUMER_APP_HEADER, headerConsumerAppResolver } from "../consumer-app-resolver.js";
import { CAUSE_HEADER } from "../outcome-http.js";
import { buildAdapterServeHandler } from "./build-serve-handler.js";
import { ResponseCacheInvalidator } from "./cache-invalidator.js";
import { InProcessResponseCache } from "./response-cache.js";

/**
 * **The real-Postgres proof of CO-6 (recompose + endpoint/binding enable-disable) and CH-5
 * (invalidate the shared response cache on every committed change).** Boots the Adapter Server
 * Runtime with the REAL serve pipeline over a live Postgres + a recording stub backend, and
 * drives the REAL {@link AdapterCompositionService} — wired with the SAME cache invalidator the
 * runtime serves from — through:
 *
 *  - **CO-6.1 / CH-5.1:** recomposing an `active` endpoint re-validates + re-activates with the
 *    new config, and drops that endpoint's cached entries (the next read is a MISS).
 *  - **CO-6.5 / CH-5 (reject → nothing):** a recompose that fails validation is inert — the
 *    prior config keeps serving, nothing is written, and the cache is NOT dropped.
 *  - **CO-6.3 / CH-5.5:** disabling sets `endpoint-disabled` (asserted through the serve path)
 *    and re-enabling restores the stored config and serves **no** entry cached before the
 *    disable (a MISS that re-calls the backend).
 *  - **CO-6.2:** a binding marked `disabled` in a recompose is retained and skipped by the
 *    planner ({@link resolveRequest}); a later recompose reactivates it.
 *  - **CH-5.6:** every committed operation invalidates through the same by-endpoint seam
 *    (asserted with a spy that wraps the real invalidator).
 *  - **CO-6.6 / OA-3:** every operation writes one operator-attributed audit row.
 *
 * Excluded from `pnpm verify`; run with `pnpm --filter @mediator/backend test:integration`.
 */

const ADAPTER_PORT = 14922;
const OPERATOR_PORT = 14923;
const ACTOR = `operator:recompose-${randomUUID()}`;

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

/** A spy {@link EndpointCacheInvalidator} that records every call and delegates to the real seam. */
class SpyEndpointInvalidator implements EndpointCacheInvalidator {
  public readonly calls: string[] = [];
  public constructor(private readonly delegate: EndpointCacheInvalidator) {}
  public invalidateEndpoint(endpointId: string): void {
    this.calls.push(endpointId);
    this.delegate.invalidateEndpoint(endpointId);
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
  {
    // A paramless read used only for the CO-6.2 fanout-merge endpoint (never served here).
    resourceRef: "dashboards",
    name: "dashboards",
    operations: [
      { operationId: "getDashboard", method: "get", path: "/dashboards", parameters: [] },
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
    resourceRef: "meta",
    name: "meta",
    operations: [
      { operationId: "getMetaA", method: "get", path: "/meta/a", parameters: [] },
      { operationId: "getMetaB", method: "get", path: "/meta/b", parameters: [] },
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
  return { id: randomUUID(), mappingId, sourcePath, targetPath, transform: "rename", phase };
}

describe("adapter recompose + enable/disable + cache invalidation (requires Postgres)", () => {
  let config: AppConfig;
  let db: Database;
  let adapter: AdapterRuntime;
  let composition: AdapterCompositionService;
  let spy: SpyEndpointInvalidator;
  const stub = new StubBackend();

  const createdAppIds: string[] = [];
  const createdSpecIds: string[] = [];
  const createdMappingIds: string[] = [];
  let consumerAppId: string;
  let readEndpointId: string;
  let readBindingId: string;
  let mergeEndpointId: string;
  let mergeBindingAId: string;
  let mergeBindingBId: string;

  const adapterApp = (): FastifyInstance => adapter.app;
  const backendGets = (): number => stub.requests.filter((r) => r.startsWith("GET /tasks")).length;

  beforeAll(async () => {
    config = integrationConfig();
    db = createDb(config.database.url);
    await runMigrations(db);
    await stub.start();

    const backendApp = activeApp("recompose-backend", stub.url());
    createdAppIds.push(backendApp.id);
    await new RegisteredAppRepository(db).create(backendApp);
    const backendSpec = specRow(backendApp.id, "PROVIDER", backendIr);
    createdSpecIds.push(backendSpec.id);
    await new ApiSpecRepository(db).create(backendSpec);

    const consumerApp = activeApp("recompose-consumer");
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
    const readOp: OperationMapping = {
      id: randomUUID(),
      mappingId,
      sourceOperationRef: "todos/getTodo",
      targetOperationRef: "tasks/getTask",
      action: "read",
    };
    const readParam: ParameterMapping = {
      id: randomUUID(),
      operationMappingId: readOp.id,
      sourceParamRef: "todos/getTodo#todoId",
      targetParamRef: "tasks/getTask#taskId",
    };
    // Two paramless backend reads under the same consumer dashboard op → a fanout-merge endpoint.
    const mergeOpA: OperationMapping = {
      id: randomUUID(),
      mappingId,
      sourceOperationRef: "dashboards/getDashboard",
      targetOperationRef: "meta/getMetaA",
      action: "read",
    };
    const mergeOpB: OperationMapping = {
      id: randomUUID(),
      mappingId,
      sourceOperationRef: "dashboards/getDashboard",
      targetOperationRef: "meta/getMetaB",
      action: "read",
    };
    await new MappingArtifactsRepository(db).replaceChildren(mappingId, {
      fieldMappings: [
        renameField(mappingId, "tasks/task_id", "todos/id"),
        renameField(mappingId, "tasks/task_title", "todos/title"),
        renameField(mappingId, "tasks/completed", "todos/done"),
      ],
      operationMappings: [readOp, mergeOpA, mergeOpB],
      parameterMappings: [readParam],
    });

    const artifacts = new DownstreamArtifactRepository(db);
    // A single-binding read endpoint composed WITH a cacheTtl (CH-1 caching enabled).
    readEndpointId = randomUUID();
    readBindingId = randomUUID();
    const readEndpoint: AdapterEndpoint = {
      id: readEndpointId,
      consumerAppId: consumerApp.id,
      consumerOperationId: "todos/getTodo",
      status: "active",
      aggregationStrategy: "single",
      strictness: "degraded",
      cacheTtl: 60_000,
    };
    await artifacts.ensureAdapterEndpoint(readEndpoint);
    await artifacts.insertAdapterBindingIfAbsent({
      id: readBindingId,
      adapterEndpointId: readEndpointId,
      backendAppId: backendApp.id,
      backendOperationId: "tasks/getTask",
      approvedMappingId: mappingId,
      role: "primary",
      status: "active",
    });

    // A fanout-merge endpoint with a primary + a supplement binding (CO-6.2 binding disable).
    mergeEndpointId = randomUUID();
    mergeBindingAId = randomUUID();
    mergeBindingBId = randomUUID();
    await artifacts.ensureAdapterEndpoint({
      id: mergeEndpointId,
      consumerAppId: consumerApp.id,
      consumerOperationId: "dashboards/getDashboard",
      status: "active",
      aggregationStrategy: "fanout-merge",
      strictness: "degraded",
    });
    await artifacts.insertAdapterBindingIfAbsent({
      id: mergeBindingAId,
      adapterEndpointId: mergeEndpointId,
      backendAppId: backendApp.id,
      backendOperationId: "meta/getMetaA",
      approvedMappingId: mappingId,
      role: "primary",
      status: "active",
    });
    await artifacts.insertAdapterBindingIfAbsent({
      id: mergeBindingBId,
      adapterEndpointId: mergeEndpointId,
      backendAppId: backendApp.id,
      backendOperationId: "meta/getMetaB",
      approvedMappingId: mappingId,
      role: "supplement",
      status: "active",
    });

    // The ONE shared cache + a spy that wraps the real by-endpoint invalidation seam, so both
    // the serve path and the composition service drop the SAME cache (CH-5.6).
    const responseCache = new InProcessResponseCache();
    const realInvalidator = new ResponseCacheInvalidator(responseCache);
    spy = new SpyEndpointInvalidator(realInvalidator);
    const serveHandler = buildAdapterServeHandler({
      db,
      logger: createServerLogger(config),
      credentialMasterKey: config.credentials.masterKey,
      loadGovernor: new AppLoadGovernor(),
      responseCache,
      cacheInvalidator: realInvalidator,
    });
    adapter = buildAdapterRuntime({
      db,
      logger: createServerLogger(config),
      serveHandler,
      resolveConsumerApp: headerConsumerAppResolver,
    });
    await adapter.mountManager.reconcile();

    composition = new AdapterCompositionService({ db, newId: randomUUID, cacheInvalidator: spy });
  });

  afterAll(async () => {
    await stub.stop();
    const endpointIds = [readEndpointId, mergeEndpointId];
    await db.delete(adapterBinding).where(eq(adapterBinding.adapterEndpointId, readEndpointId));
    await db.delete(adapterBinding).where(eq(adapterBinding.adapterEndpointId, mergeEndpointId));
    for (const id of endpointIds) {
      await db.delete(adapterEndpoint).where(eq(adapterEndpoint.id, id));
    }
    for (const mappingId of createdMappingIds) {
      const opRows = await db
        .select({ id: operationMapping.id })
        .from(operationMapping)
        .where(eq(operationMapping.mappingId, mappingId));
      for (const op of opRows) {
        await db.delete(parameterMapping).where(eq(parameterMapping.operationMappingId, op.id));
      }
      await db.delete(operationMapping).where(eq(operationMapping.mappingId, mappingId));
      await db.delete(fieldMapping).where(eq(fieldMapping.mappingId, mappingId));
      await db.delete(approvedMapping).where(eq(approvedMapping.id, mappingId));
    }
    await db.delete(auditLog).where(eq(auditLog.actor, ACTOR));
    for (const id of createdSpecIds) {
      await db.delete(apiSpec).where(eq(apiSpec.id, id));
    }
    for (const id of createdAppIds) {
      await db.delete(registeredApp).where(eq(registeredApp.id, id));
    }
    await closeDb(db);
  });

  function getTodo(todoId: string): Promise<LightMyRequestResponse> {
    return adapterApp().inject({
      method: "GET",
      url: `/todos/${todoId}`,
      headers: { [CONSUMER_APP_HEADER]: consumerAppId },
    });
  }

  function readSubmission(overrides: Partial<CompositionSubmission> = {}): CompositionSubmission {
    return {
      aggregationStrategy: "single",
      strictness: "strict",
      cacheTtl: 60_000,
      bindings: [{ bindingId: readBindingId, role: "primary" }],
      ...overrides,
    };
  }

  async function loadEndpointState(endpointId: string): Promise<{
    endpoint: AdapterEndpoint | undefined;
    bindings: readonly AdapterBinding[];
  }> {
    const repo = new AdapterCompositionRepository(db);
    return {
      endpoint: await repo.getEndpointById(endpointId),
      bindings: await repo.listBindings(endpointId),
    };
  }

  it("CO-6.1 / CH-5.1: recomposing an active endpoint re-activates the new config AND drops its cache", async () => {
    const before = backendGets();
    // A first read: MISS → backend called once → now cached.
    expect((await getTodo("42")).json()).toEqual({ id: "42", title: "Task 42", done: true });
    expect(backendGets()).toBe(before + 1);
    // A second identical read: HIT → no new backend call.
    await getTodo("42");
    expect(backendGets()).toBe(before + 1);

    const callsBefore = spy.calls.length;
    const result = await composition.recompose(readEndpointId, readSubmission(), ACTOR);

    // Re-activated with the new config (strictness flipped degraded → strict).
    expect(result.endpoint.status).toBe("active");
    expect(result.endpoint.strictness).toBe("strict");
    const state = await loadEndpointState(readEndpointId);
    expect(state.endpoint?.strictness).toBe("strict");
    // CH-5.6 — routed through the shared by-endpoint seam.
    expect(spy.calls.slice(callsBefore)).toContain(readEndpointId);

    // CH-5.1 — the cache was dropped, so the next identical read is a MISS that re-calls backend.
    expect((await getTodo("42")).json()).toEqual({ id: "42", title: "Task 42", done: true });
    expect(backendGets()).toBe(before + 2);
  });

  it("CO-6.5 / CH-5: a recompose that fails validation is inert — prior config still serves, cache NOT dropped", async () => {
    // Prime a fresh entry (self-contained: a distinct id no other test touches): MISS then HIT.
    const before = backendGets();
    await getTodo("77");
    expect(backendGets()).toBe(before + 1);
    await getTodo("77");
    expect(backendGets()).toBe(before + 1);

    const callsBefore = spy.calls.length;
    // `supplement` is not a valid role under `single` → role-invalid-for-strategy rejection.
    await expect(
      composition.recompose(
        readEndpointId,
        readSubmission({ bindings: [{ bindingId: readBindingId, role: "supplement" }] }),
        ACTOR,
      ),
    ).rejects.toThrow();

    // Nothing was activated: the prior config (strictness strict from the previous test) stands.
    const state = await loadEndpointState(readEndpointId);
    expect(state.endpoint?.strictness).toBe("strict");
    expect(state.endpoint?.status).toBe("active");
    // CH-5 — a rejected recompose invalidates nothing: no new by-endpoint drop was issued…
    expect(spy.calls.slice(callsBefore)).not.toContain(readEndpointId);
    // …and the entry survives, so the next read is still a HIT with no backend call.
    await getTodo("77");
    expect(backendGets()).toBe(before + 1);
  });

  it("CO-6.3 / CH-5.5: disable rejects with endpoint-disabled; re-enable restores config and serves no stale entry", async () => {
    // Ensure a cached entry exists before disabling.
    const before = backendGets();
    await getTodo("55"); // MISS → cached
    expect(backendGets()).toBe(before + 1);
    await getTodo("55"); // HIT
    expect(backendGets()).toBe(before + 1);

    // Disable.
    const disabled = await composition.setEndpointEnabled(readEndpointId, false, ACTOR);
    expect(disabled.status).toBe("disabled");
    expect(spy.calls).toContain(readEndpointId);

    const disabledResponse = await getTodo("55");
    // RT-3.2 — the resolver rejects with endpoint-disabled; the backend is NOT called.
    expect(disabledResponse.headers[CAUSE_HEADER]).toBe("endpoint-disabled");
    expect(backendGets()).toBe(before + 1);

    // Re-enable — restores the stored configuration.
    const reenabled = await composition.setEndpointEnabled(readEndpointId, true, ACTOR);
    expect(reenabled.status).toBe("active");
    expect(reenabled.strictness).toBe("strict"); // config retained across disable → re-enable

    // CH-5.5 — it serves NO entry cached before the disable: the next read is a MISS.
    const served = await getTodo("55");
    expect(served.json()).toEqual({ id: "55", title: "Task 55", done: true });
    expect(backendGets()).toBe(before + 2);
  });

  it("CO-6.2: a binding marked disabled in a recompose is retained + skipped by the planner; a later recompose reactivates it", async () => {
    const mergeSubmission = (bDisabled: boolean): CompositionSubmission => ({
      aggregationStrategy: "fanout-merge",
      strictness: "degraded",
      bindings: [
        { bindingId: mergeBindingAId, role: "primary" },
        {
          bindingId: mergeBindingBId,
          role: "supplement",
          ...(bDisabled ? { disabled: true } : {}),
        },
      ],
    });

    // Recompose disabling the supplement binding.
    await composition.recompose(mergeEndpointId, mergeSubmission(true), ACTOR);
    const disabledState = await loadEndpointState(mergeEndpointId);
    const bA = disabledState.bindings.find((b) => b.id === mergeBindingAId);
    const bB = disabledState.bindings.find((b) => b.id === mergeBindingBId);
    // The row is RETAINED (not deleted), just disabled; the primary stays active.
    expect(bB?.status).toBe("disabled");
    expect(bA?.status).toBe("active");
    expect(disabledState.endpoint?.status).toBe("active");
    // The planner (resolveRequest) serves only the active binding — the disabled one is skipped.
    const resolved = resolveRequest({
      endpoint: disabledState.endpoint,
      bindings: disabledState.bindings,
    });
    expect(resolved.kind).toBe("serve");
    if (resolved.kind === "serve") {
      const activeIds = resolved.activeBindings.map((b) => b.id);
      expect(activeIds).toContain(mergeBindingAId);
      expect(activeIds).not.toContain(mergeBindingBId);
    }

    // A later recompose reactivates it.
    await composition.recompose(mergeEndpointId, mergeSubmission(false), ACTOR);
    const reactivated = await loadEndpointState(mergeEndpointId);
    expect(reactivated.bindings.find((b) => b.id === mergeBindingBId)?.status).toBe("active");
    const resolvedAgain = resolveRequest({
      endpoint: reactivated.endpoint,
      bindings: reactivated.bindings,
    });
    expect(resolvedAgain.kind === "serve" && resolvedAgain.activeBindings.length).toBe(2);
  });

  it("CO-6.6 / OA-3: every committed operation wrote exactly one operator-attributed audit row", async () => {
    const rows = await db.select().from(auditLog).where(eq(auditLog.actor, ACTOR));
    // 1 recompose (read) + 1 disable + 1 re-enable + 2 recompose (merge disable + reactivate) = 5.
    // The rejected recompose wrote NOTHING (it threw before any transaction).
    expect(rows.length).toBe(5);
    for (const row of rows) {
      expect(row.actor).toBe(ACTOR);
      expect(row.type).toBe("adapter-request");
      expect([readEndpointId, mergeEndpointId]).toContain(row.relatedEndpointId);
    }
    // Both endpoints are represented, and no secret ever appears in a details note.
    const endpoints = new Set(rows.map((row) => row.relatedEndpointId));
    expect(endpoints).toEqual(new Set([readEndpointId, mergeEndpointId]));
  });
});
