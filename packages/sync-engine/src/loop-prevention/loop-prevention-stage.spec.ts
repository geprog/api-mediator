import type { FieldMapping, RecordLink, SyncFieldState } from "@mediator/domain";
import type { JsonValue } from "@mediator/transform";
import { beforeEach, describe, expect, it } from "vitest";

import { FakeSyncEventRecorder, FakeSyncFieldStateStore } from "../identity-resolution/fakes.js";
import { hashFieldValue } from "../identity-resolution/hash.js";
import type { DetectedChange, ResolutionOutcome } from "../identity-resolution/types.js";
import { FakeLoopPreventionMetrics } from "./fakes.js";
import { LoopPreventionStage } from "./loop-prevention-stage.js";
import { NullRecentlyWrittenCache, TtlRecentlyWrittenCache } from "./recently-written-cache.js";
import type {
  LoopPreventionContext,
  MappingDirection,
  RecentlyWrittenCache,
  RecordWriteInput,
} from "./types.js";

/**
 * Unit tests for the Loop Prevention stage (EP-1..EP-4), against the same fakes that
 * mirror the real SyncFieldState/RecordLink repos. The priority proofs the
 * requirement calls out have their own tests: the **durable, cache-disabled** echo
 * catch (EP-1.5 / EP-2.5) and **canonical-form capture** (EP-3.3).
 */

const RULE_ID = "rule-1";
const MAPPING_ID = "map-A-to-B";
const LINK_ID = "link-1";
const PAIR = "pair-1";
const T0 = new Date("2026-07-13T00:00:00.000Z");

function fm(
  sourcePath: string,
  targetPath: string,
  extra: Partial<FieldMapping> = {},
): FieldMapping {
  return {
    id: `fm-${sourcePath}-${targetPath}`,
    mappingId: MAPPING_ID,
    sourcePath,
    targetPath,
    transform: "rename",
    ...extra,
  };
}

// A bidirectional email+name pair (symmetric), the default context.
const A_TO_B: MappingDirection = {
  sourceSide: "A",
  fieldMappings: [fm("email", "email"), fm("name", "name")],
};
const B_TO_A: MappingDirection = {
  sourceSide: "B",
  fieldMappings: [fm("email", "email"), fm("name", "name")],
};

function makeContext(
  directions: readonly MappingDirection[] = [A_TO_B, B_TO_A],
): LoopPreventionContext {
  return { appAId: "appA", appBId: "appB", directions };
}

function makeLink(overrides: Partial<RecordLink> = {}): RecordLink {
  return {
    id: LINK_ID,
    appAId: "appA",
    appANativeId: "a1",
    appBId: "appB",
    appBNativeId: "b1",
    resourcePairRef: PAIR,
    establishedBy: "identity-match",
    status: "active",
    establishingQueueKey: { kind: "identity-value", value: "a@x.com" },
    createdAt: T0,
    tombstonedAt: null,
    ...overrides,
  };
}

function makeChange(overrides: Partial<DetectedChange> = {}): DetectedChange {
  return {
    ruleId: RULE_ID,
    mappingId: MAPPING_ID,
    sourceAppId: "appB", // the echo arrives on the last-written side (B)
    targetAppId: "appA",
    resourcePairRef: PAIR,
    sourceNativeId: "b1",
    changeKind: "update",
    observedRecord: { email: "a@x.com", name: "Ada" },
    ...overrides,
  };
}

function resolved(
  link: RecordLink,
  effectiveChangeKind: DetectedChange["changeKind"] = "update",
): ResolutionOutcome {
  return { kind: "resolved", link, effectiveChangeKind, establishedByIdentityMatch: false };
}

/** A side-field baseline row (both lastSyncedHash + observedHash = hash(value)). */
function baseline(side: "A" | "B", fieldPath: string, value: JsonValue): SyncFieldState {
  const hash = hashFieldValue(value);
  return {
    id: `sfs-${side}-${fieldPath}`,
    recordLinkId: LINK_ID,
    side,
    fieldPath,
    lastSyncedHash: hash,
    lastSyncedAt: T0,
    observedHash: hash,
    observedAt: T0,
    observedChangeTimestamp: null,
    status: "active",
  };
}

