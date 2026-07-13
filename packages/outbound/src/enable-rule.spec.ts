import type {
  AppCapabilities,
  BackfillMode,
  ConfirmableRef,
  FieldMapping,
  IrRefTarget,
  OperationMapping,
  ResourceBinding,
  SyncRule,
} from "@mediator/domain";
import {
  FakePollStateStore,
  FakeSourceReader,
  type EnablementInput,
  type ResolutionContext,
} from "@mediator/sync-engine";
import { beforeEach, describe, expect, it } from "vitest";

import type {
  BackfillRunInput,
  BackfillRunResult,
  LinkOnlyBackfillContext,
} from "./backfill-runner.js";
import {
  FakeSyncRuleEnableStore,
  RuleEnabler,
  type BackfillRunnerPort,
  type CounterpartBackfillModeLookup,
  type EnableRuleInput,
} from "./enable-rule.js";

/**
 * BE-3 (enable triggers the one-time backfill; status transitions), BE-5.3
 * (at-most-one-push), BE-4.6 (no collectionReadRef → only-skippable), and BE-6 (what
 * enablement seeds — snapshot, the deliberately-early cursor, and `lastRunAt`) for the
 * {@link RuleEnabler}. Driven with fakes + a fake clock (no LLM, no landscape, no DB).
 * A **fake** backfill runner is used here so the orchestration/seeding is isolated from
 * the runner's own BE-4/BE-5 behavior (that is covered in `backfill-runner.spec.ts`).
 */

const RULE = "rule-1";
const MAP = "map-1";
const T0 = new Date("2026-07-13T00:00:00.000Z");

// ── EnablementInput builders (mirrors enablement-gate.spec.ts) ─────────────────

function confirmed(value: IrRefTarget): ConfirmableRef {
  return { value, confirmedBy: "op-alice", confirmedAt: T0 };
}
const opTarget = (operationId: string): IrRefTarget => ({ kind: "operation", operationId });
const fieldTarget = (path: string): IrRefTarget => ({ kind: "field", path });
const paramTarget = (operationId: string, parameter: string): IrRefTarget => ({
  kind: "parameter",
  operationId,
  parameter,
});

const identityKey: FieldMapping = {
  id: "fm-email",
  mappingId: MAP,
  sourcePath: "email",
  targetPath: "email",
  transform: "rename",
  isIdentityKey: true,
  targetLookupParamRef: "emailFilter",
};
const plainField: FieldMapping = {
  id: "fm-name",
  mappingId: MAP,
  sourcePath: "name",
  targetPath: "name",
  transform: "rename",
};
const createOp: OperationMapping = {
  id: "om-create",
  mappingId: MAP,
  sourceOperationRef: "src.create",
  targetOperationRef: "tgt.create",
  action: "create",
};
const updateOp: OperationMapping = {
  id: "om-update",
  mappingId: MAP,
  sourceOperationRef: "src.update",
  targetOperationRef: "tgt.update",
  action: "update",
  targetIdParamRef: "id",
};

const capabilities = (overrides: Partial<AppCapabilities> = {}): AppCapabilities => ({
  supportsPolling: true,
  supportsDeltaQuery: false,
  supportsChangeTimestamps: false,
  defaultPollInterval: 60_000,
  ...overrides,
});

function makeRule(overrides: Partial<SyncRule> = {}): SyncRule {
  return {
    id: RULE,
    approvedMappingId: MAP,
    resourcePairRef: "pair-1",
    status: "disabled",
    pollOperationRef: "src.list",
    deletePropagation: "ignore",
    backfillMode: "link-only",
    backfillStatus: "pending",
    ...overrides,
  };
}

function fullFetchSourceBinding(overrides: Partial<ResourceBinding> = {}): ResourceBinding {
  return {
    id: "rb-src",
    apiSpecId: "spec-src",
    resourceRef: "users",
    nativeIdRef: confirmed(fieldTarget("id")),
    collectionReadRef: confirmed(opTarget("src.list")),
    paginationRef: confirmed(paramTarget("src.list", "page")),
    ...overrides,
  };
}

function targetBinding(overrides: Partial<ResourceBinding> = {}): ResourceBinding {
  return {
    id: "rb-tgt",
    apiSpecId: "spec-tgt",
    resourceRef: "users",
    nativeIdRef: confirmed(fieldTarget("id")),
    collectionReadRef: confirmed(opTarget("tgt.list")),
    ...overrides,
  };
}

function validInput(overrides: Partial<EnablementInput> = {}): EnablementInput {
  return {
    rule: makeRule(),
    fieldMappings: [identityKey, plainField],
    operationMappings: [createOp, updateOp],
    sourceBinding: fullFetchSourceBinding(),
    targetBinding: targetBinding(),
    sourceCapabilities: capabilities(),
    targetCapabilities: capabilities(),
    backfillSkipped: false,
    ...overrides,
  };
}

