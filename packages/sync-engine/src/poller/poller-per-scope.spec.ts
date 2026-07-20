import type { JsonRecord } from "@mediator/transform";
import { describe, expect, it } from "vitest";

import { FakeOrderingQueue } from "../fake-ordering-queue.js";
import { FakeRecordLinkStore } from "../identity-resolution/fakes.js";
import { QueueKeyResolver } from "../ordering/queue-key-resolver.js";
import { FakePollPlanResolver, FakePollStateStore, FakeSourceReader } from "./fakes.js";
import { Poller } from "./poller.js";
import type {
  ObservedRecord,
  PerScopePollPlan,
  PerScopeRunResult,
  PollRunOutcome,
  PollScope,
} from "./types.js";

/**
 * SS-13.2/13.3/13.4 — the **per-scope** Poller: enumerate the resolved scopes, poll each
 * container's scoped read with its **own** cursor/snapshot, isolate a scope's abort/failure
 * from the others, and **park** an unresolvable scope (fail-loud). The cross-scope
 * single-cursor path (SS-13.1/SS-8) stays covered by `poller.spec.ts` — these tests prove
 * adding per-scope state does not leak between scopes.
 */

const RULE_ID = "rule-1";
const SOURCE_APP = "app-source";
const TARGET_APP = "app-target";
const PAIR = "pair::issues";
const NOW = new Date("2026-07-19T12:00:00.000Z");

const SCOPE_A = "scope-link-A";
const SCOPE_B = "scope-link-B";

function scope(scopeLinkId: string, fill: Record<string, string>): PollScope {
  return { scopeLinkId, fillValues: new Map(Object.entries(fill)) };
}

function perScopePlan(overrides: Partial<PerScopePollPlan> = {}): PerScopePollPlan {
  return {
    ruleId: RULE_ID,
    mappingId: "mapping-1",
    sourceAppId: SOURCE_APP,
    targetAppId: TARGET_APP,
    resourcePairRef: PAIR,
    scopeMode: "per-scope",
    mode: "full-fetch",
    identitySourcePath: "email",
    scopes: [
      scope(SCOPE_A, { owner: "alice", repo: "phoenix" }),
      scope(SCOPE_B, { owner: "bob", repo: "atlas" }),
    ],
    unresolvedScopes: [],
    ...overrides,
  };
}

function rec(nativeId: string, body: JsonRecord = {}): ObservedRecord {
  return { nativeId, record: { id: nativeId, ...body } };
}

interface Harness {
  poller: Poller;
  reader: FakeSourceReader;
  state: FakePollStateStore;
  queue: FakeOrderingQueue;
}

function harness(plan: PerScopePollPlan): Harness {
  const reader = new FakeSourceReader();
  const resolver = new FakePollPlanResolver();
  resolver.set(plan.ruleId, { pollable: true, plan });
  const state = new FakePollStateStore();
  const queue = new FakeOrderingQueue();
  const queueKeys = new QueueKeyResolver(new FakeRecordLinkStore());
  const poller = new Poller(reader, resolver, state, queue, queueKeys, { now: () => NOW });
  return { poller, reader, state, queue };
}

function pending(queue: FakeOrderingQueue): Record<string, unknown>[] {
  return queue.listByStatus("pending").map((entry) => entry.payload);
}

/** How many changes a scope's completed result enqueued (0 for aborted/parked). */
function enqueuedCountOf(result: PerScopeRunResult): number {
  return result.result.kind === "completed" ? result.result.enqueued.length : 0;
}

function perScopeResults(outcome: PollRunOutcome): readonly PerScopeRunResult[] {
  if (outcome.kind !== "completed-per-scope") {
    throw new Error(`expected completed-per-scope, got ${outcome.kind}`);
  }
  return outcome.scopes;
}

