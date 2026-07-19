import type {
  DecryptedCredential,
  UsableCredentialSecret,
  WithCredentialResult,
} from "@mediator/credentials";
import type {
  FieldMapping,
  ParkedConflict,
  RecordLink,
  ScopeLink,
  SyncFieldState,
} from "@mediator/domain";
import { stripUndefined } from "@mediator/domain";
import {
  buildChangePayload,
  ConflictDetectionStage,
  FakeRecordLinkStore,
  FakeSingleRecordTargetReader,
  FakeSyncFieldStateStore,
  FakeTargetIdentityLookup,
  FakeOrderingQueue,
  hashFieldValue,
  IdentityMatchSeeder,
  IdentityResolutionStage,
  LoopPreventionStage,
  OrderingQueueDispatcher,
  TtlRecentlyWrittenCache,
  type DetectedChange,
} from "@mediator/sync-engine";
import { applyFieldMappings, type JsonRecord } from "@mediator/transform";
import { beforeEach, describe, expect, it } from "vitest";

import type { ScopeLinkReader } from "./container-scope.js";
import {
  ContainerUnresolvedError,
  PermanentOutboundError,
  RetryableOutboundError,
  ThrottledOutboundError,
  classifyOutboundFailure,
} from "./errors.js";
import { OutboundCallExecutor, type CredentialAccess } from "./executor.js";
import { computeWriteIdempotencyKey } from "./idempotency.js";
import { AppLoadGovernor } from "./load-governor.js";
import type { OutboundRequest, OutboundResponse, ProtocolClient } from "./protocol-client.js";
import { FakeSyncEventStore } from "./sync-event-store.js";
import {
  parseDetectedChange,
  SyncPipelineHandler,
  type ParkedConflictResolutionRecord,
  type ParkedConflictWriter,
  type ResolvedTargetOperation,
  type SyncPipelineContext,
} from "./sync-pipeline-handler.js";

/**
 * Phase 4 **sync pipeline handler** — the RL/EP/CF/TX/OC assembly a queue entry runs.
 * Driven with the existing fakes (no LLM, no landscape, no DB). Each terminal branch
 * of `docs/flows/sync-polling-pull.md` steps 3.1–3.7 has a named test, and the two
 * distinct "parks" (a conflict returns; a transient failure throws) are asserted
 * explicitly.
 */

// ── Fixed identities ──────────────────────────────────────────────────────────

const APP_A = "app-A";
const APP_B = "app-B";
const PAIR = "pair:custs";
const RULE_AB = "rule-AB";
const MAP_AB = "map-AB";
const SRC_RES = "app-A:customers";
const TGT_RES = "app-B:customers";
const A_NATIVE = "a1";
const B_NATIVE = "b1";
const LINK_ID = "link-1";
const BASE_URL = "https://b.test";

const T0 = new Date("2026-07-13T00:00:00.000Z");

const FM_EMAIL: FieldMapping = {
  id: "fm-email",
  mappingId: MAP_AB,
  sourcePath: "email",
  targetPath: "email",
  transform: "rename",
  isIdentityKey: true,
};
const FM_NAME: FieldMapping = {
  id: "fm-name",
  mappingId: MAP_AB,
  sourcePath: "name",
  targetPath: "name",
  transform: "rename",
};
const FIELD_MAPPINGS: readonly FieldMapping[] = [FM_EMAIL, FM_NAME];

const CREATE_OP: ResolvedTargetOperation = {
  operation: { method: "POST", pathTemplate: "/customers", parameterLocations: {} },
  operationMapping: {
    id: "op-create",
    mappingId: MAP_AB,
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
    mappingId: MAP_AB,
    sourceOperationRef: "a.get",
    targetOperationRef: "b.update",
    action: "update",
    targetIdParamRef: "idParam",
  },
};
const DELETE_OP: ResolvedTargetOperation = {
  operation: {
    method: "DELETE",
    pathTemplate: "/customers/{id}",
    parameterLocations: { idParam: { name: "id", in: "path" } },
  },
  operationMapping: {
    id: "op-delete",
    mappingId: MAP_AB,
    sourceOperationRef: "a.get",
    targetOperationRef: "b.delete",
    action: "delete",
    targetIdParamRef: "idParam",
  },
};

// ── SS-12 scoped fixtures (Layer 3 scope-link) ───────────────────────────────────

/** The scenario container link: source `alice/phoenix` ↔ target project id `42` (arbitrary value-spaces). */
function scopedLink(): ScopeLink {
  return {
    id: "link-42",
    scopeCorrespondenceId: "corr-1",
    appAId: APP_A,
    appAScopeKey: { owner: "alice", name: "phoenix" },
    appBId: APP_B,
    appBScopeKey: { id: "42" },
    resourcePairRef: PAIR,
    establishedBy: "manual",
    status: "active",
    createdAt: T0,
  };
}

/** A `ScopeLinkReader` fake mirroring `ScopeLinkRepository.getById` (resolves any status). */
class FakeScopeLinkReader implements ScopeLinkReader {
  readonly #byId = new Map<string, ScopeLink>();
  public constructor(links: readonly ScopeLink[]) {
    for (const link of links) {
      this.#byId.set(link.id, link);
    }
  }
  public getById(id: string): Promise<ScopeLink | undefined> {
    return Promise.resolve(this.#byId.get(id));
  }
}

/** A scoped delete op: `{project}` is a scope-link container param, `{taskId}` the record id. */
const SCOPED_DELETE_OP: ResolvedTargetOperation = {
  operation: {
    method: "DELETE",
    pathTemplate: "/projects/{project}/tasks/{taskId}",
    parameterLocations: { idParam: { name: "taskId", in: "path" } },
  },
  operationMapping: {
    id: "op-delete-scoped",
    mappingId: MAP_AB,
    sourceOperationRef: "a.get",
    targetOperationRef: "b.delete",
    action: "delete",
    targetIdParamRef: "idParam",
  },
};

/** A scoped create op whose `{project}` container param the loader would fill from the ScopeLink. */
const SCOPED_CREATE_OP: ResolvedTargetOperation = {
  operation: { method: "PUT", pathTemplate: "/projects/{project}/tasks", parameterLocations: {} },
  operationMapping: {
    id: "op-create-scoped",
    mappingId: MAP_AB,
    sourceOperationRef: "a.list",
    targetOperationRef: "b.create",
    action: "create",
  },
};

const SCOPE_LINK_BINDINGS = [
  {
    kind: "scope-link" as const,
    parameterName: "project",
    scopeKeyRef: "id",
    confirmedBy: "operator",
    confirmedAt: T0,
  },
];

// ── Protocol / credential fakes (no network) ──────────────────────────────────

class FakeProtocolClient implements ProtocolClient {
  public readonly requests: OutboundRequest[] = [];
  readonly #responder: () => (request: OutboundRequest) => OutboundResponse;

