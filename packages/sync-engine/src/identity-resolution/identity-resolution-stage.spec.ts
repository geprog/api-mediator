import type { FieldMapping, RecordLink } from "@mediator/domain";
import type { JsonRecord } from "@mediator/transform";
import { beforeEach, describe, expect, it } from "vitest";

import {
  FakeIdentityResolutionMetrics,
  FakeRecordLinkStore,
  FakeSyncEventRecorder,
  FakeSyncFieldStateStore,
  FakeTargetIdentityLookup,
  UniqueActiveLinkViolation,
} from "./fakes.js";
import { IdentityMatchSeeder } from "./field-state-seeder.js";
import {
  IdentityResolutionStage,
  IncompleteTargetFetchError,
} from "./identity-resolution-stage.js";
import type { DetectedChange, MatchedTargetRecord, ResolutionContext } from "./types.js";

/**
 * Unit tests for the Identity Resolution stage (RL-1..RL-5), against the fakes that
 * mirror the real repos' unique-active-link + tombstone-not-delete semantics. The
 * RL-4 ambiguous-match hard guard has its own `describe` and the explicit
 * two-candidate zero-side-effects assertion required by the requirement.
 */

const T0 = new Date("2026-07-13T00:00:00.000Z");
const PAIR = "pair-1";

const identityMapping: FieldMapping = {
  id: "fm-email",
  mappingId: "map-1",
  sourcePath: "email",
  targetPath: "email",
  transform: "rename",
  isIdentityKey: true,
};

const nameMapping: FieldMapping = {
  id: "fm-name",
  mappingId: "map-1",
  sourcePath: "name",
  targetPath: "name",
  transform: "rename",
};

interface Harness {
  readonly stage: IdentityResolutionStage;
  readonly links: FakeRecordLinkStore;
  readonly fieldState: FakeSyncFieldStateStore;
  readonly lookup: FakeTargetIdentityLookup;
  readonly events: FakeSyncEventRecorder;
  readonly metrics: FakeIdentityResolutionMetrics;
}

function makeHarness(): Harness {
  const links = new FakeRecordLinkStore();
  const fieldState = new FakeSyncFieldStateStore();
  const lookup = new FakeTargetIdentityLookup();
  const events = new FakeSyncEventRecorder();
  const metrics = new FakeIdentityResolutionMetrics();
  let counter = 0;
  const newId = (): string => `id-${String(++counter)}`;
  const clock = (): Date => T0;
  const seeder = new IdentityMatchSeeder(fieldState, { clock, newId });
  const stage = new IdentityResolutionStage(
    { links, seeder, lookup, events },
    { metrics, clock, newId, actor: "system" },
  );
  return { stage, links, fieldState, lookup, events, metrics };
}

function makeContext(overrides: Partial<ResolutionContext> = {}): ResolutionContext {
  return {
    appAId: "appA",
    appBId: "appB",
    identitySourcePath: "email",
    identityTargetPath: "email",
    targetLookup: {
      kind: "filtered-read",
      binding: { collectionReadOperationId: "listCustomers", nativeIdPath: "id" },
      lookupParamRef: "emailFilter",
    },
    hasApprovedCreateOperation: true,
    fieldMappings: [identityMapping, nameMapping],
    ...overrides,
  };
}

function makeChange(overrides: Partial<DetectedChange> = {}): DetectedChange {
  return {
    ruleId: "rule-1",
    mappingId: "map-1",
    sourceAppId: "appA",
    targetAppId: "appB",
    resourcePairRef: PAIR,
    sourceNativeId: "srcN1",
    changeKind: "create",
    observedRecord: { id: "srcN1", email: "a@x.com", name: "Alice" },
    ...overrides,
  };
}

function target(nativeId: string, record: JsonRecord): MatchedTargetRecord {
  return { nativeId, record };
}

function activeLink(overrides: Partial<RecordLink> = {}): RecordLink {
  return {
    id: "existing-link",
    appAId: "appA",
    appANativeId: "srcN1",
    appBId: "appB",
    appBNativeId: "tgtN1",
    resourcePairRef: PAIR,
    establishedBy: "manual",
    status: "active",
    establishingQueueKey: { kind: "identity-value", value: "a@x.com" },
    createdAt: T0,
    tombstonedAt: null,
    ...overrides,
  };
}

