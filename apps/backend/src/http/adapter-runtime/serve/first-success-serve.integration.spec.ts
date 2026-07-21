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
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createServerLogger } from "../../../composition-root.js";
import { AdapterCompositionService } from "../../../modules/adapter-composition/index.js";
import { operatorAccountsEnv } from "../../../testing/auth.testkit.js";
import { buildAdapterServeHandler } from "./build-serve-handler.js";

/**
 * **Real-machinery capstone for AG-6 (`fanout-first-success`).** Against a live Postgres, the
 * REAL composition service + serve handler + DB-loaded bindings, and a **stub HTTP backend**
 * serving two alternative resources (`/alpha/{id}` primary, `/bravo/{id}` fallback):
 *
 *  - **AG-6.2 short-circuit:** a healthy primary answers → served from its mapping and the
 *    fallback backend is **never called**.
 *  - **AG-6.1 ordered fallback:** a primary returning 5xx falls to the next binding in
 *    `executionOrder` → served from the fallback, both backends called in order.
 *
 * Excluded from `pnpm verify`; run with `pnpm --filter @mediator/backend test:integration`.
 */

const ACTOR = "operator:first-success-serve-integration";

function integrationConfig(): AppConfig {
  return loadConfig({
    ...process.env,
    HTTP_PORT: "14994",
    ADAPTER_HTTP_PORT: "14995",
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

/** A stub serving `GET /alpha/{id}` and `GET /bravo/{id}`, recording requests, with a fail toggle. */
class StubBackend {
  #server: Server | undefined;
  public readonly requests: string[] = [];
  public readonly failResources = new Set<string>();

  public async start(): Promise<void> {
    this.#server = createServer((request: IncomingMessage, response: ServerResponse) => {
      const url = request.url ?? "/";
      this.requests.push(url);
      const match = /^\/(alpha|bravo)\/([^/?]+)/.exec(url);
      const resource = match?.[1];
      const id = match?.[2];
      if (resource === undefined || id === undefined) {
        response.writeHead(404, { "content-type": "application/json" });
        response.end("{}");
        return;
      }
      if (this.failResources.has(resource)) {
        response.writeHead(500, { "content-type": "application/json" });
        response.end("{}");
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          [`${resource}_id`]: id,
          [`${resource}_name`]: `${resource === "alpha" ? "Alpha" : "Bravo"} ${id}`,
        }),
      );
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

  public hits(prefix: string): number {
    return this.requests.filter((url) => url.startsWith(prefix)).length;
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

/** A backend `GET /{resource}/{id}` provider resource. */
function backendResource(resource: string): Ir[number] {
  return {
    resourceRef: resource,
    name: resource,
    operations: [
      {
        operationId: `get_${resource}`,
        method: "get",
        path: `/${resource}/{id}`,
        parameters: [{ name: "id", location: "path", required: true, type: "string" }],
      },
    ],
    schemas: [],
    crossResourceRefs: [],
  };
}

const CONSUMER_IR: Ir = [
  {
    resourceRef: "things",
    name: "things",
    operations: [
      {
        operationId: "getThing",
        method: "get",
        path: "/things/{thingId}",
        parameters: [{ name: "thingId", location: "path", required: true, type: "string" }],
        responseSchema: {
          name: "Thing",
          fields: [
            { name: "id", type: "string", required: true },
            { name: "title", type: "string", required: true },
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

describe("adapter fanout-first-success serve (AG-6) — requires Postgres", () => {
  let db: Database;
  let serveHandler: ServeHandler;
  const stub = new StubBackend();

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
    const service = new AdapterCompositionService({ db, newId: () => randomUUID() });

    // Two alternative backend apps (both pointing at the one stub), each its own resource.
    const primaryApp = activeApp("ffs-primary-backend", stub.url());
    const fallbackApp = activeApp("ffs-fallback-backend", stub.url());
    createdAppIds.push(primaryApp.id, fallbackApp.id);
    await new RegisteredAppRepository(db).create(primaryApp);
    await new RegisteredAppRepository(db).create(fallbackApp);
    const primarySpec = specRow(primaryApp.id, "PROVIDER", [backendResource("alpha")]);
    const fallbackSpec = specRow(fallbackApp.id, "PROVIDER", [backendResource("bravo")]);
    createdSpecIds.push(primarySpec.id, fallbackSpec.id);
    await new ApiSpecRepository(db).create(primarySpec);
    await new ApiSpecRepository(db).create(fallbackSpec);

    // Consumer app + spec.
    const consumer = activeApp("ffs-consumer");
    consumerAppId = consumer.id;
    createdAppIds.push(consumer.id);
    await new RegisteredAppRepository(db).create(consumer);
    const consumerSpec = specRow(consumer.id, "CONSUMER", CONSUMER_IR);
    createdSpecIds.push(consumerSpec.id);
    await new ApiSpecRepository(db).create(consumerSpec);

    // One consumer-provider mapping per alternative backend (things↔alpha, things↔bravo).
    const resp = (mappingId: string, source: string, target: string): FieldMapping => ({
      id: randomUUID(),
      mappingId,
      sourcePath: source,
      targetPath: target,
      transform: "rename",
      phase: "response",
    });
    async function seedMapping(
      targetSpecId: string,
      targetAppId: string,
      resource: string,
    ): Promise<string> {
      const mappingId = randomUUID();
      createdMappingIds.push(mappingId);
      await db.insert(approvedMapping).values({
        id: mappingId,
        sourceSpecId: consumerSpec.id,
        targetSpecId,
        sourceAppId: consumer.id,
        targetAppId,
        variant: "consumer-provider",
        approvedBy: ACTOR,
        approvedAt: new Date(),
        status: "active",
      });
      const op: OperationMapping = {
        id: randomUUID(),
        mappingId,
        sourceOperationRef: "things/getThing",
        targetOperationRef: `${resource}/get_${resource}`,
        action: "read",
      };
      const param: ParameterMapping = {
        id: randomUUID(),
        operationMappingId: op.id,
        sourceParamRef: "things/getThing#thingId",
        targetParamRef: `${resource}/get_${resource}#id`,
      };
      await new MappingArtifactsRepository(db).replaceChildren(mappingId, {
        operationMappings: [op],
        parameterMappings: [param],
        fieldMappings: [
          resp(mappingId, `${resource}/${resource}_id`, "things/id"),
          resp(mappingId, `${resource}/${resource}_name`, "things/title"),
        ],
      });
      return mappingId;
    }
    const primaryMappingId = await seedMapping(primarySpec.id, primaryApp.id, "alpha");
    const fallbackMappingId = await seedMapping(fallbackSpec.id, fallbackApp.id, "bravo");

    // Endpoint + two proposed bindings, then compose to fanout-first-success (order 0 / 1).
    const artifacts = new DownstreamArtifactRepository(db);
    const endpoint: AdapterEndpoint = {
      id: randomUUID(),
      consumerAppId: consumer.id,
      consumerOperationId: "things/getThing",
      status: "composition-required",
    };
    endpointId = endpoint.id;
    await artifacts.ensureAdapterEndpoint(endpoint);
    const primaryBindingId = randomUUID();
    const fallbackBindingId = randomUUID();
    createdBindingIds.push(primaryBindingId, fallbackBindingId);
    await artifacts.insertAdapterBindingIfAbsent({
      id: primaryBindingId,
      adapterEndpointId: endpoint.id,
      backendAppId: primaryApp.id,
      backendOperationId: "alpha/get_alpha",
      approvedMappingId: primaryMappingId,
      role: "primary",
      status: "proposed",
    });
    await artifacts.insertAdapterBindingIfAbsent({
      id: fallbackBindingId,
      adapterEndpointId: endpoint.id,
      backendAppId: fallbackApp.id,
      backendOperationId: "bravo/get_bravo",
      approvedMappingId: fallbackMappingId,
      role: "fallback",
      status: "proposed",
    });

    const composed = await service.compose(
      endpoint.id,
      {
        aggregationStrategy: "fanout-first-success",
        strictness: "degraded",
        bindings: [
          { bindingId: primaryBindingId, role: "primary", executionOrder: 0 },
          { bindingId: fallbackBindingId, role: "fallback", executionOrder: 1 },
        ],
      },
      ACTOR,
    );
    expect(composed.endpoint.status).toBe("active");
    expect(composed.endpoint.aggregationStrategy).toBe("fanout-first-success");
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
    await db.delete(apiSpec).where(inArray(apiSpec.id, createdSpecIds));
    await db.delete(registeredApp).where(inArray(registeredApp.id, createdAppIds));
    await closeDb(db);
    await stub.stop();
  });

  async function serveInput(thingId: string): Promise<ServeInput> {
    const compositions = new AdapterCompositionRepository(db);
    const endpoint = await compositions.getEndpointById(endpointId);
    if (endpoint === undefined) throw new Error("endpoint missing");
    const bindings = await compositions.listBindings(endpointId);
    const request: AdapterRequest = {
      consumerAppId,
      operationKey: "things/getThing",
      pathParameters: { thingId },
      query: {},
      headers: {},
      body: undefined,
    };
    return { request, endpoint, activeBindings: bindings.filter((b) => b.status === "active") };
  }

  it("AG-6.2: a healthy primary is served and the fallback backend is never called", async () => {
    const before = { alpha: stub.hits("/alpha/"), bravo: stub.hits("/bravo/") };
    const outcome = await serveHandler.serve(await serveInput("1"));
    expect(outcome.kind).toBe("served");
    if (outcome.kind !== "served") return;
    expect(outcome.body).toEqual({ id: "1", title: "Alpha 1" });
    expect(outcome.degraded).toBe(false);
    // AG-6.2 — the primary answered, so the fallback backend was NOT called.
    expect(stub.hits("/alpha/") - before.alpha).toBe(1);
    expect(stub.hits("/bravo/") - before.bravo).toBe(0);
  });

  it("AG-6.1: a failing primary falls through to the fallback in executionOrder", async () => {
    stub.failResources.add("alpha");
    try {
      const before = { alpha: stub.hits("/alpha/"), bravo: stub.hits("/bravo/") };
      const outcome = await serveHandler.serve(await serveInput("2"));
      expect(outcome.kind).toBe("served");
      if (outcome.kind !== "served") return;
      // Served from the fallback (bravo), mapped through ITS own pair's response mappings.
      expect(outcome.body).toEqual({ id: "2", title: "Bravo 2" });
      // Primary tried first (and failed), then the fallback tried.
      expect(stub.hits("/alpha/") - before.alpha).toBe(1);
      expect(stub.hits("/bravo/") - before.bravo).toBe(1);
    } finally {
      stub.failResources.delete("alpha");
    }
  });
});
