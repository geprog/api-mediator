import type { RecordLink, SourceScopeRef } from "@mediator/domain";
import type { JsonRecord } from "@mediator/transform";
import { beforeEach, describe, expect, it } from "vitest";

import { FakeOrderingQueue } from "../fake-ordering-queue.js";
import { FakeRecordLinkStore } from "../identity-resolution/fakes.js";
import { QueueKeyResolver } from "../ordering/queue-key-resolver.js";
import { contentHashOfRecord } from "./content-hash.js";
import { FakePollPlanResolver, FakePollStateStore, FakeSourceReader } from "./fakes.js";
import { Poller } from "./poller.js";
import type { CrossScopePollPlan, ObservedRecord, PollPlan } from "./types.js";

/**
 * Unit tests for the **Poller** (SP-2..SP-5) against a fake source (canned pages +
 * injectable failures), a fake queue, a fake clock, and the atomic-advance fake state
 * store. The two crash-safety invariants are the sacred tests: **SP-4** (a truncated
 * fetch must never delete real records) and **SP-5** (a crash must never lose a change).
 */

const RULE_ID = "rule-1";
const SOURCE_APP = "app-source";
const TARGET_APP = "app-target";
const PAIR = "pair::customers";
const NOW = new Date("2026-07-13T12:00:00.000Z");

// The cross-scope (SS-13.1) plan these SP-2..SP-5 tests exercise — unchanged from SS-8.
function plan(overrides: Partial<CrossScopePollPlan> = {}): CrossScopePollPlan {
  return {
    ruleId: RULE_ID,
    mappingId: "mapping-1",
    sourceAppId: SOURCE_APP,
    targetAppId: TARGET_APP,
    resourcePairRef: PAIR,
    scopeMode: "cross-scope",
    mode: "full-fetch",
    identitySourcePath: "email",
    cursor: undefined,
    ...overrides,
  };
}

function rec(nativeId: string, body: JsonRecord): ObservedRecord {
  return { nativeId, record: { id: nativeId, ...body } };
}

interface Harness {
  poller: Poller;
  reader: FakeSourceReader;
  resolver: FakePollPlanResolver;
  state: FakePollStateStore;
  queue: FakeOrderingQueue;
  links: FakeRecordLinkStore;
}

function harness(p: PollPlan = plan()): Harness {
  const reader = new FakeSourceReader();
  const resolver = new FakePollPlanResolver();
  resolver.set(p.ruleId, { pollable: true, plan: p });
  const state = new FakePollStateStore();
  const queue = new FakeOrderingQueue();
  const links = new FakeRecordLinkStore();
  const queueKeys = new QueueKeyResolver(links);
  const poller = new Poller(reader, resolver, state, queue, queueKeys, { now: () => NOW });
  return { poller, reader, resolver, state, queue, links };
}

/** The pending enqueued payloads, in enqueue order. */
function pending(queue: FakeOrderingQueue): Record<string, unknown>[] {
  return queue.listByStatus("pending").map((entry) => entry.payload);
}

function activeLink(sourceNativeId: string): RecordLink {
  return {
    id: `link-${sourceNativeId}`,
    appAId: SOURCE_APP,
    appANativeId: sourceNativeId,
    appBId: TARGET_APP,
    appBNativeId: `t-${sourceNativeId}`,
    resourcePairRef: PAIR,
    establishedBy: "identity-match",
    status: "active",
    establishingQueueKey: { kind: "identity-value", value: "x@x.com" },
    createdAt: NOW,
    tombstonedAt: null,
  };
}