describe("Poller — SS-13.2/13.3 per-scope enumeration", () => {
  it("polls each scope's scoped read, filling that container's params, keeping a snapshot per scope", async () => {
    const h = harness(perScopePlan());
    h.reader.setFullFetch(RULE_ID, [{ records: [rec("a1"), rec("a2")] }], SCOPE_A);
    h.reader.setFullFetch(RULE_ID, [{ records: [rec("b1")] }], SCOPE_B);

    const outcome = await h.poller.pollOnce(RULE_ID);

    // SS-13.2 — one loop iteration per resolved scope, each addressed by its scope.
    expect(h.reader.scopeCalls.map((call) => call.scopeLinkId).sort()).toStrictEqual([
      SCOPE_A,
      SCOPE_B,
    ]);
    // Every scope's records enqueued (3 total across the two containers).
    expect(pending(h.queue)).toHaveLength(3);
    // SS-13.3 — each scope keeps its OWN snapshot, keyed by its ScopeLink id.
    expect(h.state.stateOf(RULE_ID, SCOPE_A)?.entries.size).toBe(2);
    expect(h.state.stateOf(RULE_ID, SCOPE_B)?.entries.size).toBe(1);
    // The cross-scope (rule-level) bucket is untouched in per-scope mode.
    expect(h.state.stateOf(RULE_ID)).toBeUndefined();

    const results = perScopeResults(outcome);
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.result.kind === "completed")).toBe(true);
  });

  it("SS-13.3 per-scope-complete-fetch abort isolation: one scope's partial fetch aborts ONLY that scope", async () => {
    const h = harness(perScopePlan());
    // Scope A: a page fails → abort A (SP-4 per scope), never mass-delete, no advance.
    h.reader.setFullFetch(
      RULE_ID,
      [{ records: [rec("a1")] }, { fail: "page 2 timed out" }],
      SCOPE_A,
    );
    // Scope B: a clean complete fetch → advances normally.
    h.reader.setFullFetch(RULE_ID, [{ records: [rec("b1"), rec("b2")] }], SCOPE_B);
    // Seed A a prior snapshot so we can prove it is NOT touched by the aborted run.
    h.state.seedSnapshot(RULE_ID, new Map([["a-old", "hash-old"]]), SCOPE_A);

    const outcome = await h.poller.pollOnce(RULE_ID);

    const results = perScopeResults(outcome);
    const a = results.find((r) => r.scopeLinkId === SCOPE_A);
    const b = results.find((r) => r.scopeLinkId === SCOPE_B);
    expect(a?.result.kind).toBe("aborted");
    expect(b?.result.kind).toBe("completed");
    // A's prior snapshot is preserved (never mass-deleted, never advanced).
    expect(h.state.stateOf(RULE_ID, SCOPE_A)?.entries).toStrictEqual(
      new Map([["a-old", "hash-old"]]),
    );
    expect(h.state.stateOf(RULE_ID, SCOPE_A)?.advanceCount).toBe(0);
    // B advanced independently — the abort did not stop it.
    expect(h.state.stateOf(RULE_ID, SCOPE_B)?.entries.size).toBe(2);
    expect(h.state.stateOf(RULE_ID, SCOPE_B)?.advanceCount).toBe(1);
    // Only B's records were enqueued; A enqueued nothing (aborted before advance).
    expect(pending(h.queue)).toHaveLength(2);
  });

  it("SS-13.3 per-scope cursor isolation (delta): advancing one scope's cursor never touches another's", async () => {
    const h = harness(perScopePlan({ mode: "delta" }));
    h.state.seedCursor(RULE_ID, "a-c0", SCOPE_A);
    h.state.seedCursor(RULE_ID, "b-c0", SCOPE_B);
    h.reader.setDelta(RULE_ID, [{ records: [rec("a1")], nextCursor: "a-c1" }], SCOPE_A);
    h.reader.setDelta(RULE_ID, [{ records: [rec("b1")], nextCursor: "b-c1" }], SCOPE_B);

    await h.poller.pollOnce(RULE_ID);

    // Each scope advanced its OWN cursor; neither clobbered the other.
    expect(h.state.stateOf(RULE_ID, SCOPE_A)?.cursor).toBe("a-c1");
    expect(h.state.stateOf(RULE_ID, SCOPE_B)?.cursor).toBe("b-c1");
  });

  it("SS-13.3 per-scope write-failure isolation: a scope whose advance throws does not stop the others", async () => {
    const h = harness(perScopePlan());
    h.reader.setFullFetch(RULE_ID, [{ records: [rec("a1")] }], SCOPE_A);
    h.reader.setFullFetch(RULE_ID, [{ records: [rec("b1")] }], SCOPE_B);
    // Inject a crash on scope A's advance ONLY (per-scope isolation, not the whole run).
    h.state.throwOnNextAdvance(RULE_ID, SCOPE_A);

    const outcome = await h.poller.pollOnce(RULE_ID);

    const results = perScopeResults(outcome);
    expect(results.find((r) => r.scopeLinkId === SCOPE_A)?.result.kind).toBe("aborted");
    expect(results.find((r) => r.scopeLinkId === SCOPE_B)?.result.kind).toBe("completed");
    // A did not advance (crash-before-advance); B advanced normally.
    expect(h.state.stateOf(RULE_ID, SCOPE_A)?.advanceCount ?? 0).toBe(0);
    expect(h.state.stateOf(RULE_ID, SCOPE_B)?.advanceCount).toBe(1);
  });

  it("SS-13 fail-loud: an unresolvable scope is PARKED, never polled with a guessed container", async () => {
    const h = harness(
      perScopePlan({
        scopes: [scope(SCOPE_A, { owner: "alice", repo: "phoenix" })],
        unresolvedScopes: [{ container: "repo-99", reason: "no ScopeLink" }],
      }),
    );
    h.reader.setFullFetch(RULE_ID, [{ records: [rec("a1")] }], SCOPE_A);

    const outcome = await h.poller.pollOnce(RULE_ID);

    const results = perScopeResults(outcome);
    const parked = results.find((r) => r.result.kind === "parked");
    expect(parked?.result.kind).toBe("parked");
    // The unresolvable container was NEVER read (never a guessed container).
    expect(h.reader.scopeCalls.some((call) => call.scopeLinkId === "repo-99")).toBe(false);
    // The resolvable scope still polled and completed.
    expect(results.find((r) => r.scopeLinkId === SCOPE_A)?.result.kind).toBe("completed");
  });
});

