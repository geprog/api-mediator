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
  AdapterEndpoint,
  ApiSpec,
  ChainInput,
  FieldMapping,
  Ir,
  MappingPhase,
  OperationMapping,
  ParameterMapping,
  RegisteredApp,
} from "@mediator/domain";
import { AppLoadGovernor } from "@mediator/outbound";
import { inArray } from "drizzle-orm";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createServerLogger } from "../../../composition-root.js";
import { AdapterCompositionService } from "../../../modules/adapter-composition/index.js";
import { operatorAccountsEnv } from "../../../testing/auth.testkit.js";
import { buildAdapterRuntime, type AdapterRuntime } from "../build-adapter-runtime.js";
import { CONSUMER_APP_HEADER, headerConsumerAppResolver } from "../consumer-app-resolver.js";
import {
  CAUSE_HEADER,
  CONTRIBUTING_BACKENDS_HEADER,
  DEGRADED_BACKENDS_HEADER,
  DEGRADED_HEADER,
} from "../outcome-http.js";
import { buildAdapterServeHandler } from "./build-serve-handler.js";

/**
 * **Real-machinery proof of Phase-5 TE-3 + AG-2** (`fanout-merge` execution with
 * chaining and degradation): the REAL injected `ServeHandler` (real `CredentialStore`
 * `withCredential`, real REST `ProtocolClient`, one shared `AppLoadGovernor`) against a
 * live Postgres and TWO stub HTTP backends (a `crm` user backend + a `billing`
 * entitlement backend). It drives:
 *
 *  - a `fanout-merge` **composed via CO-2** → served → the assembled consumer object;
 *  - a `supplement` returning 5xx → **degraded** (optional field omitted, failed backend
 *    named out of band) vs **whole-fail** (a required field → load-bearing);
 *  - a **chained** supplement whose backend id is filled from the primary's consumer-shape
 *    response (TE-3.2/3.3), and the A-absent case failing the dependent loudly (TE-3.4);
 *  - **resource-pair scoping**: a supplement mapping spanning two pairs contributes only
 *    its own pair's field — a foreign pair's mapping never leaks.
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

/**
 * A recording stub serving `GET /users/{id}` and `GET /entitlements/{id}`.
 *  - `users`: id `nullid` returns `user_id: null` (so the primary SUCCEEDS but its
 *    consumer-shape `id` is null — the chain-input-absent case, TE-3.4); otherwise
 *    `{ user_id, user_name }`.
 *  - `entitlements`: id starting `fail` returns HTTP 503 (the failed-supplement case);
 *    otherwise `{ tier, extra }`.
 */
class StubBackend {
  #server: Server | undefined;
  public readonly requests: { method: string; url: string }[] = [];