describe("Poller — SP-2 delta vs full-fetch, paged to exhaustion, snapshot diff", () => {
  it("SP-2.5 backstop: a not-pollable rule (unconfirmed ref) polls nothing and does not advance", async () => {
    const h = harness();
    h.resolver.set(RULE_ID, { pollable: false, reason: "unconfirmed-poll-operation" });

    const outcome = await h.poller.pollOnce(RULE_ID);

    expect(outcome).toStrictEqual({ kind: "skipped", reason: "unconfirmed-poll-operation" });
    expect(pending(h.queue)).toHaveLength(0);
    expect(h.state.stateOf(RULE_ID)).toBeUndefined();
  });

  it("full-fetch pages to exhaustion (3 pages) and enqueues every record", async () => {
    const h = harness();
    h.reader.setFullFetch(RULE_ID, [
      { records: [rec("1", { v: 1 }), rec("2", { v: 1 })] },
      { records: [rec("3", { v: 1 })] },
      { records: [rec("4", { v: 1 })] },
    ]);

    const outcome = await h.poller.pollOnce(RULE_ID);

    expect(outcome.kind).toBe("completed");
    expect(pending(h.queue)).toHaveLength(4);
    // The snapshot now holds all four records' hashes.
    expect(h.state.stateOf(RULE_ID)?.entries.size).toBe(4);
    expect(h.state.stateOf(RULE_ID)?.advanceCount).toBe(1);
  });

  it("SP-2.3: a record unchanged since the snapshot is NOT re-processed; a changed hash is", async () => {
    const h = harness();
    const unchanged = rec("1", { v: 1 });
    const changed = rec("2", { v: 2 });
    // Seed the snapshot with the prior hashes (record 2 had v:1 before).
    h.state.seedSnapshot(
      RULE_ID,
      new Map([
        ["1", contentHashOfRecord(unchanged.record)],
        ["2", contentHashOfRecord(rec("2", { v: 1 }).record)],
      ]),
    );
    h.reader.setFullFetch(RULE_ID, [{ records: [unchanged, changed] }]);

    await h.poller.pollOnce(RULE_ID);

    const payloads = pending(h.queue);
    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.sourceNativeId).toBe("2");
    expect(payloads[0]?.changeKind).toBe("update");
  });

  it("delta mode: enqueues reported records and advances the cursor (no snapshot)", async () => {
    const h = harness(plan({ mode: "delta", cursor: "c0" }));
    h.reader.setDelta(RULE_ID, [
      { records: [rec("1", { v: 1 }), rec("2", { v: 1 })], nextCursor: "c1" },
    ]);

    const outcome = await h.poller.pollOnce(RULE_ID);

    expect(outcome).toMatchObject({ kind: "completed", mode: "delta" });
    expect(pending(h.queue)).toHaveLength(2);
    expect(h.state.stateOf(RULE_ID)?.cursor).toBe("c1");
    // Delta rules keep no snapshot.
    expect(h.state.stateOf(RULE_ID)?.snapshotRef).toBeUndefined();
  });
});