/**
 * SP-1 regression — the per-scope fan-out must stamp the **rule's own** `lastRunAt`.
 *
 * Found by the live scoped-sync capstone: every per-scope `advance` carries a `scopeKey`,
 * so it writes only `poll_scope_state` and `SyncRule.lastRunAt` stayed NULL forever. The
 * Scheduler's SP-1 gate reads exactly that field and treats NULL as "never polled → due
 * now", so a per-scope rule was re-polled on **every tick** (1/s) no matter its interval —
 * flooding the source and racing the deterministic poll trigger, whose own run then found
 * the change already consumed and reported `enqueuedCount: 0`.
 */
describe("Poller — SP-1 rule-level lastRunAt after a per-scope fan-out", () => {
  it("stamps the rule's own lastRunAt, so the Scheduler sees the rule as polled", async () => {
    const h = harness(perScopePlan());
    h.reader.setFullFetch(RULE_ID, [{ records: [rec("a1")] }], SCOPE_A);
    h.reader.setFullFetch(RULE_ID, [{ records: [rec("b1")] }], SCOPE_B);

    await h.poller.pollOnce(RULE_ID);

    // Without this the rule's `lastRunAt` is NULL and `decidePoll` returns `poll` forever.
    expect(h.state.ruleLastRunAt(RULE_ID)).toStrictEqual(NOW);
    // …and it is a RULE-level marker only: no cross-scope snapshot/cursor bucket appears.
    expect(h.state.stateOf(RULE_ID)).toBeUndefined();
  });

  it("does NOT stamp it when EVERY scope aborted — a run with no progress stays stuck (SP-4)", async () => {
    const h = harness(perScopePlan());
    h.reader.setFullFetch(RULE_ID, [{ fail: "page 0 exploded" }], SCOPE_A);
    h.reader.setFullFetch(RULE_ID, [{ fail: "page 0 exploded" }], SCOPE_B);

    const outcome = await h.poller.pollOnce(RULE_ID);

    expect(perScopeResults(outcome).every((r) => r.result.kind === "aborted")).toBe(true);
    // Lag keeps growing → the stuck-poller alert still fires for a persistently failing source.
    expect(h.state.ruleLastRunAt(RULE_ID)).toBeUndefined();
  });

  it("stamps it when only SOME scopes aborted — one scope's failure never freezes the rule's schedule", async () => {
    const h = harness(perScopePlan());
    h.reader.setFullFetch(RULE_ID, [{ fail: "page 0 exploded" }], SCOPE_A);
    h.reader.setFullFetch(RULE_ID, [{ records: [rec("b1")] }], SCOPE_B);

    await h.poller.pollOnce(RULE_ID);

    expect(h.state.ruleLastRunAt(RULE_ID)).toStrictEqual(NOW);
  });
});

