import { randomUUID } from "node:crypto";

import type { ApiSpec, ApprovedMapping, RegisteredApp, SyncRule } from "@mediator/domain";
import {
  ApiSpecRepository,
  ApprovedMappingRepository,
  DownstreamArtifactRepository,
  PollSnapshotRepository,
  RegisteredAppRepository,
  SyncRuleRepository,
  apiSpec,
  approvedMapping,
  closeDb,
  createDb,
  pollSnapshot,
  registeredApp,
  resolveDatabaseUrl,
  runMigrations,
  syncRule,
  tx,
  type Database,
} from "@mediator/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { DbPollStateStore } from "./db-poll-state-store.js";

/**
 * Live-database integration test for the SP-5 **atomic cursor/snapshot advance** and the
 * `poll_snapshot` store (migration 0014). The single-transaction advance (`sync_rule`
 * cursor/`last_run_at`/`last_snapshot_ref` + `poll_snapshot` entries) CANNOT be faked —
 * atomicity is a real-Postgres property — so it is proven here against real Postgres +
 * the full migration chain, the live counterpart to the `FakePollStateStore` unit tests.
 *
 * Requires the compose `postgres` service + a resolvable `DATABASE_URL`; excluded from
 * `pnpm verify`, run via `pnpm --filter @mediator/sync-engine test:integration`.
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
function ruleOf(overrides: Partial<SyncRule> = {}): SyncRule {
  return {
    id: RULE,
    approvedMappingId: MAPPING,
    resourcePairRef: "pair::customers",
    status: "enabled",
    backfillStatus: "completed",
    ...overrides,
  };
}

suite("Phase-4 poll-state atomic advance + snapshot store integration (requires Postgres)", () => {
  let db: Database;

  beforeAll(async () => {
    db = createDb(databaseUrl ?? "");
    await runMigrations(db);
    await db.delete(pollSnapshot);
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
    await db.delete(pollSnapshot);
    await db.delete(syncRule);
    await new DownstreamArtifactRepository(db).insertSyncRuleIfAbsent(ruleOf());
  });

  afterAll(async () => {
    await db.delete(pollSnapshot);
    await db.delete(syncRule);
    await db.delete(approvedMapping);
    await db.delete(apiSpec);
    await db.delete(registeredApp);
    await closeDb(db);
  });

  it("seeds the snapshot, sets last_snapshot_ref + last_run_at, and loads it back", async () => {
    const store = new DbPollStateStore(db);
    expect(await store.loadSnapshot(RULE)).toBeUndefined();

    const lastRunAt = new Date("2026-07-13T12:00:00.000Z");
    await store.advance({
      ruleId: RULE,
      lastRunAt,
      snapshotEntries: new Map([
        ["1", "hash-1"],
        ["2", "hash-2"],
      ]),
      capturedAt: lastRunAt,
    });

    const loaded = await store.loadSnapshot(RULE);
    expect(loaded?.entries.get("1")).toBe("hash-1");
    expect(loaded?.entries.size).toBe(2);

    const rule = await new SyncRuleRepository(db).getById(RULE);
    expect(rule?.lastSnapshotRef).toBe(loaded?.snapshotRef);
    expect(rule?.lastRunAt?.toISOString()).toBe(lastRunAt.toISOString());
    expect(rule?.cursor).toBeUndefined(); // full-fetch rule: cursor untouched
  });

  it("replaces the snapshot in place (stable ref) on a later advance", async () => {
    const store = new DbPollStateStore(db);
    await store.advance({
      ruleId: RULE,
      lastRunAt: new Date("2026-07-13T12:00:00.000Z"),
      snapshotEntries: new Map([["1", "hash-1"]]),
    });
    const first = await store.loadSnapshot(RULE);

    await store.advance({
      ruleId: RULE,
      lastRunAt: new Date("2026-07-13T12:01:00.000Z"),
      snapshotEntries: new Map([
        ["2", "hash-2"],
        ["3", "hash-3"],
      ]),
    });
    const second = await store.loadSnapshot(RULE);

    // Same poll_snapshot row (stable id) with fully replaced contents.
    expect(second?.snapshotRef).toBe(first?.snapshotRef);
    expect([...(second?.entries.keys() ?? [])].sort()).toStrictEqual(["2", "3"]);
    expect(await new PollSnapshotRepository(db).loadByRule(RULE)).toMatchObject({ recordCount: 2 });
  });

  it("advances a delta cursor + last_run_at atomically without writing a snapshot", async () => {
    const store = new DbPollStateStore(db);
    await store.advance({
      ruleId: RULE,
      lastRunAt: new Date("2026-07-13T12:00:00.000Z"),
      cursor: "cursor-xyz",
    });

    const rule = await new SyncRuleRepository(db).getById(RULE);
    expect(rule?.cursor).toBe("cursor-xyz");
    expect(rule?.lastSnapshotRef).toBeUndefined();
    expect(await store.loadSnapshot(RULE)).toBeUndefined();
  });

  it("the advance is ONE transaction: a fault mid-advance rolls back both writes", async () => {
    // Seed a baseline snapshot + cursor first.
    const store = new DbPollStateStore(db);
    await store.advance({
      ruleId: RULE,
      lastRunAt: new Date("2026-07-13T12:00:00.000Z"),
      snapshotEntries: new Map([["1", "hash-1"]]),
      cursor: "c1",
    });

    // Now run a transaction that replaces the snapshot AND then throws — both must roll
    // back (the snapshot must NOT be left replaced while the cursor advance was lost).
    await expect(
      tx(db, async (txn) => {
        await new PollSnapshotRepository(txn).replace(
          RULE,
          new Map([["99", "hash-99"]]),
          new Date("2026-07-13T12:05:00.000Z"),
        );
        await new SyncRuleRepository(txn).applyAdvance(RULE, {
          lastRunAt: new Date("2026-07-13T12:05:00.000Z"),
          cursor: "c2",
        });
        throw new Error("simulated fault after both writes");
      }),
    ).rejects.toThrow(/simulated fault/);

    // Nothing changed — the baseline snapshot + cursor survive intact.
    const loaded = await store.loadSnapshot(RULE);
    expect([...(loaded?.entries.keys() ?? [])]).toStrictEqual(["1"]);
    expect((await new SyncRuleRepository(db).getById(RULE))?.cursor).toBe("c1");
  });

  it("listPollCandidates joins the enabled rule to its mapping status + source polling capability", async () => {
    const candidates = await new SyncRuleRepository(db).listPollCandidates();
    const candidate = candidates.find((c) => c.rule.id === RULE);
    expect(candidate).toMatchObject({
      mappingStatus: "active",
      sourceAppId: APP_A,
      sourceSupportsPolling: true,
      sourceDefaultPollInterval: 60_000,
    });
    expect(candidate?.rule.backfillStatus).toBe("completed");
  });
});
