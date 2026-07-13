import { randomUUID } from "node:crypto";

import {
  ApiSpecRepository,
  ApprovedMappingRepository,
  DownstreamArtifactRepository,
  RegisteredAppRepository,
  SyncRuleRepository,
  apiSpec,
  approvedMapping,
  closeDb,
  createDb,
  registeredApp,
  resolveDatabaseUrl,
  runMigrations,
  syncRule,
  tx,
  type Database,
} from "@mediator/db";
import type { ApiSpec, ApprovedMapping, RegisteredApp, SyncRule } from "@mediator/domain";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  InMemoryBackfillInFlightRegistry,
  SyncExecutionReconciler,
  type BackfillRetrigger,
} from "./sync-execution-reconciler.js";

/**
 * Live-database convergence integration for the Phase-4 sync-execution reconciler
 * at the **reconciler + repository** level (RS-2;
 * `docs/requirements/phase-4-reconciliation-sweep.md`). It proves the invariant
 * "bus loss / restart degrades timeliness, never correctness": a rule left at
 * `backfillStatus = running` by a dropped/crashed enablement reaction is picked up by
 * the sweep — driven by the REAL `SyncRuleRepository.listEnabledForReconciliation`
 * scan — its backfill re-triggered, and (with the trigger advancing status) the rule
 * reaches `completed`; a `completed`/`skipped` rule is left untouched; and a second
 * sweep re-triggers nothing (RS-1.5). The full running-landscape proof is the SU-6
 * capstone e2e; here the trigger is a fake that stands in for the (deferred, SA)
 * live backfill re-run.
 *
 * Requires the compose `postgres` service + a resolvable `DATABASE_URL`; excluded from
 * `pnpm verify`, run via `pnpm --filter @mediator/outbound test:integration`.
 * Self-skips when `DATABASE_URL` is unresolvable.
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
const RULE_RUNNING = randomUUID();
const RULE_COMPLETED = randomUUID();
const RULE_SKIPPED = randomUUID();
const RULE_DISABLED = randomUUID();
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
/** A freshly instantiated (Phase-3 minimal) rule: disabled, backfill `pending`. */
function minimalRuleOf(id: string): SyncRule {
  return {
    id,
    approvedMappingId: MAPPING,
    resourcePairRef: `pair::${id}`,
    status: "disabled",
    backfillStatus: "pending",
  };
}

/**
 * The backfill re-trigger stand-in: it advances the rule to `completed` exactly as the
 * real (idempotent) backfill re-run does once it finishes — so the test observes the
 * rule *converge* through the real repository.
 */
class CompletingRetrigger implements BackfillRetrigger {
  public readonly calls: string[] = [];
  readonly #repo: SyncRuleRepository;

  public constructor(repo: SyncRuleRepository) {
    this.#repo = repo;
  }

  public async retriggerBackfill(ruleId: string): Promise<void> {
    this.calls.push(ruleId);
    await this.#repo.applyEnableTransition(ruleId, { backfillStatus: "completed" });
  }
}

suite("RS-2 sync-execution reconciler convergence integration (requires Postgres)", () => {
  let db: Database;
  let repo: SyncRuleRepository;

  beforeAll(async () => {
    db = createDb(databaseUrl ?? "");
    await runMigrations(db);
    repo = new SyncRuleRepository(db);
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
    const artifacts = new DownstreamArtifactRepository(db);
    await artifacts.insertSyncRuleIfAbsent(minimalRuleOf(RULE_RUNNING));
    await artifacts.insertSyncRuleIfAbsent(minimalRuleOf(RULE_COMPLETED));
    await artifacts.insertSyncRuleIfAbsent(minimalRuleOf(RULE_SKIPPED));
    await artifacts.insertSyncRuleIfAbsent(minimalRuleOf(RULE_DISABLED));
    // A crashed/dropped enablement reaction: enabled, but stuck mid-backfill.
    await repo.applyEnableTransition(RULE_RUNNING, {
      status: "enabled",
      backfillStatus: "running",
    });
    // Already-converged rules — the sweep must leave them untouched.
    await repo.applyEnableTransition(RULE_COMPLETED, {
      status: "enabled",
      backfillStatus: "completed",
    });
    await repo.applyEnableTransition(RULE_SKIPPED, {
      status: "enabled",
      backfillStatus: "skipped",
    });
    // RULE_DISABLED stays disabled+running to prove the sweep scans only enabled rules.
    await repo.applyEnableTransition(RULE_DISABLED, { backfillStatus: "running" });
  });

  afterAll(async () => {
    await db.delete(syncRule);
    await db.delete(approvedMapping);
    await db.delete(apiSpec);
    await db.delete(registeredApp);
    await closeDb(db);
  });

  it("re-triggers the orphaned running rule and it converges to completed; others untouched", async () => {
    const retrigger = new CompletingRetrigger(repo);
    // Empty registry = post-restart: the persisted `running` rule is orphaned.
    const reconciler = new SyncExecutionReconciler({
      rules: repo,
      retrigger,
      inFlight: new InMemoryBackfillInFlightRegistry(),
    });

    await reconciler.reconcile();

    // RS-1.2: only the orphaned running rule was re-triggered (disabled+running excluded).
    expect(retrigger.calls).toStrictEqual([RULE_RUNNING]);
    // RS-2: timeliness delayed, correctness intact — the rule converged.
    expect((await repo.getById(RULE_RUNNING))?.backfillStatus).toBe("completed");
    // The already-converged rules are left exactly as they were.
    expect((await repo.getById(RULE_COMPLETED))?.backfillStatus).toBe("completed");
    expect((await repo.getById(RULE_SKIPPED))?.backfillStatus).toBe("skipped");
    // The disabled rule was never scanned (still disabled, still running).
    const disabled = await repo.getById(RULE_DISABLED);
    expect(disabled?.status).toBe("disabled");
    expect(disabled?.backfillStatus).toBe("running");
  });

  it("RS-1.5: a second sweep after convergence re-triggers nothing", async () => {
    const retrigger = new CompletingRetrigger(repo);
    const reconciler = new SyncExecutionReconciler({
      rules: repo,
      retrigger,
      inFlight: new InMemoryBackfillInFlightRegistry(),
    });

    await reconciler.reconcile();
    await reconciler.reconcile();

    expect(retrigger.calls).toStrictEqual([RULE_RUNNING]);
  });

  it("RS-1.2: an in-flight running rule is skipped (a live backfill is not orphaned)", async () => {
    const retrigger = new CompletingRetrigger(repo);
    const inFlight = new InMemoryBackfillInFlightRegistry();
    // A backfill this process is actively running right now.
    inFlight.markInFlight(RULE_RUNNING);
    const reconciler = new SyncExecutionReconciler({ rules: repo, retrigger, inFlight });

    await reconciler.reconcile();

    expect(retrigger.calls).toStrictEqual([]);
    // Left running — the live backfill owns it, the sweep did not touch it.
    expect((await repo.getById(RULE_RUNNING))?.backfillStatus).toBe("running");
  });
});
