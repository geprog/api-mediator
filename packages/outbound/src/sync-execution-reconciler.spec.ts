import type { BackfillStatus, SyncRule, SyncRuleStatus } from "@mediator/domain";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_RECONCILE_LIMIT,
  FakeSyncExecutionReconcilerMetrics,
  InMemoryBackfillInFlightRegistry,
  SYNC_EXECUTION_RECONCILER_NAME,
  SyncExecutionReconciler,
  type BackfillRetrigger,
  type EnabledRuleReader,
} from "./sync-execution-reconciler.js";

/**
 * Unit tests for the Phase-4 sync-execution reconciler (RS-1;
 * `docs/requirements/phase-4-reconciliation-sweep.md`). The orphaned-vs-in-flight
 * selection (RS-1.2) and the idempotency of re-triggering (RS-1.5) are the load-
 * bearing behaviors, so they are exercised hardest.
 */

// ── Fixtures + fakes ───────────────────────────────────────────────────────────

function ruleOf(
  id: string,
  opts: { readonly backfillStatus?: BackfillStatus; readonly status?: SyncRuleStatus } = {},
): SyncRule {
  const base = {
    id,
    approvedMappingId: `mapping-${id}`,
    resourcePairRef: `pair::${id}`,
    status: opts.status ?? "enabled",
  } satisfies SyncRule;
  return opts.backfillStatus === undefined
    ? base
    : { ...base, backfillStatus: opts.backfillStatus };
}

/** Reads from a mutable id→rule store so a re-trigger can change what the next pass sees. */
class FakeEnabledRuleReader implements EnabledRuleReader {
  public readonly limitCalls: number[] = [];
  readonly #store: Map<string, SyncRule>;

  public constructor(rules: readonly SyncRule[]) {
    this.#store = new Map(rules.map((rule) => [rule.id, rule]));
  }

  public listEnabledForReconciliation(limit: number): Promise<readonly SyncRule[]> {
    this.limitCalls.push(limit);
    // Mirror the real repo's bound: only `enabled` rules, at most `limit`, id-ordered.
    const enabled = [...this.#store.values()]
      .filter((rule) => rule.status === "enabled")
      .sort((a, b) => a.id.localeCompare(b.id))
      .slice(0, limit);
    return Promise.resolve(enabled);
  }

  /** Simulate a rule's persisted state changing between passes. */
  public set(rule: SyncRule): void {
    this.#store.set(rule.id, rule);
  }
}

class FakeRetrigger implements BackfillRetrigger {
  public readonly calls: string[] = [];
  readonly #onRetrigger: ((ruleId: string) => void) | undefined;

  public constructor(onRetrigger?: (ruleId: string) => void) {
    this.#onRetrigger = onRetrigger;
  }

