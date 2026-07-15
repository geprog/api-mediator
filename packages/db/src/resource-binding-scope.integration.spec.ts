import { randomUUID } from "node:crypto";

import type { ApiSpec, Ir, RegisteredApp, ResourceBinding } from "@mediator/domain";
import { eq, inArray } from "drizzle-orm";
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
 * Live-database integration for `ResourceBinding.scopePathBindings` (SS-1
 * criterion 5, migration `0016`): two confirmed `constant`s (`owner`, `repo`)
 * must round-trip **identically** through the `jsonb scope_path_bindings` column
 * — including `confirmedAt` surviving the Date⇄ISO-string conversion — and stay
 * **independently confirmable** (one confirmed, one not). A param-free resource
 * stores an **empty** collection. `runMigrations` in `beforeAll` proves migration
 * `0016` applies clean on the existing chain.
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

suite("scopePathBindings persistence integration (requires Postgres)", () => {
  let db: Database;

  const appId = randomUUID();
  const specId = randomUUID();
  const issuesBindingId = randomUUID();
  const partialBindingId = randomUUID();
  const emptyBindingId = randomUUID();
  const createdAt = new Date("2026-07-14T00:00:00.000Z");
  const confirmedAt = new Date("2026-07-14T09:30:00.000Z");
  const repoConfirmedAt = new Date("2026-07-14T10:45:00.000Z");

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
    contentHash: "sha256:scope",
    status: "active",
    createdAt,
  };

  // Two confirmed constants, each with its OWN confirmer + timestamp.
  const issuesBinding: ResourceBinding = {
    id: issuesBindingId,
    apiSpecId: specId,
    resourceRef: "issues",
    nativeIdRef: { value: { kind: "field", path: "id" }, confirmedBy: null, confirmedAt: null },
    scopePathBindings: [
      {
        kind: "constant",
        parameterName: "owner",
        value: "alice",
        confirmedBy: "op-a@example.test",
        confirmedAt,
      },
      {
        kind: "constant",
        parameterName: "repo",
        value: "phoenix",
        confirmedBy: "op-b@example.test",
        confirmedAt: repoConfirmedAt,
      },
    ],
  };

  // Independence: owner confirmed, repo still unconfirmed (empty value, null pair).
  const partialBinding: ResourceBinding = {
    id: partialBindingId,
    apiSpecId: specId,
    resourceRef: "issues-partial",
    scopePathBindings: [
      {
        kind: "constant",
        parameterName: "owner",
        value: "alice",
        confirmedBy: "op-a@example.test",
        confirmedAt,
      },
      { kind: "constant", parameterName: "repo", value: "", confirmedBy: null, confirmedAt: null },
    ],
  };

  // A param-free resource: the collection is empty, not absent.
  const emptyBinding: ResourceBinding = {
    id: emptyBindingId,
    apiSpecId: specId,
    resourceRef: "tasks",
    scopePathBindings: [],
  };

  beforeAll(async () => {
    db = createDb(resolveDatabaseUrl(process.env));
    await runMigrations(db);
    await tx(db, async (txn) => {
      await new RegisteredAppRepository(txn).create(app);
      await new ApiSpecRepository(txn).create(spec);
      await new ResourceBindingRepository(txn).createMany([
        issuesBinding,
        partialBinding,
        emptyBinding,
      ]);
    });
  });

  afterAll(async () => {
    await db
      .delete(resourceBindingRef)
      .where(
        inArray(resourceBindingRef.resourceBindingId, [
          issuesBindingId,
          partialBindingId,
          emptyBindingId,
        ]),
      );
    await db.delete(resourceBinding).where(eq(resourceBinding.apiSpecId, specId));
    await db.delete(apiSpec).where(eq(apiSpec.id, specId));
    await db.delete(registeredApp).where(eq(registeredApp.id, appId));
    await closeDb(db);
  });

  it("round-trips two confirmed constants identically (owner, repo) — Date confirmedAt survives", async () => {
    const reloaded = await new ResourceBindingRepository(db).getById(issuesBindingId);
    expect(reloaded).toStrictEqual(issuesBinding);
    // Each entry keeps its OWN confirmer + timestamp (independent records).
    const byName = new Map(
      (reloaded?.scopePathBindings ?? []).map((entry) => [entry.parameterName, entry]),
    );
    expect(byName.get("owner")?.confirmedAt).toStrictEqual(confirmedAt);
    expect(byName.get("repo")?.confirmedAt).toStrictEqual(repoConfirmedAt);
    expect(byName.get("owner")?.confirmedAt).toBeInstanceOf(Date);
  });

  it("keeps scope constants independently confirmable (owner confirmed, repo not)", async () => {
    const reloaded = await new ResourceBindingRepository(db).getById(partialBindingId);
    const byName = new Map(
      (reloaded?.scopePathBindings ?? []).map((entry) => [entry.parameterName, entry]),
    );
    expect(byName.get("owner")).toStrictEqual({
      kind: "constant",
      parameterName: "owner",
      value: "alice",
      confirmedBy: "op-a@example.test",
      confirmedAt,
    });
    expect(byName.get("repo")).toStrictEqual({
      kind: "constant",
      parameterName: "repo",
      value: "",
      confirmedBy: null,
      confirmedAt: null,
    });
  });

  it("stores an empty collection for a resource with no scope parameters", async () => {
    const reloaded = await new ResourceBindingRepository(db).getById(emptyBindingId);
    expect(reloaded?.scopePathBindings).toStrictEqual([]);
  });
});
