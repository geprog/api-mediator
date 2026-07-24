import type { ApprovedMappingStatus, RegisteredAppStatus, SyncRule } from "@mediator/domain";
import { describe, expect, it } from "vitest";

import { FakePollCandidateSource, FakeSchedulerMetrics } from "./fakes.js";
import { decidePoll, pollPauseConditions, Scheduler } from "./scheduler.js";
import type { PollCandidateView, PollRunOutcome, PollTrigger } from "./types.js";

/**
 * Unit tests for the **Scheduler** eligibility gate (SP-1): the pure {@link decidePoll}
 * (poll only while enabled + backfill done + mapping active + neither app disabled;
 * running backfill polls nothing; stale/suspended pauses without touching status; a
 * disabled app pauses without touching the rule at all — AL-1; a non-polling source is a
 * backstop; interval override vs default), the AL-1.6 **composition** of those conditions
 * via {@link pollPauseConditions}, and the tick's poller-lag + stuck-poller emission.
 */

const NOW = new Date("2026-07-13T12:00:00.000Z");

function rule(overrides: Partial<SyncRule> = {}): SyncRule {
  return {
    id: "rule-1",
    approvedMappingId: "mapping-1",
    resourcePairRef: "pair::customers",
    status: "enabled",
    backfillStatus: "completed",
    ...overrides,
  };
}

function candidate(
  overrides: {
    rule?: Partial<SyncRule>;
    mappingStatus?: ApprovedMappingStatus;
    sourceSupportsPolling?: boolean;
    sourceDefaultPollInterval?: number;
    sourceAppStatus?: RegisteredAppStatus;
    targetAppStatus?: RegisteredAppStatus;
  } = {},
): PollCandidateView {
  return {
    rule: rule(overrides.rule),
    mappingStatus: overrides.mappingStatus ?? "active",
    sourceAppId: "app-source",
    sourceSupportsPolling: overrides.sourceSupportsPolling ?? true,
    sourceDefaultPollInterval: overrides.sourceDefaultPollInterval ?? 60_000,
    sourceAppStatus: overrides.sourceAppStatus ?? "active",
    targetAppId: "app-target",
    targetAppStatus: overrides.targetAppStatus ?? "active",
  };
}

/** Records `pollOnce` calls; every call reports a completed no-change run. */
class FakePollTrigger implements PollTrigger {
  public readonly calls: string[] = [];
  public pollOnce(ruleId: string): Promise<PollRunOutcome> {
    this.calls.push(ruleId);
    return Promise.resolve({ kind: "completed", enqueued: [], mode: "full-fetch" });
  }
}

