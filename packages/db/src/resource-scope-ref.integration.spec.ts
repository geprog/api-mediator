import { randomUUID } from "node:crypto";

import type { ApiSpec, Ir, RegisteredApp, ResourceBinding } from "@mediator/domain";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closeDb, createDb, tx, type Database } from "./client.js";
import { resolveDatabaseUrl } from "./env.js";
import { runMigrations } from "./migrate.js";
import {
  ApiSpecRepository,
  RegisteredAppRepository,
  ResourceBindingRepository,
} from "./repositories/index.js";
import { apiSpec, registeredApp, resourceBinding, resourceBindingRef } from "./schema.js";

/**
 * Live-database integration for `ResourceBinding.sourceScopeRef` (SS-7, migration
 * `0017`): a confirmed **multi-component** ref (Gitea `owner` + `name`) must
 * round-trip **identically** through the nullable `jsonb source_scope_ref` column
 * — including `confirmedAt` surviving the Date⇄ISO-string conversion — an **absent**
 * ref stays **NULL**, and `updateSourceScopeRef` confirms the whole ref in place
 * while the operational `resource_binding_ref` rows and `scope_path_bindings` stay
 * untouched. `runMigrations` in `beforeAll` proves migration `0017` applies clean
 * on the existing chain.
 *
 * Requires the compose `postgres` service + a resolvable `DATABASE_URL`; excluded
 * from `pnpm verify`, run via `pnpm --filter @mediator/db test:integration`.
 * Self-skips when `DATABASE_URL` is unresolvable.
 */
let databaseUrl: string | undefined;
try {
  databaseUrl = resolveDatabaseUrl(process.env);
} catch {
  databaseUrl = undefined;
}
const suite = databaseUrl === undefined ? describe.skip : describe;