interface Harness {
  readonly stage: LoopPreventionStage;
  readonly fieldState: FakeSyncFieldStateStore;
  readonly events: FakeSyncEventRecorder;
  readonly metrics: FakeLoopPreventionMetrics;
}

function makeHarness(cache?: RecentlyWrittenCache): Harness {
  const fieldState = new FakeSyncFieldStateStore();
  const events = new FakeSyncEventRecorder();
  const metrics = new FakeLoopPreventionMetrics();
  let counter = 0;
  const newId = (): string => `ev-${String(++counter)}`;
  const stage = new LoopPreventionStage(
    { fieldState, events, ...(cache !== undefined ? { cache } : {}) },
    { metrics, clock: (): Date => T0, newId, actor: "system" },
  );
  return { stage, fieldState, events, metrics };
}

describe("Loop Prevention — EP-1 authoritative echo check (no cache)", () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness(); // default = NullRecentlyWrittenCache (cache disabled)
  });

  it("all participating fields match their baseline → skipped-loop, processing stops (EP-1.3)", async () => {
    await h.fieldState.seed([baseline("B", "email", "a@x.com"), baseline("B", "name", "Ada")]);

    const outcome = await h.stage.check({
      change: makeChange(),
      context: makeContext(),
      resolution: resolved(makeLink()),
      resource: "customers",
    });

    expect(outcome).toStrictEqual({
      kind: "echo",
      via: "field-baseline",
      syncEventId: "ev-1",
      recordLinkId: LINK_ID,
    });
    // A single skipped-loop sync-execution event, and the skipped-loop metric.
    expect(h.events.all()).toHaveLength(1);
    const event = h.events.all()[0];
    expect(event?.status).toBe("skipped-loop");
    expect(event?.type).toBe("sync-execution");
    expect(event?.relatedRuleId).toBe(RULE_ID);
    expect(event?.recordLinkId).toBe(LINK_ID);
    expect(h.metrics.skippedLoop).toStrictEqual([RULE_ID]);
    expect(h.metrics.skippedPolicy).toStrictEqual([]);
  });

  it("one field differs → not-echo → continue to Conflict Detection (carries the link)", async () => {
    await h.fieldState.seed([baseline("B", "email", "a@x.com"), baseline("B", "name", "Ada")]);
    const link = makeLink();

    const outcome = await h.stage.check({
      change: makeChange({ observedRecord: { email: "a@x.com", name: "CHANGED" } }),
      context: makeContext(),
      resolution: resolved(link),
      resource: "customers",
    });

    expect(outcome).toStrictEqual({ kind: "not-echo", recordLink: link });
    expect(h.events.all()).toHaveLength(0); // nothing recorded — CF decides next
    expect(h.metrics.skippedLoop).toStrictEqual([]);
  });

  it("a participating field with NO baseline is not a match → not-echo (conservative)", async () => {
    // Only email is baselined; name has no reconciled baseline → the change carries
    // something unreconciled, so it is not a pure echo.
    await h.fieldState.seed([baseline("B", "email", "a@x.com")]);

    const outcome = await h.stage.check({
      change: makeChange(),
      context: makeContext(),
      resolution: resolved(makeLink()),
      resource: "customers",
    });

    expect(outcome.kind).toBe("not-echo");
  });

  it("covers every participating field incl. the reverse direction's output + multi-input (EP-1.2)", async () => {
    // A→B: fullName = firstName + lastName ; B→A: fullName → displayName.
    const aToB: MappingDirection = {
      sourceSide: "A",
      fieldMappings: [
        fm("firstName", "fullName", {
          transform: "aggregate",
          transformConfig: { additionalInputPaths: ["lastName"] },
        }),
      ],
    };
    const bToA: MappingDirection = {
      sourceSide: "B",
      fieldMappings: [fm("fullName", "displayName")],
    };
    const context = makeContext([aToB, bToA]);

    // The echo arrives on side A. Side-A participating fields: firstName, lastName
    // (A→B inputs) AND displayName (B→A output). Baseline firstName + lastName to
    // match, but leave displayName DIFFERING — a naive check would call this an echo.
    await h.fieldState.seed([
      baseline("A", "firstName", "Ada"),
      baseline("A", "lastName", "Lovelace"),
      baseline("A", "displayName", "Ada L."),
    ]);
    const change = makeChange({
      sourceAppId: "appA",
      sourceNativeId: "a1",
      observedRecord: { firstName: "Ada", lastName: "Lovelace", displayName: "SOMEONE ELSE" },
    });

    const outcome = await h.stage.check({
      change,
      context,
      resolution: resolved(makeLink()),
      resource: "customers",
    });
    expect(outcome.kind).toBe("not-echo"); // the cross-direction output field differs

    // When displayName also matches, every participating field agrees → echo.
    const h2 = makeHarness();
    await h2.fieldState.seed([
      baseline("A", "firstName", "Ada"),
      baseline("A", "lastName", "Lovelace"),
      baseline("A", "displayName", "Ada L."),
    ]);
    const echo = await h2.stage.check({
      change: makeChange({
        sourceAppId: "appA",
        sourceNativeId: "a1",
        observedRecord: { firstName: "Ada", lastName: "Lovelace", displayName: "Ada L." },
      }),
      context,
      resolution: resolved(makeLink()),
      resource: "customers",
    });
    expect(echo.kind).toBe("echo");
  });

  it("recognizes the echo hours later — no time/cache dependency (EP-1.5)", async () => {
    await h.fieldState.seed([baseline("B", "email", "a@x.com"), baseline("B", "name", "Ada")]);
    // The stage clock is fixed; the point is EP-1 reads only durable state, never a
    // TTL — the same call succeeds regardless of when the echoing poll runs.
    const outcome = await h.stage.check({
      change: makeChange(),
      context: makeContext(),
      resolution: resolved(makeLink()),
      resource: "customers",
    });
    expect(outcome.kind).toBe("echo");
  });
});

