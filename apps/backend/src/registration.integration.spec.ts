import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { loadConfig, type AppConfig } from "@mediator/config";
import {
  apiSpec,
  createDb,
  credential,
  eventOutbox,
  registeredApp,
  resourceBinding,
  resourceBindingRef,
  runMigrations,
  type Database,
} from "@mediator/db";
import { openApiDocumentSchema, type RegisterAppResponse } from "@mediator/contracts";
import { computeContentHash } from "@mediator/ir";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildServer, createServerLogger, type RunningServer } from "./composition-root.js";

/**
 * End-to-end registration integration test against a live Postgres (compose
 * `postgres` service). Excluded from `pnpm verify`; run with
 * `pnpm --filter @mediator/backend test:integration`.
 *
 * It drives the real composition root (Fastify + real repositories +
 * `CredentialStore` + `PostgresEventBus`) with the vendored scenario-1 Gitea
 * `PROVIDER` spec and asserts the whole registration graph persists atomically —
 * `RegisteredApp` + `ApiSpec` v1 (+ correct `contentHash`) + unconfirmed
 * `ResourceBinding`s + a `SpecIngested` outbox row — that a malformed spec rolls
 * everything back, that reads expose no secret, and that binding confirm/correct
 * behaves.
 */

const SECRET_VALUE = "gitea-pat-s3cr3t-value";
const OAS3 = "scenarios/scenario-1-small-overlap/specs/oas3";

function loadSpec(name: string): Record<string, unknown> {
  const url = new URL(`../../../${OAS3}/${name}`, import.meta.url);
  return openApiDocumentSchema.parse(JSON.parse(readFileSync(fileURLToPath(url), "utf8")));
}

/**
 * A fully-valid config for the suite, defaulting the compose Postgres URL and a
 * dev master key when the environment does not supply them (the worktree has no
 * `.env`). Telemetry is disabled.
 */
function integrationConfig(): AppConfig {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DATABASE_URL:
      process.env.DATABASE_URL ?? "postgres://mediator:mediator@localhost:5432/api_mediator",
    CREDENTIAL_MASTER_KEY:
      process.env.CREDENTIAL_MASTER_KEY ?? Buffer.alloc(32, 7).toString("base64"),
    OLLAMA_BASE_URL: process.env.OLLAMA_BASE_URL ?? "http://localhost:11434",
    MAPPING_LLM_MODEL: process.env.MAPPING_LLM_MODEL ?? "test-model",
    MAPPING_LLM_THINKING: process.env.MAPPING_LLM_THINKING ?? "false",
    MAPPING_LLM_REQUEST_TIMEOUT_MS: process.env.MAPPING_LLM_REQUEST_TIMEOUT_MS ?? "300000",
    OTEL_EXPORTER_OTLP_ENDPOINT: process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "",
  };
  return loadConfig(env);
}