describe("RL-1 — resolve the RecordLink first", () => {
  it("uses an existing active link and establishes no new one (no lookup)", async () => {
    const h = makeHarness();
    await h.links.insert(activeLink());

    const outcome = await h.stage.resolve(makeChange({ changeKind: "update" }), makeContext());

    expect(outcome.kind).toBe("resolved");
    if (outcome.kind !== "resolved") return;
    expect(outcome.link.id).toBe("existing-link");
    expect(outcome.establishedByIdentityMatch).toBe(false);
    // Resolved-first: the identity lookup is never consulted when a link already exists.
    expect(h.lookup.filteredReadCalls).toHaveLength(0);
    expect(h.lookup.fetchAllCalls).toHaveLength(0);
    expect(h.links.all()).toHaveLength(1);
  });

  it("establishes a new link by identity match for a never-seen record", async () => {
    const h = makeHarness();
    h.lookup.setTarget("appB", {
      identityFieldPath: "email",
      records: [target("tgtN9", { id: "tgtN9", email: "a@x.com", name: "Alice" })],
    });

    const outcome = await h.stage.resolve(makeChange(), makeContext());

    expect(outcome.kind).toBe("resolved");
    if (outcome.kind !== "resolved") return;
    expect(outcome.establishedByIdentityMatch).toBe(true);
    expect(outcome.link.establishedBy).toBe("identity-match");
    expect(h.links.all()).toHaveLength(1);
  });

  it("carries a delete's active link through as a delete (for downstream tombstoning)", async () => {
    const h = makeHarness();
    await h.links.insert(activeLink());

    const outcome = await h.stage.resolve(
      makeChange({ changeKind: "delete", observedRecord: undefined }),
      makeContext(),
    );

    expect(outcome.kind).toBe("resolved");
    if (outcome.kind !== "resolved") return;
    expect(outcome.effectiveChangeKind).toBe("delete");
  });
});

describe("RL-2 — create-propagation", () => {
  it("writes a create-propagation link retaining the pre-link identity queue key", async () => {
    const h = makeHarness();
    // No target match → straight create.
    const outcome = await h.stage.resolve(makeChange(), makeContext());
    expect(outcome.kind).toBe("straight-create");
    expect(h.metrics.noMatch).toEqual(["rule-1"]);
    expect(h.links.all()).toHaveLength(0); // no link until the create response arrives

    // SP creates via OC, captures the new native id, then RL-2 writes the link.
    const link = await h.stage.recordCreatePropagation(makeChange(), makeContext(), "tgtNEW");

    expect(link.establishedBy).toBe("create-propagation");
    expect(link.status).toBe("active");
    expect(link.appANativeId).toBe("srcN1"); // source is side A
    expect(link.appBNativeId).toBe("tgtNEW"); // captured target id on side B
    // OQ-4: retains the pre-link queue key (the identity value the record was queued under).
    expect(link.establishingQueueKey).toEqual({ kind: "identity-value", value: "a@x.com" });
    expect(h.links.all()).toHaveLength(1);
  });

  it("records skipped-policy (no create, no link) when there is no approved create op", async () => {
    const h = makeHarness();
    const context = makeContext({ hasApprovedCreateOperation: false });

    const outcome = await h.stage.resolve(makeChange(), context);

    expect(outcome.kind).toBe("skipped-policy");
    if (outcome.kind !== "skipped-policy") return;
    expect(outcome.reason).toBe("no-create-op");
    // Visible, never silent: exactly one skipped-policy event, and NO link / NO create.
    expect(h.events.all()).toHaveLength(1);
    expect(h.events.all()[0]?.status).toBe("skipped-policy");
    expect(h.links.all()).toHaveLength(0);
  });
});

