import { randomUUID } from "node:crypto";

import { deriveMountedOperations, type ServeHandler } from "@mediator/adapter-engine";
import { loadConfig, type AppConfig } from "@mediator/config";
import {
  adapterBinding,
  adapterEndpoint,
  apiSpec,
  approvedMapping,
  auditLog,
  closeDb,
  createDb,
  registeredApp,
  runMigrations,
  tx,
  ApiSpecRepository,
  DownstreamArtifactRepository,
  RegisteredAppRepository,
  type Database,
} from "@mediator/db";
import type { AdapterBinding, AdapterEndpoint, ApiSpec, Ir, RegisteredApp } from "@mediator/domain";
import { SPEC_INGESTED_EVENT_TYPE } from "@mediator/domain";
import type { DeliveredEvent } from "@mediator/event-bus";
import { buildIr } from "@mediator/ir";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildServer, createServerLogger, type RunningServer } from "../../composition-root.js";
import { operatorAccountsEnv } from "../../testing/auth.testkit.js";
import { buildAdapterMountReactions } from "./background.js";
import { buildAdapterRuntime, type AdapterRuntime } from "./build-adapter-runtime.js";
import { CONSUMER_APP_HEADER } from "./consumer-app-resolver.js";
import { CAUSE_HEADER } from "./outcome-http.js";

/**
 * Boots the **real second Fastify instance** (the Adapter Server Runtime) over a
 * live Postgres and asserts the RT-1…RT-5 end state: the two servers are isolated
 * by port, a mounted-but-unbound operation answers `not-yet-mapped` (not 404, not an
 * empty body), an unknown path answers a plain 404, a disabled endpoint answers
 * `endpoint-disabled`, a `composition-required` endpoint with a prior active binding
 * keeps serving, the surface mounts live / tears down / re-derives from persisted
 * state, and exactly one payload-free audit row is written per request.
 *
 * Excluded from `pnpm verify`; run with `pnpm --filter @mediator/backend test:integration`.
 */

// Fixed, uncommon ports; integration spec files run serially (fileParallelism:false).
const OPERATOR_PORT = 14901;
const ADAPTER_PORT = 14900;

/** A faithful, minimal `todo-widget`-shaped CONSUMER OpenAPI document. */
const consumerDocument = {
  openapi: "3.1.0",
  info: { title: "Todo Widget API", version: "1.0.0" },
  paths: {
    "/todos": {
      get: {
        operationId: "listTodos",
        tags: ["todos"],
        responses: { "200": { description: "A page of todos." } },
      },
    },
    "/lists/{listId}/todos": {
      post: {
        operationId: "createTodo",
        tags: ["lists"],
        parameters: [{ name: "listId", in: "path", required: true, schema: { type: "string" } }],
        responses: { "201": { description: "Created." } },
      },
    },
    "/todos/{todoId}/complete": {
      post: {
        operationId: "completeTodo",
        tags: ["todos"],
        parameters: [{ name: "todoId", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "Completed." } },
      },
    },
  },
} satisfies Record<string, unknown>;

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

function activeApp(name: string): RegisteredApp {
  return {
    id: randomUUID(),
    name,
    status: "active",
    capabilities: {
      supportsPolling: false,
      supportsDeltaQuery: false,
      supportsChangeTimestamps: false,
      defaultPollInterval: 60_000,
    },
    createdAt: new Date(),
  };
}

function consumerSpecRow(appId: string, ir: Ir): ApiSpec {
  return {
    id: randomUUID(),
    appId,
    role: "CONSUMER",
    rawDocument: consumerDocument,
    parsedIR: ir,
    analysisExclusions: [],
    version: 1,
    contentHash: `hash-${randomUUID()}`,
    status: "active",
    createdAt: new Date(),
  };
}

