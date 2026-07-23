import {
  MAPPING_APPROVED_EVENT_TYPE,
  syncRuleSchema,
  type ApprovedMapping,
  type FieldMapping,
  type SyncRule,
} from "@mediator/domain";
import type { DeliveredEvent } from "@mediator/event-bus";
import { describe, expect, it } from "vitest";

import type { AddedFieldBaselineSeeder, AdoptionSyncOps, SuccessorAdoptionDeps } from "./adopt.js";
import { canonicalResourcePairRef } from "./derive.js";
import { MappingApprovedInstantiationConsumer, type LoadedApprovedMapping } from "./consumer.js";
import {
  FakeDownstreamArtifactOps,
  approvedMappingFixture,
  fieldMappingFixture,
  sequentialIds,
} from "./fakes.testkit.js";

interface FakeTx {
  readonly marker: "fake-tx";
}
const fakeTx: FakeTx = { marker: "fake-tx" };

function mappingApprovedEvent(
  id: string,
  approvedMappingId: string,
  variant: "peer-peer" | "consumer-provider" = "peer-peer",
): DeliveredEvent {
  return {
    id,
    type: MAPPING_APPROVED_EVENT_TYPE,
    occurredAt: new Date("2026-07-20T00:00:00.000Z"),
    payload: { approvedMappingId, variant },
  };
}

function rule(id: string, approvedMappingId: string, resourcePairRef: string): SyncRule {
  return syncRuleSchema.parse({ id, approvedMappingId, resourcePairRef, status: "enabled" });
}

/**
 * A fake {@link AdoptionSyncOps} mirroring the real repositories' adoption semantics: the
 * re-point moves rows by `approvedMappingId` only, supersede/setCounterpart mutate the stored
 * mapping, and every call is recorded for assertions.
 */
class FakeAdoptionSyncOps implements AdoptionSyncOps {
  readonly mappings = new Map<string, ApprovedMapping>();
  readonly rulesByMapping = new Map<string, SyncRule[]>();
  readonly fieldsByMapping = new Map<string, FieldMapping[]>();
  readonly superseded: string[] = [];
  readonly counterpartSets: { id: string; counterpart: string | null }[] = [];
  readonly syncEdgeRecomputes: { source: string; target: string }[] = [];
  readonly pendingBaselineSeedMarks: string[] = [];

  getApprovedMapping(id: string): Promise<ApprovedMapping | undefined> {
    return Promise.resolve(this.mappings.get(id));
  }
  listFieldMappings(mappingId: string): Promise<readonly FieldMapping[]> {
    return Promise.resolve(this.fieldsByMapping.get(mappingId) ?? []);
  }
  markPendingBaselineSeed(ruleId: string): Promise<void> {
    this.pendingBaselineSeedMarks.push(ruleId);
    return Promise.resolve();
  }
  repointSyncRulesToSuccessor(
    supersededMappingId: string,
    successorMappingId: string,
  ): Promise<readonly SyncRule[]> {
    const moved = (this.rulesByMapping.get(supersededMappingId) ?? []).map((r) => ({
      ...r,
      approvedMappingId: successorMappingId,
    }));
    this.rulesByMapping.set(successorMappingId, [
      ...(this.rulesByMapping.get(successorMappingId) ?? []),
      ...moved,
    ]);
    this.rulesByMapping.set(supersededMappingId, []);
    return Promise.resolve(moved);
  }
  markSuperseded(id: string): Promise<void> {
    this.superseded.push(id);
    const existing = this.mappings.get(id);
    if (existing !== undefined) {
      this.mappings.set(id, { ...existing, status: "superseded" });
    }
    return Promise.resolve();
  }
  setCounterpart(id: string, counterpartMappingId: string | null): Promise<void> {
    this.counterpartSets.push({ id, counterpart: counterpartMappingId });
    const existing = this.mappings.get(id);
    if (existing !== undefined) {
      this.mappings.set(id, {
        ...existing,
        counterpartMappingId: counterpartMappingId ?? undefined,
      });
    }
    return Promise.resolve();
  }
  recomputeSyncEdge(sourceAppId: string, targetAppId: string): Promise<void> {
    this.syncEdgeRecomputes.push({ source: sourceAppId, target: targetAppId });
    return Promise.resolve();
  }
}