  public async start(): Promise<void> {
    this.#server = createServer((request: IncomingMessage, response: ServerResponse) => {
      const url = request.url ?? "";
      this.requests.push({ method: request.method ?? "", url });
      const userMatch = /^\/users\/([^/?]+)/.exec(url);
      if (request.method === "GET" && userMatch) {
        const id = decodeURIComponent(userMatch[1] ?? "");
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify(
            id === "nullid"
              ? { user_id: null, user_name: "Null User" }
              : { user_id: id, user_name: `User ${id}` },
          ),
        );
        return;
      }
      const entMatch = /^\/entitlements\/([^/?]+)/.exec(url);
      if (request.method === "GET" && entMatch) {
        const id = decodeURIComponent(entMatch[1] ?? "");
        if (id.startsWith("fail")) {
          response.writeHead(503, { "content-type": "application/json" });
          response.end("{}");
          return;
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ tier: "pro", extra: "leak-me" }));
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

  public entitlementRequests(): number {
    return this.requests.filter((r) => r.url.startsWith("/entitlements/")).length;
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

function consumerIr(planRequired: boolean): Ir {
  return [
    {
      resourceRef: "profiles",
      name: "profiles",
      operations: [
        {
          operationId: "getProfile",
          method: "get",
          path: "/profiles/{userId}",
          parameters: [{ name: "userId", location: "path", required: true, type: "string" }],
          responseSchema: {
            name: "Profile",
            fields: [
              { name: "id", type: "string", required: true },
              { name: "name", type: "string", required: true },
              { name: "plan", type: "string", required: planRequired },
            ],
          },
        },
      ],
      schemas: [],
      crossResourceRefs: [],
    },
  ];
}

const crmIr: Ir = [
  {
    resourceRef: "users",
    name: "users",
    operations: [
      {
        operationId: "getUser",
        method: "get",
        path: "/users/{userId}",
        parameters: [{ name: "userId", location: "path", required: true, type: "string" }],
      },
    ],
    schemas: [],
    crossResourceRefs: [],
  },
];

const billingIr: Ir = [
  {
    resourceRef: "entitlements",
    name: "entitlements",
    operations: [
      {
        operationId: "getEntitlement",
        method: "get",
        path: "/entitlements/{userId}",
        parameters: [{ name: "userId", location: "path", required: true, type: "string" }],
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
  phase: MappingPhase,
): FieldMapping {
  return { id: randomUUID(), mappingId, sourcePath, targetPath, transform: "rename", phase };
}

const ACTOR = "operator:integration";

describe("fanout-merge serve integration — TE-3 + AG-2 (requires Postgres)", () => {
  let config: AppConfig;
  let db: Database;
  let adapter: AdapterRuntime;
  const stub = new StubBackend();

  const createdAppIds: string[] = [];
  const createdSpecIds: string[] = [];
  const createdMappingIds: string[] = [];

  let crmAppId: string;
  let crmSpecId: string;
  let billingAppId: string;
  let billingSpecId: string;

  const adapterApp = (): FastifyInstance => adapter.app;

  /**
   * Seed a consumer with a `fanout-merge` endpoint: a `primary` binding (profiles↔users,
   * its own mapping) and a `supplement` binding (profiles↔entitlements, its own mapping).
   * `active: true` seeds an already-`active` endpoint; `active: false` seeds a
   * `composition-required` endpoint (primary active, supplement proposed) to be composed
   * via CO-2. `chained` fills the supplement's `userId` from the primary's consumer-shape
   * `id`; `foreignLeak` adds a foreign resource-pair response mapping to the supplement.
   */
  async function seedFanout(opts: {
    name: string;
    planRequired: boolean;
    active: boolean;
    chained: boolean;
    foreignLeak: boolean;
  }): Promise<{
    consumerAppId: string;
    endpointId: string;
    primaryId: string;
    supplementId: string;
  }> {
    const consumerApp = activeApp(opts.name);
    createdAppIds.push(consumerApp.id);
    await new RegisteredAppRepository(db).create(consumerApp);
    const consumerSpec = specRow(consumerApp.id, "CONSUMER", consumerIr(opts.planRequired));
    createdSpecIds.push(consumerSpec.id);
    await new ApiSpecRepository(db).create(consumerSpec);

    const primaryMappingId = randomUUID();
    const supplementMappingId = randomUUID();
    createdMappingIds.push(primaryMappingId, supplementMappingId);

    for (const [mappingId, targetSpecId, targetAppId] of [
      [primaryMappingId, crmSpecId, crmAppId],
      [supplementMappingId, billingSpecId, billingAppId],
    ] as const) {
      await db.insert(approvedMapping).values({
        id: mappingId,
        sourceSpecId: consumerSpec.id,
        targetSpecId,
        sourceAppId: consumerApp.id,
        targetAppId,
        variant: "consumer-provider",
        approvedBy: ACTOR,
        approvedAt: new Date(),
        status: "active",
      });
    }

    // Primary mapping: profiles↔users.
    const primaryOp: OperationMapping = {
      id: randomUUID(),
      mappingId: primaryMappingId,
      sourceOperationRef: "profiles/getProfile",
      targetOperationRef: "users/getUser",
      action: "read",
    };
    await new MappingArtifactsRepository(db).replaceChildren(primaryMappingId, {
      operationMappings: [primaryOp],
      parameterMappings: [
        {
          id: randomUUID(),
          operationMappingId: primaryOp.id,
          sourceParamRef: "profiles/getProfile#userId",
          targetParamRef: "users/getUser#userId",
        },
      ],
      fieldMappings: [
        renameField(primaryMappingId, "users/user_id", "profiles/id", "response"),
        renameField(primaryMappingId, "users/user_name", "profiles/name", "response"),
      ],
    });

    // Supplement mapping: profiles↔entitlements. A chained supplement fills `userId` from
    // the upstream response, so it carries NO ParameterMapping for it.
    const supplementOp: OperationMapping = {
      id: randomUUID(),
      mappingId: supplementMappingId,
      sourceOperationRef: "profiles/getProfile",
      targetOperationRef: "entitlements/getEntitlement",
      action: "read",
    };
    const supplementParams: ParameterMapping[] = opts.chained
      ? []
      : [
          {
            id: randomUUID(),
            operationMappingId: supplementOp.id,
            sourceParamRef: "profiles/getProfile#userId",
            targetParamRef: "entitlements/getEntitlement#userId",
          },
        ];
    await new MappingArtifactsRepository(db).replaceChildren(supplementMappingId, {
      operationMappings: [supplementOp],
      parameterMappings: supplementParams,
      fieldMappings: [
        renameField(supplementMappingId, "entitlements/tier", "profiles/plan", "response"),
        // A foreign resource-pair mapping: source `teams` (NOT this binding's `entitlements`)
        // reads a field PRESENT in the entitlement body (`extra`) and would write `label`.
        // Pair-scoping must exclude it — else the assembled body leaks `label`.
        ...(opts.foreignLeak
          ? [renameField(supplementMappingId, "teams/extra", "orgs/label", "response")]
          : []),
      ],
    });

    const artifacts = new DownstreamArtifactRepository(db);
    const endpoint: AdapterEndpoint = {
      id: randomUUID(),
      consumerAppId: consumerApp.id,
      consumerOperationId: "profiles/getProfile",
      status: opts.active ? "active" : "composition-required",
      ...(opts.active
        ? { aggregationStrategy: "fanout-merge" as const, strictness: "degraded" as const }
        : {}),
    };
    await artifacts.ensureAdapterEndpoint(endpoint);

    const primaryId = randomUUID();
    const supplementId = randomUUID();
    const chainInputs: ChainInput[] = [
      { upstreamFieldPath: "profiles/id", targetParamRef: "entitlements/getEntitlement#userId" },
    ];
    await artifacts.insertAdapterBindingIfAbsent({
      id: primaryId,
      adapterEndpointId: endpoint.id,
      backendAppId: crmAppId,
      backendOperationId: "users/getUser",
      approvedMappingId: primaryMappingId,
      role: "primary",
      status: "active",
      ...(opts.active ? { executionOrder: 0 } : {}),
    });
    await artifacts.insertAdapterBindingIfAbsent({
      id: supplementId,
      adapterEndpointId: endpoint.id,
      backendAppId: billingAppId,
      backendOperationId: "entitlements/getEntitlement",
      approvedMappingId: supplementMappingId,
      role: "supplement",
      status: opts.active ? "active" : "proposed",
      ...(opts.active
        ? {
            executionOrder: 1,
            ...(opts.chained ? { dependsOnBindingId: primaryId, chainInputs } : {}),
          }
        : {}),
    });

    return { consumerAppId: consumerApp.id, endpointId: endpoint.id, primaryId, supplementId };
  }

  beforeAll(async () => {
    config = integrationConfig();
    db = createDb(config.database.url);
    await runMigrations(db);
    await stub.start();

    const crmApp = activeApp("crm-backend", stub.url());
    crmAppId = crmApp.id;
    createdAppIds.push(crmApp.id);
    await new RegisteredAppRepository(db).create(crmApp);
    const crmSpec = specRow(crmApp.id, "PROVIDER", crmIr);
    crmSpecId = crmSpec.id;
    createdSpecIds.push(crmSpec.id);
    await new ApiSpecRepository(db).create(crmSpec);

    const billingApp = activeApp("billing-backend", stub.url());
    billingAppId = billingApp.id;
    createdAppIds.push(billingApp.id);
    await new RegisteredAppRepository(db).create(billingApp);
    const billingSpec = specRow(billingApp.id, "PROVIDER", billingIr);
    billingSpecId = billingSpec.id;
    createdSpecIds.push(billingSpec.id);
    await new ApiSpecRepository(db).create(billingSpec);

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
    await db
      .delete(auditLog)
      .where(inArray(auditLog.actor, [ACTOR, ...createdAppIds.map((id) => `consumer-app:${id}`)]));
    await db.delete(credential).where(inArray(credential.appId, createdAppIds));
    await db.delete(apiSpec).where(inArray(apiSpec.id, createdSpecIds));
    await db.delete(registeredApp).where(inArray(registeredApp.id, createdAppIds));
    await closeDb(db);
  });

  async function get(appId: string, userId: string): Promise<LightMyRequestResponse> {
    await adapter.mountManager.reconcile();
    return adapterApp().inject({
      method: "GET",
      url: `/profiles/${userId}`,
      headers: { [CONSUMER_APP_HEADER]: appId },
    });
  }

  it("AG-2.1/2.6: a fanout-merge composed via CO-2 serves the assembled consumer object", async () => {
    const seeded = await seedFanout({
      name: "profile-composed",
      planRequired: false,
      active: false,
      chained: false,
      foreignLeak: false,
    });
    // Compose via the real CO-2 service — validate + activate in one transaction.
    const service = new AdapterCompositionService({ db, newId: () => randomUUID() });
    await service.compose(
      seeded.endpointId,
      {
        aggregationStrategy: "fanout-merge",
        strictness: "degraded",
        bindings: [
          { bindingId: seeded.primaryId, role: "primary", executionOrder: 0 },
          { bindingId: seeded.supplementId, role: "supplement", executionOrder: 1 },
        ],
      },
      ACTOR,
    );
    const endpoint = await new AdapterCompositionRepository(db).getEndpointById(seeded.endpointId);
    expect(endpoint?.status).toBe("active");
    expect(endpoint?.aggregationStrategy).toBe("fanout-merge");

    const response = await get(seeded.consumerAppId, "u1");
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ id: "u1", name: "User u1", plan: "pro" });
    expect(response.headers[DEGRADED_HEADER]).toBeUndefined();
  });

  it("AG-2.3: a failed supplement whose field is OPTIONAL degrades — omitted + failed backend named", async () => {
    const seeded = await seedFanout({
      name: "profile-degrade",
      planRequired: false,
      active: true,
      chained: false,
      foreignLeak: false,
    });
    // userId `fail1` → the entitlement backend returns 503, but `plan` is optional.
    const response = await get(seeded.consumerAppId, "fail1");
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ id: "fail1", name: "User fail1" });
    expect(response.headers[DEGRADED_HEADER]).toBe("true");
    expect(response.headers[DEGRADED_BACKENDS_HEADER]).toBe(billingAppId);
    expect(response.headers[CONTRIBUTING_BACKENDS_HEADER]).toBe(crmAppId);
    // The failed backend name never leaks into the body.
    expect(response.body).not.toContain(billingAppId);
  });

  it("AG-2.4: a failed supplement whose field is REQUIRED fails the whole request (load-bearing)", async () => {
    const seeded = await seedFanout({
      name: "profile-required",
      planRequired: true,
      active: true,
      chained: false,
      foreignLeak: false,
    });
    const response = await get(seeded.consumerAppId, "fail2");
    expect(response.headers[CAUSE_HEADER]).toBe("upstream-error");
  });

  it("TE-3.1/3.2/3.3: a chained supplement is called with a param filled from the upstream consumer shape", async () => {
    const seeded = await seedFanout({
      name: "profile-chained",
      planRequired: false,
      active: true,
      chained: true,
      foreignLeak: false,
    });
    const before = stub.requests.length;
    const response = await get(seeded.consumerAppId, "cu1");
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ id: "cu1", name: "User cu1", plan: "pro" });
    // The entitlement backend was called at the id fed from the primary's consumer-shape `id`.
    const after = stub.requests.slice(before);
    expect(after.some((r) => r.url === "/entitlements/cu1")).toBe(true);
  });

  it("TE-3.4: a null upstream chain value fails the dependent (named), never dispatching it", async () => {
    const seeded = await seedFanout({
      name: "profile-chain-absent",
      planRequired: true,
      active: true,
      chained: true,
      foreignLeak: false,
    });
    // userId `nullid` → the primary SUCCEEDS but its consumer-shape `id` is null, so the
    // chained supplement's `userId` cannot be filled — the dependent is refused (TE-3.4).
    const beforeEnt = stub.entitlementRequests();
    const response = await get(seeded.consumerAppId, "nullid");
    expect(response.headers[CAUSE_HEADER]).toBe("mediator-transform-error");
    // The dependent backend was never called with a hole.
    expect(stub.entitlementRequests()).toBe(beforeEnt);
  });

  it("resource-pair scoping: a foreign pair's response mapping never leaks into the supplement's fields", async () => {
    const seeded = await seedFanout({
      name: "profile-multipair",
      planRequired: false,
      active: true,
      chained: false,
      foreignLeak: true,
    });
    const response = await get(seeded.consumerAppId, "u2");
    expect(response.statusCode).toBe(200);
    // Only the entitlements pair's `plan` is contributed — the foreign `teams/extra → orgs/label`
    // mapping (source resource `teams`, not `entitlements`) is scoped out.
    expect(response.json()).toEqual({ id: "u2", name: "User u2", plan: "pro" });
    expect(response.body).not.toContain("label");
  });
});
