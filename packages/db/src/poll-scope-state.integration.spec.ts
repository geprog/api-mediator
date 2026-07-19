import { randomUUID } from "node:crypto";

import type { ApiSpec, ApprovedMapping, RegisteredApp, SyncRule } from "@mediator/domain";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";

import { closeDb, createDb, tx, type Database } from "./client.js";
import { resolveDatabaseUrl } from "./env.js";
import { runMigrations } from "./migrate.js";
import {
  ApiSpecRepository,
  ApprovedMappingRepository,
  DownstreamArtifactRepository,
  PollScopeStateRepository,
  PollSnapshotRepository,
  RegisteredAppRepository,
  SyncRuleRepository,
} from "./repositories/index.js";
import {
  CROSS_SCOPE_SCOPE_KEY,
  apiSpec,
  approvedMapping,
  pollScopeState,
  pollSnapshot,
  registeredApp,
  syncRule,
} from "./schema.js";

/**
 * SS-13.3 live-database integration test for the **per-`(rule, scope)` poll state** the
 * migration 0019 adds (`poll_scope_state` + `poll_snapshot.scope_key`) and the
 * `sync_rule.poll_scope_mode` override. Proves against real Postgres + the full migration
 * chain:
 *  - migration 0019 applies clean on the chain (the whole suite migrates in `beforeAll`);
 *  - the per-scope cursor / snapshot round-trips, keyed by `(sync_rule_id, scope_key)`;
 *  - the per-scope atomic advance (cursor + snapshot in one tx) commits together;
 *  - per-scope **isolation** — one scope's advance never touches another scope's — nor
 *    the cross-scope sentinel — state;
 *  - the `(sync_rule_id, scope_key)` uniqueness (the NULL-uniqueness trap avoided via the
 *    non-null sentinel) — a second cross-scope snapshot upserts the SAME row.
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
const SCOPE_A = randomUUID();
const SCOPE_B = randomUUID();
const CREATED_AT = new Date("2026-07-19T00:00:00.000Z");

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
function ruleOf(): SyncRule {
  return {
    id: RULE,
    approvedMappingId: MAPPING,
    resourcePairRef: "pair::issues",
    status: "enabled",
    backfillStatus: "completed",
  };
}

suite("SS-13.3 per-scope poll-state persistence integration (requires Postgres)", () => {
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
    await db.delete(pollScopeState);
    await db.delete(pollSnapshot);
    await db.delete(syncRule);
    await new DownstreamArtifactRepository(db).insertSyncRuleIfAbsent(ruleOf());
  });

  afterAll(async () => {
    await db.delete(pollScopeState);
    await db.delete(pollSnapshot);
    await db.delete(syncRule);
    await db.delete(approvedMapping);
    await db.delete(apiSpec);
    await db.delete(registeredApp);
    await closeDb(db);
  });

  it("round-trips the sync_rule.poll_scope_mode override (SS-13.5)", async () => {
    const rules = new SyncRuleRepository(db);
    await rules.updateConfig(RULE, { pollScopeMode: "per-scope-enumerated" });
    expect((await rules.getById(RULE))?.pollScopeMode).toBe("per-scope-enumerated");

    // `null` clears the override back to the derived mode (absent domain key).
    await rules.updateConfig(RULE, { pollScopeMode: null });
    expect((await rules.getById(RULE))?.pollScopeMode).toBeUndefined();
  });

  it("advances a scope's cursor + snapshot atomically, keyed by its ScopeLink id", async () => {
    const scopeStates = new PollScopeStateRepository(db);
    const snapshots = new PollSnapshotRepository(db);

    // Seed scope A's snapshot + its state pointing at it, in one tx (mirrors the store).
    await tx(db, async (txn) => {
      const snapRef = await new PollSnapshotRepository(txn).replace(
        RULE,
        new Map([["issue-1", "hash-1"]]),
        CREATED_AT,
        SCOPE_A,
      );
      await new PollScopeStateRepository(txn).advance(RULE, SCOPE_A, {
        lastRunAt: CREATED_AT,
        cursor: "a-c1",
        lastSnapshotRef: snapRef,
      });
    });

    const state = await scopeStates.load(RULE, SCOPE_A);
    expect(state?.cursor).toBe("a-c1");
    expect(state?.lastSnapshotRef).toBeDefined();
    // The scope's snapshot round-trips under its own scope_key.
    const snap = await snapshots.loadByRule(RULE, SCOPE_A);
    expect(snap?.scopeKey).toBe(SCOPE_A);
    expect(snap?.entries).toStrictEqual({ "issue-1": "hash-1" });
  });

  it("per-scope isolation: advancing scope A never touches scope B — nor the cross-scope state", async () => {
    const scopeStates = new PollScopeStateRepository(db);

    await scopeStates.advance(RULE, SCOPE_A, { lastRunAt: CREATED_AT, cursor: "a-c1" });
    await scopeStates.advance(RULE, SCOPE_B, { lastRunAt: CREATED_AT, cursor: "b-c1" });
    // Re-advance ONLY scope A.
    await scopeStates.advance(RULE, SCOPE_A, { lastRunAt: CREATED_AT, cursor: "a-c2" });

    expect((await scopeStates.load(RULE, SCOPE_A))?.cursor).toBe("a-c2");
    expect((await scopeStates.load(RULE, SCOPE_B))?.cursor).toBe("b-c1"); // untouched
    // The cross-scope rule cursor is not per-scope state — it stays NULL here.
    expect((await new SyncRuleRepository(db).getById(RULE))?.cursor).toBeUndefined();
    // Exactly two per-scope rows for the rule.
    expect(await scopeStates.listByRule(RULE)).toHaveLength(2);
  });

  it("uniqueness on (sync_rule_id, scope_key): a second cross-scope snapshot upserts the SAME row (no NULL trap)", async () => {
    const snapshots = new PollSnapshotRepository(db);

    // Two cross-scope replaces (default sentinel scope_key) must target ONE row, not two.
    const firstId = await snapshots.replace(RULE, new Map([["x", "h1"]]), CREATED_AT);
    const secondId = await snapshots.replace(RULE, new Map([["x", "h2"]]), CREATED_AT);
    expect(secondId).toBe(firstId); // upsert-in-place, not a second NULL-distinct row.

    const rows = await db
      .select()
      .from(pollSnapshot)
      .where(
        and(eq(pollSnapshot.syncRuleId, RULE), eq(pollSnapshot.scopeKey, CROSS_SCOPE_SCOPE_KEY)),
      );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.entries).toStrictEqual({ x: "h2" });

    // A per-scope snapshot for the SAME rule is a DIFFERENT row (different scope_key).
    const scopedId = await snapshots.replace(RULE, new Map([["y", "h3"]]), CREATED_AT, SCOPE_A);
    expect(scopedId).not.toBe(firstId);
    const all = await db.select().from(pollSnapshot).where(eq(pollSnapshot.syncRuleId, RULE));
    expect(all).toHaveLength(2); // one cross-scope sentinel row + one per-scope row.
  });
});
