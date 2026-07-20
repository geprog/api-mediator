import { randomUUID } from "node:crypto";

import type {
  ApiSpec,
  ApprovedMapping,
  ConfirmableRef,
  FieldMapping,
  IrRefTarget,
  OperationMapping,
  RegisteredApp,
  ResourceBinding,
  SyncRule,
} from "@mediator/domain";
import {
  ApiSpecRepository,
  ApprovedMappingRepository,
  DownstreamArtifactRepository,
  PollScopeStateRepository,
  RegisteredAppRepository,
  SyncRuleRepository,
  apiSpec,
  approvedMapping,
  closeDb,
  createDb,
  pollScopeState,
  pollSnapshot,
  registeredApp,
  resolveDatabaseUrl,
  runMigrations,
  syncRule,
  tx,
  type Database,
} from "@mediator/db";
import {
  DbPollStateStore,
  FakeSourceReader,
  decidePoll,
  type EnablementInput,
  type PollCandidateView,
  type ResolutionContext,
} from "@mediator/sync-engine";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type {
  BackfillRunInput,
  BackfillRunResult,
  BackfillScopeResult,
  LinkOnlyBackfillContext,
} from "./backfill-runner.js";
import {
  RuleEnabler,
  type BackfillRunnerPort,
  type CounterpartBackfillModeLookup,
  type EnableRuleInput,
} from "./enable-rule.js";