describe("Poller — SP-3 change classification", () => {
  it("classifies create (new, no link) vs update (changed hash) vs update (existing link)", async () => {
    const h = harness();
    // Record 2 already known to the snapshot (changed) and record 3 has an active link.
    h.state.seedSnapshot(RULE_ID, new Map([["2", contentHashOfRecord(rec("2", { v: 1 }).record)]]));
    await h.links.insert(activeLink("3"));
    h.reader.setFullFetch(RULE_ID, [
      { records: [rec("1", { v: 1 }), rec("2", { v: 2 }), rec("3", { v: 1 })] },
    ]);

    await h.poller.pollOnce(RULE_ID);

    const byId = new Map(pending(h.queue).map((p) => [p.sourceNativeId, p.changeKind]));
    expect(byId.get("1")).toBe("create"); // new to snapshot, no link
    expect(byId.get("2")).toBe("update"); // content hash changed
    expect(byId.get("3")).toBe("update"); // existing active link
  });

  it("SP-3.4 full-fetch absence: a snapshot record absent from a complete fetch is a delete", async () => {
    const h = harness();
    h.state.seedSnapshot(
      RULE_ID,
      new Map([
        ["1", contentHashOfRecord(rec("1", { v: 1 }).record)],
        ["gone", contentHashOfRecord(rec("gone", { v: 1 }).record)],
      ]),
    );
    // Complete fetch returns only record 1 — "gone" is absent.
    h.reader.setFullFetch(RULE_ID, [{ records: [rec("1", { v: 1 })] }]);

    await h.poller.pollOnce(RULE_ID);

    const payloads = pending(h.queue);
    // Record 1 unchanged (not re-processed); only the deletion of "gone" is enqueued.
    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toMatchObject({ sourceNativeId: "gone", changeKind: "delete" });
    // A delete carries no observedRecord (the record is gone).
    expect(payloads[0]?.observedRecord).toBeUndefined();
  });

  it("SP-3.2 delta deletion only when reported; SP-3.3 no fabrication when none reported", async () => {
    const reported = harness(plan({ mode: "delta", cursor: "c0" }));
    reported.reader.setDelta(RULE_ID, [{ deletedNativeIds: ["9"], nextCursor: "c1" }]);
    await reported.poller.pollOnce(RULE_ID);
    expect(pending(reported.queue)).toMatchObject([{ sourceNativeId: "9", changeKind: "delete" }]);

    // No deletions reported (unconfirmed deltaDeletionRef → reader yields none) → nothing fabricated.
    const none = harness(plan({ mode: "delta", cursor: "c0" }));
    none.reader.setDelta(RULE_ID, [{ records: [rec("1", { v: 1 })], nextCursor: "c1" }]);
    await none.poller.pollOnce(RULE_ID);
    expect(pending(none.queue).every((p) => p.changeKind !== "delete")).toBe(true);
  });
});

describe("Poller — SP-4 abort-on-partial (SACRED): a truncated fetch never deletes", () => {
  it("any page failing aborts the run: no enqueue, no advance, no false deletion", async () => {
    const h = harness();
    // Two records are in the last snapshot — a naive truncated-fetch diff would DELETE them.
    h.state.seedSnapshot(
      RULE_ID,
      new Map([
        ["A", contentHashOfRecord(rec("A", { v: 1 }).record)],
        ["B", contentHashOfRecord(rec("B", { v: 1 }).record)],
      ]),
    );
    const before = h.state.stateOf(RULE_ID);
    // Page 1 returns a record, page 2 FAILS (timeout/truncation) before exhaustion.
    h.reader.setFullFetch(RULE_ID, [
      { records: [rec("A", { v: 2 })] },
      { fail: "page 2 timed out" },
    ]);

    const outcome = await h.poller.pollOnce(RULE_ID);

    expect(outcome).toStrictEqual({ kind: "aborted", reason: "page 2 timed out" });
    // No change is enqueued at all — not even the changed record from page 1.
    expect(pending(h.queue)).toHaveLength(0);
    // The cursor/snapshot/lastRunAt did NOT advance (still exactly the seeded state).
    expect(h.state.stateOf(RULE_ID)?.advanceCount).toBe(0);
    expect(h.state.stateOf(RULE_ID)?.entries).toStrictEqual(before?.entries);
    // Absolutely NO deletion was emitted for the "missing" A/B.
    expect(pending(h.queue).some((p) => p.changeKind === "delete")).toBe(false);
  });

  it("a failed delta call aborts without advancing the cursor", async () => {
    const h = harness(plan({ mode: "delta", cursor: "c0" }));
    h.state.seedCursor(RULE_ID, "c0");
    h.reader.setDelta(RULE_ID, [{ fail: "delta call 5xx" }]);

    const outcome = await h.poller.pollOnce(RULE_ID);

    expect(outcome).toStrictEqual({ kind: "aborted", reason: "delta call 5xx" });
    expect(pending(h.queue)).toHaveLength(0);
    expect(h.state.stateOf(RULE_ID)?.cursor).toBe("c0"); // unchanged
  });
});