describe("decidePoll — SP-1 eligibility gate", () => {
  it("polls an eligible rule that has never run (due now), interval = source default", () => {
    const decision = decidePoll(candidate(), NOW);
    expect(decision).toStrictEqual({ kind: "poll", intervalMs: 60_000, lastRunAt: undefined });
  });

  it("SP-1.1 uses pollIntervalOverride when set", () => {
    const decision = decidePoll(candidate({ rule: { pollIntervalOverride: 5_000 } }), NOW);
    expect(decision).toMatchObject({ kind: "poll", intervalMs: 5_000 });
  });

  it("SP-1.1 is not due until the interval elapses since lastRunAt", () => {
    const lastRunAt = new Date(NOW.getTime() - 20_000);
    const decision = decidePoll(candidate({ rule: { lastRunAt } }), NOW);
    expect(decision).toStrictEqual({
      kind: "not-due",
      intervalMs: 60_000,
      dueInMs: 40_000,
      lastRunAt,
    });
  });

  it("SP-1.1 is due once the interval has elapsed", () => {
    const lastRunAt = new Date(NOW.getTime() - 60_000);
    const decision = decidePoll(candidate({ rule: { lastRunAt } }), NOW);
    expect(decision).toMatchObject({ kind: "poll", intervalMs: 60_000 });
  });

  it("SP-1.2 an enabled rule with a running backfill polls nothing yet", () => {
    expect(decidePoll(candidate({ rule: { backfillStatus: "running" } }), NOW)).toStrictEqual({
      kind: "hold",
      reason: "backfill-not-done",
    });
    expect(decidePoll(candidate({ rule: { backfillStatus: "pending" } }), NOW)).toMatchObject({
      kind: "hold",
      reason: "backfill-not-done",
    });
  });

  it("SP-1.2 polls when backfill is skipped (as well as completed)", () => {
    expect(decidePoll(candidate({ rule: { backfillStatus: "skipped" } }), NOW).kind).toBe("poll");
    expect(decidePoll(candidate({ rule: { backfillStatus: "completed" } }), NOW).kind).toBe("poll");
  });

  it("SP-1.3 a stale/suspended mapping pauses the rule without touching its status", () => {
    expect(decidePoll(candidate({ mappingStatus: "stale" }), NOW)).toStrictEqual({
      kind: "hold",
      reason: "mapping-stale",
    });
    expect(decidePoll(candidate({ mappingStatus: "suspended" }), NOW)).toStrictEqual({
      kind: "hold",
      reason: "mapping-suspended",
    });
  });

  it("SP-1.2 holds a mapping that is neither active nor stale/suspended (superseded/archived)", () => {
    expect(decidePoll(candidate({ mappingStatus: "superseded" }), NOW)).toMatchObject({
      kind: "hold",
      reason: "mapping-not-active",
    });
  });

  it("SP-1.4 a source that cannot poll is a runtime backstop (holds even when otherwise eligible)", () => {
    expect(decidePoll(candidate({ sourceSupportsPolling: false }), NOW)).toStrictEqual({
      kind: "hold",
      reason: "source-not-pollable",
    });
  });

  it("holds a disabled rule defensively", () => {
    expect(decidePoll(candidate({ rule: { status: "disabled" } }), NOW)).toMatchObject({
      kind: "hold",
      reason: "not-enabled",
    });
  });

  // ── AL-1.1/1.3 — the app-lifecycle condition ────────────────────────────────

  it("AL-1.1 a disabled SOURCE app pauses the rule (its status/backfill untouched)", () => {
    const held = candidate({ sourceAppStatus: "disabled" });
    expect(decidePoll(held, NOW)).toStrictEqual({ kind: "hold", reason: "app-disabled" });
    // The condition is read off the APP — the rule itself is still a healthy enabled row.
    expect(held.rule.status).toBe("enabled");
    expect(held.rule.backfillStatus).toBe("completed");
  });

  it("AL-1.1 a disabled TARGET app pauses the rule just as a disabled source does", () => {
    expect(decidePoll(candidate({ targetAppStatus: "disabled" }), NOW)).toStrictEqual({
      kind: "hold",
      reason: "app-disabled",
    });
  });

  it("AL-1.3 re-enabling the app lifts the condition — the same candidate polls again", () => {
    // Same rule row, same stored cursor state: only the app's status differs, and that
    // alone flips the decision back to `poll` (no re-backfill, nothing restored).
    expect(decidePoll(candidate({ sourceAppStatus: "disabled" }), NOW).kind).toBe("hold");
    expect(decidePoll(candidate({ sourceAppStatus: "active" }), NOW).kind).toBe("poll");
  });
});