  public retriggerBackfill(ruleId: string): Promise<void> {
    this.calls.push(ruleId);
    this.#onRetrigger?.(ruleId);
    return Promise.resolve();
  }
}

// ── Tests ───────────────────────────────────────────────────────────────────────

describe("SyncExecutionReconciler", () => {
  it("has the stable sweep-registry name (structural Reconciler)", () => {
    const reconciler = new SyncExecutionReconciler({
      rules: new FakeEnabledRuleReader([]),
      retrigger: new FakeRetrigger(),
      inFlight: new InMemoryBackfillInFlightRegistry(),
    });
    expect(reconciler.name).toBe(SYNC_EXECUTION_RECONCILER_NAME);
    expect(reconciler.name).toBe("sync-execution");
  });

  it("RS-1.2: re-triggers an enabled, orphaned `running` rule (not in-flight)", async () => {
    const reader = new FakeEnabledRuleReader([ruleOf("r-run", { backfillStatus: "running" })]);
    const retrigger = new FakeRetrigger();
    // Empty registry = post-restart: the `running` rule is orphaned by construction.
    const reconciler = new SyncExecutionReconciler({
      rules: reader,
      retrigger,
      inFlight: new InMemoryBackfillInFlightRegistry(),
    });

    await reconciler.reconcile();

    expect(retrigger.calls).toStrictEqual(["r-run"]);
  });

  it("RS-1.2: does NOT re-trigger a `running` rule whose backfill IS in flight", async () => {
    const reader = new FakeEnabledRuleReader([ruleOf("r-live", { backfillStatus: "running" })]);
    const retrigger = new FakeRetrigger();
    const inFlight = new InMemoryBackfillInFlightRegistry();
    // This process is actively running the backfill right now — legitimately in progress.
    inFlight.markInFlight("r-live");
    const reconciler = new SyncExecutionReconciler({ rules: reader, retrigger, inFlight });

    await reconciler.reconcile();

    expect(retrigger.calls).toStrictEqual([]);
  });

  it("RS-1.2/RS-1.5: never re-triggers `pending`, `completed`, or `skipped` rules", async () => {
    const reader = new FakeEnabledRuleReader([
      ruleOf("r-pending", { backfillStatus: "pending" }),
      ruleOf("r-completed", { backfillStatus: "completed" }),
      ruleOf("r-skipped", { backfillStatus: "skipped" }),
      // Defensive: an enabled rule with no persisted backfillStatus at all.
      ruleOf("r-absent"),
    ]);
    const retrigger = new FakeRetrigger();
    const reconciler = new SyncExecutionReconciler({
      rules: reader,
      retrigger,
      inFlight: new InMemoryBackfillInFlightRegistry(),
    });

    await reconciler.reconcile();

    expect(retrigger.calls).toStrictEqual([]);
  });

  it("re-triggers only the orphaned running rules in a mixed set", async () => {
    const reader = new FakeEnabledRuleReader([
      ruleOf("a-run", { backfillStatus: "running" }),
      ruleOf("b-completed", { backfillStatus: "completed" }),
      ruleOf("c-run", { backfillStatus: "running" }),
      ruleOf("d-pending", { backfillStatus: "pending" }),
    ]);
    const retrigger = new FakeRetrigger();
    const inFlight = new InMemoryBackfillInFlightRegistry();
    inFlight.markInFlight("c-run"); // c is legitimately in flight
    const reconciler = new SyncExecutionReconciler({ rules: reader, retrigger, inFlight });

    await reconciler.reconcile();

    // Only a-run: b/d wrong status, c in flight.
    expect(retrigger.calls).toStrictEqual(["a-run"]);
  });

  it("RS-1.4: scans bounded — passes the default limit to the reader", async () => {
    const reader = new FakeEnabledRuleReader([]);
    const reconciler = new SyncExecutionReconciler({
      rules: reader,
      retrigger: new FakeRetrigger(),
      inFlight: new InMemoryBackfillInFlightRegistry(),
    });

    await reconciler.reconcile();

    expect(reader.limitCalls).toStrictEqual([DEFAULT_RECONCILE_LIMIT]);
  });

  it("RS-1.4: honours a configured limit per pass", async () => {
    const reader = new FakeEnabledRuleReader([]);
    const reconciler = new SyncExecutionReconciler(
      {
        rules: reader,
        retrigger: new FakeRetrigger(),
        inFlight: new InMemoryBackfillInFlightRegistry(),
      },
      { limit: 25 },
    );

    await reconciler.reconcile();

    expect(reader.limitCalls).toStrictEqual([25]);
  });

  it("RS-1.5: two consecutive sweeps do not double-trigger a rule that completed after the first", async () => {
    const reader = new FakeEnabledRuleReader([ruleOf("r-run", { backfillStatus: "running" })]);
    // The re-trigger advances the rule to `completed`, exactly as a real (idempotent)
    // backfill re-run would once it finishes.
    const retrigger = new FakeRetrigger((ruleId) => {
      reader.set(ruleOf(ruleId, { backfillStatus: "completed" }));
    });
    const reconciler = new SyncExecutionReconciler({
      rules: reader,
      retrigger,
      inFlight: new InMemoryBackfillInFlightRegistry(),
    });

    await reconciler.reconcile();
    await reconciler.reconcile();

    // First pass triggered it; second pass saw `completed` and left it alone.
    expect(retrigger.calls).toStrictEqual(["r-run"]);
  });

  it("RS-1.3: documented no-op — never re-schedules; only re-triggers orphaned backfills", async () => {
    // A completed, enabled rule that "isn't polling" is left to the stateless Scheduler
    // (it re-derives its poll set from listPollCandidates every tick). The reconciler
    // holds no scheduling port at all — its ONLY side-effect port is `retrigger`, and it
    // is not invoked for a completed rule.
    const reader = new FakeEnabledRuleReader([
      ruleOf("r-completed", { backfillStatus: "completed" }),
      ruleOf("r-skipped", { backfillStatus: "skipped" }),
    ]);
    const retrigger = new FakeRetrigger();
    const reconciler = new SyncExecutionReconciler({
      rules: reader,
      retrigger,
      inFlight: new InMemoryBackfillInFlightRegistry(),
    });

    await reconciler.reconcile();

    expect(retrigger.calls).toStrictEqual([]);
  });

  it("emits metrics: evaluated count per pass + one per re-triggered rule", async () => {
    const reader = new FakeEnabledRuleReader([
      ruleOf("a-run", { backfillStatus: "running" }),
      ruleOf("b-completed", { backfillStatus: "completed" }),
    ]);
    const metrics = new FakeSyncExecutionReconcilerMetrics();
    const reconciler = new SyncExecutionReconciler({
      rules: reader,
      retrigger: new FakeRetrigger(),
      inFlight: new InMemoryBackfillInFlightRegistry(),
      metrics,
    });

    await reconciler.reconcile();

    expect(metrics.evaluated).toStrictEqual([2]);
    expect(metrics.retriggered).toStrictEqual(["a-run"]);
  });
});

describe("InMemoryBackfillInFlightRegistry", () => {
  it("tracks mark/clear membership", () => {
    const registry = new InMemoryBackfillInFlightRegistry();
    expect(registry.isBackfillInFlight("r-1")).toBe(false);

    registry.markInFlight("r-1");
    expect(registry.isBackfillInFlight("r-1")).toBe(true);
    expect(registry.isBackfillInFlight("r-2")).toBe(false);

    registry.clear("r-1");
    expect(registry.isBackfillInFlight("r-1")).toBe(false);
  });
});
