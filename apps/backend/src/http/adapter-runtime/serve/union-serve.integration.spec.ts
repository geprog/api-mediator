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
  fieldMapping,
  operationMapping,
  parameterMapping,
  recordLink,
  registeredApp,
  resourceBinding as resourceBindingTable,
  resourceBindingRef,
  runMigrations,
  AdapterCompositionRepository,
  ApiSpecRepository,
  DownstreamArtifactRepository,
  MappingArtifactsRepository,
  RecordLinkRepository,
  RegisteredAppRepository,
  ResourceBindingRepository,
  type Database,
} from "@mediator/db";
import type {
  AdapterEndpoint,
  ApiSpec,
  FieldMapping,
  Ir,
  OperationMapping,
  RecordLink,
  RegisteredApp,
  ResourceBinding,
} from "@mediator/domain";
import { AppLoadGovernor } from "@mediator/outbound";
import { inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createServerLogger } from "../../../composition-root.js";
import { canonicalResourcePairRef } from "../../../modules/artifact-instantiation/index.js";
import { AdapterCompositionService } from "../../../modules/adapter-composition/index.js";
import { operatorAccountsEnv } from "../../../testing/auth.testkit.js";
import { buildAdapterServeHandler } from "./build-serve-handler.js";
import { RecordLinkUnionLinkResolver } from "./union-links.js";

/**
 * **Real-machinery capstone for AG-3/AG-4/AG-5 (`collection-union`).** Against a live
 * Postgres, the REAL composition service + serve handler, and a **stub HTTP backend**
 * that pages via offset (server-clamped page size, so paging advances by the actual
 * received count and exhausts on an empty page):
 *
 *  - **merge + paging + resource-pair scoping:** a union over two backend resources, each
 *    paged, each mapped through its OWN pair's response-phase field mappings.
 *  - **AG-3.2 drop:** a contributor whose backend returns 5xx is dropped (non-strict) and
 *    named out of band via `degradedBackendAppIds`.
 *  - **AG-5.2 never truncate:** a request exceeding the row ceiling fails loud.
 *  - **AG-4 stable pages:** page 2 (sorted) is byte-identical across repeated requests.
 *  - **AG-3.3 link dedup over real Postgres:** a seeded `RecordLink` collapses two records
 *    across distinct apps through the real DB-backed link resolver.
 *
 * Excluded from `pnpm verify`; run with `pnpm --filter @mediator/backend test:integration`.
 */

const ACTOR = "operator:union-serve-integration";