// ── Backfill context/input (unused by the fake runner, required by the type) ──

function linkOnlyContext(): LinkOnlyBackfillContext {
  const resolution: ResolutionContext = {
    appAId: "app-A",
    appBId: "app-B",
    identitySourcePath: "email",
    identityTargetPath: "email",
    targetLookup: { kind: "none" },
    hasApprovedCreateOperation: true,
    fieldMappings: [identityKey, plainField],
  };
  return {
    ruleId: RULE,
    mappingId: MAP,
    sourceAppId: "app-A",
    targetAppId: "app-B",
    resourcePairRef: "pair-1",
    resolution,
    fieldMappings: [identityKey, plainField],
  };
}

function backfillInput(mode: BackfillMode = "link-only"): BackfillRunInput {
  // `push` never actually runs here (the fake runner is used); a link-only context
  // satisfies the type for the mode-agnostic orchestration tests.
  return mode === "push"
    ? {
        mode: "push",
        context: {
          ...linkOnlyContext(),
          loopPrevention: { appAId: "app-A", appBId: "app-B", directions: [] },
          targetBaseUrl: "https://b.test",
          targetResourceNativeIdRef: { kind: "field", path: "id" },
          targetResourceRef: "app-B:users",
        },
      }
    : { mode: "link-only", context: linkOnlyContext() };
}

// ── Fakes ──────────────────────────────────────────────────────────────────

const COMPLETED_FULL_FETCH: BackfillRunResult = {
  outcome: "completed",
  mode: "link-only",
  enumeratedCount: 2,
  snapshotEntries: new Map([
    ["a1", "hash-1"],
    ["a2", "hash-2"],
  ]),
  records: [],
  counts: {
    matched: 0,
    unmatched: 2,
    created: 0,
    overwritten: 0,
    ambiguous: 0,
    severed: 0,
    skipped: 0,
    writeFailed: 0,
    disagreedFields: 0,
  },
};

/** A fake backfill runner returning a canned result; records the clock at run() entry (BE-6.5). */
class FakeBackfillRunner implements BackfillRunnerPort {
  public readonly calls: BackfillRunInput[] = [];
  public enumerationStartedAt: Date | undefined;
  readonly #result: BackfillRunResult;
  readonly #clock: () => Date;

  public constructor(result: BackfillRunResult, clock: () => Date) {
    this.#result = result;
    this.#clock = clock;
  }

