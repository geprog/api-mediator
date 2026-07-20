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
  type EnablementInput,
  type ResolutionContext,
} from "@mediator/sync-engine";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type {
  BackfillRunInput,
  BackfillRunResult,
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
});
