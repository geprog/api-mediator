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
 * Live-database integration for `ResourceBindingRepository.updateScopePathBinding`
 * (SS-3): confirming one scope `constant` by `parameterName` must rewrite **only**
 * that entry of the `jsonb scope_path_bindings` collection (value + confirmation,
 * `confirmedAt` surviving the Date⇄ISO round-trip) while its **sibling** scope
 * entry and all normalized operational `resource_binding_ref` rows persist
 * untouched (SS-3.2). A `parameterName` that is not a derived scope entry is a
 * no-op (the service rejects it up front — SS-3.4).
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

suite("updateScopePathBinding persistence integration (requires Postgres)", () => {
  let db: Database;

  const appId = randomUUID();
  const specId = randomUUID();
  const bindingId = randomUUID();
  // A second, isolated binding for the record-derived confirm (SS-8), so it does not
  // share mutable scope state with the constant-confirm tests above.
  const bindingId2 = randomUUID();
  const createdAt = new Date("2026-07-15T00:00:00.000Z");
  const confirmedAt = new Date("2026-07-15T09:30:00.000Z");

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
        },
      ],
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
    contentHash: "sha256:scope-confirm",
    status: "active",
    createdAt,
  };

  // Two UNCONFIRMED scope constants + one operational ref (also unconfirmed) —
  // the derive-then-confirm starting point.
  const binding: ResourceBinding = {
    id: bindingId,
    apiSpecId: specId,
    resourceRef: "issues",
    nativeIdRef: { value: { kind: "field", path: "id" }, confirmedBy: null, confirmedAt: null },
    scopePathBindings: [
      { kind: "constant", parameterName: "owner", value: "", confirmedBy: null, confirmedAt: null },
      { kind: "constant", parameterName: "repo", value: "", confirmedBy: null, confirmedAt: null },
    ],
  };

  // The record-derived confirm's own binding: same two unconfirmed constant seeds.
  const binding2: ResourceBinding = {
    id: bindingId2,
    apiSpecId: specId,
    resourceRef: "issues",
    nativeIdRef: { value: { kind: "field", path: "id" }, confirmedBy: null, confirmedAt: null },
    scopePathBindings: [
      { kind: "constant", parameterName: "owner", value: "", confirmedBy: null, confirmedAt: null },
      { kind: "constant", parameterName: "repo", value: "", confirmedBy: null, confirmedAt: null },
    ],
  };

  beforeAll(async () => {
    db = createDb(resolveDatabaseUrl(process.env));
    await runMigrations(db);
    await tx(db, async (txn) => {
      await new RegisteredAppRepository(txn).create(app);
      await new ApiSpecRepository(txn).create(spec);
      await new ResourceBindingRepository(txn).createMany([binding, binding2]);
    });
  });

  afterAll(async () => {
    await db.delete(resourceBindingRef).where(eq(resourceBindingRef.resourceBindingId, bindingId));
    await db.delete(resourceBindingRef).where(eq(resourceBindingRef.resourceBindingId, bindingId2));
    await db.delete(resourceBinding).where(eq(resourceBinding.apiSpecId, specId));
    await db.delete(apiSpec).where(eq(apiSpec.id, specId));
    await db.delete(registeredApp).where(eq(registeredApp.id, appId));
    await closeDb(db);
  });

  it("confirms one scope constant by parameterName, leaving the sibling entry and operational refs untouched (SS-3.2)", async () => {
    const repo = new ResourceBindingRepository(db);

    const updated = await repo.updateScopePathBinding(bindingId, {
      kind: "constant",
      parameterName: "owner",
      value: "alice",
      confirmedBy: "op@example.test",
      confirmedAt,
    });
    expect(updated).toBeDefined();

    // Reload independently to prove the write hit the column, not just memory.
    const reloaded = await repo.getById(bindingId);
    const byName = new Map(
      (reloaded?.scopePathBindings ?? []).map((entry) => [entry.parameterName, entry]),
    );

    // The confirmed entry: value set + confirmation stamped, confirmedAt a Date.
    expect(byName.get("owner")).toStrictEqual({
      kind: "constant",
      parameterName: "owner",
      value: "alice",
      confirmedBy: "op@example.test",
      confirmedAt,
    });
    expect(byName.get("owner")?.confirmedAt).toBeInstanceOf(Date);

    // The sibling scope entry is byte-identical to its unconfirmed seed.
    expect(byName.get("repo")).toStrictEqual({
      kind: "constant",
      parameterName: "repo",
      value: "",
      confirmedBy: null,
      confirmedAt: null,
    });

    // The normalized operational ref (a separate table) is untouched.
    expect(reloaded?.nativeIdRef).toStrictEqual({
      value: { kind: "field", path: "id" },
      confirmedBy: null,
      confirmedAt: null,
    });
  });

  it("is a no-op for a parameterName that is not a scope entry of the resource", async () => {
    const repo = new ResourceBindingRepository(db);
    const before = await repo.getById(bindingId);

    const result = await repo.updateScopePathBinding(bindingId, {
      kind: "constant",
      parameterName: "tenant",
      value: "acme",
      confirmedBy: "op@example.test",
      confirmedAt,
    });

    expect(result?.scopePathBindings).toStrictEqual(before?.scopePathBindings);
    expect(result?.scopePathBindings?.some((entry) => entry.parameterName === "tenant")).toBe(
      false,
    );
  });

  it("confirms one scope entry record-derived by parameterName, leaving the constant sibling untouched (SS-8)", async () => {
    const repo = new ResourceBindingRepository(db);

    const updated = await repo.updateScopePathBinding(bindingId2, {
      kind: "record-derived",
      parameterName: "owner",
      sourceScopeKey: "owner",
      transform: { kind: "rename" },
      confirmedBy: "op@example.test",
      confirmedAt,
    });
    expect(updated).toBeDefined();

    // Reload independently to prove the write hit the jsonb column, not just memory.
    const reloaded = await repo.getById(bindingId2);
    const byName = new Map(
      (reloaded?.scopePathBindings ?? []).map((entry) => [entry.parameterName, entry]),
    );

    // The confirmed entry becomes the record-derived member (kind flipped, no `value`
    // key), sourceScopeKey + transform set, confirmation stamped, confirmedAt a Date.
    expect(byName.get("owner")).toStrictEqual({
      kind: "record-derived",
      parameterName: "owner",
      sourceScopeKey: "owner",
      transform: { kind: "rename" },
      confirmedBy: "op@example.test",
      confirmedAt,
    });
    expect(byName.get("owner")?.confirmedAt).toBeInstanceOf(Date);

    // The sibling constant scope entry is byte-identical to its unconfirmed seed.
    expect(byName.get("repo")).toStrictEqual({
      kind: "constant",
      parameterName: "repo",
      value: "",
      confirmedBy: null,
      confirmedAt: null,
    });
  });
});