  public run(input: BackfillRunInput): Promise<BackfillRunResult> {
    this.calls.push(input);
    // The moment enumeration begins — the seeded changed-since cursor must be ≤ this.
    this.enumerationStartedAt = this.#clock();
    return Promise.resolve(this.#result);
  }
}

class FakeCounterpart implements CounterpartBackfillModeLookup {
  public constructor(private readonly mode: BackfillMode | undefined) {}
  public getCounterpartBackfillMode(): Promise<BackfillMode | undefined> {
    return Promise.resolve(this.mode);
  }
}

/** A clock that returns strictly increasing Dates (one step per call) — for BE-6.5. */
function monotonicClock(base: Date, stepMs = 1000): () => Date {
  let n = 0;
  return (): Date => {
    const at = new Date(base.getTime() + n * stepMs);
    n += 1;
    return at;
  };
}

interface Harness {
  readonly rules: FakeSyncRuleEnableStore;
  readonly pollState: FakePollStateStore;
  readonly runner: FakeBackfillRunner;
  readonly sourceReader: FakeSourceReader;
  readonly enabler: RuleEnabler;
}

function setup(
  opts: {
    result?: BackfillRunResult;
    counterpart?: BackfillMode | undefined;
    clock?: () => Date;
  } = {},
): Harness {
  const clock = opts.clock ?? ((): Date => T0);
  const rules = new FakeSyncRuleEnableStore({ status: "disabled", backfillStatus: "pending" });
  const pollState = new FakePollStateStore();
  const runner = new FakeBackfillRunner(opts.result ?? COMPLETED_FULL_FETCH, clock);
  const sourceReader = new FakeSourceReader();
  const enabler = new RuleEnabler(
    {
      rules,
      pollState,
      backfillRunner: runner,
      sourceReader,
      counterpart: new FakeCounterpart(opts.counterpart),
    },
    { clock },
  );
  return { rules, pollState, runner, sourceReader, enabler };
}

function input(overrides: Partial<EnableRuleInput> = {}): EnableRuleInput {
  return {
    enablement: validInput(),
    backfill: backfillInput(),
    pollSeed: { kind: "full-fetch" },
    ...overrides,
  };
}

beforeEach(() => {
  /* fresh fakes per test via setup() */
});

// ── BE-3: enable triggers the backfill; polling held until done/skipped ────────

describe("BE-3 enable orchestration", () => {
  it("BE-3: a blocked rule returns `stillNeeds` and does NOTHING (no transition, no backfill, no seed)", async () => {
    const h = setup();
    // Remove the identity key → the gate blocks (the hard identity gate, BE-1.1).
    const result = await h.enabler.enable(
      input({ enablement: validInput({ fieldMappings: [plainField] }) }),
    );

    expect(result.kind).toBe("blocked");
    if (result.kind !== "blocked") return;
    expect(result.stillNeeds.some((r) => r.kind === "identity-key")).toBe(true);
    expect(h.rules.transitions).toStrictEqual([]);
    expect(h.runner.calls).toStrictEqual([]);
    expect(h.pollState.stateOf(RULE)).toBeUndefined();
  });

  it("BE-3.1: enable → running → completed (backfill runs, polling held meanwhile)", async () => {
    const h = setup();
    const result = await h.enabler.enable(input());

    expect(result.kind).toBe("enabled");
    if (result.kind !== "enabled") return;
    expect(result.backfill.kind).toBe("ran");
    expect(h.runner.calls).toHaveLength(1);
    // The rule flips enabled+running (SP-1 holds polling) BEFORE the run, then completed AFTER.
    expect(h.rules.transitions).toStrictEqual([
      { status: "enabled", backfillStatus: "running" },
      { backfillStatus: "completed" },
    ]);
    expect(h.rules.status).toBe("enabled");
    expect(h.rules.backfillStatus).toBe("completed");
  });

  it("BE-3.1: an EXPLICIT skip → `skipped` (no backfill run), poll state still seeded", async () => {
    const h = setup();
    const result = await h.enabler.enable(
      input({ enablement: validInput({ backfillSkipped: true }) }),
    );

    expect(result.kind).toBe("enabled");
    if (result.kind !== "enabled") return;
    expect(result.backfill.kind).toBe("skipped");
    expect(h.runner.calls).toStrictEqual([]); // backfill NOT run
    expect(h.rules.transitions).toStrictEqual([{ status: "enabled", backfillStatus: "skipped" }]);
    // `lastRunAt` is still seeded at go-live (BE-6) even on a skip.
    expect(h.pollState.stateOf(RULE)?.lastRunAt).toStrictEqual(T0);
    // A full-fetch rule skipped → the first poll seeds the snapshot, not enablement (BE-6.2).
    expect(h.pollState.stateOf(RULE)?.snapshotRef).toBeUndefined();
  });

  it("BE-3.1: seeds the poll state BEFORE flipping backfillStatus to completed (SP-1 never sees completed over an unseeded cursor)", async () => {
    const h = setup();
    await h.enabler.enable(input());
    // The advance ran, and the completed flip is the LAST transition.
    expect(h.pollState.stateOf(RULE)?.advanceCount).toBe(1);
    expect(h.rules.transitions.at(-1)).toStrictEqual({ backfillStatus: "completed" });
  });
});

// ── BE-5.3: at-most-one-push ───────────────────────────────────────────────────

describe("BE-5.3 at-most-one-push", () => {
  it("rejects `push` when the counterpart direction also uses `push`", async () => {
    const h = setup({ counterpart: "push" });
    const result = await h.enabler.enable(
      input({
        enablement: validInput({ rule: makeRule({ backfillMode: "push" }) }),
        backfill: backfillInput("push"),
      }),
    );

    expect(result).toStrictEqual({ kind: "rejected", reason: "counterpart-also-push" });
    expect(h.rules.transitions).toStrictEqual([]); // nothing changed
    expect(h.runner.calls).toStrictEqual([]);
  });

  it("allows `push` when the counterpart is link-only", async () => {
    const h = setup({ counterpart: "link-only" });
    const result = await h.enabler.enable(
      input({
        enablement: validInput({ rule: makeRule({ backfillMode: "push" }) }),
        backfill: backfillInput("push"),
      }),
    );
    expect(result.kind).toBe("enabled");
    expect(h.runner.calls).toHaveLength(1);
  });
});

// ── BE-4.6: a delta rule with no collectionReadRef → only-skippable ────────────

describe("BE-4.6 no collectionReadRef → only-skippable", () => {
  function deltaNoCollectionRead(backfillSkipped: boolean): EnablementInput {
    // Delta-polling source (supportsDeltaQuery + confirmed deltaCursorRef) with NO
    // collectionReadRef — backfill enumeration cannot run.
    return validInput({
      sourceCapabilities: capabilities({ supportsDeltaQuery: true }),
      sourceBinding: {
        id: "rb-src",
        apiSpecId: "spec-src",
        resourceRef: "users",
        nativeIdRef: confirmed(fieldTarget("id")),
        deltaCursorRef: confirmed(paramTarget("src.delta", "since")),
        // collectionReadRef deliberately ABSENT
      },
      backfillSkipped,
    });
  }

  it("blocks a non-skipped enable (the backfill would need to enumerate)", async () => {
    const h = setup();
    const result = await h.enabler.enable(
      input({
        enablement: deltaNoCollectionRead(false),
        pollSeed: { kind: "delta-changed-since" },
      }),
    );
    expect(result.kind).toBe("blocked");
    if (result.kind !== "blocked") return;
    expect(
      result.stillNeeds.some((r) => r.kind === "binding-ref" && r.ref === "collectionReadRef"),
    ).toBe(true);
    expect(h.runner.calls).toStrictEqual([]);
  });

  it("allows an EXPLICITLY skipped enable (no enumeration needed)", async () => {
    const h = setup();
    const result = await h.enabler.enable(
      input({
        enablement: deltaNoCollectionRead(true),
        pollSeed: { kind: "delta-changed-since" },
      }),
    );
    expect(result.kind).toBe("enabled");
    if (result.kind !== "enabled") return;
    expect(result.backfill.kind).toBe("skipped");
  });
});

// ── BE-6: what enablement seeds ───────────────────────────────────────────────

describe("BE-6 enablement seeding", () => {
  it("BE-6.1: a full-fetch rule seeds lastSnapshotRef from the backfill's complete enumeration", async () => {
    const h = setup();
    await h.enabler.enable(input({ pollSeed: { kind: "full-fetch" } }));

    const state = h.pollState.stateOf(RULE);
    expect(state?.snapshotRef).toBeDefined();
    expect(state?.entries.get("a1")).toBe("hash-1");
    expect(state?.entries.get("a2")).toBe("hash-2");
    expect(state?.cursor).toBeUndefined(); // a full-fetch rule has no delta cursor
    expect(state?.lastRunAt).toStrictEqual(T0); // BE-6: lastRunAt seeded at go-live
  });

  it("BE-6.4: a changed-since delta rule seeds the cursor at the early timestamp (no snapshot)", async () => {
    const h = setup();
    await h.enabler.enable(input({ pollSeed: { kind: "delta-changed-since" } }));

    const state = h.pollState.stateOf(RULE);
    expect(state?.cursor).toBe(T0.toISOString());
    expect(state?.snapshotRef).toBeUndefined(); // delta rule: no snapshot seeded
    expect(state?.lastRunAt).toStrictEqual(T0);
  });

  it("BE-6.3: a cursor-returning delta rule seeds the cursor from the initialization call", async () => {
    const h = setup();
    h.sourceReader.setDelta(RULE, [{ nextCursor: "cursor-42" }]);
    await h.enabler.enable(input({ pollSeed: { kind: "delta-cursor-returning" } }));

    expect(h.pollState.stateOf(RULE)?.cursor).toBe("cursor-42");
  });

  it("BE-6.5 (HARD invariant): the seeded changed-since cursor is ≤ the moment enumeration began", async () => {
    // A strictly-increasing clock: enableRule's single early capture is BEFORE the
    // runner's enumeration, so no later time can leak into the seeded cursor.
    const clock = monotonicClock(T0, 1000);
    const h = setup({ clock });
    await h.enabler.enable(input({ pollSeed: { kind: "delta-changed-since" } }));

    const state = h.pollState.stateOf(RULE);
    const seededCursorMs = Date.parse(state?.cursor ?? "");
    const enumerationStartedMs = h.runner.enumerationStartedAt?.getTime() ?? 0;
    expect(Number.isNaN(seededCursorMs)).toBe(false);
    // The seeded cursor is the deliberately-early capture, strictly before enumeration.
    expect(seededCursorMs).toBeLessThanOrEqual(enumerationStartedMs);
    expect(seededCursorMs).toBe(T0.getTime());
  });

  it("BE-6: a backfill abort leaves the rule enabled+running (no seed, no completed flip) — retriable", async () => {
    const aborted: BackfillRunResult = {
      outcome: "aborted",
      mode: "link-only",
      reason: "page 2 timed out",
      enumeratedCount: 1,
    };
    const h = setup({ result: aborted });
    const result = await h.enabler.enable(input());

    expect(result.kind).toBe("backfill-aborted");
    // Flipped to running, but NEVER to completed; poll state was not seeded.
    expect(h.rules.transitions).toStrictEqual([{ status: "enabled", backfillStatus: "running" }]);
    expect(h.rules.backfillStatus).toBe("running");
    expect(h.pollState.stateOf(RULE)).toBeUndefined();
  });
});