describe("adapter runtime integration (requires Postgres)", () => {
  let config: AppConfig;
  let db: Database;
  let operator: RunningServer;
  let adapter: AdapterRuntime;

  const createdAppIds: string[] = [];
  const createdSpecIds: string[] = [];
  let consumerAppId: string;
  let disabledEndpointId: string;
  let servingEndpointId: string;
  let ir: Ir;

  const auditActor = (): string => `consumer-app:${consumerAppId}`;
  const adapterUrl = (path: string): string => `http://127.0.0.1:${String(ADAPTER_PORT)}${path}`;
  const withApp = (appId: string): Record<string, string> => ({ [CONSUMER_APP_HEADER]: appId });

  beforeAll(async () => {
    config = integrationConfig();
    db = createDb(config.database.url);
    await runMigrations(db);

    ir = await buildIr(consumerDocument);
    const keyOf: Record<string, string> = Object.fromEntries(
      deriveMountedOperations(ir).map((op) => [op.operationId, op.operationKey]),
    );

    const apps = new RegisteredAppRepository(db);
    const specs = new ApiSpecRepository(db);
    const artifacts = new DownstreamArtifactRepository(db);

    const consumerApp = activeApp("todo-widget");
    const backendApp = activeApp("vikunja-backend");
    consumerAppId = consumerApp.id;
    createdAppIds.push(consumerApp.id, backendApp.id);
    await apps.create(consumerApp);
    await apps.create(backendApp);

    const consumerSpec = consumerSpecRow(consumerApp.id, ir);
    const backendSpec: ApiSpec = {
      id: randomUUID(),
      appId: backendApp.id,
      role: "PROVIDER",
      rawDocument: { openapi: "3.1.0", info: { title: "Vikunja", version: "1" }, paths: {} },
      parsedIR: [],
      analysisExclusions: [],
      version: 1,
      contentHash: `hash-${randomUUID()}`,
      status: "active",
      createdAt: new Date(),
    };
    createdSpecIds.push(consumerSpec.id, backendSpec.id);
    await specs.create(consumerSpec);
    await specs.create(backendSpec);

    // An active consumer-provider ApprovedMapping so the active binding's FK holds.
    const mappingId = randomUUID();
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

    // `/todos/{todoId}/complete` → a DISABLED endpoint (RT-3.2).
    const disabled: AdapterEndpoint = {
      id: randomUUID(),
      consumerAppId: consumerApp.id,
      consumerOperationId: keyOf["completeTodo"] ?? "todos/completeTodo",
      status: "disabled",
    };
    await artifacts.ensureAdapterEndpoint(disabled);
    disabledEndpointId = disabled.id;

    // `/lists/{listId}/todos` → composition-required WITH an active binding (RT-3.3).
    const serving: AdapterEndpoint = {
      id: randomUUID(),
      consumerAppId: consumerApp.id,
      consumerOperationId: keyOf["createTodo"] ?? "lists/createTodo",
      status: "composition-required",
    };
    await artifacts.ensureAdapterEndpoint(serving);
    servingEndpointId = serving.id;
    const activeBinding: AdapterBinding = {
      id: randomUUID(),
      adapterEndpointId: serving.id,
      backendAppId: backendApp.id,
      backendOperationId: "tasks/createTask",
      approvedMappingId: mappingId,
      role: "primary",
      status: "active",
    };
    await artifacts.insertAdapterBindingIfAbsent(activeBinding);
    // `/todos` (listTodos) intentionally has NO endpoint → not-yet-mapped.

    const logger = createServerLogger(config);
    operator = buildServer({ config, db, logger });
    await operator.app.listen({ port: config.http.port, host: "127.0.0.1" });

    adapter = buildAdapterRuntime({ db, logger });
    await adapter.mountManager.reconcile();
    await adapter.app.listen({ port: config.adapterHttp.port, host: "127.0.0.1" });
  });

  afterAll(async () => {
    await adapter.app.close();
    await operator.app.close();
    // Children first, then parents.
    const endpointRows = await db
      .select({ id: adapterEndpoint.id })
      .from(adapterEndpoint)
      .where(inArray(adapterEndpoint.consumerAppId, createdAppIds));
    const endpointIds = endpointRows.map((row) => row.id);
    if (endpointIds.length > 0) {
      await db.delete(adapterBinding).where(inArray(adapterBinding.adapterEndpointId, endpointIds));
      await db.delete(adapterEndpoint).where(inArray(adapterEndpoint.id, endpointIds));
    }
    await db.delete(approvedMapping).where(inArray(approvedMapping.sourceAppId, createdAppIds));
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

  // ── RT-1: two isolated listeners ───────────────────────────────────────────

  it("RT-1.2: an operator route (/api/apps) 404s on the adapter port", async () => {
    const response = await fetch(adapterUrl("/api/apps"), { headers: withApp(consumerAppId) });
    expect(response.status).toBe(404);
  });

  it("RT-1.3: a consumer route (/todos) 404s on the operator port", async () => {
    const response = await operator.app.inject({
      method: "GET",
      url: "/todos",
      headers: withApp(consumerAppId),
    });
    expect(response.statusCode).toBe(404);
  });

  // ── RT-2 / RT-3: the three distinct answers ────────────────────────────────

  it("RT-3.1: a mounted but unbound operation answers not-yet-mapped (not 404, not an empty body)", async () => {
    const response = await fetch(adapterUrl("/todos"), { headers: withApp(consumerAppId) });
    expect(response.status).not.toBe(404);
    expect(response.headers.get(CAUSE_HEADER)).toBe("not-yet-mapped");
    const body = (await response.json()) as { cause?: string };
    expect(body.cause).toBe("not-yet-mapped");
  });

  it("RT-2.2: a path in no mounted spec answers a plain 404", async () => {
    const response = await fetch(adapterUrl("/nope/does-not-exist"), {
      headers: withApp(consumerAppId),
    });
    expect(response.status).toBe(404);
    expect(response.headers.get(CAUSE_HEADER)).toBeNull();
  });

  it("RT-3.2: a disabled endpoint answers endpoint-disabled", async () => {
    const response = await fetch(adapterUrl("/todos/42/complete"), {
      method: "POST",
      headers: withApp(consumerAppId),
    });
    expect(response.headers.get(CAUSE_HEADER)).toBe("endpoint-disabled");
    const body = (await response.json()) as { cause?: string };
    expect(body.cause).toBe("endpoint-disabled");
  });

  it("RT-3.3: composition-required WITH a prior active binding keeps serving — not not-yet-mapped", async () => {
    const response = await fetch(adapterUrl("/lists/7/todos"), {
      method: "POST",
      headers: withApp(consumerAppId),
    });
    // No ServeHandler is wired in this RT slice, so a served resolution renders the
    // distinct placeholder — the point is that it is NOT `not-yet-mapped`.
    expect(response.headers.get(CAUSE_HEADER)).not.toBe("not-yet-mapped");
    expect(response.headers.get(CAUSE_HEADER)).toBe("serving-not-implemented");
  });

  it("RT-2.3: an unregistered consumer app resolves within an empty surface — a 404, never the first app's not-yet-mapped", async () => {
    const response = await fetch(adapterUrl("/todos"), { headers: withApp(randomUUID()) });
    expect(response.status).toBe(404);
    expect(response.headers.get(CAUSE_HEADER)).toBeNull();
  });

  it("unattributable caller (no consumer-app seam) is rejected 401, not audited", async () => {
    const response = await fetch(adapterUrl("/todos"));
    expect(response.status).toBe(401);
  });

  // ── RT-5: one payload-free audit row per request ───────────────────────────

  it("RT-5.1/5.5: exactly one adapter-request audit row per request, with no payload or token", async () => {
    await db.delete(auditLog).where(eq(auditLog.actor, auditActor()));
    const token = "super-secret-adapter-token-value";

    await fetch(adapterUrl("/todos"), {
      headers: { ...withApp(consumerAppId), authorization: `Bearer ${token}` },
    });

    const rows = await db.select().from(auditLog).where(eq(auditLog.actor, auditActor()));
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row?.type).toBe("adapter-request");
    expect(row?.status).toBe("failure");
    expect(row?.cause).toBe("not-yet-mapped");
    // No token or payload anywhere in the row (metadata only — RT-5.5).
    expect(JSON.stringify(row)).not.toContain(token);
  });

  it("RT-5.1: a served (composition-required) request records the endpoint + binding", async () => {
    await db.delete(auditLog).where(eq(auditLog.actor, auditActor()));

    await fetch(adapterUrl("/lists/7/todos"), { method: "POST", headers: withApp(consumerAppId) });

    const rows = await db.select().from(auditLog).where(eq(auditLog.actor, auditActor()));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.relatedEndpointId).toBe(servingEndpointId);
    expect(rows[0]?.relatedBindingId).not.toBeNull();
  });

  // ── RT-1.5: the serving seam RP/TE/AG build behind ─────────────────────────

  it("delegates a serve outcome to an injected ServeHandler → 200 with the served body", async () => {
    const serveHandler: ServeHandler = {
      serve: (input) =>
        Promise.resolve({
          kind: "served",
          body: { servedOperation: input.request.operationKey },
          degraded: false,
          contributingBackendAppIds: [input.activeBindings[0]?.backendAppId ?? "none"],
        }),
    };
    const runtime = buildAdapterRuntime({ db, logger: createServerLogger(config), serveHandler });
    await runtime.mountManager.reconcile();

    const response = await runtime.app.inject({
      method: "POST",
      url: "/lists/7/todos",
      headers: withApp(consumerAppId),
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<{ servedOperation?: string }>();
    expect(body.servedOperation).toContain("createTodo");
    await runtime.app.close();
  });

  // ── RT-4: mount lifecycle ──────────────────────────────────────────────────

  it("RT-4.5: a fresh runtime re-derives the mounted surface from persisted state alone", async () => {
    const fresh = buildAdapterRuntime({ db, logger: createServerLogger(config) });
    const before = await fresh.app.inject({
      method: "GET",
      url: "/todos",
      headers: withApp(consumerAppId),
    });
    expect(before.statusCode).toBe(404);

    await fresh.mountManager.reconcile();
    const after = await fresh.app.inject({
      method: "GET",
      url: "/todos",
      headers: withApp(consumerAppId),
    });
    expect(after.headers[CAUSE_HEADER]).toBe("not-yet-mapped");
    await fresh.app.close();
  });

  it("RT-4.1: a newly-ingested CONSUMER spec becomes routable live via the SpecIngested consumer", async () => {
    const app = activeApp("second-consumer");
    const spec = consumerSpecRow(app.id, ir);
    createdAppIds.push(app.id);
    createdSpecIds.push(spec.id);
    await new RegisteredAppRepository(db).create(app);
    await new ApiSpecRepository(db).create(spec);

    const before = await fetch(adapterUrl("/todos"), { headers: withApp(app.id) });
    expect(before.status).toBe(404);

    // Drive the REAL mount consumer with a CONSUMER SpecIngested event.
    const reactions = buildAdapterMountReactions(adapter.mountManager);
    const event: DeliveredEvent = {
      id: randomUUID(),
      type: SPEC_INGESTED_EVENT_TYPE,
      occurredAt: new Date(),
      payload: { apiSpecId: spec.id, appId: app.id, role: "CONSUMER" },
    };
    await tx(db, (txn) => reactions.consumer.handle(event, txn));

    const after = await fetch(adapterUrl("/todos"), { headers: withApp(app.id) });
    expect(after.headers.get(CAUSE_HEADER)).toBe("not-yet-mapped");
  });

  it("RT-4.2: a disabled consumer app stops being served after reconcile", async () => {
    await db
      .update(registeredApp)
      .set({ status: "disabled" })
      .where(eq(registeredApp.id, consumerAppId));
    await adapter.mountManager.reconcile();

    const response = await fetch(adapterUrl("/todos"), { headers: withApp(consumerAppId) });
    expect(response.status).toBe(404);

    await db
      .update(registeredApp)
      .set({ status: "active" })
      .where(eq(registeredApp.id, consumerAppId));
    await adapter.mountManager.reconcile();
  });

  it("RT-4.3: a deregistered consumer app (endpoints deleted, spec archived) leaves callers hitting nothing", async () => {
    // Simulate the adapter-side effect of the deregister cascade (the cascade
    // operation itself is Phase 6): delete endpoints/bindings and archive the spec.
    await db
      .delete(adapterBinding)
      .where(inArray(adapterBinding.adapterEndpointId, [servingEndpointId, disabledEndpointId]));
    await db
      .delete(adapterEndpoint)
      .where(inArray(adapterEndpoint.id, [servingEndpointId, disabledEndpointId]));
    await db
      .update(apiSpec)
      .set({ status: "archived" })
      .where(and(eq(apiSpec.appId, consumerAppId), eq(apiSpec.role, "CONSUMER")));
    await adapter.mountManager.reconcile();

    const response = await fetch(adapterUrl("/todos"), { headers: withApp(consumerAppId) });
    expect(response.status).toBe(404);
    expect(response.headers.get(CAUSE_HEADER)).toBeNull();
  });
});