describe("RL-3 — identity-key match execution", () => {
  it("prefers a filtered read and passes the identity value AS-IS (no transform)", async () => {
    const h = makeHarness();
    // A value that a normalizing transform (e.g. lowercasing) would alter — proving
    // the raw observed value is used verbatim.
    const change = makeChange({ observedRecord: { id: "srcN1", email: "A@X.COM", name: "Alice" } });
    h.lookup.setTarget("appB", {
      identityFieldPath: "email",
      records: [target("tgtN1", { id: "tgtN1", email: "A@X.COM", name: "Alice" })],
    });

    const outcome = await h.stage.resolve(change, makeContext());

    expect(outcome.kind).toBe("resolved");
    expect(h.lookup.filteredReadCalls).toHaveLength(1);
    expect(h.lookup.fetchAllCalls).toHaveLength(0); // filtered read preferred
    // The value reached the lookup verbatim — no transform was applied to it.
    expect(h.lookup.filteredReadCalls[0]?.value).toBe("A@X.COM");
  });

  it("falls back to fetch-and-match when there is no filter parameter", async () => {
    const h = makeHarness();
    const context = makeContext({
      targetLookup: {
        kind: "fetch-and-match",
        binding: { collectionReadOperationId: "listCustomers", nativeIdPath: "id" },
      },
    });
    h.lookup.setTarget("appB", {
      identityFieldPath: "email",
      records: [
        target("tgtOther", { id: "tgtOther", email: "b@x.com", name: "Bob" }),
        target("tgtN1", { id: "tgtN1", email: "a@x.com", name: "Alice" }),
      ],
    });

    const outcome = await h.stage.resolve(makeChange(), context);

    expect(outcome.kind).toBe("resolved");
    if (outcome.kind !== "resolved") return;
    expect(outcome.link.appBNativeId).toBe("tgtN1"); // matched in-memory by email value
    expect(h.lookup.fetchAllCalls).toHaveLength(1);
    expect(h.lookup.filteredReadCalls).toHaveLength(0);
  });

  it("single match → links, seeds SyncFieldState (agree/disagree), downgrades to update", async () => {
    const h = makeHarness();
    h.lookup.setTarget("appB", {
      identityFieldPath: "email",
      // email agrees (same value), name disagrees (Alice vs Alicia).
      records: [target("tgtN1", { id: "tgtN1", email: "a@x.com", name: "Alicia" })],
    });

    const outcome = await h.stage.resolve(makeChange(), makeContext());

    expect(outcome.kind).toBe("resolved");
    if (outcome.kind !== "resolved") return;
    expect(outcome.effectiveChangeKind).toBe("update"); // create downgraded to update
    expect(outcome.establishedByIdentityMatch).toBe(true);

    const rows = await h.fieldState.findByLink(outcome.link.id);
    // one row per side per field: A/email, A/name, B/email, B/name.
    expect(rows).toHaveLength(4);
    const emailRows = rows.filter((r) => r.fieldPath === "email");
    const nameRows = rows.filter((r) => r.fieldPath === "name");
    // email agrees → baseline present on both sides; name disagrees → no baseline.
    expect(emailRows.every((r) => r.lastSyncedHash !== undefined)).toBe(true);
    expect(nameRows.every((r) => r.lastSyncedHash === undefined)).toBe(true);
    // every row still records the observed value.
    expect(rows.every((r) => r.observedHash.length > 0)).toBe(true);
  });

  it("neither lookup path → straight create, degraded (match-first unavailable)", async () => {
    const h = makeHarness();
    const context = makeContext({ targetLookup: { kind: "none" } });

    const outcome = await h.stage.resolve(makeChange(), context);

    expect(outcome.kind).toBe("straight-create");
    if (outcome.kind !== "straight-create") return;
    expect(outcome.matchFirstAvailable).toBe(false); // the RL-3.5 degradation flag
    expect(h.lookup.filteredReadCalls).toHaveLength(0);
    expect(h.lookup.fetchAllCalls).toHaveLength(0);
    expect(h.links.all()).toHaveLength(0);
    // no-match metric is NOT emitted for the degraded path (matching never ran).
    expect(h.metrics.noMatch).toHaveLength(0);
  });

  it("fetch-and-match abort-on-partial throws (no match/no-match inferred, zero side effects)", async () => {
    const h = makeHarness();
    const context = makeContext({
      targetLookup: {
        kind: "fetch-and-match",
        binding: { collectionReadOperationId: "listCustomers", nativeIdPath: "id" },
      },
    });
    h.lookup.setTarget("appB", { identityFieldPath: "email", records: [], incomplete: true });

    await expect(h.stage.resolve(makeChange(), context)).rejects.toBeInstanceOf(
      IncompleteTargetFetchError,
    );
    expect(h.links.all()).toHaveLength(0);
    expect(h.fieldState.all()).toHaveLength(0);
    expect(h.events.all()).toHaveLength(0);
  });
});