describe("Loop Prevention — EP-3 canonical-form capture + cache-disabled proof", () => {
  it("target-normalized value matches the captured baseline → skipped-loop, no ping-pong (EP-3.3, EP-2.5)", async () => {
    // Country pair, transformed representations: A holds "DE", B holds "Germany".
    const aToB: MappingDirection = {
      sourceSide: "A",
      fieldMappings: [fm("country", "country", { transform: "coerce" })],
    };
    const bToA: MappingDirection = {
      sourceSide: "B",
      fieldMappings: [fm("country", "country", { transform: "coerce" })],
    };
    const context = makeContext([aToB, bToA]);

    // Cache DISABLED — so only EP-1's durable baseline can catch the echo.
    const h = makeHarness(new NullRecentlyWrittenCache());

    // A→B write. The mediator SENT " Germany " (say) but the target STORED "Germany"
    // (trimmed). EP-3 captures the WRITTEN side from the stored representation.
    const writeInput: RecordWriteInput = {
      recordLinkId: LINK_ID,
      mappingId: MAPPING_ID,
      writtenSide: "B",
      sourceSide: "A",
      fieldMappings: aToB.fieldMappings,
      storedRepresentation: { country: "Germany" }, // the target's normalized, stored value
      observedSource: { country: "DE" }, // the observed source the write was computed from
      writtenRecord: { appId: "appB", resource: "customers", nativeId: "b1" },
    };
    await h.stage.recordWrite(writeInput);

    // Each side's baseline lives in its OWN representation — never crossing the
    // transform: A/country = hash("DE"), B/country = hash("Germany").
    const rows = await h.fieldState.findByLink(LINK_ID);
    const aCountry = rows.find((r) => r.side === "A" && r.fieldPath === "country");
    const bCountry = rows.find((r) => r.side === "B" && r.fieldPath === "country");
    expect(aCountry?.lastSyncedHash).toBe(hashFieldValue("DE"));
    expect(bCountry?.lastSyncedHash).toBe(hashFieldValue("Germany"));

    // B's echoing poll returns the NORMALIZED value "Germany" (not what we sent). It
    // matches the captured baseline exactly → dropped skipped-loop, no ping-pong.
    const outcome = await h.stage.check({
      change: makeChange({ observedRecord: { country: "Germany" } }),
      context,
      resolution: resolved(makeLink()),
      resource: "customers",
    });
    expect(outcome).toMatchObject({ kind: "echo", via: "field-baseline" });
  });

  it("recordWrite sets lastWrittenByMappingId on the written side only, and returns the rows", async () => {
    const h = makeHarness();
    await h.stage.recordWrite({
      recordLinkId: LINK_ID,
      mappingId: MAPPING_ID,
      writtenSide: "B",
      sourceSide: "A",
      fieldMappings: [fm("email", "email")],
      storedRepresentation: { email: "a@x.com" },
      observedSource: { email: "a@x.com" },
      writtenRecord: { appId: "appB", resource: "customers", nativeId: "b1" },
    });
    const rows = await h.fieldState.findByLink(LINK_ID);
    const written = rows.find((r) => r.side === "B" && r.fieldPath === "email");
    const source = rows.find((r) => r.side === "A" && r.fieldPath === "email");
    expect(written?.lastWrittenByMappingId).toBe(MAPPING_ID);
    expect(source?.lastWrittenByMappingId).toBeUndefined();
  });

  it("re-baseline OVERWRITES a prior baseline (a genuine value change reconciled by a later write)", async () => {
    const h = makeHarness();
    await h.fieldState.seed([baseline("B", "email", "old@x.com")]);
    await h.stage.recordWrite({
      recordLinkId: LINK_ID,
      mappingId: MAPPING_ID,
      writtenSide: "B",
      sourceSide: "A",
      fieldMappings: [fm("email", "email")],
      storedRepresentation: { email: "new@x.com" },
      observedSource: { email: "new@x.com" },
      writtenRecord: { appId: "appB", resource: "customers", nativeId: "b1" },
    });
    const rows = await h.fieldState.findByLink(LINK_ID);
    const written = rows.find((r) => r.side === "B" && r.fieldPath === "email");
    expect(written?.lastSyncedHash).toBe(hashFieldValue("new@x.com")); // overwritten, not monotone
  });
});