describe("Poller — SP-5 enqueue-then-advance (SACRED): a crash never loses a change", () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
    h.reader.setFullFetch(RULE_ID, [
      { records: [rec("1", { v: 1 }), rec("2", { v: 1 }), rec("3", { v: 1 })] },
    ]);
  });

  it("all N are durably enqueued before the cursor/snapshot advance", async () => {
    await h.poller.pollOnce(RULE_ID);
    // All 3 enqueued AND the advance ran exactly once — enqueue precedes advance.
    expect(pending(h.queue)).toHaveLength(3);
    expect(h.state.stateOf(RULE_ID)?.advanceCount).toBe(1);
    expect(h.state.stateOf(RULE_ID)?.entries.size).toBe(3);
  });

  it("crash BEFORE the advance: changes are already enqueued, cursor NOT advanced; next poll re-detects", async () => {
    // Simulate a crash between enqueue and advance.
    h.state.throwOnNextAdvance();
    await expect(h.poller.pollOnce(RULE_ID)).rejects.toThrow(/crash before advance/);

    // The N changes ARE durably enqueued (they precede the advance)...
    expect(pending(h.queue)).toHaveLength(3);
    // ...but the advance did NOT happen (no snapshot written, no lastRunAt) — the store
    // has no advanced state for the rule at all.
    expect(h.state.stateOf(RULE_ID)?.advanceCount ?? 0).toBe(0);
    expect(h.state.stateOf(RULE_ID)?.snapshotRef).toBeUndefined();

    // Next poll re-detects the SAME changes (snapshot still empty) and re-enqueues them —
    // duplicates the queue absorbs downstream via echo/idempotency — then advances.
    const outcome = await h.poller.pollOnce(RULE_ID);
    expect(outcome.kind).toBe("completed");
    expect(pending(h.queue)).toHaveLength(6); // 3 original (durable) + 3 re-detected
    expect(h.state.stateOf(RULE_ID)?.advanceCount).toBe(1);
  });

  it("processing never gates advancement: the run advances while every entry is still pending", async () => {
    await h.poller.pollOnce(RULE_ID);
    // Nothing processed the queue — all 3 remain pending — yet the cursor advanced.
    expect(h.queue.listByStatus("pending")).toHaveLength(3);
    expect(h.queue.listByStatus("done")).toHaveLength(0);
    expect(h.state.stateOf(RULE_ID)?.advanceCount).toBe(1);
  });

  it("the poll-trigger hook runs exactly one synchronous cycle (detect → enqueue → advance)", async () => {
    const outcome = await h.poller.pollOnce(RULE_ID);
    expect(outcome).toMatchObject({ kind: "completed", mode: "full-fetch" });
    if (outcome.kind === "completed") {
      expect(outcome.enqueued).toHaveLength(3);
      expect(outcome.enqueued.map((c) => c.changeKind)).toStrictEqual([
        "create",
        "create",
        "create",
      ]);
    }
  });

  it("a no-change poll still advances (empty run)", async () => {
    const empty = harness();
    empty.reader.setFullFetch(RULE_ID, [{ records: [] }]);
    const outcome = await empty.poller.pollOnce(RULE_ID);
    expect(outcome).toMatchObject({ kind: "completed", enqueued: [] });
    expect(empty.state.stateOf(RULE_ID)?.advanceCount).toBe(1);
  });
});

