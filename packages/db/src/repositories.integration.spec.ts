import { randomUUID } from "node:crypto";

import type { ApiSpec, Credential, Ir, RegisteredApp, ResourceBinding } from "@mediator/domain";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closeDb, createDb, tx, type Database } from "./client.js";
import { resolveDatabaseUrl } from "./env.js";
import { runMigrations } from "./migrate.js";
import {
  ApiSpecRepository,
  CredentialRepository,
  RegisteredAppRepository,
  ResourceBindingRepository,
} from "./repositories/index.js";
import {
  apiSpec,
  credential,
  registeredApp,
  resourceBinding,
  resourceBindingRef,
} from "./schema.js";

/**
 * Live-database integration test for the Phase-1 repositories. Requires the
 * compose `postgres` service (`docker compose up -d postgres --wait`) and a
 * resolvable `DATABASE_URL`. Excluded from `pnpm verify`; run explicitly via
 * `pnpm --filter @mediator/db test:integration`.
 *
 * It replaces the Phase-0 `schema_probe` round-trip: migrate a fresh schema,
 * then exercise the whole registration graph — `RegisteredApp` → `ApiSpec` →
 * `ResourceBinding`s → `Credential` — inside `tx()`, read it back, confirm/
 * correct binding refs per-ref, and prove the credential payload never leaves
 * the store.
 */