/**
 * The EP-3 → EP-1 round trip over **resource-qualified** `FieldMapping` paths
 * (`issues/title`, not `title`) — the path shape a real `ApprovedMapping` stores.
 *
 * `FieldMapping.sourcePath`/`targetPath` are stored resource-qualified, while a live
 * record is record-relative (`{ title }`, never `{ "issues/title" }`), so every read
 * against a live record must go through `recordRelativePath` while the
 * `SyncFieldState.fieldPath` KEY stays qualified. The rest of this file exercises
 * bare paths, where the two spaces coincide and the reduction is a no-op — so a
 * missing reduction is invisible to it. These cases pin both halves at once.
 *
 * Without the reduction both halves silently degrade to `hashFieldValue(null)`:
 * every baseline matches every observation, so a genuine human edit is dropped as an
 * echo and that direction stops syncing after the mediator's first write.
 */
describe("Loop Prevention — resource-qualified FieldMapping paths (EP-3 → EP-1 round trip)", () => {
  // issues/title → tasks/title, bidirectional.
  const A_TO_B_QUALIFIED: MappingDirection = {
    sourceSide: "A",
    fieldMappings: [fm("issues/title", "tasks/title")],
  };
  const B_TO_A_QUALIFIED: MappingDirection = {
    sourceSide: "B",
    fieldMappings: [fm("tasks/title", "issues/title")],
  };

  /** EP-3: an A→B write of `title`, baselining both sides from live records. */
  async function writeAToB(h: Harness, title: string): Promise<void> {
    await h.stage.recordWrite({
      recordLinkId: LINK_ID,
      mappingId: MAPPING_ID,
      writtenSide: "B",
      sourceSide: "A",
      fieldMappings: A_TO_B_QUALIFIED.fieldMappings,
      // Live records: record-relative keys, exactly as a polled record / write
      // response body arrives.
      storedRepresentation: { title },
      observedSource: { title },
      writtenRecord: { appId: "appB", resource: "tasks", nativeId: "b1" },
    });
  }

  it("EP-3 baselines the REAL value under the qualified key, not hash(null)", async () => {
    const h = makeHarness();
    await writeAToB(h, "Ship the release");

    const rows = await h.fieldState.findByLink(LINK_ID);
    const written = rows.find((r) => r.side === "B" && r.fieldPath === "tasks/title");
    const source = rows.find((r) => r.side === "A" && r.fieldPath === "issues/title");

    // The KEY stays resource-qualified (the seeder / `participatingFieldsForSide`
    // key space) — reducing it would need a migration.
    expect(written).toBeDefined();
    expect(source).toBeDefined();
    // The VALUE is read record-relative: the real title, never the absent-read null.
    expect(written?.lastSyncedHash).toBe(hashFieldValue("Ship the release"));
    expect(source?.lastSyncedHash).toBe(hashFieldValue("Ship the release"));
    expect(written?.lastSyncedHash).not.toBe(hashFieldValue(null));
  });

  it("EP-1: a genuine edit on the last-written side is NOT an echo — reverse sync survives", async () => {
    const h = makeHarness(); // cache disabled → only the durable baseline can decide
    await writeAToB(h, "Ship the release");
    const link = makeLink();

    // A human then edits the title in app B. B is the side the mediator last wrote,
    // so this is precisely the change an over-eager echo check would swallow.
    const outcome = await h.stage.check({
      change: makeChange({ observedRecord: { title: "Ship the release TODAY" } }),
      context: makeContext([A_TO_B_QUALIFIED, B_TO_A_QUALIFIED]),
      resolution: resolved(link),
      resource: "tasks",
    });

    expect(outcome).toStrictEqual({ kind: "not-echo", recordLink: link });
    expect(h.events.all()).toHaveLength(0);
    expect(h.metrics.skippedLoop).toStrictEqual([]);
  });

  it("EP-1: the mediator's own write coming back on qualified paths IS still an echo", async () => {
    // The other half of the contract: the reduction must not break real echo
    // detection, or bidirectional sync ping-pongs.
    const h = makeHarness();
    await writeAToB(h, "Ship the release");

    const outcome = await h.stage.check({
      change: makeChange({ observedRecord: { title: "Ship the release" } }),
      context: makeContext([A_TO_B_QUALIFIED, B_TO_A_QUALIFIED]),
      resolution: resolved(makeLink()),
      resource: "tasks",
    });

    expect(outcome).toMatchObject({ kind: "echo", via: "field-baseline" });
    expect(h.metrics.skippedLoop).toStrictEqual([RULE_ID]);
  });
});