interface AdapterAdoptCall {
  readonly supersededMappingId: string;
  readonly successorMappingId: string;
  readonly actor: string;
}

interface SeedCall {
  readonly ruleId: string;
  readonly successorMappingId: string;
}

function buildAdoption(syncOps: FakeAdoptionSyncOps): {
  readonly deps: SuccessorAdoptionDeps<FakeTx>;
  readonly adapterCalls: AdapterAdoptCall[];
  readonly seedCalls: SeedCall[];
} {
  const adapterCalls: AdapterAdoptCall[] = [];
  const seedCalls: SeedCall[] = [];
  const seedAddedFieldBaselines: AddedFieldBaselineSeeder = (input) => {
    seedCalls.push(input);
  };
  const deps: SuccessorAdoptionDeps<FakeTx> = {
    syncOps: () => syncOps,
    adoptAdapter: (input, actor) => {
      adapterCalls.push({ ...input, actor });
      return Promise.resolve();
    },
    seedAddedFieldBaselines,
  };
  return { deps, adapterCalls, seedCalls };
}

/** A loader returning a fixed set of successors/first-time mappings by id. */
function loaderFor(
  byId: ReadonlyMap<string, LoadedApprovedMapping>,
): (id: string, tx: FakeTx) => Promise<LoadedApprovedMapping | undefined> {
  return (id) => Promise.resolve(byId.get(id));
}