function integrationConfig(): AppConfig {
  return loadConfig({
    ...process.env,
    HTTP_PORT: "14992",
    ADAPTER_HTTP_PORT: "14993",
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

interface Row {
  readonly [key: string]: string;
}

/** A stub backend paging two list resources by offset, with a server-clamped page size. */
class StubBackend {
  #server: Server | undefined;
  public readonly tasks: Row[] = [
    { task_id: "t1", task_title: "Alpha", task_state: "open" },
    { task_id: "t2", task_title: "Gamma", task_state: "open" },
    { task_id: "t3", task_title: "Echo", task_state: "closed" },
  ];
  public readonly issues: Row[] = [
    { issue_id: "i1", issue_title: "Bravo", issue_state: "open" },
    { issue_id: "i2", issue_title: "Delta", issue_state: "open" },
  ];
  public readonly failResources = new Set<string>();
  public pageSize = 2;

  public async start(): Promise<void> {
    this.#server = createServer((request: IncomingMessage, response: ServerResponse) => {
      const url = new URL(request.url ?? "/", "http://stub");
      const resource =
        url.pathname === "/tasks" ? "tasks" : url.pathname === "/issues" ? "issues" : undefined;
      if (resource === undefined) {
        response.writeHead(404, { "content-type": "application/json" });
        response.end("[]");
        return;
      }
      if (this.failResources.has(resource)) {
        response.writeHead(500, { "content-type": "application/json" });
        response.end("{}");
        return;
      }
      const offset = Number(url.searchParams.get("offset") ?? "0");
      const all = resource === "tasks" ? this.tasks : this.issues;
      const page = all.slice(offset, offset + this.pageSize);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(page));
    });
    await new Promise<void>((resolve) => this.#server?.listen(0, "127.0.0.1", resolve));
  }

  public url(): string {
    const address = this.#server?.address();
    if (address === null || address === undefined || typeof address === "string") {
      throw new Error("stub backend not listening");
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

/** A backend list resource with offset+limit paging parameters. */
function backendListResource(resource: string): Ir[number] {
  return {
    resourceRef: resource,
    name: resource,
    operations: [
      {
        operationId: `list_${resource}`,
        method: "get",
        path: `/${resource}`,
        parameters: [
          { name: "offset", location: "query", required: false, type: "integer" },
          { name: "limit", location: "query", required: false, type: "integer" },
        ],
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
          { name: "sort", location: "query", required: false, type: "string" },
          { name: "page", location: "query", required: false, type: "string" },
          { name: "size", location: "query", required: false, type: "string" },
        ],
        responseSchema: {
          name: "Todo",
          fields: [
            { name: "id", type: "string", required: true },
            { name: "title", type: "string", required: true },
            { name: "state", type: "string", required: false },
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

describe("adapter collection-union serve (AG-3/4/5) — requires Postgres", () => {
  let db: Database;
  let serveHandler: ServeHandler;
  let tightHandler: ServeHandler;
  const stub = new StubBackend();

  let backendAppId: string;
  let endpointId: string;
  let consumerAppId: string;

  beforeAll(async () => {
    await stub.start();
    const config = integrationConfig();
    db = createDb(config.database.url);
    await runMigrations(db);
    serveHandler = buildAdapterServeHandler({
      db,
      logger: createServerLogger(config),
      credentialMasterKey: config.credentials.masterKey,
      loadGovernor: new AppLoadGovernor(),
    });
    tightHandler = buildAdapterServeHandler({
      db,
      logger: createServerLogger(config),
      credentialMasterKey: config.credentials.masterKey,
      loadGovernor: new AppLoadGovernor(),
      unionRowCeiling: 2,
    });
    const service = new AdapterCompositionService({ db, newId: () => randomUUID() });

    // One backend PROVIDER app (the stub) with two paged list resources.
    const backendApp = activeApp("union-serve-backend", stub.url());
    backendAppId = backendApp.id;
    createdAppIds.push(backendApp.id);
    await new RegisteredAppRepository(db).create(backendApp);
    const backendSpec = specRow(backendApp.id, "PROVIDER", [
      backendListResource("tasks"),
      backendListResource("issues"),
    ]);
    createdSpecIds.push(backendSpec.id);
    await new ApiSpecRepository(db).create(backendSpec);

    const now = new Date();
    const rb = (resource: string, nativeIdField: string): ResourceBinding => ({
      id: randomUUID(),
      apiSpecId: backendSpec.id,
      resourceRef: resource,
      nativeIdRef: {
        value: { kind: "field", path: nativeIdField },
        confirmedBy: ACTOR,
        confirmedAt: now,
      },
      collectionReadRef: {
        value: { kind: "operation", operationId: `list_${resource}` },
        confirmedBy: ACTOR,
        confirmedAt: now,
      },
      paginationRef: {
        value: { kind: "parameter", operationId: `list_${resource}`, parameter: "offset" },
        confirmedBy: ACTOR,
        confirmedAt: now,
      },
      scopePathBindings: [],
    });
    await new ResourceBindingRepository(db).createMany([
      rb("tasks", "task_id"),
      rb("issues", "issue_id"),
    ]);

    // Consumer app + spec + a consumer-provider mapping over both resource pairs.
    const consumer = activeApp("union-serve-consumer");
    consumerAppId = consumer.id;
    createdAppIds.push(consumer.id);
    await new RegisteredAppRepository(db).create(consumer);
    const consumerSpec = specRow(consumer.id, "CONSUMER", CONSUMER_LIST_IR);
    createdSpecIds.push(consumerSpec.id);
    await new ApiSpecRepository(db).create(consumerSpec);

    const mappingId = randomUUID();
    createdMappingIds.push(mappingId);
    await db.insert(approvedMapping).values({
      id: mappingId,
      sourceSpecId: consumerSpec.id,
      targetSpecId: backendSpec.id,
      sourceAppId: consumer.id,
      targetAppId: backendApp.id,
      variant: "consumer-provider",
      approvedBy: "integration-test",
      approvedAt: new Date(),
      status: "active",
    });

    const operationMappings: OperationMapping[] = [
      {
        id: randomUUID(),
        mappingId,
        sourceOperationRef: "todos/listTodos",
        targetOperationRef: "tasks/list_tasks",
        action: "read",
      },
      {
        id: randomUUID(),
        mappingId,
        sourceOperationRef: "todos/listTodos",
        targetOperationRef: "issues/list_issues",
        action: "read",
      },
    ];
    // Per-pair response-phase field mappings — each maps that backend's native fields to the
    // consumer shape. The loader scopes them per binding's resource pair, so `issues` never
    // sees `tasks/*` mappings (the multi-pair scoping proof).
    const resp = (source: string, target: string): FieldMapping => ({
      id: randomUUID(),
      mappingId,
      sourcePath: source,
      targetPath: target,
      transform: "rename",
      phase: "response",
    });
    const fieldMappings: FieldMapping[] = [
      resp("tasks/task_id", "todos/id"),
      resp("tasks/task_title", "todos/title"),
      resp("tasks/task_state", "todos/state"),
      resp("issues/issue_id", "todos/id"),
      resp("issues/issue_title", "todos/title"),
      resp("issues/issue_state", "todos/state"),
    ];
    await new MappingArtifactsRepository(db).replaceChildren(mappingId, {
      operationMappings,
      parameterMappings: [],
      fieldMappings,
    });

    const artifacts = new DownstreamArtifactRepository(db);
    const endpoint: AdapterEndpoint = {
      id: randomUUID(),
      consumerAppId: consumer.id,
      consumerOperationId: "todos/listTodos",
      status: "composition-required",
    };
    endpointId = endpoint.id;
    await artifacts.ensureAdapterEndpoint(endpoint);
    for (const resource of ["tasks", "issues"]) {
      const bindingId = randomUUID();
      createdBindingIds.push(bindingId);
      await artifacts.insertAdapterBindingIfAbsent({
        id: bindingId,
        adapterEndpointId: endpoint.id,
        backendAppId: backendApp.id,
        backendOperationId: `${resource}/list_${resource}`,
        approvedMappingId: mappingId,
        role: "supplement",
        status: "proposed",
      });
    }

    // Compose + activate: dedup none, a value-driven sort, a confirmed page-number pagination.
    const bindings = await new AdapterCompositionRepository(db).listBindings(endpoint.id);
    const composed = await service.compose(
      endpoint.id,
      {
        aggregationStrategy: "collection-union",
        strictness: "degraded",
        bindings: bindings.map((binding) => ({
          bindingId: binding.id,
          role: "supplement" as const,
        })),
        postMergeDedup: { mode: "none" },
        postMergeSorts: [
          {
            consumerParamRef: "todos/listTodos#sort",
            paramValue: "title",
            consumerFieldPath: "todos/title",
            direction: "asc",
          },
        ],
        postMergePagination: {
          convention: "page-number",
          pageParamRef: "todos/listTodos#page",
          sizeParamRef: "todos/listTodos#size",
          firstPageNumber: 1,
        },
        confirmPostMergePagination: true,
        cacheTtl: 30_000,
      },
      ACTOR,
    );
    expect(composed.endpoint.status).toBe("active");
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
    await db.delete(recordLink).where(inArray(recordLink.appAId, createdAppIds));
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
    await stub.stop();
  });

  async function serveWith(
    handler: ServeHandler,
    query: Record<string, string>,
  ): Promise<ServeInput> {
    const compositions = new AdapterCompositionRepository(db);
    const endpoint = await compositions.getEndpointById(endpointId);
    if (endpoint === undefined) throw new Error("endpoint missing");
    const bindings = await compositions.listBindings(endpointId);
    const request: AdapterRequest = {
      consumerAppId,
      operationKey: "todos/listTodos",
      pathParameters: {},
      query,
      headers: {},
      body: undefined,
    };
    return { request, endpoint, activeBindings: bindings.filter((b) => b.status === "active") };
  }

  it("merges two paged backend resources into one consumer-shape list (per-pair field mappings)", async () => {
    const outcome = await serveHandler.serve(await serveWith(serveHandler, {}));
    expect(outcome.kind).toBe("served");
    if (outcome.kind !== "served") return;
    const rows = outcome.body as { id: string; title: string; state?: string }[];
    // All 5 records across both paged resources, each mapped through its own pair.
    expect(rows.map((r) => r.id).sort()).toEqual(["i1", "i2", "t1", "t2", "t3"]);
    // The `tasks` rows carry the tasks pair's mapping; `issues` rows the issues pair's.
    expect(rows.find((r) => r.id === "t1")).toEqual({ id: "t1", title: "Alpha", state: "open" });
    expect(rows.find((r) => r.id === "i1")).toEqual({ id: "i1", title: "Bravo", state: "open" });
  });

  it("AG-3.2: a contributor whose backend returns 5xx is dropped (non-strict), named out of band", async () => {
    stub.failResources.add("issues");
    try {
      const outcome = await serveHandler.serve(await serveWith(serveHandler, {}));
      expect(outcome.kind).toBe("served");
      if (outcome.kind !== "served") return;
      const rows = outcome.body as { id: string }[];
      expect(rows.map((r) => r.id).sort()).toEqual(["t1", "t2", "t3"]);
      expect(outcome.degraded).toBe(true);
      expect(outcome.degradedBackendAppIds).toContain(backendAppId);
    } finally {
      stub.failResources.delete("issues");
    }
  });

  it("AG-5.2: a request exceeding the row ceiling fails loud (never a truncated union)", async () => {
    // `tasks` has 3 rows; the tight handler's ceiling is 2 → the fetch fails rather than truncate.
    const outcome = await tightHandler.serve(await serveWith(tightHandler, {}));
    expect(outcome.kind).toBe("failed");
    if (outcome.kind !== "failed") return;
    expect(outcome.cause).toBe("upstream-error");
  });

  it("AG-4: page 2 (sorted) is stable across identical repeated requests", async () => {
    // Sorted by title asc: Alpha(t1), Bravo(i1), Delta(i2), Echo(t3), Gamma(t2).
    // page 2, size 2, first page 1 → rows [2,4) → Delta(i2), Echo(t3).
    const query = { sort: "title", page: "2", size: "2" };
    const first = await serveHandler.serve(await serveWith(serveHandler, query));
    const second = await serveHandler.serve(await serveWith(serveHandler, query));
    expect(first).toEqual(second);
    expect(first.kind).toBe("served");
    if (first.kind !== "served") return;
    expect((first.body as { id: string }[]).map((r) => r.id)).toEqual(["i2", "t3"]);
  });

  it("AG-3.3: a seeded RecordLink collapses two records across apps (real DB link resolver)", async () => {
    const appX = backendAppId;
    const peer = activeApp("union-link-peer");
    createdAppIds.push(peer.id);
    await new RegisteredAppRepository(db).create(peer);
    const pairRef = canonicalResourcePairRef(
      { appId: appX, resourceRef: "tasks" },
      { appId: peer.id, resourceRef: "issues" },
    );
    const link: RecordLink = {
      id: randomUUID(),
      appAId: appX,
      appANativeId: "t1",
      appBId: peer.id,
      appBNativeId: "i1",
      resourcePairRef: pairRef,
      establishedBy: "manual",
      status: "active",
      establishingQueueKey: { kind: "both-native-id-queues" },
      createdAt: new Date(),
      tombstonedAt: null,
    };
    await new RecordLinkRepository(db).insert(link);

    const resolver = new RecordLinkUnionLinkResolver(new RecordLinkRepository(db));
    const groups = await resolver.resolve([
      { bindingId: "a", backendAppId: appX, backendResourceRef: "tasks", nativeIds: ["t1", "t2"] },
      { bindingId: "b", backendAppId: peer.id, backendResourceRef: "issues", nativeIds: ["i1"] },
    ]);
    // t1 ↔ i1 collapse (shared group key); t2 is unlinked.
    expect(groups.get("a")?.[0]).toBeDefined();
    expect(groups.get("a")?.[0]).toBe(groups.get("b")?.[0]);
    expect(groups.get("a")?.[1]).toBeUndefined();
  });
});