suite("sourceScopeRef persistence integration (requires Postgres)", () => {
  let db: Database;

  const appId = randomUUID();
  const specId = randomUUID();
  const confirmedBindingId = randomUUID();
  const absentBindingId = randomUUID();
  const derivedBindingId = randomUUID();
  const createdAt = new Date("2026-07-16T00:00:00.000Z");
  const confirmedAt = new Date("2026-07-16T09:30:00.000Z");
  const confirmedLater = new Date("2026-07-16T11:15:00.000Z");

  const ir: Ir = [
    {
      resourceRef: "issues",
      name: "issues",
      operations: [
        {
          operationId: "issueListIssues",
          method: "get",
          path: "/repos/{owner}/{repo}/issues",
          parameters: [],
          responseSchema: {
            name: "Issue",
            fields: [
              { name: "id", type: "integer", required: true },
              { name: "repository", type: "RepositoryMeta", required: false },
            ],
          },
        },
      ],
      schemas: [{ name: "Issue", fields: [{ name: "id", type: "integer", required: true }] }],
      crossResourceRefs: [{ name: "RepositoryMeta", fields: ["owner", "name", "full_name"] }],
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
      supportsChangeTimestamps: false,
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
    contentHash: "sha256:source-scope-ref",
    status: "active",
    createdAt,
  };

  // A CONFIRMED two-component sourceScopeRef (Gitea owner + name).
  const confirmedBinding: ResourceBinding = {
    id: confirmedBindingId,
    apiSpecId: specId,
    resourceRef: "issues",
    nativeIdRef: { value: { kind: "field", path: "id" }, confirmedBy: null, confirmedAt: null },
    scopePathBindings: [
      { kind: "constant", parameterName: "owner", value: "", confirmedBy: null, confirmedAt: null },
    ],
    sourceScopeRef: {
      components: [
        { key: "owner", fieldPath: "repository.owner" },
        { key: "name", fieldPath: "repository.name" },
      ],
      confirmedBy: "op@example.test",
      confirmedAt,
    },
  };

  // An ABSENT sourceScopeRef → NULL column.
  const absentBinding: ResourceBinding = {
    id: absentBindingId,
    apiSpecId: specId,
    resourceRef: "issues-absent",
    scopePathBindings: [],
  };

  // A DERIVED-UNCONFIRMED ref, for the updateSourceScopeRef confirm-in-place test.
  const derivedBinding: ResourceBinding = {
    id: derivedBindingId,
    apiSpecId: specId,
    resourceRef: "issues-derived",
    nativeIdRef: { value: { kind: "field", path: "id" }, confirmedBy: null, confirmedAt: null },
    scopePathBindings: [
      { kind: "constant", parameterName: "owner", value: "", confirmedBy: null, confirmedAt: null },
    ],
    sourceScopeRef: {
      components: [{ key: "owner", fieldPath: "repository.owner" }],
      confirmedBy: null,
      confirmedAt: null,
    },
  };

  beforeAll(async () => {
    db = createDb(resolveDatabaseUrl(process.env));
    await runMigrations(db);
    await tx(db, async (txn) => {
      await new RegisteredAppRepository(txn).create(app);
      await new ApiSpecRepository(txn).create(spec);
      await new ResourceBindingRepository(txn).createMany([
        confirmedBinding,
        absentBinding,
        derivedBinding,
      ]);
    });
  });

  afterAll(async () => {
    await db
      .delete(resourceBindingRef)
      .where(eq(resourceBindingRef.resourceBindingId, confirmedBindingId));
    await db
      .delete(resourceBindingRef)
      .where(eq(resourceBindingRef.resourceBindingId, derivedBindingId));
    await db.delete(resourceBinding).where(eq(resourceBinding.apiSpecId, specId));
    await db.delete(apiSpec).where(eq(apiSpec.id, specId));
    await db.delete(registeredApp).where(eq(registeredApp.id, appId));
    await closeDb(db);
  });

  it("round-trips a confirmed 2-component sourceScopeRef identically — Date confirmedAt survives", async () => {
    const reloaded = await new ResourceBindingRepository(db).getById(confirmedBindingId);
    expect(reloaded).toStrictEqual(confirmedBinding);
    expect(reloaded?.sourceScopeRef?.components).toStrictEqual([
      { key: "owner", fieldPath: "repository.owner" },
      { key: "name", fieldPath: "repository.name" },
    ]);
    expect(reloaded?.sourceScopeRef?.confirmedAt).toStrictEqual(confirmedAt);
    expect(reloaded?.sourceScopeRef?.confirmedAt).toBeInstanceOf(Date);
  });

  it("stores an absent sourceScopeRef as NULL (a NULL column is the absent domain ref)", async () => {
    const reloaded = await new ResourceBindingRepository(db).getById(absentBindingId);
    expect(reloaded?.sourceScopeRef).toBeUndefined();

    // Prove the underlying column is NULL, not an empty/serialized object.
    const [row] = await db
      .select({ sourceScopeRef: resourceBinding.sourceScopeRef })
      .from(resourceBinding)
      .where(eq(resourceBinding.id, absentBindingId));
    expect(row?.sourceScopeRef).toBeNull();
  });

  it("confirms the whole sourceScopeRef in place, leaving refs and scope bindings untouched", async () => {
    const repo = new ResourceBindingRepository(db);

    const updated = await repo.updateSourceScopeRef(derivedBindingId, {
      components: [
        { key: "owner", fieldPath: "repository.owner" },
        { key: "name", fieldPath: "repository.name" },
      ],
      confirmedBy: "op@example.test",
      confirmedAt: confirmedLater,
    });
    expect(updated).toBeDefined();

    const reloaded = await repo.getById(derivedBindingId);
    expect(reloaded?.sourceScopeRef).toStrictEqual({
      components: [
        { key: "owner", fieldPath: "repository.owner" },
        { key: "name", fieldPath: "repository.name" },
      ],
      confirmedBy: "op@example.test",
      confirmedAt: confirmedLater,
    });
    // The operational ref is untouched…
    expect(reloaded?.nativeIdRef).toStrictEqual({
      value: { kind: "field", path: "id" },
      confirmedBy: null,
      confirmedAt: null,
    });
    // …and so is the scope path-parameter binding.
    expect(reloaded?.scopePathBindings).toStrictEqual([
      { kind: "constant", parameterName: "owner", value: "", confirmedBy: null, confirmedAt: null },
    ]);
  });
});