describe("RL-4 — ambiguous identity match → manual only (THE HARD GUARD)", () => {
  it("two-candidate lookup → one failure event + ZERO RecordLink/write side effects", async () => {
    const h = makeHarness();
    // Two target records share the identity value — a non-unique / wrong identity key.
    h.lookup.setTarget("appB", {
      identityFieldPath: "email",
      records: [
        target("dup-1", { id: "dup-1", email: "a@x.com", name: "Alice" }),
        target("dup-2", { id: "dup-2", email: "a@x.com", name: "Alicia" }),
      ],
    });

    const outcome = await h.stage.resolve(makeChange(), makeContext());

    // NEVER picks one.
    expect(outcome.kind).toBe("ambiguous-failure");
    if (outcome.kind !== "ambiguous-failure") return;
    expect(new Set(outcome.candidateNativeIds)).toEqual(new Set(["dup-1", "dup-2"]));

    // Exactly one `failure` SyncEvent, carrying the candidate ids in `details`.
    const recorded = h.events.all();
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.status).toBe("failure");
    expect(recorded[0]?.details).toContain("dup-1");
    expect(recorded[0]?.details).toContain("dup-2");
    expect(recorded[0]?.id).toBe(outcome.syncEventId);

    // ZERO side effects: no RecordLink established, no SyncFieldState seeded.
    expect(h.links.all()).toHaveLength(0);
    expect(h.fieldState.all()).toHaveLength(0);

    // The ambiguous-match rate is DISTINCT from no-match: one ambiguous, zero no-match.
    expect(h.metrics.ambiguousMatch).toEqual(["rule-1"]);
    expect(h.metrics.noMatch).toHaveLength(0);
  });

  it("ambiguity persists: a later change to the same record does not self-resolve", async () => {
    const h = makeHarness();
    h.lookup.setTarget("appB", {
      identityFieldPath: "email",
      records: [
        target("dup-1", { id: "dup-1", email: "a@x.com", name: "Alice" }),
        target("dup-2", { id: "dup-2", email: "a@x.com", name: "Alicia" }),
      ],
    });

    const first = await h.stage.resolve(makeChange(), makeContext());
    expect(first.kind).toBe("ambiguous-failure");

    const second = await h.stage.resolve(makeChange({ changeKind: "update" }), makeContext());
    expect(second.kind).toBe("ambiguous-failure");

    // Still no link — ambiguity persists until a human links it (RL-5) or a dup is removed.
    expect(h.links.all()).toHaveLength(0);
    expect(h.metrics.ambiguousMatch).toEqual(["rule-1", "rule-1"]);
  });

  it("ambiguity via fetch-and-match is guarded identically", async () => {
    const h = makeHarness();
    const context = makeContext({
      targetLookup: {
        kind: "fetch-and-match",
        binding: { collectionReadOperationId: "listCustomers", nativeIdPath: "id" },
      },
    });
    h.lookup.setTarget("appB", {
      identityFieldPath: "email",
      records: [
        target("dup-1", { id: "dup-1", email: "a@x.com" }),
        target("dup-2", { id: "dup-2", email: "a@x.com" }),
      ],
    });

    const outcome = await h.stage.resolve(makeChange(), context);

    expect(outcome.kind).toBe("ambiguous-failure");
    expect(h.links.all()).toHaveLength(0);
  });
});