describe("Poller — SS-8.2 captured scope (cross-scope read, record-carried scope, single cursor)", () => {
  // Gitea `Issue` carries its container as `repository.owner` + `repository.name`
  // (scenario-1) — the source resource's confirmed `sourceScopeRef`.
  const GITEA_SCOPE_REF: SourceScopeRef = {
    components: [
      { key: "owner", fieldPath: "repository.owner" },
      { key: "name", fieldPath: "repository.name" },
    ],
    confirmedBy: "operator-1",
    confirmedAt: NOW,
  };

  function issue(nativeId: string, owner: string, name: string): ObservedRecord {
    return { nativeId, record: { id: nativeId, title: "t", repository: { owner, name } } };
  }

  it("a confirmed sourceScopeRef captures each record's scope onto its DetectedChange (Gitea {owner,name})", async () => {
    const h = harness(plan({ sourceScopeRef: GITEA_SCOPE_REF }));
    // ONE cross-scope collection read returns issues across TWO repos — the record
    // self-carries its scope; the Poller needs only the single collection read.
    h.reader.setFullFetch(RULE_ID, [
      { records: [issue("1", "alice", "phoenix"), issue("2", "bob", "atlas")] },
    ]);

    await h.poller.pollOnce(RULE_ID);

    const byId = new Map(pending(h.queue).map((p) => [p.sourceNativeId, p.capturedScope]));
    expect(byId.get("1")).toStrictEqual({ owner: "alice", name: "phoenix" });
    expect(byId.get("2")).toStrictEqual({ owner: "bob", name: "atlas" });
  });

  it("keeps its single per-rule cursor/snapshot unchanged — no per-scope state (SS-8.2)", async () => {
    const h = harness(plan({ mode: "delta", cursor: "c0", sourceScopeRef: GITEA_SCOPE_REF }));
    // A delta over the cross-scope read: records from different repos, ONE `since`/`before`
    // cursor advance — not one per repo.
    h.reader.setDelta(RULE_ID, [
      { records: [issue("1", "alice", "phoenix"), issue("2", "bob", "atlas")], nextCursor: "c1" },
    ]);

    await h.poller.pollOnce(RULE_ID);

    // Exactly one advance of the single cursor, regardless of how many scopes appeared.
    expect(h.state.stateOf(RULE_ID)?.cursor).toBe("c1");
    expect(h.state.stateOf(RULE_ID)?.advanceCount).toBe(1);
    // Delta keeps no snapshot — and there is no per-scope snapshot either.
    expect(h.state.stateOf(RULE_ID)?.snapshotRef).toBeUndefined();
    // Both records still carried their captured scope through the single-cursor poll.
    expect(pending(h.queue).map((p) => p.capturedScope)).toStrictEqual([
      { owner: "alice", name: "phoenix" },
      { owner: "bob", name: "atlas" },
    ]);
  });

  it("no sourceScopeRef → no capturedScope (a constant / non-scoped rule is unaffected)", async () => {
    const h = harness(plan()); // no sourceScopeRef on the plan
    h.reader.setFullFetch(RULE_ID, [{ records: [issue("1", "alice", "phoenix")] }]);

    await h.poller.pollOnce(RULE_ID);

    const payloads = pending(h.queue);
    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.capturedScope).toBeUndefined();
    expect("capturedScope" in (payloads[0] ?? {})).toBe(false);
  });

  it("a record missing one component captures only the present ones (SS-7 omission → fail-loud downstream)", async () => {
    const h = harness(plan({ sourceScopeRef: GITEA_SCOPE_REF }));
    // The second issue carries owner but no repository.name.
    h.reader.setFullFetch(RULE_ID, [
      {
        records: [
          issue("1", "alice", "phoenix"),
          { nativeId: "2", record: { id: "2", repository: { owner: "bob" } } },
        ],
      },
    ]);

    await h.poller.pollOnce(RULE_ID);

    const byId = new Map(pending(h.queue).map((p) => [p.sourceNativeId, p.capturedScope]));
    expect(byId.get("1")).toStrictEqual({ owner: "alice", name: "phoenix" });
    // Only the present component is captured; `name` is omitted (never null/placeholder).
    expect(byId.get("2")).toStrictEqual({ owner: "bob" });
  });

  it("a delete carries no capturedScope (the source record is gone)", async () => {
    const h = harness(plan({ sourceScopeRef: GITEA_SCOPE_REF }));
    h.state.seedSnapshot(
      RULE_ID,
      new Map([["gone", contentHashOfRecord(issue("gone", "a", "b").record)]]),
    );
    h.reader.setFullFetch(RULE_ID, [{ records: [] }]);

    await h.poller.pollOnce(RULE_ID);

    const payloads = pending(h.queue);
    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toMatchObject({ sourceNativeId: "gone", changeKind: "delete" });
    expect(payloads[0]?.capturedScope).toBeUndefined();
  });
});
