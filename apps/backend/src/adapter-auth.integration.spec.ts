import { randomUUID } from "node:crypto";

import { loadConfig, type AppConfig } from "@mediator/config";
import {
  apiSpec,
  auditLog,
  closeDb,
  createDb,
  credential,
  registeredApp,
  runMigrations,
  ApiSpecRepository,
  RegisteredAppRepository,
  type Database,
} from "@mediator/db";
import type { ApiSpec, Ir, RegisteredApp } from "@mediator/domain";
import { buildIr } from "@mediator/ir";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createServerLogger } from "./composition-root.js";
import {
  buildAdapterRuntime,
  createTokenConsumerAppResolver,
  type AdapterRuntime,
} from "./http/adapter-runtime/index.js";
import { CAUSE_HEADER } from "./http/adapter-runtime/outcome-http.js";
import { AdapterTokenService, buildAdapterTokenValidator } from "./modules/adapter-token/index.js";
import { operatorAccountsEnv } from "./testing/auth.testkit.js";

/**
 * Boots the **real Auth Gateway in front of the real Adapter Server Runtime** over a
 * live Postgres and asserts the AT-2..AT-4 end state: a valid adapter token binds a
 * request to its consumer app and reaches the RT answer (with an audit row naming the
 * credential id), no/unknown/foreign/expired tokens are a clean `401` **before** any
 * routing or backend call and are never audited, one consumer's token cannot reach
 * another's endpoints, a disabled app's token stops validating, a deregistered app's
 * tokens are deleted, and the raw token never appears in any audit row.
 *
 * Excluded from `pnpm verify`; run with `pnpm --filter @mediator/backend test:integration`.
 */

const ADAPTER_PORT = 14910;
const OPERATOR_PORT = 14911;

/** A CONSUMER doc with only `/todos`. */
const docTodosOnly = {
  openapi: "3.1.0",
  info: { title: "Todos A", version: "1.0.0" },
  paths: {
    "/todos": {
      get: {
        operationId: "listTodos",
        tags: ["todos"],
        responses: { "200": { description: "ok" } },
      },
    },
  },
} satisfies Record<string, unknown>;