describe("RL-5 — manual link/unlink and tombstone lifecycle", () => {
  it("manual link with a confirmed identity value records it as the queue key", async () => {
    const h = makeHarness();
    const link = await h.stage.linkManually({
      resourcePairRef: PAIR,
      appAId: "appA",
      appANativeId: "srcN1",
      appBId: "appB",
      appBNativeId: "tgtN1",
      identityValue: "a@x.com",
    });
    expect(link.establishedBy).toBe("manual");
    expect(link.establishingQueueKey).toEqual({ kind: "identity-value", value: "a@x.com" });
    expect(h.links.all()).toHaveLength(1);
  });

  it("manual link without an identity value carries the both-native-id-queues marker", async () => {
    const h = makeHarness();
    const link = await h.stage.linkManually({
      resourcePairRef: PAIR,
      appAId: "appA",
      appANativeId: "srcN1",
      appBId: "appB",
      appBNativeId: "tgtN1",
    });
    expect(link.establishingQueueKey).toEqual({ kind: "both-native-id-queues" });
  });

  it("unlink removes/severs the link", async () => {
    const h = makeHarness();
    await h.links.insert(activeLink());
    await h.stage.unlink("existing-link");
    expect(await h.links.getById("existing-link")).toBeUndefined();
  });

  it("processed deletion tombstones (never deletes) the link, propagated-delete", async () => {
    const h = makeHarness();
    const link = activeLink();
    await h.links.insert(link);

    const tombstoned = await h.stage.processDeletion(link, "propagated-delete");

    expect(tombstoned.status).toBe("tombstoned");
    expect(tombstoned.tombstoneReason).toBe("propagated-delete");
    expect(tombstoned.tombstonedAt).toEqual(T0);
    // Not deleted: the row survives, tombstoned.
    const stored = await h.links.getById("existing-link");
    expect(stored?.status).toBe("tombstoned");
  });

  it("processed deletion tombstones observed-delete", async () => {
    const h = makeHarness();
    const link = activeLink();
    await h.links.insert(link);
    const tombstoned = await h.stage.processDeletion(link, "observed-delete");
    expect(tombstoned.tombstoneReason).toBe("observed-delete");
  });

  it("observed-delete survivor: later changes are skipped-policy (counterpart deleted)", async () => {
    const h = makeHarness();
    const link = activeLink();
    await h.links.insert(link);
    await h.stage.processDeletion(link, "observed-delete");

    // The surviving record (side B, tgtN1) polled by the counterpart direction.
    const survivorChange = makeChange({
      sourceAppId: "appB",
      targetAppId: "appA",
      sourceNativeId: "tgtN1",
      changeKind: "update",
      observedRecord: { id: "tgtN1", email: "a@x.com", name: "Alicia" },
    });

    const outcome = await h.stage.resolve(survivorChange, makeContext());

    expect(outcome.kind).toBe("skipped-policy");
    if (outcome.kind !== "skipped-policy") return;
    expect(outcome.reason).toBe("counterpart-deleted");
    expect(outcome.recordLink?.id).toBe("existing-link");
    // No new link, no create — the survivor is unmanaged.
    expect(h.links.all()).toHaveLength(1);
    expect(h.links.all()[0]?.status).toBe("tombstoned");
  });

  it("resurrection prevented: a create over a tombstoned link does not re-create", async () => {
    const h = makeHarness();
    const link = activeLink();
    await h.links.insert(link);
    await h.stage.processDeletion(link, "propagated-delete");
    // A slow poll still sees the deleted record and classifies it as a create.
    h.lookup.setTarget("appB", {
      identityFieldPath: "email",
      records: [target("tgtN1", { id: "tgtN1", email: "a@x.com", name: "Alice" })],
    });

    const outcome = await h.stage.resolve(makeChange(), makeContext());

    expect(outcome.kind).toBe("severed-tombstone");
    if (outcome.kind !== "severed-tombstone") return;
    expect(outcome.tombstoneReason).toBe("propagated-delete");
    // No new link, no lookup-driven create — resurrection is prevented.
    expect(h.links.all()).toHaveLength(1);
    expect(h.links.all()[0]?.status).toBe("tombstoned");
    expect(h.lookup.filteredReadCalls).toHaveLength(0);
  });

  it("a re-create after observed-delete forms a fresh active link (tombstone does not block it)", async () => {
    const h = makeHarness();
    const link = activeLink();
    await h.links.insert(link);
    await h.stage.processDeletion(link, "observed-delete");

    // A genuine re-create arrives with a NEW native id → normal create path, fresh link.
    const recreate = makeChange({
      sourceNativeId: "srcN2",
      observedRecord: { id: "srcN2", email: "a@x.com", name: "Al" },
    });
    const outcome = await h.stage.resolve(
      recreate,
      makeContext({ targetLookup: { kind: "none" } }),
    );
    expect(outcome.kind).toBe("straight-create");
    const fresh = await h.stage.recordCreatePropagation(recreate, makeContext(), "tgtN2");
    expect(fresh.status).toBe("active");
    // Old tombstoned link + new active link coexist (unique-active only blocks two actives).
    expect(h.links.all().filter((l) => l.status === "active")).toHaveLength(1);
  });
});