describe("Loop Prevention — EP-2 recently-written cache fast path", () => {
  it("a live cache entry short-circuits ahead of the field compare (no baselines needed)", async () => {
    const now = 0;
    const cache = new TtlRecentlyWrittenCache(1_000, { now: () => now });
    const h = makeHarness(cache);
    cache.markWritten({ appId: "appB", resource: "customers", nativeId: "b1" });

    // No baselines seeded — only the cache can catch this.
    const outcome = await h.stage.check({
      change: makeChange({ observedRecord: { email: "whatever", name: "whatever" } }),
      context: makeContext(),
      resolution: resolved(makeLink()),
      resource: "customers",
    });
    expect(outcome).toMatchObject({
      kind: "echo",
      via: "recently-written-cache",
      recordLinkId: LINK_ID,
    });
    expect(h.metrics.skippedLoop).toStrictEqual([RULE_ID]);
  });

  it("once the cache is COLD (TTL expired), the same change is NOT an echo without a baseline (EP-2.4)", async () => {
    let now = 0;
    const cache = new TtlRecentlyWrittenCache(1_000, { now: () => now });
    const h = makeHarness(cache);
    cache.markWritten({ appId: "appB", resource: "customers", nativeId: "b1" });
    now = 1_000; // TTL lapsed

    const outcome = await h.stage.check({
      change: makeChange({ observedRecord: { email: "whatever", name: "whatever" } }),
      context: makeContext(),
      resolution: resolved(makeLink()),
      resource: "customers",
    });
    // No baseline, cold cache → EP-1 governs and finds no echo.
    expect(outcome.kind).toBe("not-echo");
  });

  it("recentlyWritten() + recordCacheEcho() form the pre-Identity-Resolution fast path", async () => {
    const now = 0;
    const cache = new TtlRecentlyWrittenCache(1_000, { now: () => now });
    const h = makeHarness(cache);
    cache.markWritten({ appId: "appB", resource: "customers", nativeId: "b1" });

    expect(h.stage.recentlyWritten({ appId: "appB", resource: "customers", nativeId: "b1" })).toBe(
      true,
    );
    const outcome = await h.stage.recordCacheEcho(makeChange());
    expect(outcome).toStrictEqual({
      kind: "echo",
      via: "recently-written-cache",
      syncEventId: "ev-1",
    });
    expect(h.events.all()[0]?.status).toBe("skipped-loop");
    expect(h.metrics.skippedLoop).toStrictEqual([RULE_ID]);
  });

  it("the write tag (EP-2.3 seam) short-circuits as an echo", async () => {
    const h = makeHarness();
    const outcome = await h.stage.check({
      change: makeChange({ observedRecord: {} }),
      context: makeContext(),
      resolution: resolved(makeLink()),
      resource: "customers",
      carriesMediatorWriteTag: true,
    });
    expect(outcome).toMatchObject({ kind: "echo", via: "write-tag" });
  });

  it("recordWrite populates the cache for the written record (EP-2.1)", async () => {
    const now = 0;
    const cache = new TtlRecentlyWrittenCache(1_000, { now: () => now });
    const h = makeHarness(cache);
    await h.stage.recordWrite({
      recordLinkId: LINK_ID,
      mappingId: MAPPING_ID,
      writtenSide: "B",
      sourceSide: "A",
      fieldMappings: [fm("email", "email")],
      storedRepresentation: { email: "a@x.com" },
      observedSource: { email: "a@x.com" },
      writtenRecord: { appId: "appB", resource: "customers", nativeId: "b1" },
    });
    expect(cache.isRecentlyWritten({ appId: "appB", resource: "customers", nativeId: "b1" })).toBe(
      true,
    );
  });
});