describe("successor adoption (SL-7/SL-8) via the MappingApproved consumer", () => {
  it("adopts a peer-peer successor in place: re-points rules, transfers counterpart, supersedes predecessor — no fresh instantiation", async () => {
    const syncOps = new FakeAdoptionSyncOps();
    // Predecessor A->B (stale), with a counterpart B->A, and its two re-pointable rules.
    syncOps.mappings.set("pred", {
      ...approvedMappingFixture({
        id: "pred",
        variant: "peer-peer",
        sourceAppId: "a",
        targetAppId: "b",
      }),
      status: "stale",
      counterpartMappingId: "cp",
    });
    syncOps.mappings.set(
      "cp",
      approvedMappingFixture({
        id: "cp",
        variant: "peer-peer",
        sourceAppId: "b",
        targetAppId: "a",
      }),
    );
    syncOps.rulesByMapping.set("pred", [
      rule("r1", "pred", "a:issues|b:tasks"),
      rule("r2", "pred", "a:comments|b:notes"),
    ]);

    const successor = approvedMappingFixture({
      id: "succ",
      variant: "peer-peer",
      sourceAppId: "a",
      targetAppId: "b",
    });
    const loaded: LoadedApprovedMapping = {
      mapping: { ...successor, predecessorMappingId: "pred" },
      fields: [],
      operations: [],
    };
    syncOps.mappings.set("succ", loaded.mapping);

    const ops = new FakeDownstreamArtifactOps();
    const { deps, adapterCalls } = buildAdoption(syncOps);
    const consumer = new MappingApprovedInstantiationConsumer<FakeTx>({
      load: loaderFor(new Map([["succ", loaded]])),
      ops: () => ops,
      adoption: deps,
      newId: sequentialIds("id"),
    });

    await consumer.handle(mappingApprovedEvent("evt-1", "succ"), fakeTx);

    // Re-pointed both rules to the successor; predecessor superseded.
    expect(
      syncOps.rulesByMapping
        .get("succ")
        ?.map((r) => r.id)
        .sort(),
    ).toEqual(["r1", "r2"]);
    expect(syncOps.rulesByMapping.get("pred")).toEqual([]);
    expect(syncOps.superseded).toEqual(["pred"]);
    // Counterpart pairing transferred to the successor, both directions.
    expect(syncOps.counterpartSets).toContainEqual({ id: "succ", counterpart: "cp" });
    expect(syncOps.counterpartSets).toContainEqual({ id: "cp", counterpart: "succ" });
    // Sync GraphEdge recomputed for the successor's direction.
    expect(syncOps.syncEdgeRecomputes).toEqual([{ source: "a", target: "b" }]);
    // A peer-peer successor drives NO adapter half.
    expect(adapterCalls).toEqual([]);
    // Crucially: NO fresh instantiation happened (the whole point of adoption).
    expect(ops.calls.insertSyncRuleIfAbsent).toBe(0);
    expect(ops.calls.upsertGraphEdge).toBe(0);
  });

  it("drives CO-7 adoptSuccessor for a consumer-provider successor and supersedes the predecessor (no sync re-point)", async () => {
    const syncOps = new FakeAdoptionSyncOps();
    syncOps.mappings.set(
      "pred",
      approvedMappingFixture({
        id: "pred",
        variant: "consumer-provider",
        sourceAppId: "consumer",
        targetAppId: "backend",
      }),
    );
    const successor = {
      ...approvedMappingFixture({
        id: "succ",
        variant: "consumer-provider",
        sourceAppId: "consumer",
        targetAppId: "backend",
      }),
      approvedBy: "reviewer-1",
      predecessorMappingId: "pred",
    };
    syncOps.mappings.set("succ", successor);
    const loaded: LoadedApprovedMapping = { mapping: successor, fields: [], operations: [] };

    const ops = new FakeDownstreamArtifactOps();
    const { deps, adapterCalls } = buildAdoption(syncOps);
    const consumer = new MappingApprovedInstantiationConsumer<FakeTx>({
      load: loaderFor(new Map([["succ", loaded]])),
      ops: () => ops,
      adoption: deps,
      newId: sequentialIds("id"),
    });

    await consumer.handle(mappingApprovedEvent("evt-1", "succ", "consumer-provider"), fakeTx);

    // Adapter half driven with the predecessor->successor ids, attributed to the approver.
    expect(adapterCalls).toEqual([
      { supersededMappingId: "pred", successorMappingId: "succ", actor: "reviewer-1" },
    ]);
    // Predecessor superseded; no sync re-point / counterpart / edge (consumer-provider).
    expect(syncOps.superseded).toEqual(["pred"]);
    expect(syncOps.counterpartSets).toEqual([]);
    expect(syncOps.syncEdgeRecomputes).toEqual([]);
    expect(ops.calls.insertSyncRuleIfAbsent).toBe(0);
  });

  it("freshly instantiates a FIRST-TIME mapping (no predecessorMappingId) — adoption not invoked", async () => {
    const syncOps = new FakeAdoptionSyncOps();
    const firstTime: LoadedApprovedMapping = {
      mapping: approvedMappingFixture({
        id: "m-1",
        variant: "peer-peer",
        sourceAppId: "a",
        targetAppId: "b",
      }),
      fields: [
        {
          id: "f-1",
          mappingId: "m-1",
          sourcePath: "issues/title",
          targetPath: "tasks/title",
          transform: "rename",
        },
      ],
      operations: [],
    };

    const ops = new FakeDownstreamArtifactOps();
    const { deps, adapterCalls } = buildAdoption(syncOps);
    const consumer = new MappingApprovedInstantiationConsumer<FakeTx>({
      load: loaderFor(new Map([["m-1", firstTime]])),
      ops: () => ops,
      adoption: deps,
      newId: sequentialIds("id"),
    });

    await consumer.handle(mappingApprovedEvent("evt-1", "m-1"), fakeTx);

    // Ordinary instantiation ran; NO adoption path touched.
    expect(ops.syncRules).toHaveLength(1);
    expect(ops.calls.upsertGraphEdge).toBe(1);
    expect(adapterCalls).toEqual([]);
    expect(syncOps.superseded).toEqual([]);
    expect(syncOps.rulesByMapping.size).toBe(0);
  });

  it("does not link the counterpart when it is itself already superseded (SL-7.3 cleared)", async () => {
    const syncOps = new FakeAdoptionSyncOps();
    syncOps.mappings.set("pred", {
      ...approvedMappingFixture({
        id: "pred",
        variant: "peer-peer",
        sourceAppId: "a",
        targetAppId: "b",
      }),
      status: "stale",
      counterpartMappingId: "cp",
    });
    // The counterpart is already superseded (its own adoption ran) → do NOT re-link to it.
    syncOps.mappings.set("cp", {
      ...approvedMappingFixture({
        id: "cp",
        variant: "peer-peer",
        sourceAppId: "b",
        targetAppId: "a",
      }),
      status: "superseded",
    });
    syncOps.rulesByMapping.set("pred", [rule("r1", "pred", "a:issues|b:tasks")]);
    const successor = {
      ...approvedMappingFixture({
        id: "succ",
        variant: "peer-peer",
        sourceAppId: "a",
        targetAppId: "b",
      }),
      predecessorMappingId: "pred",
    };
    syncOps.mappings.set("succ", successor);

    const ops = new FakeDownstreamArtifactOps();
    const { deps } = buildAdoption(syncOps);
    const consumer = new MappingApprovedInstantiationConsumer<FakeTx>({
      load: loaderFor(new Map([["succ", { mapping: successor, fields: [], operations: [] }]])),
      ops: () => ops,
      adoption: deps,
      newId: sequentialIds("id"),
    });

    await consumer.handle(mappingApprovedEvent("evt-1", "succ"), fakeTx);

    expect(syncOps.superseded).toEqual(["pred"]);
    expect(syncOps.counterpartSets).toEqual([]);
  });

  it("falls back to fresh instantiation for a successor when no adoption capability is wired", async () => {
    // A Phase-1..5 harness omits `adoption`; a mapping carrying predecessorMappingId cannot
    // arise there, but the guard must not blow up — it instantiates as usual.
    const successor = {
      ...approvedMappingFixture({
        id: "succ",
        variant: "peer-peer",
        sourceAppId: "a",
        targetAppId: "b",
      }),
      predecessorMappingId: "pred",
    };
    const ops = new FakeDownstreamArtifactOps();
    const consumer = new MappingApprovedInstantiationConsumer<FakeTx>({
      load: loaderFor(
        new Map([
          [
            "succ",
            {
              mapping: successor,
              fields: [
                {
                  id: "f-1",
                  mappingId: "succ",
                  sourcePath: "issues/title",
                  targetPath: "tasks/title",
                  transform: "rename",
                },
              ],
              operations: [],
            },
          ],
        ]),
      ),
      ops: () => ops,
      newId: sequentialIds("id"),
    });

    await consumer.handle(mappingApprovedEvent("evt-1", "succ"), fakeTx);
    expect(ops.syncRules).toHaveLength(1);
  });

  it("SL-8.5 — enqueues an added-field baseline seed only for a re-pointed rule whose successor ADDS a field pair", async () => {
    const syncOps = new FakeAdoptionSyncOps();
    const issuesPair = canonicalResourcePairRef(
      { appId: "a", resourceRef: "issues" },
      { appId: "b", resourceRef: "tasks" },
    );
    const commentsPair = canonicalResourcePairRef(
      { appId: "a", resourceRef: "comments" },
      { appId: "b", resourceRef: "notes" },
    );
    syncOps.mappings.set("pred", {
      ...approvedMappingFixture({
        id: "pred",
        variant: "peer-peer",
        sourceAppId: "a",
        targetAppId: "b",
      }),
      status: "stale",
    });
    // Predecessor covered issues↔tasks (title) and comments↔notes (body).
    syncOps.fieldsByMapping.set("pred", [
      fieldMappingFixture({
        id: "p-f1",
        mappingId: "pred",
        sourcePath: "issues/title",
        targetPath: "tasks/title",
      }),
      fieldMappingFixture({
        id: "p-f2",
        mappingId: "pred",
        sourcePath: "comments/body",
        targetPath: "notes/text",
      }),
    ]);
    syncOps.rulesByMapping.set("pred", [
      rule("r-issues", "pred", issuesPair),
      rule("r-comments", "pred", commentsPair),
    ]);

    const successor = {
      ...approvedMappingFixture({
        id: "succ",
        variant: "peer-peer",
        sourceAppId: "a",
        targetAppId: "b",
      }),
      predecessorMappingId: "pred",
    };
    syncOps.mappings.set("succ", successor);
    // The successor ADDS issues/body → tasks/description (a new pair in issues↔tasks); the
    // issues/title pair and the whole comments↔notes pair are carried forward unchanged.
    const successorFields: FieldMapping[] = [
      fieldMappingFixture({
        id: "s-f1",
        mappingId: "succ",
        sourcePath: "issues/title",
        targetPath: "tasks/title",
      }),
      fieldMappingFixture({
        id: "s-f2",
        mappingId: "succ",
        sourcePath: "issues/body",
        targetPath: "tasks/description",
      }),
      fieldMappingFixture({
        id: "s-f3",
        mappingId: "succ",
        sourcePath: "comments/body",
        targetPath: "notes/text",
      }),
    ];
    const loaded: LoadedApprovedMapping = {
      mapping: successor,
      fields: successorFields,
      operations: [],
    };

    const ops = new FakeDownstreamArtifactOps();
    const { deps, seedCalls } = buildAdoption(syncOps);
    const consumer = new MappingApprovedInstantiationConsumer<FakeTx>({
      load: loaderFor(new Map([["succ", loaded]])),
      ops: () => ops,
      adoption: deps,
      newId: sequentialIds("id"),
    });

    await consumer.handle(mappingApprovedEvent("evt-1", "succ"), fakeTx);

    // ONLY the issues rule (whose pair gained a field) is seeded — the comments rule (no added
    // pair) enqueues nothing — and the seed resolves against the successor mapping.
    expect(seedCalls).toEqual([{ ruleId: "r-issues", successorMappingId: "succ" }]);
    // The DURABLE seed-intent was persisted (in the adoption tx) for exactly that rule — the
    // recovery record the reconciler drains if the async seed aborts/crashes.
    expect(syncOps.pendingBaselineSeedMarks).toEqual(["r-issues"]);
    // Adoption still re-pointed both rules + superseded the predecessor (the seed is additive).
    expect(syncOps.superseded).toEqual(["pred"]);
  });

  it("SL-8.5 — a successor that adds NO field pair enqueues no baseline seed", async () => {
    const syncOps = new FakeAdoptionSyncOps();
    const issuesPair = canonicalResourcePairRef(
      { appId: "a", resourceRef: "issues" },
      { appId: "b", resourceRef: "tasks" },
    );
    syncOps.mappings.set("pred", {
      ...approvedMappingFixture({
        id: "pred",
        variant: "peer-peer",
        sourceAppId: "a",
        targetAppId: "b",
      }),
      status: "stale",
    });
    syncOps.fieldsByMapping.set("pred", [
      fieldMappingFixture({
        id: "p-f1",
        mappingId: "pred",
        sourcePath: "issues/title",
        targetPath: "tasks/title",
      }),
    ]);
    syncOps.rulesByMapping.set("pred", [rule("r-issues", "pred", issuesPair)]);

    const successor = {
      ...approvedMappingFixture({
        id: "succ",
        variant: "peer-peer",
        sourceAppId: "a",
        targetAppId: "b",
      }),
      predecessorMappingId: "pred",
    };
    syncOps.mappings.set("succ", successor);
    // The successor covers the SAME field pair (its identity `(sourcePath, targetPath, phase)` is
    // unchanged — e.g. only a transform tweak) → nothing added → no seed.
    const successorFields: FieldMapping[] = [
      fieldMappingFixture({
        id: "s-f1",
        mappingId: "succ",
        sourcePath: "issues/title",
        targetPath: "tasks/title",
      }),
    ];
    const loaded: LoadedApprovedMapping = {
      mapping: successor,
      fields: successorFields,
      operations: [],
    };

    const ops = new FakeDownstreamArtifactOps();
    const { deps, seedCalls } = buildAdoption(syncOps);
    const consumer = new MappingApprovedInstantiationConsumer<FakeTx>({
      load: loaderFor(new Map([["succ", loaded]])),
      ops: () => ops,
      adoption: deps,
      newId: sequentialIds("id"),
    });

    await consumer.handle(mappingApprovedEvent("evt-1", "succ"), fakeTx);

    expect(seedCalls).toEqual([]);
    // No added pair → no durable seed-intent persisted either.
    expect(syncOps.pendingBaselineSeedMarks).toEqual([]);
    expect(syncOps.superseded).toEqual(["pred"]);
  });
});