/**
 * Live-database integration for the **SS-17.5 per-scope backfill fan-out seeding**: the
 * `RuleEnabler` seeds each COMPLETED fan-out scope's OWN `poll_scope_state` (keyed by its
 * `ScopeLink` id) through the real single-transaction {@link DbPollStateStore} — the
 * per-scope snapshot/cursor round-trip + isolation that CANNOT be faked (per-scope tx
 * atomicity is a real-Postgres property). An aborted scope seeds nothing and the
 * cross-scope state is never touched. Migration **0019** already added `poll_scope_state`
 * — this story adds NO migration. Requires the compose `postgres` service; self-skips
 * when `DATABASE_URL` is unresolvable. Run via `pnpm --filter @mediator/outbound test:integration`.
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
const T0 = new Date("2026-07-19T00:00:00.000Z");

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
    createdAt: T0,
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
    createdAt: T0,
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
    approvedAt: T0,
    status: "active",
  };
}
function ruleRowOf(): SyncRule {
  return {
    id: RULE,
    approvedMappingId: MAPPING,
    resourcePairRef: "pair::issues",
    status: "disabled",
    backfillStatus: "pending",
  };
}

// ── A gate-passing EnablementInput (mirrors enable-rule.spec's validInput) ──────
function confirmed(value: IrRefTarget): ConfirmableRef {
  return { value, confirmedBy: "op", confirmedAt: T0 };
}
const identityKey: FieldMapping = {
  id: "fm-email",
  mappingId: MAPPING,
  sourcePath: "email",
  targetPath: "email",
  transform: "rename",
  isIdentityKey: true,
  targetLookupParamRef: "emailFilter",
};
const createOp: OperationMapping = {
  id: "om-create",
  mappingId: MAPPING,
  sourceOperationRef: "src.create",
  targetOperationRef: "tgt.create",
  action: "create",
};
function sourceBinding(): ResourceBinding {
  return {
    id: "rb-src",
    apiSpecId: SPEC_A,
    resourceRef: "users",
    nativeIdRef: confirmed({ kind: "field", path: "id" }),
    collectionReadRef: confirmed({ kind: "operation", operationId: "src.list" }),
  };
}
function targetBinding(): ResourceBinding {
  return {
    id: "rb-tgt",
    apiSpecId: SPEC_B,
    resourceRef: "users",
    nativeIdRef: confirmed({ kind: "field", path: "id" }),
    collectionReadRef: confirmed({ kind: "operation", operationId: "tgt.list" }),
  };
}
function enablementInput(): EnablementInput {
  return {
    rule: { ...ruleRowOf(), pollOperationRef: "src.list", backfillMode: "link-only" },
    fieldMappings: [identityKey],
    operationMappings: [createOp],
    sourceBinding: sourceBinding(),
    targetBinding: targetBinding(),
    sourceCapabilities: appOf(APP_A, "prov-a").capabilities,
    targetCapabilities: appOf(APP_B, "prov-b").capabilities,
    backfillSkipped: false,
    requiredScopeBindings: [],
  };
}
function linkOnlyContext(): LinkOnlyBackfillContext {
  const resolution: ResolutionContext = {
    appAId: APP_A,
    appBId: APP_B,
    identitySourcePath: "email",
    identityTargetPath: "email",
    targetLookup: { kind: "none" },
    hasApprovedCreateOperation: true,
    fieldMappings: [identityKey],
  };
  return {
    ruleId: RULE,
    mappingId: MAPPING,
    sourceAppId: APP_A,
    targetAppId: APP_B,
    resourcePairRef: "pair::issues",
    resolution,
    fieldMappings: [identityKey],
  };
}
function enableInput(): EnableRuleInput {
  return {
    enablement: enablementInput(),
    backfill: { mode: "link-only", context: linkOnlyContext() },
    pollSeed: { kind: "full-fetch" },
  };
}

/** A fake runner returning a canned per-scope fan-out result (the DB seeding is under test, not the runner). */
class FakePerScopeRunner implements BackfillRunnerPort {
  public readonly calls: BackfillRunInput[] = [];
  readonly #result: BackfillRunResult;
  public constructor(result: BackfillRunResult) {
    this.#result = result;
  }
  public run(input: BackfillRunInput): Promise<BackfillRunResult> {
    this.calls.push(input);
    return Promise.resolve(this.#result);
  }
}
class NoCounterpart implements CounterpartBackfillModeLookup {
  public getCounterpartBackfillMode(): Promise<undefined> {
    return Promise.resolve(undefined);
  }
}

const ZERO_COUNTS = {
  matched: 0,
  unmatched: 0,
  created: 0,
  overwritten: 0,
  ambiguous: 0,
  severed: 0,
  skipped: 0,
  writeFailed: 0,
  disagreedFields: 0,
};

suite("SS-17.5 per-scope backfill seeding integration (requires Postgres)", () => {
  let db: Database;

  beforeAll(async () => {
    db = createDb(databaseUrl ?? "");
    await runMigrations(db);
    await db.delete(pollScopeState);
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
    await db.delete(pollScopeState);
    await db.delete(pollSnapshot);
    await db.delete(syncRule);
    await new DownstreamArtifactRepository(db).insertSyncRuleIfAbsent(ruleRowOf());
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

  function enablerWith(result: BackfillRunResult): RuleEnabler {
    return new RuleEnabler(
      {
        rules: new SyncRuleRepository(db),
        pollState: new DbPollStateStore(db),
        backfillRunner: new FakePerScopeRunner(result),
        sourceReader: new FakeSourceReader(),
        counterpart: new NoCounterpart(),
      },
      { clock: (): Date => T0 },
    );
  }

  it("seeds each completed scope's OWN poll_scope_state snapshot (round-trip + isolation)", async () => {
    const result: BackfillRunResult = {
      outcome: "completed-per-scope",
      mode: "link-only",
      scopes: [
        {
          scopeLinkId: SCOPE_A,
          outcome: {
            outcome: "completed",
            enumeratedCount: 2,
            snapshotEntries: new Map([
              ["issue-1", "hash-1"],
              ["issue-2", "hash-2"],
            ]),
            records: [],
            counts: ZERO_COUNTS,
          },
        },
        {
          scopeLinkId: SCOPE_B,
          outcome: {
            outcome: "completed",
            enumeratedCount: 1,
            snapshotEntries: new Map([["issue-9", "hash-9"]]),
            records: [],
            counts: ZERO_COUNTS,
          },
        },
      ],
    };

    const outcome = await enablerWith(result).enable(enableInput());
    expect(outcome.kind).toBe("enabled");

    const store = new DbPollStateStore(db);
    // Each scope round-trips ITS OWN snapshot, keyed by its ScopeLink id.
    const a = await store.loadSnapshot(RULE, SCOPE_A);
    const b = await store.loadSnapshot(RULE, SCOPE_B);
    expect([...(a?.entries.keys() ?? [])].sort()).toStrictEqual(["issue-1", "issue-2"]);
    expect([...(b?.entries.keys() ?? [])]).toStrictEqual(["issue-9"]);
    // Isolation: distinct snapshot rows, distinct scope-state rows.
    expect(a?.snapshotRef).not.toBe(b?.snapshotRef);
    const scopeStates = new PollScopeStateRepository(db);
    expect(await scopeStates.load(RULE, SCOPE_A)).not.toBeUndefined();
    expect(await scopeStates.load(RULE, SCOPE_B)).not.toBeUndefined();
    // The CROSS-SCOPE state was never touched (a per-scope rule).
    expect(await store.loadSnapshot(RULE)).toBeUndefined();
    // The rule went live.
    expect((await new SyncRuleRepository(db).getById(RULE))?.backfillStatus).toBe("completed");
  });

  it("an aborted scope seeds NOTHING; its completed sibling still round-trips (isolation)", async () => {
    const result: BackfillRunResult = {
      outcome: "completed-per-scope",
      mode: "link-only",
      scopes: [
        {
          scopeLinkId: SCOPE_A,
          outcome: {
            outcome: "completed",
            enumeratedCount: 1,
            snapshotEntries: new Map([["issue-1", "hash-1"]]),
            records: [],
            counts: ZERO_COUNTS,
          },
        },
        {
          scopeLinkId: SCOPE_B,
          outcome: { outcome: "aborted", reason: "page timed out", enumeratedCount: 0 },
        },
      ],
    };

    await enablerWith(result).enable(enableInput());

    const store = new DbPollStateStore(db);
    expect(await store.loadSnapshot(RULE, SCOPE_A)).not.toBeUndefined();
    // The aborted scope seeded no snapshot AND no scope-state row.
    expect(await store.loadSnapshot(RULE, SCOPE_B)).toBeUndefined();
    expect(await new PollScopeStateRepository(db).load(RULE, SCOPE_B)).toBeUndefined();
  });

  /**
   * SP-1/BE-6 regression — the enable path had the SAME `scopeKey`-routing gap as the
   * poll path: every per-scope go-live seed passes `scopeKey`, so it writes only
   * `poll_scope_state` and `sync_rule.last_run_at` was never stamped. The rule then went
   * live with a NULL `lastRunAt`, which the REAL `decidePoll` gate reads as "never polled
   * → due now" — polling on the very next tick regardless of the interval, and racing any
   * concurrent poll trigger. The cross-scope seed has always stamped it.
   *
   * Proven end-to-end here: real `RuleEnabler` → real `DbPollStateStore` → real Postgres →
   * real `SyncRuleRepository.listPollCandidates` → real `decidePoll`.
   */
  async function decideFor(now: Date): Promise<ReturnType<typeof decidePoll>> {
    const candidate = (await new SyncRuleRepository(db).listPollCandidates()).find(
      (entry) => entry.rule.id === RULE,
    );
    if (candidate === undefined) {
      throw new Error("expected the enabled rule to be a poll candidate");
    }
    return decidePoll(candidate satisfies PollCandidateView, now);
  }

  function completedScope(scopeLinkId: string, nativeId: string): BackfillScopeResult[] {
    return [
      {
        scopeLinkId,
        outcome: {
          outcome: "completed",
          enumeratedCount: 1,
          snapshotEntries: new Map([[nativeId, `hash-${nativeId}`]]),
          records: [],
          counts: ZERO_COUNTS,
        },
      },
    ];
  }

  it("a completed per-scope backfill stamps the rule's own last_run_at → NOT due within the interval", async () => {
    const result: BackfillRunResult = {
      outcome: "completed-per-scope",
      mode: "link-only",
      scopes: [...completedScope(SCOPE_A, "issue-1"), ...completedScope(SCOPE_B, "issue-9")],
    };

    expect((await enablerWith(result).enable(enableInput())).kind).toBe("enabled");

    // The rule-level marker is stamped, and agrees with the per-scope seeds' `seededAt`.
    const rule = await new SyncRuleRepository(db).getById(RULE);
    expect(rule?.lastRunAt?.toISOString()).toBe(T0.toISOString());
    expect((await new PollScopeStateRepository(db).load(RULE, SCOPE_A))?.lastRunAt).toStrictEqual(
      T0,
    );

    // Without the stamp this is `poll` — the rule would be polled on the very next tick.
    expect(await decideFor(new Date(T0.getTime() + 1_000))).toMatchObject({ kind: "not-due" });
    // …and it still becomes due once the interval really has elapsed.
    expect(await decideFor(new Date(T0.getTime() + 60_001))).toMatchObject({ kind: "poll" });
  });

  it("a PARTIAL fan-out still goes live and still stamps it (SS-17.5 isolation)", async () => {
    const result: BackfillRunResult = {
      outcome: "completed-per-scope",
      mode: "link-only",
      scopes: [
        ...completedScope(SCOPE_A, "issue-1"),
        {
          scopeLinkId: SCOPE_B,
          outcome: { outcome: "aborted", reason: "page timed out", enumeratedCount: 0 },
        },
      ],
    };

    expect((await enablerWith(result).enable(enableInput())).kind).toBe("enabled");

    // One scope's abort never freezes the whole rule's schedule.
    expect((await new SyncRuleRepository(db).getById(RULE))?.lastRunAt?.toISOString()).toBe(
      T0.toISOString(),
    );
    expect(await decideFor(new Date(T0.getTime() + 1_000))).toMatchObject({ kind: "not-due" });
  });

  it("an ALL-scopes-failed fan-out stamps NOTHING and leaves polling held by SP-1", async () => {
    const result: BackfillRunResult = {
      outcome: "completed-per-scope",
      mode: "link-only",
      scopes: [
        {
          scopeLinkId: SCOPE_A,
          outcome: { outcome: "aborted", reason: "page timed out", enumeratedCount: 0 },
        },
        {
          scopeLinkId: SCOPE_B,
          outcome: { outcome: "aborted", reason: "page timed out", enumeratedCount: 0 },
        },
      ],
    };

    expect((await enablerWith(result).enable(enableInput())).kind).toBe("backfill-aborted");

    // No seed, no `lastRunAt` — matching the documented single-scope abort behaviour…
    const rule = await new SyncRuleRepository(db).getById(RULE);
    expect(rule?.lastRunAt).toBeUndefined();
    expect(rule?.backfillStatus).toBe("running");
    // …and SP-1 keeps polling held, so the NULL marker never reaches the due-ness branch.
    expect(await decideFor(new Date(T0.getTime() + 1_000))).toMatchObject({
      kind: "hold",
      reason: "backfill-not-done",
    });
  });
});
