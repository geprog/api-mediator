import type {
  DecryptedCredential,
  UsableCredentialSecret,
  WithCredentialResult,
} from "@mediator/credentials";
import type { FieldMapping, RecordLink } from "@mediator/domain";
import {
  FakeRecordLinkStore,
  FakeSyncFieldStateStore,
  FakeTargetIdentityLookup,
  hashFieldValue,
  IdentityMatchSeeder,
  IdentityResolutionStage,
  LoopPreventionStage,
  TtlRecentlyWrittenCache,
  type DeltaOutcome,
  type ObservedRecord,
  type PageOutcome,
  type ResolutionContext,
  type SourceReader,
} from "@mediator/sync-engine";
import { applyFieldMappings, type JsonRecord } from "@mediator/transform";
import { beforeEach, describe, expect, it } from "vitest";

import {
  BackfillRunner,
  FakeBackfillMetrics,
  type BackfillOutbound,
  type LinkOnlyBackfillContext,
  type PushBackfillContext,
} from "./backfill-runner.js";
import { OutboundCallExecutor, type CredentialAccess, type OutboundCall } from "./executor.js";
import { AppLoadGovernor } from "./load-governor.js";
import type { OutboundRequest, OutboundResponse, ProtocolClient } from "./protocol-client.js";
import { FakeSyncEventStore } from "./sync-event-store.js";
import type { ResolvedTargetOperation } from "./sync-pipeline-handler.js";

/**
 * BE-4 (`link-only`) + BE-5 (`push`) + BE-3.4 (`backfill-run` events / progress
 * metric) for the {@link BackfillRunner}, driven with the existing fakes + a fake
 * clock (no LLM, no landscape, no DB). The runner composes the REAL
 * `IdentityResolutionStage`/`IdentityMatchSeeder`/`LoopPreventionStage`/
 * `OutboundCallExecutor` over the fakes, so the reviewer-weighted invariants are
 * exercised end to end: link-only writes NOTHING, seeding is monotone, and push
 * OVERWRITES a differing target (never parks).
 */

const APP_A = "app-A";
const APP_B = "app-B";
const PAIR = "pair::customers";
const RULE = "rule-AB";
const MAP = "map-AB";
const BASE_URL = "https://b.test";
const T0 = new Date("2026-07-13T00:00:00.000Z");

const FM_EMAIL: FieldMapping = {
  id: "fm-email",
  mappingId: MAP,
  sourcePath: "email",
  targetPath: "email",
  transform: "rename",
  isIdentityKey: true,
};
const FM_NAME: FieldMapping = {
  id: "fm-name",
  mappingId: MAP,
  sourcePath: "name",
  targetPath: "name",
  transform: "rename",
};
const FIELD_MAPPINGS: readonly FieldMapping[] = [FM_EMAIL, FM_NAME];

const CREATE_OP: ResolvedTargetOperation = {
  operation: { method: "POST", pathTemplate: "/customers", parameterLocations: {} },
  operationMapping: {
    id: "op-create",
    mappingId: MAP,
    sourceOperationRef: "a.list",
    targetOperationRef: "b.create",
    action: "create",
  },
};
const UPDATE_OP: ResolvedTargetOperation = {
  operation: {
    method: "PATCH",
    pathTemplate: "/customers/{id}",
    parameterLocations: { idParam: { name: "id", in: "path" } },
  },
  operationMapping: {
    id: "op-update",
    mappingId: MAP,
    sourceOperationRef: "a.get",
    targetOperationRef: "b.update",
    action: "update",
    targetIdParamRef: "idParam",
  },
};

// ── Test doubles ────────────────────────────────────────────────────────────

/**
 * A source reader that serves canned collection pages AND a canned delta batch,
 * counting both — so BE-4.1 can prove the runner enumerated the collection read and
 * NEVER touched the delta operation (even records offered by delta are not processed).
 */
class RecordingReader implements SourceReader {
  public collectionCalls = 0;
  public deltaCalls = 0;
  readonly #pages: readonly PageOutcome[];
  readonly #delta: DeltaOutcome;

  public constructor(pages: readonly PageOutcome[], delta: DeltaOutcome) {
    this.#pages = pages;
    this.#delta = delta;
  }