/** A CONSUMER doc with `/todos` AND `/projects` (an op the todos-only apps lack). */
const docTodosAndProjects = {
  openapi: "3.1.0",
  info: { title: "Todos B", version: "1.0.0" },
  paths: {
    "/todos": {
      get: {
        operationId: "listTodos",
        tags: ["todos"],
        responses: { "200": { description: "ok" } },
      },
    },
    "/projects": {
      get: {
        operationId: "listProjects",
        tags: ["projects"],
        responses: { "200": { description: "ok" } },
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

function specRow(
  appId: string,
  role: ApiSpec["role"],
  ir: Ir,
  raw: Record<string, unknown>,
): ApiSpec {
  return {
    id: randomUUID(),
    appId,
    role,
    rawDocument: raw,
    parsedIR: ir,
    analysisExclusions: [],
    version: 1,
    contentHash: `hash-${randomUUID()}`,
    status: "active",
    createdAt: new Date(),
  };
}

describe("adapter auth gateway integration (requires Postgres)", () => {
  let config: AppConfig;
  let db: Database;
  let adapter: AdapterRuntime;
  let service: AdapterTokenService;

  const createdAppIds: string[] = [];
  const createdSpecIds: string[] = [];

  // Consumer A (only /todos), consumer B (/todos + /projects), consumer C (disable),
  // consumer D (deregister), provider-only P.
  let appA: string;
  let appB: string;
  let appC: string;
  let appD: string;
  let appP: string;

  let tokenA: string;
  let credA: string;
  let tokenB: string;
  let tokenC: string;
  let tokenD: string;

  const bearer = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` });

  async function seedConsumer(name: string, raw: Record<string, unknown>): Promise<string> {
    const app = activeApp(name);
    createdAppIds.push(app.id);
    await new RegisteredAppRepository(db).create(app);
    const ir = await buildIr(raw);
    const spec = specRow(app.id, "CONSUMER", ir, raw);
    createdSpecIds.push(spec.id);
    await new ApiSpecRepository(db).create(spec);
    return app.id;
  }

  async function issue(appId: string): Promise<{ token: string; credentialId: string }> {
    const result = await service.issue(appId, "operator");
    if (result.outcome !== "issued") {
      throw new Error(`issue failed for ${appId}: ${result.outcome}`);
    }
    return { token: result.token.rawToken, credentialId: result.token.credentialId };
  }

  beforeAll(async () => {
    config = integrationConfig();
    db = createDb(config.database.url);
    await runMigrations(db);

    appA = await seedConsumer("consumer-a", docTodosOnly);
    appB = await seedConsumer("consumer-b", docTodosAndProjects);
    appC = await seedConsumer("consumer-c", docTodosOnly);
    appD = await seedConsumer("consumer-d", docTodosOnly);

    const provider = activeApp("provider-only-p");
    appP = provider.id;
    createdAppIds.push(provider.id);
    await new RegisteredAppRepository(db).create(provider);
    const providerSpec = specRow(provider.id, "PROVIDER", [], {
      openapi: "3.1.0",
      info: { title: "P", version: "1" },
      paths: {},
    });
    createdSpecIds.push(providerSpec.id);
    await new ApiSpecRepository(db).create(providerSpec);

    service = new AdapterTokenService({
      db,
      rotationOverlapMs: config.adapterAuth.rotationOverlapMs,
    });

    const issuedA = await issue(appA);
    tokenA = issuedA.token;
    credA = issuedA.credentialId;
    tokenB = (await issue(appB)).token;
    tokenC = (await issue(appC)).token;
    tokenD = (await issue(appD)).token;

    const validator = buildAdapterTokenValidator({
      db,
      rotationOverlapMs: config.adapterAuth.rotationOverlapMs,
    });
    const logger = createServerLogger(config);
    adapter = buildAdapterRuntime({
      db,
      logger,
      resolveConsumerApp: createTokenConsumerAppResolver(validator),
    });
    await adapter.mountManager.reconcile();
    await adapter.app.ready();
  });

  afterAll(async () => {
    await adapter.app.close();
    await db.delete(credential).where(inArray(credential.appId, createdAppIds));
    await db.delete(auditLog).where(inArray(auditLog.originAppId, createdAppIds));
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

  async function adapterRequestRows(appId: string): Promise<unknown[]> {
    return db
      .select()
      .from(auditLog)
      .where(
        and(eq(auditLog.type, "adapter-request"), eq(auditLog.actor, `consumer-app:${appId}`)),
      );
  }

  // ── AT-2: a valid token binds the request; no/unknown token is a clean 401 ────

  it("AT-2: a valid token reaches the RT answer and audits the credential id", async () => {
    const response = await adapter.app.inject({
      method: "GET",
      url: "/todos",
      headers: bearer(tokenA),
    });
    // Past the gateway: a mounted-but-unbound op is not-yet-mapped, never 401/404.
    expect(response.statusCode).toBe(501);
    expect(response.headers[CAUSE_HEADER]).toBe("not-yet-mapped");

    // Exactly one adapter-request row for A, naming the credential that authenticated it.
    const rows = await adapterRequestRows(appA);
    expect(rows).toHaveLength(1);
    const row = rows[0] as { relatedCredentialId?: string | null };
    expect(row.relatedCredentialId).toBe(credA);
  });

  it("AT-2.1: no token is a clean 401 before any resolution, never audited", async () => {
    const before = (await adapterRequestRows(appB)).length;
    const response = await adapter.app.inject({ method: "GET", url: "/todos" });
    expect(response.statusCode).toBe(401);
    const body = response.json<{ cause?: string }>();
    // Distinct from every serving cause (AT-2.4).
    expect(body.cause).toBe("unauthenticated");
    expect(response.headers[CAUSE_HEADER]).toBeUndefined();
    // No audit row was written for the unauthenticated request.
    expect((await adapterRequestRows(appB)).length).toBe(before);
  });

  it("AT-2: a malformed / unknown / non-Bearer token is a clean 401", async () => {
    const malformed = await adapter.app.inject({
      method: "GET",
      url: "/todos",
      headers: { authorization: "Bearer not-an-adapter-token" },
    });
    expect(malformed.statusCode).toBe(401);

    const unknown = await adapter.app.inject({
      method: "GET",
      url: "/todos",
      headers: bearer(`amt.${randomUUID()}.${"a".repeat(64)}`),
    });
    expect(unknown.statusCode).toBe(401);
  });

  // ── AT-3: one consumer's token serves only that consumer's endpoints ─────────

  it("AT-3.1: A's token cannot reach an op that exists only in B's spec (404, not served from B)", async () => {
    // /projects exists only in B. With A's token the request resolves WITHIN A, which
    // has no /projects → a plain 404, never served from B.
    const withA = await adapter.app.inject({
      method: "GET",
      url: "/projects",
      headers: bearer(tokenA),
    });
    expect(withA.statusCode).toBe(404);
    expect(withA.headers[CAUSE_HEADER]).toBeUndefined();

    // B's own token reaches B's /projects surface (mounted, unbound → not-yet-mapped).
    const withB = await adapter.app.inject({
      method: "GET",
      url: "/projects",
      headers: bearer(tokenB),
    });
    expect(withB.statusCode).toBe(501);
    expect(withB.headers[CAUSE_HEADER]).toBe("not-yet-mapped");
  });

  it("AT-1.4/AT-3.4: a provider-only app cannot be issued a token (so none authorizes the surface)", async () => {
    await expect(service.issue(appP, "operator")).resolves.toStrictEqual({
      outcome: "app-not-consumer",
    });
  });

  // ── AT-4: rotation overlap + cutover, disable, deregister ─────────────────────

  it("AT-4.1/4.3: after rotation both tokens serve within the overlap window", async () => {
    const rotated = await service.rotate(appA, "operator");
    if (rotated.outcome !== "issued") {
      throw new Error("rotate failed");
    }
    const newToken = rotated.token.rawToken;
    expect(rotated.token.credentialId).not.toBe(credA);

    // The previous token still validates during the overlap window …
    const oldStill = await adapter.app.inject({
      method: "GET",
      url: "/todos",
      headers: bearer(tokenA),
    });
    expect(oldStill.statusCode).toBe(501);
    // … and so does the new one, both binding to app A.
    const newWorks = await adapter.app.inject({
      method: "GET",
      url: "/todos",
      headers: bearer(newToken),
    });
    expect(newWorks.statusCode).toBe(501);

    // An explicit cutover ends the previous token; the new one keeps serving.
    const cut = await service.cutover(appA, "operator");
    expect(cut.outcome).toBe("cutover");

    const oldAfter = await adapter.app.inject({
      method: "GET",
      url: "/todos",
      headers: bearer(tokenA),
    });
    expect(oldAfter.statusCode).toBe(401);
    const newAfter = await adapter.app.inject({
      method: "GET",
      url: "/todos",
      headers: bearer(newToken),
    });
    expect(newAfter.statusCode).toBe(501);
  });

  it("AT-4.4: a disabled app's token stops validating (401, not 404)", async () => {
    // Works while active.
    const before = await adapter.app.inject({
      method: "GET",
      url: "/todos",
      headers: bearer(tokenC),
    });
    expect(before.statusCode).toBe(501);

    await db.update(registeredApp).set({ status: "disabled" }).where(eq(registeredApp.id, appC));

    const after = await adapter.app.inject({
      method: "GET",
      url: "/todos",
      headers: bearer(tokenC),
    });
    // Revocation is implicit in status — a clean 401 from the gateway, not a 404.
    expect(after.statusCode).toBe(401);
  });

  it("AT-4.5: deregister deletes the app's adapter-token credentials; its token dies", async () => {
    const beforeRows = await db
      .select({ id: credential.id })
      .from(credential)
      .where(and(eq(credential.appId, appD), eq(credential.type, "adapterToken")));
    expect(beforeRows.length).toBeGreaterThan(0);

    // The deregister-cascade step: delete the adapter-token credentials outright.
    const deleted = await service.deleteForApp(appD);
    expect(deleted).toBeGreaterThan(0);

    const afterRows = await db
      .select({ id: credential.id })
      .from(credential)
      .where(and(eq(credential.appId, appD), eq(credential.type, "adapterToken")));
    expect(afterRows).toHaveLength(0);

    const response = await adapter.app.inject({
      method: "GET",
      url: "/todos",
      headers: bearer(tokenD),
    });
    expect(response.statusCode).toBe(401);
  });

  // ── The no-secret guarantee (AT-1.2 / AT-2.5) ─────────────────────────────────

  it("no raw token ever appears in any audit row", async () => {
    const rows = await db
      .select()
      .from(auditLog)
      .where(inArray(auditLog.originAppId, createdAppIds));
    const consumerRows = await db
      .select()
      .from(auditLog)
      .where(
        inArray(
          auditLog.actor,
          createdAppIds.map((id) => `consumer-app:${id}`),
        ),
      );
    const serialized = JSON.stringify([...rows, ...consumerRows]);
    for (const token of [tokenA, tokenB, tokenC, tokenD]) {
      const secret = token.split(".")[2] ?? token;
      expect(serialized).not.toContain(secret);
      expect(serialized).not.toContain(token);
    }
  });
});