describe("registration API integration (requires Postgres)", () => {
  let config: AppConfig;
  let db: Database;
  let server: RunningServer;
  const createdAppIds: string[] = [];

  beforeAll(async () => {
    config = integrationConfig();
    db = createDb(config.database.url);
    await runMigrations(db);
    const logger = createServerLogger(config);
    server = buildServer({ config, db, logger });
  });

  afterAll(async () => {
    // Targeted cleanup of everything the suite created (children first).
    if (createdAppIds.length > 0) {
      const specRows = await db
        .select({ id: apiSpec.id })
        .from(apiSpec)
        .where(inArray(apiSpec.appId, createdAppIds));
      const specIds = specRows.map((row) => row.id);
      if (specIds.length > 0) {
        const bindingRows = await db
          .select({ id: resourceBinding.id })
          .from(resourceBinding)
          .where(inArray(resourceBinding.apiSpecId, specIds));
        const bindingIds = bindingRows.map((row) => row.id);
        if (bindingIds.length > 0) {
          await db
            .delete(resourceBindingRef)
            .where(inArray(resourceBindingRef.resourceBindingId, bindingIds));
          await db.delete(resourceBinding).where(inArray(resourceBinding.id, bindingIds));
        }
        const events = await db
          .select({ id: eventOutbox.id, payload: eventOutbox.payload })
          .from(eventOutbox)
          .where(eq(eventOutbox.type, "SpecIngested"));
        const eventIds = events
          .filter((row) => specIds.includes(String(row.payload["apiSpecId"])))
          .map((row) => row.id);
        if (eventIds.length > 0) {
          await db.delete(eventOutbox).where(inArray(eventOutbox.id, eventIds));
        }
        await db.delete(apiSpec).where(inArray(apiSpec.id, specIds));
      }
      await db.delete(credential).where(inArray(credential.appId, createdAppIds));
      await db.delete(registeredApp).where(inArray(registeredApp.id, createdAppIds));
    }
    await server.shutdown();
  });

  it("persists the whole registration graph atomically with a SpecIngested outbox row", async () => {
    const document = loadSpec("gitea.trimmed.oas3.json");
    const response = await server.app.inject({
      method: "POST",
      url: "/api/apps",
      payload: {
        name: "Gitea (integration)",
        baseUrl: "https://gitea.example.test",
        capabilities: {
          supportsPolling: true,
          supportsDeltaQuery: true,
          supportsChangeTimestamps: true,
          defaultPollInterval: 60000,
        },
        credential: { secret: { type: "apiKey", apiKey: SECRET_VALUE }, scopes: ["repo"] },
        specs: [{ role: "PROVIDER", document }],
      },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json<RegisterAppResponse>();
    createdAppIds.push(body.app.id);
    const specId = body.specs[0]?.id ?? "";

    // RegisteredApp persisted.
    const [appRow] = await db.select().from(registeredApp).where(eq(registeredApp.id, body.app.id));
    expect(appRow?.name).toBe("Gitea (integration)");
    expect(appRow?.status).toBe("active");

    // ApiSpec v1 with the correct contentHash.
    const [specRow] = await db.select().from(apiSpec).where(eq(apiSpec.id, specId));
    expect(specRow?.version).toBe(1);
    expect(specRow?.status).toBe("active");
    expect(specRow?.contentHash).toBe(computeContentHash(document));

    // ResourceBindings derived + persisted, unconfirmed, with an `issue` group.
    const bindingRows = await db
      .select()
      .from(resourceBinding)
      .where(eq(resourceBinding.apiSpecId, specId));
    expect(bindingRows.length).toBeGreaterThan(0);
    expect(bindingRows.some((row) => row.resourceRef === "issue")).toBe(true);
    const bindingIds = bindingRows.map((row) => row.id);
    const refRows = await db
      .select()
      .from(resourceBindingRef)
      .where(inArray(resourceBindingRef.resourceBindingId, bindingIds));
    expect(refRows.length).toBeGreaterThan(0);
    expect(refRows.every((row) => row.confirmedBy === null && row.confirmedAt === null)).toBe(true);

    // A SpecIngested outbox row exists for this spec (same tx — atomic).
    const events = await db.select().from(eventOutbox).where(eq(eventOutbox.type, "SpecIngested"));
    const ingested = events.find((row) => String(row.payload["apiSpecId"]) === specId);
    expect(ingested).toBeDefined();
    expect(ingested?.payload["appId"]).toBe(body.app.id);

    // Credential stored as ciphertext; the plaintext never appears anywhere.
    const [credRow] = await db.select().from(credential).where(eq(credential.appId, body.app.id));
    expect(credRow?.type).toBe("apiKey");
    expect(credRow?.encryptedPayload).not.toContain(SECRET_VALUE);
    expect(response.body).not.toContain(SECRET_VALUE);
    expect(response.body).not.toContain("encryptedPayload");
    expect(response.body).not.toContain("rawDocument");
  });

  it("rolls everything back when a submitted spec is malformed", async () => {
    const document = loadSpec("gitea.trimmed.oas3.json");
    const response = await server.app.inject({
      method: "POST",
      url: "/api/apps",
      payload: {
        name: "Malformed (integration)",
        baseUrl: "https://malformed.example.test",
        credential: { secret: { type: "apiKey", apiKey: SECRET_VALUE } },
        specs: [
          { role: "PROVIDER", document },
          { role: "PROVIDER", document: { not: "an-openapi-document" } },
        ],
      },
    });

    expect(response.statusCode).toBe(400);
    // No RegisteredApp with this name was created (atomic — AR-1 crit 7).
    const appRows = await db
      .select()
      .from(registeredApp)
      .where(eq(registeredApp.name, "Malformed (integration)"));
    expect(appRows).toHaveLength(0);
  });

  it("serves reads with no secrets and confirms/rejects binding refs", async () => {
    const document = loadSpec("gitea.trimmed.oas3.json");
    const registration = await server.app.inject({
      method: "POST",
      url: "/api/apps",
      payload: {
        name: "Gitea reads (integration)",
        baseUrl: "https://gitea-reads.example.test",
        capabilities: {
          supportsPolling: true,
          supportsDeltaQuery: false,
          supportsChangeTimestamps: true,
          defaultPollInterval: 60000,
        },
        credential: { secret: { type: "apiKey", apiKey: SECRET_VALUE } },
        specs: [{ role: "PROVIDER", document }],
      },
    });
    const registered = registration.json<RegisterAppResponse>();
    createdAppIds.push(registered.app.id);
    const specId = registered.specs[0]?.id ?? "";

    // GET /api/apps/:id/specs — metadata only, no rawDocument, no secret.
    const specsResponse = await server.app.inject({
      method: "GET",
      url: `/api/apps/${registered.app.id}/specs`,
    });
    expect(specsResponse.statusCode).toBe(200);
    expect(specsResponse.body).not.toContain("rawDocument");
    expect(specsResponse.body).not.toContain(SECRET_VALUE);

    // GET /api/specs/:id/ir — the parsed IR, no secret.
    const irResponse = await server.app.inject({ method: "GET", url: `/api/specs/${specId}/ir` });
    expect(irResponse.statusCode).toBe(200);
    expect(irResponse.body).not.toContain(SECRET_VALUE);

    // GET the bindings, confirm the `issue` native id ref.
    const bindingsResponse = await server.app.inject({
      method: "GET",
      url: `/api/specs/${specId}/resource-bindings`,
    });
    const bindings = bindingsResponse.json<{ bindings: { id: string; resourceRef: string }[] }>();
    const issueBinding = bindings.bindings.find((binding) => binding.resourceRef === "issue");
    expect(issueBinding).toBeDefined();
    const issueBindingId = issueBinding?.id ?? "";

    const confirm = await server.app.inject({
      method: "PATCH",
      url: `/api/resource-bindings/${issueBindingId}`,
      headers: { "x-operator-id": "integration-operator" },
      payload: { refKind: "nativeIdRef" },
    });
    expect(confirm.statusCode).toBe(200);
    const confirmedRef = confirm
      .json<{ refs: { kind: string; confirmedBy: string | null }[] }>()
      .refs.find((ref) => ref.kind === "nativeIdRef");
    expect(confirmedRef?.confirmedBy).toBe("integration-operator");

    // The confirmation persisted to the specific nativeIdRef DB row.
    const [refRow] = await db
      .select()
      .from(resourceBindingRef)
      .where(
        and(
          eq(resourceBindingRef.resourceBindingId, issueBindingId),
          eq(resourceBindingRef.refKind, "nativeIdRef"),
        ),
      );
    expect(refRow?.confirmedBy).toBe("integration-operator");
    expect(refRow?.confirmedAt).not.toBeNull();

    // A correction naming a non-IR field is rejected (RB-2 crit 4).
    const badCorrection = await server.app.inject({
      method: "PATCH",
      url: `/api/resource-bindings/${issueBindingId}`,
      payload: { refKind: "nativeIdRef", value: { kind: "field", path: "definitely-not-a-field" } },
    });
    expect(badCorrection.statusCode).toBe(400);

    // PATCH analysis-exclusions persists to the real ApiSpec row (SI-4).
    const exclusions = await server.app.inject({
      method: "PATCH",
      url: `/api/specs/${specId}/analysis-exclusions`,
      payload: { analysisExclusions: ["issue"] },
    });
    expect(exclusions.statusCode).toBe(200);
    const [specRow] = await db.select().from(apiSpec).where(eq(apiSpec.id, specId));
    expect(specRow?.analysisExclusions).toEqual(["issue"]);

    // A resourceRef not in the spec's IR is rejected (SI-4 crit 4).
    const badExclusion = await server.app.inject({
      method: "PATCH",
      url: `/api/specs/${specId}/analysis-exclusions`,
      payload: { analysisExclusions: ["nope"] },
    });
    expect(badExclusion.statusCode).toBe(400);
  });
});