describe("side assignment is direction-agnostic (source app B)", () => {
  it("assigns native ids to the correct canonical side when the source is app B", async () => {
    const h = makeHarness();
    const change = makeChange({
      sourceAppId: "appB",
      targetAppId: "appA",
      sourceNativeId: "bNative",
      observedRecord: { id: "bNative", email: "a@x.com", name: "Alice" },
    });
    const link = await h.stage.recordCreatePropagation(change, makeContext(), "aNative");
    // source is side B → its native id lands on appB; captured target id on appA.
    expect(link.appBNativeId).toBe("bNative");
    expect(link.appANativeId).toBe("aNative");
  });
});

describe("SS-12 — the resolved container (scopeRef) is frozen onto the new link at establishment", () => {
  const SCOPE_LINK_REF = { kind: "scope-link", scopeLinkId: "link-phoenix-42" } as const;
  const RESOLVED_REF = { kind: "resolved", values: { owner: "alice", name: "phoenix" } } as const;

  it("create-propagation persists scopeRef from context.scopeRefForNewLink (SS-12.2, L3)", async () => {
    const h = makeHarness();
    const link = await h.stage.recordCreatePropagation(
      makeChange(),
      makeContext({ scopeRefForNewLink: SCOPE_LINK_REF }),
      "tgtNEW",
    );
    expect(link.scopeRef).toEqual(SCOPE_LINK_REF);
    // Persisted at insert — re-reading the stored link carries the frozen container.
    expect((await h.links.getById(link.id))?.scopeRef).toEqual(SCOPE_LINK_REF);
  });

  it("identity-match persists scopeRef from context.scopeRefForNewLink", async () => {
    const h = makeHarness();
    h.lookup.setTarget("appB", {
      identityFieldPath: "email",
      records: [target("tgtN1", { id: "tgtN1", email: "a@x.com", name: "Alice" })],
    });
    const outcome = await h.stage.resolve(
      makeChange(),
      makeContext({ scopeRefForNewLink: SCOPE_LINK_REF }),
    );
    expect(outcome.kind).toBe("resolved");
    if (outcome.kind !== "resolved") return;
    expect(outcome.link.scopeRef).toEqual(SCOPE_LINK_REF);
  });

  it("L2 record-derived rule persists the frozen resolved values (SS-12.7)", async () => {
    const h = makeHarness();
    const link = await h.stage.recordCreatePropagation(
      makeChange(),
      makeContext({ scopeRefForNewLink: RESOLVED_REF }),
      "tgtNEW",
    );
    expect(link.scopeRef).toEqual(RESOLVED_REF);
  });

  it("linkManually freezes the operator-supplied scopeRef", async () => {
    const h = makeHarness();
    const link = await h.stage.linkManually({
      resourcePairRef: PAIR,
      appAId: "appA",
      appANativeId: "srcN1",
      appBId: "appB",
      appBNativeId: "tgtN1",
      scopeRef: SCOPE_LINK_REF,
    });
    expect(link.scopeRef).toEqual(SCOPE_LINK_REF);
  });

  it("a non-scoped rule (no scopeRefForNewLink) establishes a link with NO scopeRef", async () => {
    const h = makeHarness();
    const link = await h.stage.recordCreatePropagation(makeChange(), makeContext(), "tgtNEW");
    expect(link.scopeRef).toBeUndefined();
  });
});

describe("fake mirrors the DB unique-active-link invariant", () => {
  let links: FakeRecordLinkStore;
  beforeEach(() => {
    links = new FakeRecordLinkStore();
  });

  it("rejects a second active link for the same side-record", async () => {
    await links.insert(activeLink({ id: "l1" }));
    await expect(links.insert(activeLink({ id: "l2" }))).rejects.toBeInstanceOf(
      UniqueActiveLinkViolation,
    );
  });

  it("allows a fresh active link once the prior one is tombstoned", async () => {
    await links.insert(activeLink({ id: "l1" }));
    await links.tombstone("l1", "observed-delete", T0);
    await expect(links.insert(activeLink({ id: "l2" }))).resolves.toBeUndefined();
  });
});