/**
 * Two concurrent cycles for ONE rule are unsound: both load the same prior snapshot, and
 * whichever commits last overwrites the other's advance — dropping a just-detected record
 * from the baseline and reporting zero changes for a change that did happen. The second
 * caller is therefore SERIALIZED behind the first, not refused: its cycle still runs and
 * still reports its own true result.
 */
describe("Poller — one poll cycle per rule at a time", () => {
  it("serializes a second concurrent cycle instead of racing it", async () => {
    const h = harness(perScopePlan());
    h.reader.setFullFetch(RULE_ID, [{ records: [rec("a1")] }], SCOPE_A);
    h.reader.setFullFetch(RULE_ID, [{ records: [rec("b1")] }], SCOPE_B);

    const [first, second] = await Promise.all([
      h.poller.pollOnce(RULE_ID),
      h.poller.pollOnce(RULE_ID),
    ]);

    // Both cycles really ran — neither was dropped or refused.
    expect(first.kind).toBe("completed-per-scope");
    expect(second.kind).toBe("completed-per-scope");
    // The first consumed both records; the second, running AFTER it, correctly finds
    // nothing new. Overlapped, both would have diffed the same empty baseline and
    // double-enqueued, and the later advance would have clobbered the earlier one.
    expect(pending(h.queue)).toHaveLength(2);
    expect(perScopeResults(second).every((r) => enqueuedCountOf(r) === 0)).toBe(true);
  });

  it("a failing cycle never cancels the one queued behind it", async () => {
    const h = harness(perScopePlan());
    h.reader.setFullFetch(RULE_ID, [{ records: [rec("a1")] }], SCOPE_A);
    h.reader.setFullFetch(RULE_ID, [{ records: [rec("b1")] }], SCOPE_B);
    // The first cycle's advance throws for every scope (crash-before-advance, SP-5).
    h.state.throwOnNextAdvance();

    const [, second] = await Promise.all([h.poller.pollOnce(RULE_ID), h.poller.pollOnce(RULE_ID)]);

    // The successor still ran a full cycle of its own.
    expect(second.kind).toBe("completed-per-scope");
  });

  it("releases the slot when a cycle finishes, so a later cycle runs normally", async () => {
    const h = harness(perScopePlan());
    h.reader.setFullFetch(RULE_ID, [{ records: [rec("a1")] }], SCOPE_A);
    h.reader.setFullFetch(RULE_ID, [{ records: [rec("b1")] }], SCOPE_B);

    await h.poller.pollOnce(RULE_ID);
    const second = await h.poller.pollOnce(RULE_ID);

    expect(second.kind).toBe("completed-per-scope");
  });
});
