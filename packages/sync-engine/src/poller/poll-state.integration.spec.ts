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

import { FakeOrderingQueue } from "../fake-ordering-queue.js";
import { FakeRecordLinkStore } from "../identity-resolution/fakes.js";
import { QueueKeyResolver } from "../ordering/queue-key-resolver.js";
import { DbPollStateStore } from "./db-poll-state-store.js";
import { FakePollPlanResolver, FakeSourceReader } from "./fakes.js";
import { Poller } from "./poller.js";
import { decidePoll } from "./scheduler.js";
import type { PollCandidateView } from "./types.js";

/** Narrow an optional fixture lookup, failing loudly rather than asserting on `undefined`. */
function required(candidate: PollCandidateView | undefined): PollCandidateView {
  if (candidate === undefined) {
    throw new Error("expected a poll candidate for the seeded rule");
  }
  return candidate;
}

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

  /**
   * SP-1 regression, proven against real Postgres + the real `listPollCandidates` join +
   * the real `decidePoll` gate — the exact composition the live scoped-sync capstone
   * exercised, and the one the fake-backed unit tests structurally cannot cover.
   *
   * A per-scope run advances only `poll_scope_state`, so `sync_rule.last_run_at` stayed
   * NULL and `decidePoll` read that as "never polled → due now" — re-polling the rule on
   * EVERY scheduler tick regardless of its interval, and racing the deterministic poll
   * trigger into reporting `enqueuedCount: 0` for a change a concurrent run had consumed.
   */
  it("a per-scope advance alone leaves the rule due forever; advanceRuleRun makes it not-due", async () => {
    const store = new DbPollStateStore(db);
    const scopeKey = randomUUID();
    const lastRunAt = new Date("2026-07-13T12:00:00.000Z");

    // A per-scope poll: the scope advances its own row (snapshot + its own last_run_at)…
    await store.advance({
      ruleId: RULE,
      scopeKey,
      lastRunAt,
      snapshotEntries: new Map([["1", "hash-1"]]),
      capturedAt: lastRunAt,
    });

    // …and that write does NOT touch the rule's own marker (this is the gap, in the real DB).
    expect((await new SyncRuleRepository(db).getById(RULE))?.lastRunAt).toBeUndefined();

    // Which the REAL scheduler gate reads as "never polled → due now", every single tick.
    const dueCandidate = (await new SyncRuleRepository(db).listPollCandidates()).find(
      (candidate) => candidate.rule.id === RULE,
    );
    expect(dueCandidate).toBeDefined();
    expect(decidePoll(required(dueCandidate), new Date(lastRunAt.getTime() + 1_000))).toMatchObject(
      { kind: "poll" },
    );

    // The fix: the fan-out stamps the RULE's own last_run_at — nothing else moves.
    await store.advanceRuleRun(RULE, lastRunAt);

    const rule = await new SyncRuleRepository(db).getById(RULE);
    expect(rule?.lastRunAt?.toISOString()).toBe(lastRunAt.toISOString());
    expect(rule?.cursor).toBeUndefined();
    expect(rule?.lastSnapshotRef).toBeUndefined();
    // The scope's own state is untouched by the rule-level stamp (per-scope isolation).
    expect((await store.loadSnapshot(RULE, scopeKey))?.entries.get("1")).toBe("hash-1");

    // And now the gate honours the interval instead of firing on every tick.
    const settled = (await new SyncRuleRepository(db).listPollCandidates()).find(
      (candidate) => candidate.rule.id === RULE,
    );
    expect(decidePoll(required(settled), new Date(lastRunAt.getTime() + 1_000))).toMatchObject({
      kind: "not-due",
    });
  });

  /**
   * The end-to-end shape of the same regression: the REAL {@link Poller} running a
   * per-scope fan-out against REAL Postgres, then the REAL `decidePoll` gate. This is the
   * composition the capstone flake lived in — every existing per-scope Poller test drives a
   * fake state store, which is why a rule-level column left NULL slipped through.
   */
  it("a real per-scope poll run against Postgres leaves the rule NOT due on the next tick", async () => {
    const scopeA = randomUUID();
    const scopeB = randomUUID();
    const now = new Date("2026-07-13T12:00:00.000Z");

    const reader = new FakeSourceReader();
    reader.setFullFetch(RULE, [{ records: [{ nativeId: "a1", record: { id: "a1" } }] }], scopeA);
    reader.setFullFetch(RULE, [{ records: [{ nativeId: "b1", record: { id: "b1" } }] }], scopeB);
    const resolver = new FakePollPlanResolver();
    resolver.set(RULE, {
      pollable: true,
      plan: {
        ruleId: RULE,
        mappingId: MAPPING,
        sourceAppId: APP_A,
        targetAppId: APP_B,
        resourcePairRef: "pair::customers",
        scopeMode: "per-scope",
        mode: "full-fetch",
        identitySourcePath: "email",
        scopes: [
          { scopeLinkId: scopeA, fillValues: new Map([["repo", "alpha"]]) },
          { scopeLinkId: scopeB, fillValues: new Map([["repo", "beta"]]) },
        ],
        unresolvedScopes: [],
      },
    });
    const poller = new Poller(
      reader,
      resolver,
      new DbPollStateStore(db),
      new FakeOrderingQueue(),
      new QueueKeyResolver(new FakeRecordLinkStore()),
      { now: () => now },
    );

    const outcome = await poller.pollOnce(RULE);
    expect(outcome.kind).toBe("completed-per-scope");

    // One second later the 60s-interval rule must NOT be due again. Without the rule-level
    // stamp its `last_run_at` is still NULL → `poll` on this and every subsequent tick.
    const candidate = (await new SyncRuleRepository(db).listPollCandidates()).find(
      (entry) => entry.rule.id === RULE,
    );
    expect(decidePoll(required(candidate), new Date(now.getTime() + 1_000))).toMatchObject({
      kind: "not-due",
    });
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