  public readCollectionPage(
    _ruleId: string,
    continuation: string | undefined,
  ): Promise<PageOutcome> {
    this.collectionCalls += 1;
    const index = continuation === undefined ? 0 : Number(continuation);
    return Promise.resolve(this.#pages[index] ?? { ok: false, reason: "page out of range" });
  }

  public readDelta(): Promise<DeltaOutcome> {
    this.deltaCalls += 1;
    return Promise.resolve(this.#delta);
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A single-page reader for the given records (the common case). */
function onePage(records: readonly ObservedRecord[]): RecordingReader {
  const page: PageOutcome = { ok: true, records, next: { done: true } };
  return new RecordingReader([page], { ok: false, reason: "delta must not be used by backfill" });
}

class FakeCredentialAccess implements CredentialAccess {
  public async withCredential<T>(
    appId: string,
    fn: (credential: DecryptedCredential) => Promise<T>,
  ): Promise<WithCredentialResult<T>> {
    const secret: UsableCredentialSecret = { type: "apiKey", apiKey: "SECRET" };
    const value = await fn({ credentialId: `cred-${appId}`, type: "apiKey", scopes: [], secret });
    return { outcome: "invoked", value };
  }
}

class FakeProtocolClient implements ProtocolClient {
  public readonly requests: OutboundRequest[] = [];
  #createSeq = 0;

  public send(request: OutboundRequest): Promise<OutboundResponse> {
    this.requests.push(request);
    if (request.method === "POST") {
      this.#createSeq += 1;
      const body = isRecord(request.body) ? request.body : {};
      return Promise.resolve({
        status: 201,
        headers: {},
        body: { ...body, id: `b-new-${String(this.#createSeq)}` },
      });
    }
    // PATCH/PUT: 200 echoing the payload (the target's stored representation).
    const body = isRecord(request.body) ? request.body : {};
    return Promise.resolve({ status: 200, headers: {}, body });
  }
}

/** A counting {@link BackfillOutbound} that records every execute (link-only must never call it). */
class CountingOutbound implements BackfillOutbound {
  public readonly calls: OutboundCall[] = [];
  public execute(call: OutboundCall): ReturnType<BackfillOutbound["execute"]> {
    this.calls.push(call);
    throw new Error("link-only must not issue an outbound write");
  }
}

// ── Harness ─────────────────────────────────────────────────────────────────

let idSeq = 0;
function nextId(): string {
  idSeq += 1;
  return `id-${String(idSeq)}`;
}
const clock = (): Date => T0;

interface Harness {
  readonly links: FakeRecordLinkStore;
  readonly fieldState: FakeSyncFieldStateStore;
  readonly events: FakeSyncEventStore;
  readonly lookup: FakeTargetIdentityLookup;
  readonly metrics: FakeBackfillMetrics;
  readonly countingOutbound: CountingOutbound;
  readonly protocol: FakeProtocolClient;
  readonly seeder: IdentityMatchSeeder;
  readonly identity: IdentityResolutionStage;
  readonly loopPrevention: LoopPreventionStage;
  readonly realOutbound: OutboundCallExecutor;
}

function setup(): Harness {
  const links = new FakeRecordLinkStore();
  const fieldState = new FakeSyncFieldStateStore();
  const events = new FakeSyncEventStore();
  const lookup = new FakeTargetIdentityLookup();
  const metrics = new FakeBackfillMetrics();
  const countingOutbound = new CountingOutbound();
  const protocol = new FakeProtocolClient();
  const cache = new TtlRecentlyWrittenCache(60_000, { now: () => T0.getTime() });
  const seeder = new IdentityMatchSeeder(fieldState, { clock, newId: nextId });
  const identity = new IdentityResolutionStage(
    { links, seeder, lookup, events },
    { clock, newId: nextId },
  );
  const loopPrevention = new LoopPreventionStage(
    { fieldState, events, cache },
    { clock, newId: nextId },
  );
  const realOutbound = new OutboundCallExecutor(
    protocol,
    new FakeCredentialAccess(),
    events,
    new AppLoadGovernor(),
    { now: clock },
  );
  return {
    links,
    fieldState,
    events,
    lookup,
    metrics,
    countingOutbound,
    protocol,
    seeder,
    identity,
    loopPrevention,
    realOutbound,
  };
}

function runnerWith(h: Harness, reader: SourceReader, outbound: BackfillOutbound): BackfillRunner {
  return new BackfillRunner(
    {
      sourceReader: reader,
      identityResolution: h.identity,
      seeder: h.seeder,
      fieldState: h.fieldState,
      lookup: h.lookup,
      loopPrevention: h.loopPrevention,
      outbound,
      transform: applyFieldMappings,
      events: h.events,
      metrics: h.metrics,
    },
    { clock, newId: nextId },
  );
}

function linkOnlyContext(overrides: Partial<ResolutionContext> = {}): LinkOnlyBackfillContext {
  return {
    ruleId: RULE,
    mappingId: MAP,
    sourceAppId: APP_A,
    targetAppId: APP_B,
    resourcePairRef: PAIR,
    resolution: resolutionOf(APP_A, APP_B, overrides),
    fieldMappings: FIELD_MAPPINGS,
  };
}

function resolutionOf(
  sourceApp: string,
  targetApp: string,
  overrides: Partial<ResolutionContext> = {},
): ResolutionContext {
  // Canonical A/B is stable (A = APP_A, B = APP_B); the direction chooses source/target.
  return {
    appAId: APP_A,
    appBId: APP_B,
    identitySourcePath: "email",
    identityTargetPath: "email",
    targetLookup: {
      kind: "filtered-read",
      binding: { collectionReadOperationId: `${targetApp}.list`, nativeIdPath: "id" },
      lookupParamRef: "emailFilter",
    },
    hasApprovedCreateOperation: true,
    fieldMappings: FIELD_MAPPINGS,
    ...overrides,
  };
}

function pushContext(): PushBackfillContext {
  return {
    ...linkOnlyContext(),
    loopPrevention: {
      appAId: APP_A,
      appBId: APP_B,
      directions: [{ sourceSide: "A", fieldMappings: FIELD_MAPPINGS }],
    },
    createOperation: CREATE_OP,
    updateOperation: UPDATE_OP,
    targetBaseUrl: BASE_URL,
    targetResourceNativeIdRef: { kind: "field", path: "id" },
    targetResourceRef: "app-B:customers",
  };
}

function record(nativeId: string, body: JsonRecord): ObservedRecord {
  return { nativeId, record: body };
}

beforeEach(() => {
  idSeq = 0;
});

// ── BE-4: link-only ───────────────────────────────────────────────────────────

describe("BE-4 link-only backfill", () => {
  it("BE-4.1: enumerates the collection read to exhaustion — NEVER the delta operation", async () => {
    const h = setup();
    // The delta operation offers a record `d1`; the collection read offers `a1`. A
    // delta-polling rule's backfill must still enumerate — so `d1` is never processed.
    const reader = new RecordingReader(
      [
        {
          ok: true,
          records: [record("a1", { id: "a1", email: "a@x.com", name: "A" })],
          next: { done: true },
        },
      ],
      {
        ok: true,
        records: [record("d1", { id: "d1", email: "d@x.com", name: "D" })],
        deletedNativeIds: [],
        nextCursor: "c1",
      },
    );
    // No match configured → every record is `unmatched` (link-only writes nothing).
    const runner = runnerWith(h, reader, h.countingOutbound);

    const result = await runner.run({ mode: "link-only", context: linkOnlyContext() });

    expect(reader.deltaCalls).toBe(0);
    expect(reader.collectionCalls).toBeGreaterThan(0);
    expect(result.outcome).toBe("completed");
    if (result.outcome !== "completed") return;
    expect(result.enumeratedCount).toBe(1);
    expect(result.records.map((r) => r.sourceNativeId)).toStrictEqual(["a1"]); // never `d1`
  });

  it("BE-4.3/4.4: a matched pair seeds per-side baselines — agree → baseline, disagree → NO baseline + summary note", async () => {
    const h = setup();
    // Source A record matches target B record by email; `name` disagrees.
    h.lookup.setTarget(APP_B, {
      identityFieldPath: "email",
      records: [{ nativeId: "b1", record: { id: "b1", email: "alice@x.com", name: "Alicia" } }],
    });
    const reader = onePage([record("a1", { id: "a1", email: "alice@x.com", name: "Alice" })]);
    const runner = runnerWith(h, reader, h.countingOutbound);

    const result = await runner.run({ mode: "link-only", context: linkOnlyContext() });
    expect(result.outcome).toBe("completed");
    if (result.outcome !== "completed") return;

    // One link established, and NOTHING written to either app.
    expect(h.links.all()).toHaveLength(1);
    expect(h.countingOutbound.calls).toHaveLength(0);

    const rows = new Map(h.fieldState.all().map((row) => [`${row.side}:${row.fieldPath}`, row]));
    // email agrees in the target's representation → baseline on BOTH sides.
    expect(rows.get("A:email")?.lastSyncedHash).toBeDefined();
    expect(rows.get("B:email")?.lastSyncedHash).toBeDefined();
    // name disagrees → NO baseline on either side (first change is a conflict by construction).
    expect(rows.get("A:name")?.lastSyncedHash).toBeUndefined();
    expect(rows.get("B:name")?.lastSyncedHash).toBeUndefined();

    const note = result.records[0];
    expect(note?.kind).toBe("matched");
    if (note?.kind !== "matched") return;
    expect(note.disagreedFields.map((f) => f.fieldPath).sort()).toStrictEqual(["name", "name"]);
    expect(result.counts.matched).toBe(1);
    expect(result.counts.disagreedFields).toBe(2);
  });

  it("BE-4.5: monotone — a disagreeing second bidirectional direction does NOT erase the first run's baseline", async () => {
    const h = setup();
    // Direction 1 already linked a1↔b1 and seeded an AGREEING baseline for A/name.
    const link: RecordLink = {
      id: "L1",
      appAId: APP_A,
      appANativeId: "a1",
      appBId: APP_B,
      appBNativeId: "b1",
      resourcePairRef: PAIR,
      establishedBy: "identity-match",
      status: "active",
      establishingQueueKey: { kind: "identity-value", value: "alice@x.com" },
      createdAt: T0,
      tombstonedAt: null,
    };
    await h.links.insert(link);
    const firstRunBaseline = hashFieldValue("Alice");
    await h.fieldState.seed([
      {
        id: "s-A-name",
        recordLinkId: "L1",
        side: "A",
        fieldPath: "name",
        observedHash: firstRunBaseline,
        observedAt: T0,
        observedChangeTimestamp: null,
        lastSyncedHash: firstRunBaseline,
        lastSyncedAt: T0,
        status: "active",
      },
    ]);
    // Direction 2 (source = APP_B) enumerates b1; its counterpart (a1) DISAGREES on name.
    h.lookup.setTarget(APP_A, {
      identityFieldPath: "email",
      records: [{ nativeId: "a1", record: { id: "a1", email: "alice@x.com", name: "Alice" } }],
    });
    const reader = onePage([record("b1", { id: "b1", email: "alice@x.com", name: "Bob" })]);
    const runner = runnerWith(h, reader, h.countingOutbound);

    const result = await runner.run({
      mode: "link-only",
      context: {
        ruleId: RULE,
        mappingId: MAP,
        sourceAppId: APP_B, // the reverse direction's source
        targetAppId: APP_A,
        resourcePairRef: PAIR,
        resolution: resolutionOf(APP_B, APP_A),
        fieldMappings: FIELD_MAPPINGS,
      },
    });

    expect(result.outcome).toBe("completed");
    // The first run's A/name baseline SURVIVED the disagreeing second pairing (monotone).
    const aName = h.fieldState.all().find((r) => r.side === "A" && r.fieldPath === "name");
    expect(aName?.lastSyncedHash).toBe(firstRunBaseline);
    // Still just one link (the existing one was reused, not duplicated).
    expect(h.links.all()).toHaveLength(1);
    expect(h.countingOutbound.calls).toHaveLength(0);
  });

  it("BE-4: an unmatched record links nothing and writes nothing", async () => {
    const h = setup();
    // No target configured → no match.
    const reader = onePage([record("a1", { id: "a1", email: "solo@x.com", name: "Solo" })]);
    const runner = runnerWith(h, reader, h.countingOutbound);

    const result = await runner.run({ mode: "link-only", context: linkOnlyContext() });
    expect(result.outcome).toBe("completed");
    if (result.outcome !== "completed") return;
    expect(result.records[0]?.kind).toBe("unmatched");
    expect(result.counts.unmatched).toBe(1);
    expect(h.links.all()).toHaveLength(0);
    expect(h.fieldState.all()).toHaveLength(0);
    expect(h.countingOutbound.calls).toHaveLength(0);
  });

  it("BE-3.4: emits `backfill-run` SyncEvents and a progress metric per processed record", async () => {
    const h = setup();
    const reader = onePage([
      record("a1", { id: "a1", email: "one@x.com", name: "One" }),
      record("a2", { id: "a2", email: "two@x.com", name: "Two" }),
    ]);
    const runner = runnerWith(h, reader, h.countingOutbound);

    await runner.run({ mode: "link-only", context: linkOnlyContext() });

    const backfillEvents = h.events.all().filter((e) => e.type === "backfill-run");
    expect(backfillEvents).toHaveLength(2);
    expect(backfillEvents.every((e) => e.relatedRuleId === RULE)).toBe(true);
    // Progress metric ticks once per record (running count + total), duration once.
    expect(h.metrics.progress).toStrictEqual([
      { ruleId: RULE, processed: 1, total: 2 },
      { ruleId: RULE, processed: 2, total: 2 },
    ]);
    expect(h.metrics.durations).toHaveLength(1);
  });

  it("BE-4.1: abort-on-partial — a failing page aborts the run (no completion, not 'no more records')", async () => {
    const h = setup();
    const reader = new RecordingReader([{ ok: false, reason: "page 0 timed out" }], {
      ok: false,
      reason: "unused",
    });
    const runner = runnerWith(h, reader, h.countingOutbound);

    const result = await runner.run({ mode: "link-only", context: linkOnlyContext() });
    expect(result.outcome).toBe("aborted");
    if (result.outcome !== "aborted") return;
    expect(result.reason).toContain("timed out");
  });
});

// ── BE-5: push ──────────────────────────────────────────────────────────────

describe("BE-5 push backfill", () => {
  it("BE-5.2/5.4: OVERWRITES a differing matched target (source wins) — the write happens, is NOT parked, and captures the baseline", async () => {
    const h = setup();
    // Matched target b1 whose `name` DIFFERS from the source ("OLD" vs "Alice").
    h.lookup.setTarget(APP_B, {
      identityFieldPath: "email",
      records: [{ nativeId: "b1", record: { id: "b1", email: "alice@x.com", name: "OLD" } }],
    });
    const reader = onePage([record("a1", { id: "a1", email: "alice@x.com", name: "Alice" })]);
    const runner = runnerWith(h, reader, h.realOutbound);

    const result = await runner.run({ mode: "push", context: pushContext() });
    expect(result.outcome).toBe("completed");
    if (result.outcome !== "completed") return;

    // The differing target was OVERWRITTEN (a PATCH went out) — never parked as a conflict.
    const patch = h.protocol.requests.find((r) => r.method === "PATCH");
    expect(patch?.url).toBe(`${BASE_URL}/customers/b1`);
    expect(result.records[0]?.kind).toBe("overwritten");
    expect(result.counts.overwritten).toBe(1);
    expect(h.events.all().some((e) => e.status === "conflict")).toBe(false);

    // BE-5.4: the target-side baseline is captured from the write response (EP-3).
    const bName = h.fieldState.all().find((r) => r.side === "B" && r.fieldPath === "name");
    expect(bName?.lastSyncedHash).toBe(hashFieldValue("Alice"));
  });

  it("BE-5.1: CREATES an unmatched source record in the target and links it via the create response", async () => {
    const h = setup();
    // No matching target → the source record is created in the target.
    const reader = onePage([record("a9", { id: "a9", email: "new@x.com", name: "Newby" })]);
    const runner = runnerWith(h, reader, h.realOutbound);

    const result = await runner.run({ mode: "push", context: pushContext() });
    expect(result.outcome).toBe("completed");
    if (result.outcome !== "completed") return;

    const post = h.protocol.requests.find((r) => r.method === "POST");
    expect(post?.url).toBe(`${BASE_URL}/customers`);
    expect(result.records[0]?.kind).toBe("created");
    expect(result.counts.created).toBe(1);
    // The create response's native id established the RecordLink.
    const link = h.links.all()[0];
    expect(link?.appBNativeId).toBe("b-new-1");
  });
});