describe("Loop Prevention — EP-4 create / delete echoes via RecordLink state", () => {
  it("a create resolving to a create-propagation link is a create echo (EP-4.1)", async () => {
    const h = makeHarness();
    const link = makeLink({ establishedBy: "create-propagation" });
    // No content baselines at all (simulating a create response with no body).
    const outcome = await h.stage.check({
      change: makeChange({
        changeKind: "create",
        observedRecord: { email: "a@x.com", name: "Ada" },
      }),
      context: makeContext(),
      resolution: resolved(link, "update"), // IR downgrades a matched/linked create to update
      resource: "customers",
    });
    expect(outcome).toMatchObject({
      kind: "echo",
      via: "create-propagation-link",
      recordLinkId: LINK_ID,
    });
    expect(h.metrics.skippedLoop).toStrictEqual([RULE_ID]);
  });

  it("an UPDATE over a create-propagation link is NOT a create echo — EP-1 governs (EP-4.1 gate)", async () => {
    const h = makeHarness();
    const link = makeLink({ establishedBy: "create-propagation" });
    await h.fieldState.seed([baseline("B", "email", "a@x.com"), baseline("B", "name", "Ada")]);
    // A genuine later update whose name drifted from the baseline.
    const outcome = await h.stage.check({
      change: makeChange({
        changeKind: "update",
        observedRecord: { email: "a@x.com", name: "Renamed" },
      }),
      context: makeContext(),
      resolution: resolved(link, "update"),
      resource: "customers",
    });
    expect(outcome.kind).toBe("not-echo");
  });

  it("a delete echo over a propagated-delete tombstone → skipped-loop (EP-4.2)", async () => {
    const h = makeHarness();
    const link = makeLink({
      status: "tombstoned",
      tombstoneReason: "propagated-delete",
      tombstonedAt: T0,
    });
    const outcome = await h.stage.check({
      change: makeChange({ changeKind: "delete", observedRecord: undefined }),
      context: makeContext(),
      resolution: { kind: "severed-tombstone", tombstoneReason: "propagated-delete", link },
      resource: "customers",
    });
    expect(outcome).toMatchObject({
      kind: "echo",
      via: "propagated-delete-tombstone",
      recordLinkId: LINK_ID,
    });
    expect(h.events.all()[0]?.status).toBe("skipped-loop");
    expect(h.metrics.skippedLoop).toStrictEqual([RULE_ID]);
  });

  it("a non-delete change over a propagated-delete tombstone → resurrection prevented, skipped-loop (EP-4.4)", async () => {
    const h = makeHarness();
    const link = makeLink({
      status: "tombstoned",
      tombstoneReason: "propagated-delete",
      tombstonedAt: T0,
    });
    const outcome = await h.stage.check({
      change: makeChange({
        changeKind: "update",
        observedRecord: { email: "a@x.com", name: "Ada" },
      }),
      context: makeContext(),
      resolution: { kind: "severed-tombstone", tombstoneReason: "propagated-delete", link },
      resource: "customers",
    });
    expect(outcome).toStrictEqual({
      kind: "resurrection-prevented",
      syncEventId: "ev-1",
      recordLinkId: LINK_ID,
      tombstoneReason: "propagated-delete",
    });
    // Recorded as a SyncEvent (closing the RL carry-forward) with status skipped-loop.
    expect(h.events.all()).toHaveLength(1);
    expect(h.events.all()[0]?.status).toBe("skipped-loop");
    expect(h.metrics.skippedLoop).toStrictEqual([RULE_ID]);
  });

  it("a change over an observed-delete tombstone → skipped-policy, DISTINCT from skipped-loop (EP-4.3)", async () => {
    const h = makeHarness();
    const link = makeLink({
      status: "tombstoned",
      tombstoneReason: "observed-delete",
      tombstonedAt: T0,
    });
    const outcome = await h.stage.check({
      change: makeChange({ changeKind: "delete", observedRecord: undefined }),
      context: makeContext(),
      resolution: { kind: "severed-tombstone", tombstoneReason: "observed-delete", link },
      resource: "customers",
    });
    expect(outcome).toStrictEqual({
      kind: "skipped-policy",
      reason: "counterpart-deleted",
      syncEventId: "ev-1",
      recordLinkId: LINK_ID,
    });
    expect(h.events.all()[0]?.status).toBe("skipped-policy");
    // Distinct metric — never counted as a skipped-loop echo.
    expect(h.metrics.skippedPolicy).toStrictEqual([RULE_ID]);
    expect(h.metrics.skippedLoop).toStrictEqual([]);
  });
});

