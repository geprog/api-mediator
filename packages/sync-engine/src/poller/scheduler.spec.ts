import type { ApprovedMappingStatus, SyncRule } from "@mediator/domain";
import { describe, expect, it } from "vitest";

import { FakePollCandidateSource, FakeSchedulerMetrics } from "./fakes.js";
import { decidePoll, Scheduler } from "./scheduler.js";
import type { PollCandidateView, PollRunOutcome, PollTrigger } from "./types.js";

/**
 * Unit tests for the **Scheduler** eligibility gate (SP-1): the pure {@link decidePoll}
 * (poll only while enabled + backfill done + mapping active; running backfill polls
 * nothing; stale/suspended pauses without touching status; a non-polling source is a
 * backstop; interval override vs default) and the tick's poller-lag + stuck-poller
 * emission.
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
  } = {},
): PollCandidateView {
  return {
    rule: rule(overrides.rule),
    mappingStatus: overrides.mappingStatus ?? "active",
    sourceAppId: "app-source",
    sourceSupportsPolling: overrides.sourceSupportsPolling ?? true,
    sourceDefaultPollInterval: overrides.sourceDefaultPollInterval ?? 60_000,
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