  public constructor(responder: () => (request: OutboundRequest) => OutboundResponse) {
    this.#responder = responder;
  }

  public send(request: OutboundRequest): Promise<OutboundResponse> {
    this.requests.push(request);
    try {
      return Promise.resolve(this.#responder()(request));
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }
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

/** Default responder: 2xx echoing the request body; a create is tagged with `id: "b1"`. */
function successResponder(request: OutboundRequest): OutboundResponse {
  if (request.method === "DELETE") {
    return { status: 204, headers: {}, body: undefined };
  }
  const body = isRecord(request.body) ? request.body : {};
  if (request.method === "POST") {
    return { status: 201, headers: {}, body: { ...body, id: B_NATIVE } };
  }
  return { status: 200, headers: {}, body };
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A fake `ParkedConflictWriter` mirroring the real `ParkedConflictRepository`'s
 * idempotent-open semantics ([[fakes-must-mirror-real-repos]]): one open row per
 * `(recordLinkId, side, kind, fieldPath)` field conflict / per `(recordLinkId,
 * drifted-delete)`; a re-park updates the open row's hashes; `resolve` only marks an
 * OPEN row (a double-resolve is a no-op).
 */
class FakeParkedConflictStore implements ParkedConflictWriter {
  public readonly rows: ParkedConflict[] = [];

  #findOpen(predicate: (row: ParkedConflict) => boolean): ParkedConflict | undefined {
    return this.rows.find((row) => row.status === "open" && predicate(row));
  }

  public upsertOpenFieldConflict(conflict: ParkedConflict): Promise<void> {
    const existing = this.#findOpen(
      (row) =>
        row.recordLinkId === conflict.recordLinkId &&
        row.side === conflict.side &&
        row.kind === conflict.kind &&
        row.fieldPath === conflict.fieldPath,
    );
    if (existing !== undefined) {
      existing.sourceObservedHash = conflict.sourceObservedHash;
      existing.targetObservedHash = conflict.targetObservedHash;
      existing.updatedAt = conflict.updatedAt;
    } else {
      this.rows.push({ ...conflict });
    }
    return Promise.resolve();
  }

  public upsertOpenDriftedDelete(conflict: ParkedConflict): Promise<void> {
    const existing = this.#findOpen(
      (row) => row.recordLinkId === conflict.recordLinkId && row.kind === "drifted-delete",
    );
    if (existing !== undefined) {
      existing.details = conflict.details;
      existing.updatedAt = conflict.updatedAt;
    } else {
      this.rows.push({ ...conflict });
    }
    return Promise.resolve();
  }

  public resolve(
    id: string,
    resolution: ParkedConflictResolutionRecord,
  ): Promise<ParkedConflict | undefined> {
    const row = this.rows.find((candidate) => candidate.id === id && candidate.status === "open");
    if (row === undefined) {
      return Promise.resolve(undefined);
    }
    row.status = "resolved";
    row.resolutionChoice = resolution.choice;
    row.resolvedBy = resolution.resolvedBy;
    row.resolvedAt = resolution.resolvedAt;
    row.updatedAt = resolution.resolvedAt;
    return Promise.resolve(row);
  }
}

// ── Harness ───────────────────────────────────────────────────────────────────

interface Harness {
  readonly links: FakeRecordLinkStore;
  readonly fieldState: FakeSyncFieldStateStore;
  readonly events: FakeSyncEventStore;
  readonly lookup: FakeTargetIdentityLookup;
  readonly targetReader: FakeSingleRecordTargetReader;
  readonly protocol: FakeProtocolClient;
  readonly cache: TtlRecentlyWrittenCache;
  readonly parkedConflicts: FakeParkedConflictStore;
  readonly handler: SyncPipelineHandler;
  respond: (request: OutboundRequest) => OutboundResponse;
  loader: (change: DetectedChange) => SyncPipelineContext;
}

let idSeq = 0;
function nextId(): string {
  idSeq += 1;
  return `id-${String(idSeq)}`;
}

function baseContext(): SyncPipelineContext {
  return {
    resolution: {
      appAId: APP_A,
      appBId: APP_B,
      identitySourcePath: "email",
      identityTargetPath: "email",
      targetLookup: { kind: "none" },
      hasApprovedCreateOperation: true,
      fieldMappings: FIELD_MAPPINGS,
    },
    loopPrevention: {
      appAId: APP_A,
      appBId: APP_B,
      directions: [{ sourceSide: "A", fieldMappings: FIELD_MAPPINGS }],
    },
    conflict: {
      appAId: APP_A,
      appBId: APP_B,
      fields: [
        { targetPath: "email", sourcePath: "email" },
        { targetPath: "name", sourcePath: "name" },
      ],
      writeShape: "patch",
      targetDriftCheck: "none",
      changeTimestampsComparable: false,
    },
    deletion: {
      appAId: APP_A,
      appBId: APP_B,
      deletePropagation: "propagate",
      targetDriftCheck: "none",
      targetFields: ["email", "name"],
    },
    fieldMappings: FIELD_MAPPINGS,
    sourceResourceRef: SRC_RES,
    targetResourceRef: TGT_RES,
    createOperation: CREATE_OP,
    updateOperation: UPDATE_OP,
    deleteOperation: DELETE_OP,
    targetBaseUrl: BASE_URL,
    targetResourceNativeIdRef: { kind: "field", path: "id" },
  };
}

function setup(): Harness {
  const links = new FakeRecordLinkStore();
  const fieldState = new FakeSyncFieldStateStore();
  const events = new FakeSyncEventStore();
  const lookup = new FakeTargetIdentityLookup();
  const targetReader = new FakeSingleRecordTargetReader();
  const clock = (): Date => T0;
  const cache = new TtlRecentlyWrittenCache(60_000, { now: () => T0.getTime() });
  const state: {
    respond: (request: OutboundRequest) => OutboundResponse;
    loader: (change: DetectedChange) => SyncPipelineContext;
  } = {
    respond: successResponder,
    loader: () => baseContext(),
  };
  const protocol = new FakeProtocolClient(() => state.respond);

  const seeder = new IdentityMatchSeeder(fieldState, { clock, newId: nextId });
  const identityResolution = new IdentityResolutionStage(
    { links, seeder, lookup, events },
    { clock, newId: nextId },
  );
  const loopPrevention = new LoopPreventionStage(
    { fieldState, events, cache },
    { clock, newId: nextId },
  );
  const conflictDetection = new ConflictDetectionStage(
    { fieldState, events, targetReader },
    { clock, newId: nextId },
  );
  const outbound = new OutboundCallExecutor(
    protocol,
    new FakeCredentialAccess(),
    events,
    new AppLoadGovernor(),
    { now: clock },
  );

  const parkedConflicts = new FakeParkedConflictStore();
  // SS-12 — a ScopeLink reader carrying the scenario container link (alice/phoenix ↔ 42);
  // consulted only when a scoped rule's write op leaves a container `{…}` templated.
  const scopeLinks = new FakeScopeLinkReader([scopedLink()]);
  const handler = new SyncPipelineHandler(
    {
      identityResolution,
      loopPrevention,
      conflictDetection,
      transform: applyFieldMappings,
      outbound,
      fieldState,
      contextLoader: { load: (change) => Promise.resolve(state.loader(change)) },
      events,
      parkedConflicts,
      scopeLinks,
    },
    { clock, newId: nextId },
  );

  return {
    links,
    fieldState,
    events,
    lookup,
    targetReader,
    protocol,
    cache,
    parkedConflicts,
    handler,
    get respond(): (request: OutboundRequest) => OutboundResponse {
      return state.respond;
    },
    set respond(value: (request: OutboundRequest) => OutboundResponse) {
      state.respond = value;
    },
    get loader(): (change: DetectedChange) => SyncPipelineContext {
      return state.loader;
    },
    set loader(value: (change: DetectedChange) => SyncPipelineContext) {
      state.loader = value;
    },
  };
}

// ── Change + row builders ─────────────────────────────────────────────────────

function createChange(observed: JsonRecord = { email: "e@x", name: "Ada" }): DetectedChange {
  return {
    ruleId: RULE_AB,
    mappingId: MAP_AB,
    sourceAppId: APP_A,
    targetAppId: APP_B,
    resourcePairRef: PAIR,
    sourceNativeId: A_NATIVE,
    changeKind: "create",
    observedRecord: observed,
  };
}

function updateChange(observed: JsonRecord): DetectedChange {
  return { ...createChange(observed), changeKind: "update" };
}

function deleteChange(): DetectedChange {
  return {
    ruleId: RULE_AB,
    mappingId: MAP_AB,
    sourceAppId: APP_A,
    targetAppId: APP_B,
    resourcePairRef: PAIR,
    sourceNativeId: A_NATIVE,
    changeKind: "delete",
  };
}

async function insertActiveLink(links: FakeRecordLinkStore): Promise<RecordLink> {
  const link: RecordLink = {
    id: LINK_ID,
    appAId: APP_A,
    appANativeId: A_NATIVE,
    appBId: APP_B,
    appBNativeId: B_NATIVE,
    resourcePairRef: PAIR,
    establishedBy: "identity-match",
    status: "active",
    establishingQueueKey: { kind: "identity-value", value: "e@x" },
    createdAt: T0,
    tombstonedAt: null,
  };
  await links.insert(link);
  return link;
}

interface RowOptions {
  readonly synced?: string; // baseline value; absent → divergent (no baseline)
  readonly observed: string;
  readonly changeTs?: Date | null;
}

function fieldRow(side: "A" | "B", fieldPath: string, opts: RowOptions): SyncFieldState {
  const base: SyncFieldState = {
    id: nextId(),
    recordLinkId: LINK_ID,
    side,
    fieldPath,
    observedHash: hashFieldValue(opts.observed),
    observedAt: T0,
    observedChangeTimestamp: opts.changeTs ?? null,
    status: "active",
  };
  if (opts.synced === undefined) {
    return base;
  }
  return { ...base, lastSyncedHash: hashFieldValue(opts.synced), lastSyncedAt: T0 };
}

function runHandle(h: Harness, change: DetectedChange): Promise<void> {
  return h.handler.handle({
    id: "queue-entry-1",
    queueKey: LINK_ID,
    payload: buildChangePayload(change),
    attempts: 1,
  });
}

function statusesOf(h: Harness): (string | undefined)[] {
  return h.events.all().map((entry) => entry.status);
}

beforeEach(() => {
  idSeq = 0;
});

// ── Golden paths ──────────────────────────────────────────────────────────────

describe("SyncPipelineHandler — golden create path (flow 3.1 straight-create, 3.6–3.7)", () => {
  it("straight-create → OC create success → create-propagation link + re-baseline + success event", async () => {
    const h = setup();

    await runHandle(h, createChange());

    // One create call was made against the target's create operation.
    expect(h.protocol.requests).toHaveLength(1);
    const request = h.protocol.requests[0];
    expect(request?.method).toBe("POST");
    expect(request?.url).toBe(`${BASE_URL}/customers`);

    // Step 3.6 — App B's new native id captured onto a create-propagation link.
    const link = h.links.all()[0];
    expect(link?.establishedBy).toBe("create-propagation");
    expect(link?.appANativeId).toBe(A_NATIVE);
    expect(link?.appBNativeId).toBe(B_NATIVE);

    // Step 3.7 — EP re-baselined BOTH sides from the write response + observed source.
    const rows = h.fieldState.all();
    const bName = rows.find((row) => row.side === "B" && row.fieldPath === "name");
    const aName = rows.find((row) => row.side === "A" && row.fieldPath === "name");
    expect(bName?.lastSyncedHash).toBe(hashFieldValue("Ada"));
    expect(aName?.lastSyncedHash).toBe(hashFieldValue("Ada"));

    // OC recorded exactly one success SyncEvent (OC-5); no conflict/skip.
    expect(statusesOf(h)).toEqual(["success"]);
  });
});

describe("SyncPipelineHandler — golden update path (flow 3.4–3.7)", () => {
  it("resolved link, no drift → source observation persisted → CF write → TX → OC update → re-baseline", async () => {
    const h = setup();
    await insertActiveLink(h.links);
    await h.fieldState.seed([
      fieldRow("A", "email", { synced: "e@x", observed: "e@x" }),
      fieldRow("A", "name", { synced: "Old", observed: "Old" }),
      fieldRow("B", "email", { synced: "e@x", observed: "e@x" }),
      fieldRow("B", "name", { synced: "Old", observed: "Old" }),
    ]);

    await runHandle(h, updateChange({ email: "e@x", name: "New" }));

    // A single update (PATCH) routed to the linked target id.
    expect(h.protocol.requests).toHaveLength(1);
    expect(h.protocol.requests[0]?.method).toBe("PATCH");
    expect(h.protocol.requests[0]?.url).toBe(`${BASE_URL}/customers/${B_NATIVE}`);
    expect(h.protocol.requests[0]?.body).toEqual({ email: "e@x", name: "New" });

    const rows = h.fieldState.all();
    // The source-side observation was persisted (App A's `name` now shows "New").
    expect(rows.find((r) => r.side === "A" && r.fieldPath === "name")?.observedHash).toBe(
      hashFieldValue("New"),
    );
    // EP re-baselined the written target field to the stored representation.
    expect(rows.find((r) => r.side === "B" && r.fieldPath === "name")?.lastSyncedHash).toBe(
      hashFieldValue("New"),
    );
    expect(statusesOf(h)).toEqual(["success"]);
  });
});

// ── Identity Resolution terminal branches (flow 3.1) ──────────────────────────

describe("SyncPipelineHandler — Identity Resolution branches (flow 3.1)", () => {
  it("ambiguous match → done, never auto-linked, a failure event recorded, no write", async () => {
    const h = setup();
    h.loader = () => ({
      ...baseContext(),
      resolution: {
        ...baseContext().resolution,
        targetLookup: {
          kind: "fetch-and-match",
          binding: { collectionReadOperationId: "b.list", nativeIdPath: "id" },
        },
      },
    });
    // Two target records share the identity value → ambiguous.
    h.lookup.setTarget(APP_B, {
      identityFieldPath: "email",
      records: [
        { nativeId: "b1", record: { email: "e@x", name: "One" } },
        { nativeId: "b2", record: { email: "e@x", name: "Two" } },
      ],
    });

    await expect(runHandle(h, createChange())).resolves.toBeUndefined();

    expect(h.protocol.requests).toHaveLength(0); // no write — NEVER auto-linked
    expect(h.links.all()).toHaveLength(0); // no link established (no silent merge)
    expect(statusesOf(h)).toEqual(["failure"]);
    expect(h.events.all()[0]?.details).toContain("ambiguous identity match");
  });

  it("no-create-op → skipped-policy, done, no write", async () => {
    const h = setup();
    h.loader = () => ({
      ...baseContext(),
      resolution: { ...baseContext().resolution, hasApprovedCreateOperation: false },
    });

    await runHandle(h, createChange());

    expect(h.protocol.requests).toHaveLength(0);
    expect(statusesOf(h)).toEqual(["skipped-policy"]);
  });

  it("delete of a never-linked record → skipped-policy, done, no write", async () => {
    const h = setup();

    await runHandle(h, deleteChange());

    expect(h.protocol.requests).toHaveLength(0);
    expect(statusesOf(h)).toEqual(["skipped-policy"]);
    expect(h.events.all()[0]?.details).toContain("no active RecordLink");
  });
});

// ── Loop Prevention (flow 3.2) ────────────────────────────────────────────────

describe("SyncPipelineHandler — Loop Prevention echo (flow 3.2)", () => {
  it("content echo → skipped-loop, done, no write", async () => {
    const h = setup();
    await insertActiveLink(h.links);
    // App A's baselines already equal the incoming values → an echo of our own write.
    await h.fieldState.seed([
      fieldRow("A", "email", { synced: "e@x", observed: "e@x" }),
      fieldRow("A", "name", { synced: "Ada", observed: "Ada" }),
    ]);

    await runHandle(h, updateChange({ email: "e@x", name: "Ada" }));

    expect(h.protocol.requests).toHaveLength(0);
    expect(statusesOf(h)).toEqual(["skipped-loop"]);
  });
});

// ── Deletion path (flow 3.3) ──────────────────────────────────────────────────

describe("SyncPipelineHandler — deletion path (flow 3.3)", () => {
  it("deletePropagation=ignore → skipped-policy + tombstone observed-delete, no delete call", async () => {
    const h = setup();
    await insertActiveLink(h.links);
    h.loader = () => ({
      ...baseContext(),
      deletion: { ...baseContext().deletion, deletePropagation: "ignore" },
    });

    await runHandle(h, deleteChange());

    expect(h.protocol.requests).toHaveLength(0);
    expect(statusesOf(h)).toEqual(["skipped-policy"]);
    const link = h.links.all()[0];
    expect(link?.status).toBe("tombstoned");
    expect(link?.tombstoneReason).toBe("observed-delete");
  });

  it("drifted target → conflict park, link stays active, NO delete call, done", async () => {
    const h = setup();
    await insertActiveLink(h.links);
    await h.fieldState.seed([
      fieldRow("B", "email", { synced: "e@x", observed: "e@x" }),
      fieldRow("B", "name", { synced: "Old", observed: "DriftedByHand" }), // drift
    ]);

    await expect(runHandle(h, deleteChange())).resolves.toBeUndefined();

    expect(h.protocol.requests).toHaveLength(0); // deletes never auto-resolved vs a drifted target
    expect(statusesOf(h)).toEqual(["conflict"]);
    expect(h.links.all()[0]?.status).toBe("active"); // link untouched, nothing deleted
  });

  it("undrifted target → delete call + tombstone propagated-delete", async () => {
    const h = setup();
    await insertActiveLink(h.links);
    await h.fieldState.seed([
      fieldRow("B", "email", { synced: "e@x", observed: "e@x" }),
      fieldRow("B", "name", { synced: "Old", observed: "Old" }),
    ]);

    await runHandle(h, deleteChange());

    expect(h.protocol.requests).toHaveLength(1);
    expect(h.protocol.requests[0]?.method).toBe("DELETE");
    expect(h.protocol.requests[0]?.url).toBe(`${BASE_URL}/customers/${B_NATIVE}`);
    const link = h.links.all()[0];
    expect(link?.status).toBe("tombstoned");
    expect(link?.tombstoneReason).toBe("propagated-delete");
    expect(statusesOf(h)).toEqual(["success"]);
  });
});

// ── Conflict Detection write-path (flow 3.4–3.5) ──────────────────────────────

describe("SyncPipelineHandler — Conflict Detection write path (flow 3.4–3.5)", () => {
  it("all fields withheld → NO OC call, conflict recorded, done", async () => {
    const h = setup();
    await insertActiveLink(h.links);
    h.loader = () => ({
      ...baseContext(),
      conflict: {
        ...baseContext().conflict,
        fields: [
          { targetPath: "email", sourcePath: "email", conflictPolicy: "manual-resolve" },
          { targetPath: "name", sourcePath: "name", conflictPolicy: "manual-resolve" },
        ],
      },
    });
    // Both target fields drifted → both manual-park → no field left to write.
    await h.fieldState.seed([
      fieldRow("B", "email", { synced: "e@x", observed: "DriftEmail" }),
      fieldRow("B", "name", { synced: "Old", observed: "DriftName" }),
    ]);

    await expect(
      runHandle(h, updateChange({ email: "e@x", name: "New" })),
    ).resolves.toBeUndefined();

    expect(h.protocol.requests).toHaveLength(0);
    expect(statusesOf(h)).toEqual(["conflict"]);
  });

  it("partial withhold on a PUT → writes the rest, the withheld field carries the target's current value", async () => {
    const h = setup();
    await insertActiveLink(h.links);
    h.loader = () => ({
      ...baseContext(),
      conflict: {
        ...baseContext().conflict,
        writeShape: "put",
        targetReadBinding: { readOperationId: "b.get", idParamRef: "idParam" },
        fields: [
          { targetPath: "email", sourcePath: "email" },
          { targetPath: "name", sourcePath: "name", conflictPolicy: "manual-resolve" },
        ],
      },
    });
    await h.fieldState.seed([
      fieldRow("B", "email", { synced: "e@x", observed: "e@x" }), // no drift → written
      fieldRow("B", "name", { synced: "Old", observed: "DriftName" }), // drift → manual-park
    ]);
    // PUT read-carry reads the target's CURRENT value for the withheld field.
    h.targetReader.setRecord(APP_B, B_NATIVE, { email: "e@x", name: "TargetCurrentName" });

    await runHandle(h, updateChange({ email: "e@x", name: "SourceContestedName" }));

    expect(h.protocol.requests).toHaveLength(1);
    // The withheld `name` carries the target's current value, never the contested source value.
    expect(h.protocol.requests[0]?.body).toEqual({ email: "e@x", name: "TargetCurrentName" });
    // A partial conflict: CF records the `conflict`, and the rest of the record still syncs (`success`).
    expect(statusesOf(h)).toEqual(["conflict", "success"]);
    // At most one target read (OC-3 discipline; CF memoizes).
    expect(h.targetReader.calls).toHaveLength(1);
  });

  it("source-observation persist runs BEFORE CF: LWW source-wins uses the just-persisted source timestamp", async () => {
    const h = setup();
    await insertActiveLink(h.links);
    const targetTs = new Date("2026-07-13T00:00:00.000Z");
    h.loader = () => ({
      ...baseContext(),
      conflict: {
        ...baseContext().conflict,
        changeTimestampsComparable: true,
        fields: [{ targetPath: "name", sourcePath: "name" }],
      },
      sourceChangeTimestampRef: "updatedAt",
    });
    await h.fieldState.seed([
      // Target `name` drifted; its observed change timestamp is the earlier one.
      fieldRow("B", "name", { synced: "Old", observed: "Drift", changeTs: targetTs }),
      // Stale source row: if the handler did NOT persist the fresh observation before CF,
      // this stale (earlier) timestamp would make the target win and withhold the write.
      fieldRow("A", "name", {
        synced: "Old",
        observed: "Old",
        changeTs: new Date("2026-07-12T00:00:00.000Z"),
      }),
    ]);

    // The incoming change carries a LATER source change timestamp (> target + epsilon).
    await runHandle(h, updateChange({ name: "New", updatedAt: "2026-07-13T00:00:30.000Z" }));

    // Source won → the write proceeded, proving the fresh source observation was
    // persisted before CF read it for last-write-wins.
    expect(h.protocol.requests).toHaveLength(1);
    expect(h.protocol.requests[0]?.body).toEqual({ name: "New" });
    // Source-wins still records a conflict (nothing silently lost), then the write succeeds.
    expect(statusesOf(h)).toEqual(["conflict", "success"]);
  });
});

// ── Create-only rule: an observed update is skipped-policy, never dead-lettered ─

describe("SyncPipelineHandler — create-only rule (no approved update operation)", () => {
  it("an observed update records skipped-policy and settles the queue entry DONE (never dead-lettered)", async () => {
    const h = setup();
    await insertActiveLink(h.links);
    // A create-only rule: the resolved context carries no `updateOperation`.
    h.loader = () => stripUndefined({ ...baseContext(), updateOperation: undefined });
    await h.fieldState.seed([
      fieldRow("B", "email", { synced: "e@x", observed: "e@x" }),
      fieldRow("B", "name", { synced: "Old", observed: "Old" }),
    ]);
    const queue = new FakeOrderingQueue();
    await queue.enqueue(LINK_ID, buildChangePayload(updateChange({ email: "e@x", name: "New" })));

    const dispatcher = new OrderingQueueDispatcher(queue, h.handler.handle, {
      classifyFailure: classifyOutboundFailure,
      clock: () => T0,
      maxAttempts: 5,
    });
    const result = await dispatcher.runOnce();

    // Recorded, visible, and DONE — not parked, so a later edit can still sync.
    expect(result.outcome).toBe("done");
    expect(queue.listByStatus("parked")).toHaveLength(0);
    expect(h.protocol.requests).toHaveLength(0); // no OC call
    expect(statusesOf(h)).toEqual(["skipped-policy"]);
    expect(h.events.all()[0]?.details).toContain("create-only rule");
  });
});

// ── Transformation failure (flow 3.5) ─────────────────────────────────────────

describe("SyncPipelineHandler — transform failure (flow 3.5, TX-5)", () => {
  it("a transform error records a failure event and THROWS a permanent (dead-letter) error", async () => {
    const h = setup();
    // A rename over a source path the observed record does not carry → TransformError.
    h.loader = () => ({
      ...baseContext(),
      fieldMappings: [
        {
          id: "fm-x",
          mappingId: MAP_AB,
          sourcePath: "absent",
          targetPath: "x",
          transform: "rename",
        },
      ],
    });

    await expect(runHandle(h, createChange({ email: "e@x", name: "Ada" }))).rejects.toBeInstanceOf(
      PermanentOutboundError,
    );

    expect(h.protocol.requests).toHaveLength(0); // never a corrupted/partial payload
    expect(statusesOf(h)).toEqual(["failure"]);
  });
});

// ── Outbound Call dispositions (flow 3.6) ─────────────────────────────────────

describe("SyncPipelineHandler — Outbound Call dispositions (flow 3.6)", () => {
  async function seedUndriftedUpdate(h: Harness): Promise<void> {
    await insertActiveLink(h.links);
    await h.fieldState.seed([
      fieldRow("A", "email", { synced: "e@x", observed: "e@x" }),
      fieldRow("A", "name", { synced: "Old", observed: "Old" }),
      fieldRow("B", "email", { synced: "e@x", observed: "e@x" }),
      fieldRow("B", "name", { synced: "Old", observed: "Old" }),
    ]);
  }

  it("throttled (429) → THROWS ThrottledOutboundError (dispatcher defers)", async () => {
    const h = setup();
    await seedUndriftedUpdate(h);
    h.respond = () => ({ status: 429, headers: { "retry-after": "5" }, body: undefined });

    await expect(runHandle(h, updateChange({ email: "e@x", name: "New" }))).rejects.toBeInstanceOf(
      ThrottledOutboundError,
    );
  });

  it("transient failure (5xx) → THROWS RetryableOutboundError (dispatcher retries)", async () => {
    const h = setup();
    await seedUndriftedUpdate(h);
    h.respond = () => ({ status: 503, headers: {}, body: undefined });

    await expect(runHandle(h, updateChange({ email: "e@x", name: "New" }))).rejects.toBeInstanceOf(
      RetryableOutboundError,
    );
    expect(statusesOf(h)).toEqual(["failure"]); // OC recorded the failure event
  });

  it("client error (4xx) → THROWS PermanentOutboundError (dispatcher parks)", async () => {
    const h = setup();
    await seedUndriftedUpdate(h);
    h.respond = () => ({ status: 400, headers: {}, body: undefined });

    await expect(runHandle(h, updateChange({ email: "e@x", name: "New" }))).rejects.toBeInstanceOf(
      PermanentOutboundError,
    );
  });
});

// ── Idempotency key threading (OC-2) ──────────────────────────────────────────

describe("SyncPipelineHandler — idempotency key reflects prior reconciled state (OC-2)", () => {
  it("the recorded key folds in the target-side baselines the write was computed from", async () => {
    const h = setup();
    await insertActiveLink(h.links);
    await h.fieldState.seed([
      fieldRow("A", "email", { synced: "e@x", observed: "e@x" }),
      fieldRow("A", "name", { synced: "Old", observed: "Old" }),
      fieldRow("B", "email", { synced: "e@x", observed: "e@x" }),
      fieldRow("B", "name", { synced: "Old", observed: "Old" }),
    ]);

    await runHandle(h, updateChange({ email: "e@x", name: "New" }));

    const successEvent = h.events.all().find((entry) => entry.status === "success");
    const payload = { email: "e@x", name: "New" };
    const withPriorState = computeWriteIdempotencyKey({
      mappingId: MAP_AB,
      sourceNativeId: A_NATIVE,
      payload,
      priorReconciledState: {
        kind: "reconciled",
        fieldHashes: { email: hashFieldValue("e@x"), name: hashFieldValue("Old") },
      },
    });
    const withoutPriorState = computeWriteIdempotencyKey({
      mappingId: MAP_AB,
      sourceNativeId: A_NATIVE,
      payload,
      priorReconciledState: { kind: "none" },
    });

    expect(successEvent?.idempotencyKey).toBe(withPriorState);
    expect(successEvent?.idempotencyKey).not.toBe(withoutPriorState);
  });
});

// ── Loop closes: a write marks the recently-written cache (flow 3.7) ───────────

describe("SyncPipelineHandler — the no-echo loop closes (flow 3.7)", () => {
  it("a create marks the cache so App B's own next poll of that record is recognized as an echo", async () => {
    const h = setup();
    // The A→B create; its context is the default (source = App A).
    const contextAB = baseContext();
    // The B→A direction for the *same* physical record: source app is B, its resource
    // ref is the same physical resource the create landed on.
    const contextBA: SyncPipelineContext = {
      ...baseContext(),
      resolution: { ...baseContext().resolution, targetLookup: { kind: "none" } },
      sourceResourceRef: TGT_RES,
      targetResourceRef: SRC_RES,
    };
    h.loader = (change) => (change.sourceAppId === APP_A ? contextAB : contextBA);

    await runHandle(h, createChange()); // marks cache[{app-B, TGT_RES, b1}]
    expect(h.protocol.requests).toHaveLength(1);

    // App B's own poll now reports that record back to the mediator (source = App B).
    const bEcho: DetectedChange = {
      ruleId: "rule-BA",
      mappingId: "map-BA",
      sourceAppId: APP_B,
      targetAppId: APP_A,
      resourcePairRef: PAIR,
      sourceNativeId: B_NATIVE,
      changeKind: "update",
      observedRecord: { email: "e@x", name: "Ada" },
    };
    await runHandle(h, bEcho);

    // No second outbound call — the cache recognized App B's report as our own echo.
    expect(h.protocol.requests).toHaveLength(1);
    expect(statusesOf(h)).toEqual(["success", "skipped-loop"]);
  });
});

// ── The two distinct parks, end to end through the dispatcher ──────────────────

describe("SyncPipelineHandler — the two parks (conflict returns; a transient failure throws)", () => {
  function dispatcherFor(h: Harness, queue: FakeOrderingQueue): OrderingQueueDispatcher {
    return new OrderingQueueDispatcher(queue, h.handler.handle, {
      classifyFailure: classifyOutboundFailure,
      clock: () => T0,
      maxAttempts: 5,
    });
  }

  it("a conflict (all-withheld) settles the queue entry DONE — never a dispatcher failure", async () => {
    const h = setup();
    await insertActiveLink(h.links);
    h.loader = () => ({
      ...baseContext(),
      conflict: {
        ...baseContext().conflict,
        fields: [
          { targetPath: "email", sourcePath: "email", conflictPolicy: "manual-resolve" },
          { targetPath: "name", sourcePath: "name", conflictPolicy: "manual-resolve" },
        ],
      },
    });
    await h.fieldState.seed([
      fieldRow("B", "email", { synced: "e@x", observed: "DriftEmail" }),
      fieldRow("B", "name", { synced: "Old", observed: "DriftName" }),
    ]);
    const queue = new FakeOrderingQueue();
    await queue.enqueue(LINK_ID, buildChangePayload(updateChange({ email: "e@x", name: "New" })));

    const result = await dispatcherFor(h, queue).runOnce();

    expect(result.outcome).toBe("done");
    expect(h.protocol.requests).toHaveLength(0);
  });

  it("a transient failure settles the queue entry RETRIED — never a silent done", async () => {
    const h = setup();
    await insertActiveLink(h.links);
    await h.fieldState.seed([
      fieldRow("B", "email", { synced: "e@x", observed: "e@x" }),
      fieldRow("B", "name", { synced: "Old", observed: "Old" }),
    ]);
    h.respond = () => ({ status: 503, headers: {}, body: undefined });
    const queue = new FakeOrderingQueue();
    await queue.enqueue(LINK_ID, buildChangePayload(updateChange({ email: "e@x", name: "New" })));

    const result = await dispatcherFor(h, queue).runOnce();

    expect(result.outcome).toBe("retried");
    expect(queue.listByStatus("pending")).toHaveLength(1);
  });

  it("a throttle settles the queue entry DEFERRED (attempt-neutral)", async () => {
    const h = setup();
    await insertActiveLink(h.links);
    await h.fieldState.seed([
      fieldRow("B", "email", { synced: "e@x", observed: "e@x" }),
      fieldRow("B", "name", { synced: "Old", observed: "Old" }),
    ]);
    h.respond = () => ({ status: 429, headers: { "retry-after": "5" }, body: undefined });
    const queue = new FakeOrderingQueue();
    await queue.enqueue(LINK_ID, buildChangePayload(updateChange({ email: "e@x", name: "New" })));

    const result = await dispatcherFor(h, queue).runOnce();

    expect(result.outcome).toBe("deferred");
  });
});

// ── Payload parsing ────────────────────────────────────────────────────────────

describe("SyncPipelineHandler — payload parsing", () => {
  it("a malformed payload parks permanently (never a cast-and-hope)", async () => {
    const h = setup();
    await expect(
      h.handler.handle({ id: "q", queueKey: "k", payload: { ruleId: 42 }, attempts: 1 }),
    ).rejects.toBeInstanceOf(PermanentOutboundError);
  });

  it("SS-8.5 — the captured scope round-trips through the ordering-queue payload parse", () => {
    const change: DetectedChange = {
      ruleId: RULE_AB,
      mappingId: MAP_AB,
      sourceAppId: APP_A,
      targetAppId: APP_B,
      resourcePairRef: PAIR,
      sourceNativeId: "42",
      changeKind: "create",
      observedRecord: { id: 42, title: "t", repository: { owner: "alice", name: "phoenix" } },
      capturedScope: { owner: "alice", name: "phoenix" },
    };
    const roundTripped = parseDetectedChange(buildChangePayload(change));
    expect(roundTripped.capturedScope).toStrictEqual({ owner: "alice", name: "phoenix" });
  });

  it("SS-8.5 — a change with no captured scope round-trips with capturedScope absent (backward-compatible)", () => {
    const change: DetectedChange = {
      ruleId: RULE_AB,
      mappingId: MAP_AB,
      sourceAppId: APP_A,
      targetAppId: APP_B,
      resourcePairRef: PAIR,
      sourceNativeId: "42",
      changeKind: "create",
      observedRecord: { id: 42, title: "t" },
    };
    const payload = buildChangePayload(change);
    expect("capturedScope" in payload).toBe(false);
    expect(parseDetectedChange(payload).capturedScope).toBeUndefined();
  });
});

// ── SA-4: the handler records structured parks + consumes a resolution directive ──

function runWithResolution(
  h: Harness,
  change: DetectedChange,
  resolution: Record<string, unknown>,
): Promise<void> {
  return h.handler.handle({
    id: "queue-entry-r",
    queueKey: LINK_ID,
    payload: { ...buildChangePayload(change), resolution },
    attempts: 1,
  });
}

function openFieldParkRow(id: string, fieldPath: string): ParkedConflict {
  return {
    id,
    recordLinkId: LINK_ID,
    syncRuleId: RULE_AB,
    mappingId: MAP_AB,
    kind: "manual-resolve",
    side: "B",
    fieldPath,
    status: "open",
    createdAt: T0,
    updatedAt: T0,
  };
}

function openDeleteParkRow(id: string): ParkedConflict {
  return {
    id,
    recordLinkId: LINK_ID,
    syncRuleId: RULE_AB,
    mappingId: MAP_AB,
    kind: "drifted-delete",
    side: "B",
    status: "open",
    createdAt: T0,
    updatedAt: T0,
  };
}

describe("SyncPipelineHandler — SA-4 structured parks", () => {
  it("a manual-resolve field conflict → records an open parked_conflict row (hashes, no value)", async () => {
    const h = setup();
    await insertActiveLink(h.links);
    h.loader = () => ({
      ...baseContext(),
      conflict: {
        ...baseContext().conflict,
        fields: [
          { targetPath: "email", sourcePath: "email" },
          { targetPath: "name", sourcePath: "name", conflictPolicy: "manual-resolve" },
        ],
      },
    });
    await h.fieldState.seed([
      fieldRow("B", "email", { synced: "e@x", observed: "e@x" }), // no drift → written
      fieldRow("B", "name", { synced: "Old", observed: "DriftName" }), // drift → manual-park
      fieldRow("A", "name", { synced: "Old", observed: "SourceName" }),
    ]);

    await runHandle(h, updateChange({ email: "e@x", name: "SourceName" }));

    const open = h.parkedConflicts.rows.filter((row) => row.status === "open");
    expect(open).toHaveLength(1);
    const parked = open[0];
    expect(parked?.kind).toBe("manual-resolve");
    expect(parked?.side).toBe("B");
    expect(parked?.fieldPath).toBe("name");
    // Hashes only — never a raw value.
    expect(parked?.targetObservedHash).toBe(hashFieldValue("DriftName"));
    expect(parked?.sourceObservedHash).toBe(hashFieldValue("SourceName"));
    expect(JSON.stringify(parked)).not.toContain("DriftName");
    expect(JSON.stringify(parked)).not.toContain("SourceName");
  });

  it("re-processing the same still-conflicting field keeps ONE open row (idempotent re-park)", async () => {
    const h = setup();
    await insertActiveLink(h.links);
    h.loader = () => ({
      ...baseContext(),
      conflict: {
        ...baseContext().conflict,
        fields: [{ targetPath: "name", sourcePath: "name", conflictPolicy: "manual-resolve" }],
      },
    });
    await h.fieldState.seed([
      fieldRow("B", "name", { synced: "Old", observed: "DriftName" }),
      fieldRow("A", "name", { synced: "Old", observed: "SourceName" }),
    ]);

    await runHandle(h, updateChange({ email: "e@x", name: "SourceName" }));
    await runHandle(h, updateChange({ email: "e@x", name: "SourceName" }));

    expect(h.parkedConflicts.rows.filter((row) => row.status === "open")).toHaveLength(1);
  });

  it("a drifted delete → records an open drifted-delete parked_conflict row (no fieldPath, no value)", async () => {
    const h = setup();
    await insertActiveLink(h.links);
    await h.fieldState.seed([
      fieldRow("B", "email", { synced: "e@x", observed: "e@x" }),
      fieldRow("B", "name", { synced: "Old", observed: "DriftedByHand" }),
    ]);

    await runHandle(h, deleteChange());

    const open = h.parkedConflicts.rows.filter((row) => row.status === "open");
    expect(open).toHaveLength(1);
    expect(open[0]?.kind).toBe("drifted-delete");
    expect(open[0]?.fieldPath).toBeUndefined();
  });
});

describe("SyncPipelineHandler — SA-4 resolution re-run consumes the directive", () => {
  it("source-wins directive → CF writes the field + the parked row is resolved", async () => {
    const h = setup();
    await insertActiveLink(h.links);
    h.parkedConflicts.rows.push(openFieldParkRow("pc-1", "name"));
    h.loader = () => ({
      ...baseContext(),
      conflict: {
        ...baseContext().conflict,
        fields: [{ targetPath: "name", sourcePath: "name", conflictPolicy: "manual-resolve" }],
      },
    });
    await h.fieldState.seed([
      fieldRow("B", "name", { synced: "Old", observed: "DriftName" }), // still drifted
      fieldRow("A", "name", { synced: "Old", observed: "SourceWins" }),
    ]);

    await runWithResolution(h, updateChange({ email: "e@x", name: "SourceWins" }), {
      overrides: [{ targetPath: "name", choice: "source-wins" }],
      parkedConflictIds: ["pc-1"],
      choice: "source-wins",
      resolvedBy: "operator@x",
    });

    // The write went out (the source value propagated through the normal path).
    expect(h.protocol.requests).toHaveLength(1);
    expect(h.protocol.requests[0]?.method).toBe("PATCH");
    // The parked row is superseded, attributed to the operator.
    const row = h.parkedConflicts.rows.find((candidate) => candidate.id === "pc-1");
    expect(row?.status).toBe("resolved");
    expect(row?.resolutionChoice).toBe("source-wins");
    expect(row?.resolvedBy).toBe("operator@x");
  });

  it("target-wins directive → withheld (no write), row resolved, no NEW park for that field", async () => {
    const h = setup();
    await insertActiveLink(h.links);
    h.parkedConflicts.rows.push(openFieldParkRow("pc-1", "name"));
    h.loader = () => ({
      ...baseContext(),
      conflict: {
        ...baseContext().conflict,
        fields: [{ targetPath: "name", sourcePath: "name", conflictPolicy: "manual-resolve" }],
      },
    });
    await h.fieldState.seed([
      fieldRow("B", "name", { synced: "Old", observed: "DriftName" }),
      fieldRow("A", "name", { synced: "Old", observed: "SourceLoses" }),
    ]);

    await runWithResolution(h, updateChange({ email: "e@x", name: "SourceLoses" }), {
      overrides: [{ targetPath: "name", choice: "target-wins" }],
      parkedConflictIds: ["pc-1"],
      choice: "target-wins",
      resolvedBy: "operator@x",
    });

    // Withheld → no write; baselines never forged (CF wrote nothing to state).
    expect(h.protocol.requests).toHaveLength(0);
    const row = h.parkedConflicts.rows.find((candidate) => candidate.id === "pc-1");
    expect(row?.status).toBe("resolved");
    expect(row?.resolutionChoice).toBe("target-wins");
    // The resolved field is NOT re-parked as a new open row.
    expect(h.parkedConflicts.rows.filter((candidate) => candidate.status === "open")).toHaveLength(
      0,
    );
  });

  it("propagate directive on a drifted delete → delete call + tombstone + row resolved", async () => {
    const h = setup();
    await insertActiveLink(h.links);
    h.parkedConflicts.rows.push(openDeleteParkRow("pc-del"));
    await h.fieldState.seed([
      fieldRow("B", "email", { synced: "e@x", observed: "e@x" }),
      fieldRow("B", "name", { synced: "Old", observed: "DriftedByHand" }), // still drifted
    ]);

    await runWithResolution(h, deleteChange(), {
      deleteOverride: { choice: "propagate" },
      parkedConflictIds: ["pc-del"],
      choice: "propagate",
      resolvedBy: "operator@x",
    });

    // The delete proceeded through the pipeline (never a blind delete).
    expect(h.protocol.requests).toHaveLength(1);
    expect(h.protocol.requests[0]?.method).toBe("DELETE");
    const link = h.links.all()[0];
    expect(link?.status).toBe("tombstoned");
    expect(link?.tombstoneReason).toBe("propagated-delete");
    const row = h.parkedConflicts.rows.find((candidate) => candidate.id === "pc-del");
    expect(row?.status).toBe("resolved");
    expect(row?.resolutionChoice).toBe("propagate");
  });
});

// ── SS-12 scoped write routing (Layer 3 scope-link + Layer 2 unified delete) ─────

describe("SyncPipelineHandler — SS-12 scoped write container routing", () => {
  function scopedActiveLink(scopeRef: RecordLink["scopeRef"]): RecordLink {
    return stripUndefined({
      id: LINK_ID,
      appAId: APP_A,
      appANativeId: A_NATIVE,
      appBId: APP_B,
      appBNativeId: B_NATIVE,
      resourcePairRef: PAIR,
      establishedBy: "manual" as const,
      status: "active" as const,
      establishingQueueKey: { kind: "identity-value" as const, value: "e@x" },
      createdAt: T0,
      tombstonedAt: null,
      scopeRef,
    });
  }

  /** Undrifted target baselines so the deletion drift check yields `delete` (not a conflict park). */
  async function seedUndrifted(h: Harness): Promise<void> {
    await h.fieldState.seed([
      fieldRow("B", "email", { synced: "e@x", observed: "e@x" }),
      fieldRow("B", "name", { synced: "Old", observed: "Old" }),
    ]);
  }

  it("L3 linked delete fills {project} from RecordLink.scopeRef → /projects/42/tasks/b1 (SS-12.3)", async () => {
    const h = setup();
    await h.links.insert(scopedActiveLink({ kind: "scope-link", scopeLinkId: "link-42" }));
    await seedUndrifted(h);
    h.loader = () => ({
      ...baseContext(),
      deleteOperation: SCOPED_DELETE_OP,
      scopePathBindings: SCOPE_LINK_BINDINGS,
    });

    await runHandle(h, deleteChange());

    expect(h.protocol.requests).toHaveLength(1);
    expect(h.protocol.requests[0]?.method).toBe("DELETE");
    // {project}=42 from the ScopeLink's target side; {taskId}=b1 from the RecordLink (id × scope never crossed).
    expect(h.protocol.requests[0]?.url).toBe(`${BASE_URL}/projects/42/tasks/${B_NATIVE}`);
    expect((await h.links.getById(LINK_ID))?.status).toBe("tombstoned");
  });

  it("L2 linked delete routes from the frozen resolved values (SS-12.7 — unified delete fix)", async () => {
    const h = setup();
    await h.links.insert(scopedActiveLink({ kind: "resolved", values: { project: "77" } }));
    await seedUndrifted(h);
    h.loader = () => ({
      ...baseContext(),
      deleteOperation: SCOPED_DELETE_OP,
      scopePathBindings: [
        {
          kind: "record-derived",
          parameterName: "project",
          sourceScopeKey: "project",
          confirmedBy: "operator",
          confirmedAt: T0,
        },
      ],
    });

    await runHandle(h, deleteChange());

    expect(h.protocol.requests[0]?.url).toBe(`${BASE_URL}/projects/77/tasks/${B_NATIVE}`);
  });

  it("a linked delete whose scopeRef is ABSENT parks for manual container linking (SS-12.4)", async () => {
    const h = setup();
    await h.links.insert(scopedActiveLink(undefined)); // scoped op, but the link never captured its container
    await seedUndrifted(h);
    h.loader = () => ({
      ...baseContext(),
      deleteOperation: SCOPED_DELETE_OP,
      scopePathBindings: SCOPE_LINK_BINDINGS,
    });

    // A container park is a dead-letter throw (not a silent done), routed to the container queue.
    await expect(runHandle(h, deleteChange())).rejects.toBeInstanceOf(ContainerUnresolvedError);
    expect(h.protocol.requests).toHaveLength(0); // never a guessed-container write
  });

  it("a scoped create whose captured scope matched no active ScopeLink parks (SS-12.6)", async () => {
    const h = setup();
    // The loader left {project} templated (no active ScopeLink resolved) — the create must park.
    h.loader = () => ({
      ...baseContext(),
      createOperation: SCOPED_CREATE_OP,
      scopePathBindings: SCOPE_LINK_BINDINGS,
    });

    await expect(runHandle(h, createChange())).rejects.toBeInstanceOf(ContainerUnresolvedError);
    expect(h.protocol.requests).toHaveLength(0);
    expect(h.links.all()).toHaveLength(0); // no link established against a guessed container
  });
});
