import { randomUUID } from "node:crypto";

import type {
  ApiSpec,
  ApprovedMapping,
  BackfillStatus,
  RegisteredApp,
  SyncRule,
} from "@mediator/domain";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { closeDb, createDb, tx, type Database } from "./client.js";
import { resolveDatabaseUrl } from "./env.js";
import { runMigrations } from "./migrate.js";
import {
  ApiSpecRepository,
  ApprovedMappingRepository,
  DownstreamArtifactRepository,
  RegisteredAppRepository,
  SyncRuleRepository,
} from "./repositories/index.js";
import { apiSpec, approvedMapping, registeredApp, syncRule } from "./schema.js";

/**
 * Live-database integration test for the BE-3 **enable transition** — the real
 * `SyncRuleRepository.applyEnableTransition` `status`/`backfillStatus` update. The
 * partial-`set` semantics (write only the provided column, leave the other's prior
 * value untouched) is a real-Postgres property the `FakeSyncRuleEnableStore` mirrors,
 * so it is proven here against real Postgres + the full migration chain.
 *
 * Requires the compose `postgres` service + a resolvable `DATABASE_URL`; excluded from
 * `pnpm verify`, run via `pnpm --filter @mediator/db test:integration`.
 */
let databaseUrl: string | undefined;
try {
  databaseUrl = resolveDatabaseUrl(process.env);
} catch {
  databaseUrl = undefined;
}
const suite = databaseUrl === undefined ? describe.skip : describe;

const APP_A = randomUUID();
const APP_B = randomUUID();
const SPEC_A = randomUUID();
const SPEC_B = randomUUID();
const MAPPING = randomUUID();
const RULE = randomUUID();
const CREATED_AT = new Date("2026-07-13T00:00:00.000Z");

function appOf(id: string, name: string): RegisteredApp {
  return {
    id,
    name,
    status: "active",
    baseUrl: `https://${name}.example.test`,
    capabilities: {
      supportsPolling: true,
      supportsDeltaQuery: false,
      supportsChangeTimestamps: false,
      defaultPollInterval: 60_000,
    },
    createdAt: CREATED_AT,
  };
}
function specOf(id: string, appId: string): ApiSpec {
  return {
    id,
    appId,
    role: "PROVIDER",
    rawDocument: { openapi: "3.1.0" },
    parsedIR: [],
    analysisExclusions: [],
    version: 1,
    contentHash: `sha256:${id}`,
    status: "active",
    createdAt: CREATED_AT,
  };
}
function mappingOf(): ApprovedMapping {
  return {
    id: MAPPING,
    sourceSpecId: SPEC_A,
    targetSpecId: SPEC_B,
    sourceAppId: APP_A,
    targetAppId: APP_B,
    variant: "peer-peer",
    approvedBy: "operator",
    approvedAt: CREATED_AT,
    status: "active",
  };
}
/** A freshly instantiated rule: disabled, backfill `pending` (the pre-enable state). */
function pendingRuleOf(): SyncRule {
  return {
    id: RULE,
    approvedMappingId: MAPPING,
    resourcePairRef: "pair::customers",
    status: "disabled",
    backfillStatus: "pending",
  };
}