describe("Phase-1 repositories integration (requires Postgres)", () => {
  let db: Database;

  const appId = randomUUID();
  const specId = randomUUID();
  const issuesBindingId = randomUUID();
  const pullsBindingId = randomUUID();
  const credentialId = randomUUID();
  const createdAt = new Date("2026-07-10T00:00:00.000Z");
  const lastRotatedAt = new Date("2026-07-10T00:00:00.000Z");
  const ciphertext = `envelope:${randomUUID()}`;

  const ir: Ir = [
    {
      resourceRef: "issues",
      name: "Issues",
      operations: [{ operationId: "listIssues", method: "get", path: "/issues", parameters: [] }],
      schemas: [{ name: "Issue", fields: [{ name: "id", type: "integer", required: true }] }],
      crossResourceRefs: [],
    },
  ];

  const app: RegisteredApp = {
    id: appId,
    name: "Gitea",
    status: "active",
    baseUrl: "https://gitea.example.test",
    capabilities: {
      supportsPolling: true,
      supportsDeltaQuery: false,
      supportsChangeTimestamps: true,
      defaultPollInterval: 60000,
    },
    createdAt,
  };

  const spec: ApiSpec = {
    id: specId,
    appId,
    role: "PROVIDER",
    rawDocument: { openapi: "3.1.0", info: { title: "Gitea", version: "1" } },
    parsedIR: ir,
    analysisExclusions: [],
    version: 1,
    contentHash: "sha256:issues",
    status: "active",
    createdAt,
  };

  const issuesBinding: ResourceBinding = {
    id: issuesBindingId,
    apiSpecId: specId,
    resourceRef: "issues",
    nativeIdRef: { value: { kind: "field", path: "id" }, confirmedBy: null, confirmedAt: null },
    collectionReadRef: {
      value: { kind: "operation", operationId: "listIssues" },
      confirmedBy: null,
      confirmedAt: null,
    },
    paginationRef: {
      value: { kind: "parameter", operationId: "listIssues", parameter: "page" },
      confirmedBy: null,
      confirmedAt: null,
    },
    changeTimestampRef: {
      value: { kind: "field", path: "updated" },
      confirmedBy: null,
      confirmedAt: null,
    },
  };

  const pullsBinding: ResourceBinding = {
    id: pullsBindingId,
    apiSpecId: specId,
    resourceRef: "pulls",
    nativeIdRef: { value: { kind: "field", path: "id" }, confirmedBy: null, confirmedAt: null },
  };

  const cred: Credential = {
    id: credentialId,
    appId,
    type: "apiKey",
    encryptedPayload: ciphertext,
    scopes: ["repo:read"],
    lastRotatedAt,
  };

  beforeAll(async () => {
    db = createDb(resolveDatabaseUrl(process.env));
    await runMigrations(db);
  });

  afterAll(async () => {
    await db
      .delete(resourceBindingRef)
      .where(inArray(resourceBindingRef.resourceBindingId, [issuesBindingId, pullsBindingId]));
    await db.delete(resourceBinding).where(eq(resourceBinding.apiSpecId, specId));
    await db.delete(credential).where(eq(credential.appId, appId));
    await db.delete(apiSpec).where(eq(apiSpec.id, specId));
    await db.delete(registeredApp).where(eq(registeredApp.id, appId));
    await closeDb(db);
  });

  it("creates the whole registration graph inside tx() and reads it back equal", async () => {
    await tx(db, async (txn) => {
      await new RegisteredAppRepository(txn).create(app);
      await new ApiSpecRepository(txn).create(spec);
      await new ResourceBindingRepository(txn).createMany([issuesBinding, pullsBinding]);
      await new CredentialRepository(txn).create(cred);
    });

    expect(await new RegisteredAppRepository(db).getById(appId)).toStrictEqual(app);

    const specs = await new ApiSpecRepository(db).listByAppId(appId);
    expect(specs).toStrictEqual([spec]);

    const bindings = await new ResourceBindingRepository(db).listByApiSpecId(specId);
    const byRef = new Map(bindings.map((binding) => [binding.resourceRef, binding]));
    expect(byRef.get("issues")).toStrictEqual(issuesBinding);
    expect(byRef.get("pulls")).toStrictEqual(pullsBinding);
    // Absent refs stay absent through a real DB round-trip.
    expect("deltaCursorRef" in (byRef.get("issues") as ResourceBinding)).toBe(false);
    expect("collectionReadRef" in (byRef.get("pulls") as ResourceBinding)).toBe(false);
  });

  it("confirms and corrects binding refs per-ref, leaving others unconfirmed", async () => {
    const repo = new ResourceBindingRepository(db);
    const confirmedAt = new Date("2026-07-10T12:00:00.000Z");

    // Confirm nativeIdRef only.
    await repo.update(issuesBindingId, {
      nativeIdRef: { confirmedBy: "operator@example.test", confirmedAt },
    });
    // Correct paginationRef's value AND confirm it in the same action.
    await repo.update(issuesBindingId, {
      paginationRef: {
        value: { kind: "parameter", operationId: "listIssues", parameter: "limit" },
        confirmedBy: "operator@example.test",
        confirmedAt,
      },
    });

    const updated = await repo.getById(issuesBindingId);
    expect(updated?.nativeIdRef).toStrictEqual({
      value: { kind: "field", path: "id" },
      confirmedBy: "operator@example.test",
      confirmedAt,
    });
    expect(updated?.paginationRef).toStrictEqual({
      value: { kind: "parameter", operationId: "listIssues", parameter: "limit" },
      confirmedBy: "operator@example.test",
      confirmedAt,
    });
    // Per-ref: confirming/correcting two refs did not touch the others.
    expect(updated?.collectionReadRef?.confirmedBy).toBeNull();
    expect(updated?.collectionReadRef?.confirmedAt).toBeNull();
    expect(updated?.changeTimestampRef?.confirmedBy).toBeNull();
  });

  it("stores the credential payload but never returns it through a read", async () => {
    const metadata = await new CredentialRepository(db).listByAppId(appId);
    expect(metadata).toStrictEqual([
      { id: credentialId, type: "apiKey", scopes: ["repo:read"], lastRotatedAt },
    ]);
    expect(Object.keys(metadata[0] ?? {})).not.toContain("encryptedPayload");

    // The payload IS persisted (opaque ciphertext), reachable only by an
    // explicit internal select — never by the repository's read surface.
    const [internal] = await db
      .select({ payload: credential.encryptedPayload })
      .from(credential)
      .where(eq(credential.id, credentialId));
    expect(internal?.payload).toBe(ciphertext);
  });
});