describe("pollPauseConditions — AL-1.6 composition of the pause conditions", () => {
  it("reports no condition for a fully healthy candidate (the only case that polls)", () => {
    expect(pollPauseConditions(candidate())).toEqual([]);
  });

  it("reports each condition alone", () => {
    expect(pollPauseConditions(candidate({ mappingStatus: "stale" }))).toEqual(["mapping-stale"]);
    expect(pollPauseConditions(candidate({ mappingStatus: "suspended" }))).toEqual([
      "mapping-suspended",
    ]);
    expect(pollPauseConditions(candidate({ sourceAppStatus: "disabled" }))).toEqual([
      "app-disabled",
    ]);
    expect(pollPauseConditions(candidate({ rule: { backfillStatus: "running" } }))).toEqual([
      "backfill-not-done",
    ]);
  });

  it("AL-1.6 reports an app disable AND a suspended mapping simultaneously", () => {
    expect(
      pollPauseConditions(candidate({ mappingStatus: "suspended", targetAppStatus: "disabled" })),
    ).toEqual(["mapping-suspended", "app-disabled"]);
  });

  it("AL-1.6 a rule held by BOTH conditions resumes only when BOTH clear", () => {
    const both = { mappingStatus: "suspended" as const, sourceAppStatus: "disabled" as const };
    expect(decidePoll(candidate(both), NOW).kind).toBe("hold");

    // Lift only the app disable: the suspended mapping still holds it.
    expect(decidePoll(candidate({ ...both, sourceAppStatus: "active" }), NOW)).toStrictEqual({
      kind: "hold",
      reason: "mapping-suspended",
    });
    // Lift only the suspension: the app disable still holds it.
    expect(decidePoll(candidate({ ...both, mappingStatus: "active" }), NOW)).toStrictEqual({
      kind: "hold",
      reason: "app-disabled",
    });
    // Both lifted → and only then does it poll.
    expect(
      decidePoll(candidate({ mappingStatus: "active", sourceAppStatus: "active" }), NOW).kind,
    ).toBe("poll");
  });

  it("AL-1.6 accumulates every applicable condition, in the documented reporting order", () => {
    const conditions = pollPauseConditions(
      candidate({
        rule: { status: "disabled", backfillStatus: "running" },
        mappingStatus: "stale",
        sourceSupportsPolling: false,
        targetAppStatus: "disabled",
      }),
    );
    expect(conditions).toEqual([
      "not-enabled",
      "source-not-pollable",
      "backfill-not-done",
      "mapping-stale",
      "app-disabled",
    ]);
    // `decidePoll` surfaces the first, and holds while ANY of them stands.
    expect(decidePoll(candidate({ rule: { status: "disabled" } }), NOW).kind).toBe("hold");
  });
});

describe("Scheduler.tick — SP-1 poller lag + stuck-poller alert + polling due rules", () => {
  it("polls due rules and skips held ones", async () => {
    const source = new FakePollCandidateSource([
      candidate({ rule: { id: "due" } }),
      candidate({ rule: { id: "held", backfillStatus: "running" } }),
    ]);
    const trigger = new FakePollTrigger();
    const scheduler = new Scheduler(source, trigger, { now: () => NOW });

    const decisions = await scheduler.tick();

    expect(decisions.get("due")?.kind).toBe("poll");
    expect(decisions.get("held")?.kind).toBe("hold");
    expect(trigger.calls).toStrictEqual(["due"]);
  });

  it("SP-1.5 emits poller lag for scheduled rules and fires the stuck-poller alert past N× interval", async () => {
    const metrics = new FakeSchedulerMetrics();
    // Lag = 5× the interval → past the default factor of 3 → stuck.
    const stuckLastRun = new Date(NOW.getTime() - 5 * 60_000);
    // Lag = 1× the interval (due, not stuck).
    const dueLastRun = new Date(NOW.getTime() - 60_000);
    const source = new FakePollCandidateSource([
      candidate({ rule: { id: "stuck", lastRunAt: stuckLastRun } }),
      candidate({ rule: { id: "fresh", lastRunAt: dueLastRun } }),
    ]);
    const scheduler = new Scheduler(source, new FakePollTrigger(), { now: () => NOW, metrics });

    await scheduler.tick();

    expect(metrics.lag.map((l) => l.ruleId).sort()).toStrictEqual(["fresh", "stuck"]);
    // Only the 5×-interval rule tripped the stuck-poller alert.
    expect(metrics.stuck.map((s) => s.ruleId)).toStrictEqual(["stuck"]);
    expect(metrics.stuck[0]).toMatchObject({ lagMs: 5 * 60_000, intervalMs: 60_000 });
  });

  it("does not treat an intentionally-held (stale mapping) rule as a stuck poller", async () => {
    const metrics = new FakeSchedulerMetrics();
    const source = new FakePollCandidateSource([
      candidate({
        rule: { id: "paused", lastRunAt: new Date(NOW.getTime() - 999_000) },
        mappingStatus: "stale",
      }),
    ]);
    const scheduler = new Scheduler(source, new FakePollTrigger(), { now: () => NOW, metrics });

    await scheduler.tick();

    // A paused rule emits no lag / stuck signal — it is not "stuck", it is intentionally idle.
    expect(metrics.lag).toHaveLength(0);
    expect(metrics.stuck).toHaveLength(0);
  });
});