suite("BE-3 SyncRule enable-transition persistence integration (requires Postgres)", () => {
  let db: Database;

  beforeAll(async () => {
    db = createDb(databaseUrl ?? "");
    await runMigrations(db);
    await db.delete(syncRule);
    await db.delete(approvedMapping);
    await db.delete(apiSpec);
    await db.delete(registeredApp);

    await tx(db, async (txn) => {
      const apps = new RegisteredAppRepository(txn);
      await apps.create(appOf(APP_A, "prov-a"));
      await apps.create(appOf(APP_B, "prov-b"));
      const specs = new ApiSpecRepository(txn);
      await specs.create(specOf(SPEC_A, APP_A));
      await specs.create(specOf(SPEC_B, APP_B));
      await new ApprovedMappingRepository(txn).insert(mappingOf());
    });
  });

  beforeEach(async () => {
    await db.delete(syncRule);
    await new DownstreamArtifactRepository(db).insertSyncRuleIfAbsent(pendingRuleOf());
  });

  afterAll(async () => {
    await db.delete(syncRule);
    await db.delete(approvedMapping);
    await db.delete(apiSpec);
    await db.delete(registeredApp);
    await closeDb(db);
  });

  it("enables + starts the backfill (status → enabled, backfillStatus pending → running)", async () => {
    const repo = new SyncRuleRepository(db);
    await repo.applyEnableTransition(RULE, { status: "enabled", backfillStatus: "running" });

    const rule = await repo.getById(RULE);
    expect(rule?.status).toBe("enabled");
    expect(rule?.backfillStatus).toBe("running");
  });

  it("flips backfillStatus running → completed WITHOUT touching status", async () => {
    const repo = new SyncRuleRepository(db);
    await repo.applyEnableTransition(RULE, { status: "enabled", backfillStatus: "running" });

    // Only backfillStatus in the transition — status must keep its prior `enabled` value.
    await repo.applyEnableTransition(RULE, { backfillStatus: "completed" });

    const rule = await repo.getById(RULE);
    expect(rule?.status).toBe("enabled");
    expect(rule?.backfillStatus).toBe("completed");
  });

  it("records an explicit skip (status → enabled, backfillStatus → skipped)", async () => {
    const repo = new SyncRuleRepository(db);
    await repo.applyEnableTransition(RULE, { status: "enabled", backfillStatus: "skipped" });

    const rule = await repo.getById(RULE);
    expect(rule?.status).toBe("enabled");
    expect(rule?.backfillStatus).toBe("skipped");
  });

  it("an empty transition is a no-op (leaves both columns unchanged)", async () => {
    const repo = new SyncRuleRepository(db);
    await repo.applyEnableTransition(RULE, {});

    const rule = await repo.getById(RULE);
    expect(rule?.status).toBe("disabled");
    expect(rule?.backfillStatus).toBe("pending");
  });

  // ── RS-1: the reconciliation sweep's bounded enabled-rule scan ────────────────

  interface SeedRule {
    readonly id: string;
    readonly pair: string;
    readonly status: "enabled" | "disabled";
    readonly backfillStatus: BackfillStatus;
  }

  async function seedReconciliationRules(rows: readonly SeedRule[]): Promise<void> {
    await db.delete(syncRule);
    const artifacts = new DownstreamArtifactRepository(db);
    const repo = new SyncRuleRepository(db);
    for (const row of rows) {
      await artifacts.insertSyncRuleIfAbsent({
        id: row.id,
        approvedMappingId: MAPPING,
        resourcePairRef: row.pair,
        status: "disabled",
        backfillStatus: "pending",
      });
      await repo.applyEnableTransition(row.id, {
        status: row.status,
        backfillStatus: row.backfillStatus,
      });
    }
  }

  // Code-unit compare — matches Postgres's `uuid` ordering for canonical lowercase UUIDs.
  const byId = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

  it("listEnabledForReconciliation returns only enabled rules with their backfillStatus (RS-1.1)", async () => {
    const running = randomUUID();
    const completed = randomUUID();
    const disabled = randomUUID();
    await seedReconciliationRules([
      { id: running, pair: "pair::a", status: "enabled", backfillStatus: "running" },
      { id: completed, pair: "pair::b", status: "enabled", backfillStatus: "completed" },
      { id: disabled, pair: "pair::c", status: "disabled", backfillStatus: "running" },
    ]);

    const repo = new SyncRuleRepository(db);
    const rules = await repo.listEnabledForReconciliation(100);

    // Only the two enabled rows — the disabled+running rule is excluded up front.
    expect(new Set(rules.map((r) => r.id))).toStrictEqual(new Set([running, completed]));
    expect(rules.find((r) => r.id === running)?.backfillStatus).toBe("running");
    expect(rules.find((r) => r.id === completed)?.backfillStatus).toBe("completed");
  });

  it("listEnabledForReconciliation is bounded by the limit and id-ordered (RS-1.4)", async () => {
    const ids = [randomUUID(), randomUUID(), randomUUID()];
    await seedReconciliationRules(
      ids.map((id, i) => ({
        id,
        pair: `pair::lim-${String(i)}`,
        status: "enabled" as const,
        backfillStatus: "running" as const,
      })),
    );

    const repo = new SyncRuleRepository(db);
    const rules = await repo.listEnabledForReconciliation(2);

    // Bounded to the limit, and the deterministic id order (the two smallest ids).
    const expected = [...ids].sort(byId).slice(0, 2);
    expect(rules).toHaveLength(2);
    expect(rules.map((r) => r.id)).toStrictEqual(expected);
  });
});