describe("Loop Prevention — non-echo pass-throughs and guards", () => {
  it("a straight-create (genuine new record) is not an echo → continue", async () => {
    const h = makeHarness();
    const outcome = await h.stage.check({
      change: makeChange({ changeKind: "create" }),
      context: makeContext(),
      resolution: { kind: "straight-create", matchFirstAvailable: true },
      resource: "customers",
    });
    expect(outcome).toStrictEqual({ kind: "not-echo" });
    expect(h.events.all()).toHaveLength(0);
  });

  it("a genuine delete over an ACTIVE link is not an echo → continue to CF-7", async () => {
    const h = makeHarness();
    const link = makeLink();
    const outcome = await h.stage.check({
      change: makeChange({ changeKind: "delete", observedRecord: undefined }),
      context: makeContext(),
      resolution: resolved(link, "delete"),
      resource: "customers",
    });
    expect(outcome).toStrictEqual({ kind: "not-echo", recordLink: link });
  });

  it("throws if handed a terminal IR outcome (SP must stop before EP)", async () => {
    const h = makeHarness();
    await expect(
      h.stage.check({
        change: makeChange(),
        context: makeContext(),
        resolution: { kind: "ambiguous-failure", candidateNativeIds: ["x", "y"], syncEventId: "e" },
        resource: "customers",
      }),
    ).rejects.toThrow(/terminal resolution outcome/);
  });
});
