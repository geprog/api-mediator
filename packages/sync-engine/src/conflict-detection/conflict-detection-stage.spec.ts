import type { RecordLink, SyncFieldState } from "@mediator/domain";
import type { JsonValue } from "@mediator/transform";
import { describe, expect, it } from "vitest";

import { FakeSyncEventRecorder, FakeSyncFieldStateStore } from "../identity-resolution/fakes.js";
import { hashFieldValue } from "../identity-resolution/hash.js";
import type { DetectedChange } from "../identity-resolution/types.js";
import { ConflictDetectionStage, DEFAULT_CONFLICT_EPSILON_MS } from "./conflict-detection-stage.js";
import { FakeConflictDetectionMetrics, FakeSingleRecordTargetReader } from "./fakes.js";
import type {
  ConflictDetectionContext,
  ConflictDetectionOutcome,
  DeletionConflictContext,
  FieldPlan,
  SingleRecordReadBinding,
  WithholdFieldPlan,
} from "./types.js";

/**
 * Unit tests for the Conflict Detection stage (CF-1..CF-7), over hand-seeded
 * `SyncFieldState` rows + a fake single-record target reader + PATCH/PUT op fixtures.
 * No LLM, no landscape. The spec's three explicit **hard invariants** each have a
 * named test: target-wins withholds and leaves both baselines untouched (CF-4.6), a
 * PUT withhold carries the target's current value not the source's (CF-5.4), and a
 * propagated delete against a drifted target parks with no delete (CF-7.6).
 *
 * The direction under test is A→B: the change's source app is A (side A), the write
 * lands on B (side B). So target-side rows are side `B`, source-side rows are side `A`.
 */

const RULE_ID = "rule-1";
const MAPPING_ID = "map-A-to-B";
const LINK_ID = "link-1";
const PAIR = "pair-1";
const APP_A = "appA";
const APP_B = "appB";
const B_NATIVE = "b1";

const T0 = new Date("2026-07-13T00:00:00.000Z");
const T_EARLY = new Date("2026-07-13T00:00:00.000Z");
const T_LATE = new Date("2026-07-13T01:00:00.000Z");
const NOW = new Date("2026-07-13T12:00:00.000Z");

const READ_BINDING: SingleRecordReadBinding = { readOperationId: "getB", idParamRef: "id" };

interface Harness {
  readonly stage: ConflictDetectionStage;
  readonly fieldState: FakeSyncFieldStateStore;
  readonly events: FakeSyncEventRecorder;
  readonly metrics: FakeConflictDetectionMetrics;
  readonly reader: FakeSingleRecordTargetReader;
}

let idCounter = 0;

function harness(epsilonMs = DEFAULT_CONFLICT_EPSILON_MS): Harness {
  const fieldState = new FakeSyncFieldStateStore();
  const events = new FakeSyncEventRecorder();
  const metrics = new FakeConflictDetectionMetrics();
  const reader = new FakeSingleRecordTargetReader();
  idCounter = 0;
  const stage = new ConflictDetectionStage(
    { fieldState, events, targetReader: reader },
    {
      metrics,
      clock: (): Date => NOW,
      newId: (): string => `evt-${String(++idCounter)}`,
      epsilonMs,
    },
  );
  return { stage, fieldState, events, metrics, reader };
}

function makeChange(overrides: Partial<DetectedChange> = {}): DetectedChange {
  return {
    ruleId: RULE_ID,
    mappingId: MAPPING_ID,
    sourceAppId: APP_A,
    targetAppId: APP_B,
    resourcePairRef: PAIR,
    sourceNativeId: "a1",
    changeKind: "update",
    observedRecord: { name: "new-source" },
    ...overrides,
  };
}

function makeLink(overrides: Partial<RecordLink> = {}): RecordLink {
  return {
    id: LINK_ID,
    appAId: APP_A,
    appANativeId: "a1",
    appBId: APP_B,
    appBNativeId: B_NATIVE,
    resourcePairRef: PAIR,
    establishedBy: "identity-match",
    status: "active",
    establishingQueueKey: { kind: "identity-value", value: "a@x.com" },
    createdAt: T0,
    tombstonedAt: null,
    ...overrides,
  };
}

/**
 * A per-side-field `SyncFieldState` row. `baseline` omitted → a **divergent seed**
 * (no `lastSyncedHash`); `baseline` !== `observed` → the side has **drifted**.
 */
function fieldRow(params: {
  side: "A" | "B";
  fieldPath: string;
  observed: JsonValue;
  baseline?: JsonValue;
  observedAt?: Date;
  changeTs?: Date | null;
}): SyncFieldState {
  const base = {
    id: `sfs-${params.side}-${params.fieldPath}`,
    recordLinkId: LINK_ID,
    side: params.side,
    fieldPath: params.fieldPath,
    observedHash: hashFieldValue(params.observed),
    observedAt: params.observedAt ?? T0,
    observedChangeTimestamp: params.changeTs ?? null,
    status: "active" as const,
  };
  return params.baseline === undefined
    ? base
    : { ...base, lastSyncedHash: hashFieldValue(params.baseline), lastSyncedAt: T0 };
}

function writeContext(overrides: Partial<ConflictDetectionContext> = {}): ConflictDetectionContext {
  return {
    appAId: APP_A,
    appBId: APP_B,
    fields: [{ targetPath: "name", sourcePath: "name" }],
    writeShape: "patch",
    targetDriftCheck: "none",
    changeTimestampsComparable: false,
    ...overrides,
  };
}

function deleteContext(overrides: Partial<DeletionConflictContext> = {}): DeletionConflictContext {
  return {
    appAId: APP_A,
    appBId: APP_B,
    deletePropagation: "propagate",
    targetDriftCheck: "none",
    targetFields: ["name"],
    ...overrides,
  };
}

function planFor(outcome: ConflictDetectionOutcome, targetPath: string): FieldPlan | undefined {
  return outcome.kind === "write"
    ? outcome.fields.find((field) => field.targetPath === targetPath)
    : undefined;
}

// ── CF-1: detect drift over observed state ────────────────────────────────────

describe("CF-1 drift detection over observed state", () => {
  it("no drift (observed == baseline) → writes every field, records no conflict, reads nothing", async () => {
    const { stage, fieldState, events, metrics, reader } = harness();
    await fieldState.seed([
      fieldRow({ side: "B", fieldPath: "name", baseline: "same", observed: "same" }),
      fieldRow({ side: "A", fieldPath: "name", baseline: "same", observed: "new-source" }),
    ]);

    const outcome = await stage.detect({
      change: makeChange(),
      link: makeLink(),
      context: writeContext(),
    });

    expect(outcome.kind).toBe("write");
    expect(planFor(outcome, "name")).toEqual({ kind: "write", targetPath: "name" });
    expect(outcome.kind === "write" && outcome.conflict).toBeUndefined();
    expect(events.all()).toHaveLength(0);
    expect(metrics.conflicts).toHaveLength(0);
    // CF-1.2: the default `none` + PATCH path reads the target NOT AT ALL.
    expect(reader.calls).toHaveLength(0);
  });

  it("target drifted (observed != baseline) → conflict, recorded `conflict`, metric emitted per rule", async () => {
    const { stage, fieldState, events, metrics } = harness();
    await fieldState.seed([
      // Target drifted: baseline "reconciled", now observed "target-edit".
      fieldRow({
        side: "B",
        fieldPath: "name",
        baseline: "reconciled",
        observed: "target-edit",
        observedAt: T_EARLY,
      }),
      // Source change observed later → source wins by observation order.
      fieldRow({
        side: "A",
        fieldPath: "name",
        baseline: "reconciled",
        observed: "new-source",
        observedAt: T_LATE,
      }),
    ]);

    const outcome = await stage.detect({
      change: makeChange(),
      link: makeLink(),
      context: writeContext(),
    });

    expect(outcome.kind).toBe("write");
    const event = events.all()[0];
    expect(event?.status).toBe("conflict");
    expect(event?.relatedRuleId).toBe(RULE_ID);
    expect(event?.recordLinkId).toBe(LINK_ID);
    expect(metrics.conflicts).toEqual([RULE_ID]);
  });

  it("absent baseline (divergent seed) → the first change is a conflict by construction", async () => {
    const { stage, fieldState, events } = harness();
    await fieldState.seed([
      fieldRow({ side: "B", fieldPath: "name", observed: "b-value", observedAt: T_EARLY }), // no baseline
      fieldRow({ side: "A", fieldPath: "name", observed: "new-source", observedAt: T_LATE }),
    ]);

    const outcome = await stage.detect({
      change: makeChange(),
      link: makeLink(),
      context: writeContext(),
    });

    expect(outcome.kind === "write" && outcome.conflict?.resolutions[0]?.targetPath).toBe("name");
    expect(events.all()[0]?.status).toBe("conflict");
  });

  it("records one conflict event (and one metric) for an execution with two contested fields", async () => {
    const { stage, fieldState, events, metrics } = harness();
    await fieldState.seed([
      fieldRow({
        side: "B",
        fieldPath: "name",
        baseline: "r1",
        observed: "drift1",
        observedAt: T_EARLY,
      }),
      fieldRow({
        side: "B",
        fieldPath: "title",
        baseline: "r2",
        observed: "drift2",
        observedAt: T_EARLY,
      }),
      fieldRow({ side: "A", fieldPath: "name", observed: "s1", observedAt: T_LATE }),
      fieldRow({ side: "A", fieldPath: "title", observed: "s2", observedAt: T_LATE }),
    ]);

    await stage.detect({
      change: makeChange(),
      link: makeLink(),
      context: writeContext({
        fields: [
          { targetPath: "name", sourcePath: "name" },
          { targetPath: "title", sourcePath: "title" },
        ],
      }),
    });

    expect(events.all()).toHaveLength(1);
    expect(metrics.conflicts).toEqual([RULE_ID]);
  });
});

// ── CF-2: last-write-wins with epsilon fallback to observation order ───────────

describe("CF-2 auto-resolution policy", () => {
  async function resolveWith(params: {
    comparable: boolean;
    sourceChangeTs: Date | null;
    targetChangeTs: Date | null;
    sourceObservedAt: Date;
    targetObservedAt: Date;
    epsilonMs?: number;
  }): Promise<"source-wins" | "target-wins" | "manual-park" | undefined> {
    const h = harness(params.epsilonMs);
    await h.fieldState.seed([
      fieldRow({
        side: "B",
        fieldPath: "name",
        baseline: "reconciled",
        observed: "target-edit",
        observedAt: params.targetObservedAt,
        changeTs: params.targetChangeTs,
      }),
      fieldRow({
        side: "A",
        fieldPath: "name",
        observed: "new-source",
        observedAt: params.sourceObservedAt,
        changeTs: params.sourceChangeTs,
      }),
    ]);
    const outcome = await h.stage.detect({
      change: makeChange(),
      link: makeLink(),
      context: writeContext({ changeTimestampsComparable: params.comparable }),
    });
    // A single contested field withheld yields a `no-call` outcome; both outcome kinds
    // carry the `conflict` record with the field's resolution.
    return outcome.conflict?.resolutions[0]?.outcome;
  }

  it("LWW picks the newer observedChangeTimestamp (source newer → source wins)", async () => {
    const outcome = await resolveWith({
      comparable: true,
      sourceChangeTs: T_LATE,
      targetChangeTs: T_EARLY,
      // Observation order would say TARGET (later observedAt) — proving the timestamp decided, not order.
      sourceObservedAt: T_EARLY,
      targetObservedAt: T_LATE,
    });
    expect(outcome).toBe("source-wins");
  });

  it("LWW picks the newer observedChangeTimestamp (target newer → target wins)", async () => {
    const outcome = await resolveWith({
      comparable: true,
      sourceChangeTs: T_EARLY,
      targetChangeTs: T_LATE,
      sourceObservedAt: T_LATE, // observation order would say SOURCE — timestamp overrides it
      targetObservedAt: T_EARLY,
    });
    expect(outcome).toBe("target-wins");
  });

  it("epsilon tie → inconclusive → falls back to observation order", async () => {
    const base = new Date("2026-07-13T03:00:00.000Z");
    const outcome = await resolveWith({
      comparable: true,
      // Source timestamp is 1s OLDER than target — but within the 2s epsilon → inconclusive.
      sourceChangeTs: new Date(base.getTime() - 1000),
      targetChangeTs: base,
      // Observation order says SOURCE (observed later) → source wins despite the older timestamp.
      sourceObservedAt: T_LATE,
      targetObservedAt: T_EARLY,
      epsilonMs: 2000,
    });
    expect(outcome).toBe("source-wins");
  });

  it("timestamps not comparable (capability/ref absent) → observation order is the policy", async () => {
    const outcome = await resolveWith({
      comparable: false,
      // Timestamps present but IGNORED: source is much newer, yet observation order decides.
      sourceChangeTs: T_LATE,
      targetChangeTs: T_EARLY,
      sourceObservedAt: T_EARLY, // observed earlier than target → target wins
      targetObservedAt: T_LATE,
    });
    expect(outcome).toBe("target-wins");
  });

  it("every auto-resolution — even source-wins — is recorded `conflict`", async () => {
    const { stage, fieldState, events } = harness();
    await fieldState.seed([
      fieldRow({
        side: "B",
        fieldPath: "name",
        baseline: "reconciled",
        observed: "target-edit",
        observedAt: T_EARLY,
      }),
      fieldRow({ side: "A", fieldPath: "name", observed: "new-source", observedAt: T_LATE }),
    ]);
    await stage.detect({ change: makeChange(), link: makeLink(), context: writeContext() });
    expect(events.all()[0]?.status).toBe("conflict");
  });
});

// ── CF-3: manual-resolve override ─────────────────────────────────────────────

describe("CF-3 manual-resolve override", () => {
  it("manual-resolve parks instead of auto-resolving (even when LWW would pick source)", async () => {
    const { stage, fieldState } = harness();
    await fieldState.seed([
      fieldRow({
        side: "B",
        fieldPath: "name",
        baseline: "reconciled",
        observed: "target-edit",
        observedAt: T_EARLY,
      }),
      // Source observed later → LWW/observation-order would say SOURCE — manual-resolve overrides it.
      fieldRow({ side: "A", fieldPath: "name", observed: "new-source", observedAt: T_LATE }),
      // A clean field so the write still proceeds — keeps the outcome a `write` we can inspect.
      fieldRow({ side: "B", fieldPath: "keep", baseline: "k", observed: "k" }),
      fieldRow({ side: "A", fieldPath: "keep", baseline: "k", observed: "k2" }),
    ]);

    const outcome = await stage.detect({
      change: makeChange(),
      link: makeLink(),
      context: writeContext({
        fields: [
          { targetPath: "name", sourcePath: "name", conflictPolicy: "manual-resolve" },
          { targetPath: "keep", sourcePath: "keep" },
        ],
      }),
    });

    const plan = planFor(outcome, "name");
    expect(plan?.kind).toBe("withhold");
    expect((plan as WithholdFieldPlan).reason).toBe("manual-park");
    expect(outcome.conflict?.resolutions.find((r) => r.targetPath === "name")?.outcome).toBe(
      "manual-park",
    );
  });

  it("no manual-resolve policy (the consumer-provider / unset case) → auto-resolves, never parks", async () => {
    // conflictPolicy is inert unless it is `manual-resolve` (CF-3.3): a field with no
    // policy auto-resolves under the default LWW/observation-order path.
    const { stage, fieldState } = harness();
    await fieldState.seed([
      fieldRow({
        side: "B",
        fieldPath: "name",
        baseline: "reconciled",
        observed: "target-edit",
        observedAt: T_EARLY,
      }),
      fieldRow({ side: "A", fieldPath: "name", observed: "new-source", observedAt: T_LATE }),
    ]);
    const outcome = await stage.detect({
      change: makeChange(),
      link: makeLink(),
      context: writeContext(),
    });
    expect(outcome.kind === "write" && outcome.conflict?.resolutions[0]?.outcome).toBe(
      "source-wins",
    );
  });
});

// ── CF-4: what resolution does ────────────────────────────────────────────────

describe("CF-4 resolution effects", () => {
  it("source-wins permits the write and does NOT itself re-baseline (EP-3 owns re-baselining)", async () => {
    const { stage, fieldState } = harness();
    await fieldState.seed([
      fieldRow({
        side: "B",
        fieldPath: "name",
        baseline: "reconciled",
        observed: "target-edit",
        observedAt: T_EARLY,
      }),
      fieldRow({
        side: "A",
        fieldPath: "name",
        baseline: "reconciled",
        observed: "new-source",
        observedAt: T_LATE,
      }),
    ]);
    const before = fieldState.all();

    const outcome = await stage.detect({
      change: makeChange(),
      link: makeLink(),
      context: writeContext(),
    });

    expect(planFor(outcome, "name")).toEqual({ kind: "write", targetPath: "name" });
    // CF wrote NOTHING to SyncFieldState — the rows are byte-for-byte unchanged.
    expect(fieldState.all()).toEqual(before);
  });

  it("HARD INVARIANT (CF-4.6) target-wins → no write for the contested field AND both baselines untouched", async () => {
    const { stage, fieldState } = harness();
    await fieldState.seed([
      fieldRow({
        side: "B",
        fieldPath: "name",
        baseline: "reconciled",
        observed: "target-edit",
        observedAt: T_LATE,
      }),
      // Source observed earlier → target wins by observation order.
      fieldRow({
        side: "A",
        fieldPath: "name",
        baseline: "reconciled",
        observed: "new-source",
        observedAt: T_EARLY,
      }),
      // A clean co-field so the write proceeds and the withheld plan is inspectable.
      fieldRow({ side: "B", fieldPath: "keep", baseline: "k", observed: "k" }),
      fieldRow({ side: "A", fieldPath: "keep", baseline: "k", observed: "k2" }),
    ]);
    const baselineByKey = new Map(
      fieldState.all().map((row) => [`${row.side}/${row.fieldPath}`, row.lastSyncedHash]),
    );

    const outcome = await stage.detect({
      change: makeChange(),
      link: makeLink(),
      context: writeContext({
        fields: [
          { targetPath: "name", sourcePath: "name" },
          { targetPath: "keep", sourcePath: "keep" },
        ],
      }),
    });

    // No write for the contested field.
    const plan = planFor(outcome, "name");
    expect(plan?.kind).toBe("withhold");
    expect((plan as WithholdFieldPlan).reason).toBe("target-wins");
    // BOTH sides' lastSyncedHash unchanged — no forged reconciliation.
    for (const row of fieldState.all()) {
      expect(row.lastSyncedHash).toBe(baselineByKey.get(`${row.side}/${row.fieldPath}`));
    }
  });

  it("CF-4.5 every mapped field withheld → NO call is made, the conflict event stands alone", async () => {
    const { stage, fieldState, events } = harness();
    await fieldState.seed([
      fieldRow({
        side: "B",
        fieldPath: "name",
        baseline: "reconciled",
        observed: "target-edit",
        observedAt: T_LATE,
      }),
      fieldRow({ side: "A", fieldPath: "name", observed: "new-source", observedAt: T_EARLY }),
    ]);

    const outcome = await stage.detect({
      change: makeChange(),
      link: makeLink(),
      context: writeContext(),
    });

    expect(outcome.kind).toBe("no-call");
    expect(outcome.conflict?.resolutions[0]?.outcome).toBe("target-wins");
    expect(events.all()).toHaveLength(1);
    expect(events.all()[0]?.status).toBe("conflict");
  });

  it("CF-5.1 partial conflict — the record still syncs with the contested field withheld", async () => {
    const { stage, fieldState } = harness();
    await fieldState.seed([
      // `name` drifted → target wins → withheld; `title` clean → written.
      fieldRow({
        side: "B",
        fieldPath: "name",
        baseline: "reconciled",
        observed: "target-edit",
        observedAt: T_LATE,
      }),
      fieldRow({ side: "B", fieldPath: "title", baseline: "same", observed: "same" }),
      fieldRow({ side: "A", fieldPath: "name", observed: "new-source", observedAt: T_EARLY }),
      fieldRow({ side: "A", fieldPath: "title", baseline: "same", observed: "new-title" }),
    ]);

    const outcome = await stage.detect({
      change: makeChange(),
      link: makeLink(),
      context: writeContext({
        fields: [
          { targetPath: "name", sourcePath: "name" },
          { targetPath: "title", sourcePath: "title" },
        ],
      }),
    });

    expect(outcome.kind).toBe("write"); // a call IS made
    expect(planFor(outcome, "name")?.kind).toBe("withhold");
    expect(planFor(outcome, "title")).toEqual({ kind: "write", targetPath: "title" });
  });
});

// ── CF-5: write granularity / PUT read-carry ──────────────────────────────────

describe("CF-5 write granularity and PUT read-carry", () => {
  it("PATCH withhold = omit the field (no carry, no target read)", async () => {
    const { stage, fieldState, reader } = harness();
    await fieldState.seed([
      fieldRow({
        side: "B",
        fieldPath: "name",
        baseline: "reconciled",
        observed: "target-edit",
        observedAt: T_LATE,
      }),
      fieldRow({ side: "A", fieldPath: "name", observed: "new-source", observedAt: T_EARLY }),
      fieldRow({ side: "B", fieldPath: "keep", baseline: "k", observed: "k" }),
      fieldRow({ side: "A", fieldPath: "keep", baseline: "k", observed: "k2" }),
    ]);

    const outcome = await stage.detect({
      change: makeChange(),
      link: makeLink(),
      context: writeContext({
        writeShape: "patch",
        fields: [
          { targetPath: "name", sourcePath: "name" },
          { targetPath: "keep", sourcePath: "keep" },
        ],
      }),
    });

    const plan = planFor(outcome, "name") as WithholdFieldPlan | undefined;
    expect(plan?.kind).toBe("withhold");
    expect(plan?.carry).toBeUndefined();
    expect(reader.calls).toHaveLength(0);
  });

  it("HARD INVARIANT (CF-5.4) PUT withhold carries the target's CURRENT value, never the source's contested value", async () => {
    const { stage, fieldState, reader } = harness();
    await fieldState.seed([
      fieldRow({
        side: "B",
        fieldPath: "name",
        baseline: "reconciled",
        observed: "target-edit",
        observedAt: T_LATE,
      }),
      fieldRow({ side: "B", fieldPath: "bio", baseline: "same", observed: "same" }),
      fieldRow({ side: "A", fieldPath: "name", observed: "SOURCE_CONTESTED", observedAt: T_EARLY }),
      fieldRow({ side: "A", fieldPath: "bio", baseline: "same", observed: "new-bio" }),
    ]);
    // The target's CURRENT record (what read-carry must preserve).
    reader.setRecord(APP_B, B_NATIVE, { name: "TARGET_CURRENT", bio: "TARGET_BIO" });

    const outcome = await stage.detect({
      change: makeChange({ observedRecord: { name: "SOURCE_CONTESTED", bio: "new-bio" } }),
      link: makeLink(),
      context: writeContext({
        writeShape: "put",
        targetReadBinding: READ_BINDING,
        fields: [
          { targetPath: "name", sourcePath: "name" },
          { targetPath: "bio", sourcePath: "bio" },
        ],
      }),
    });

    const withheld = planFor(outcome, "name") as WithholdFieldPlan;
    expect(withheld.kind).toBe("withhold");
    expect(withheld.carry).toEqual({ present: true, value: "TARGET_CURRENT" });

    // Simulate the handler assembling the full-replace payload: TX produces the source
    // value, then the withhold carry re-injects the target's current value.
    const payload: Record<string, JsonValue> = { name: "SOURCE_CONTESTED", bio: "new-bio" };
    for (const field of outcome.kind === "write" ? outcome.fields : []) {
      if (field.kind === "withhold" && field.carry?.present === true) {
        payload[field.targetPath] = field.carry.value;
      }
    }
    // The contested field is NOT clobbered with the source value.
    expect(payload.name).toBe("TARGET_CURRENT");
    expect(payload.name).not.toBe("SOURCE_CONTESTED");
    expect(payload.bio).toBe("new-bio"); // the clean field still syncs (CF-5.1)
  });

  it("PUT read-carry reads the target at most once even with multiple withheld fields (OC-3)", async () => {
    const { stage, fieldState, reader } = harness();
    await fieldState.seed([
      fieldRow({
        side: "B",
        fieldPath: "name",
        baseline: "r1",
        observed: "drift1",
        observedAt: T_LATE,
      }),
      fieldRow({
        side: "B",
        fieldPath: "title",
        baseline: "r2",
        observed: "drift2",
        observedAt: T_LATE,
      }),
      fieldRow({ side: "A", fieldPath: "name", observed: "s1", observedAt: T_EARLY }),
      fieldRow({ side: "A", fieldPath: "title", observed: "s2", observedAt: T_EARLY }),
    ]);
    reader.setRecord(APP_B, B_NATIVE, { name: "tn", title: "tt" });

    await stage.detect({
      change: makeChange(),
      link: makeLink(),
      context: writeContext({
        writeShape: "put",
        targetReadBinding: READ_BINDING,
        fields: [
          { targetPath: "name", sourcePath: "name" },
          { targetPath: "title", sourcePath: "title" },
        ],
      }),
    });

    expect(reader.calls).toHaveLength(1);
    expect(reader.calls[0]?.nativeId).toBe(B_NATIVE);
  });
});

// ── CF-6: unobserved-target silent overwrite and read-before-write ────────────

describe("CF-6 targetDriftCheck", () => {
  // Persisted state shows NO drift (observedHash == baseline), but the live target has
  // an unobserved edit.
  async function withUnobservedTargetEdit(
    driftCheck: "none" | "read-before-write",
  ): Promise<{ readonly outcome: ConflictDetectionOutcome; readonly reads: number }> {
    const h = harness();
    await h.fieldState.seed([
      // Persisted state shows NO drift; a clean co-field keeps the outcome a `write`.
      fieldRow({
        side: "B",
        fieldPath: "name",
        baseline: "reconciled",
        observed: "reconciled",
        observedAt: T_EARLY,
      }),
      fieldRow({ side: "A", fieldPath: "name", observed: "new-source", observedAt: T_EARLY }),
      fieldRow({ side: "B", fieldPath: "keep", baseline: "k", observed: "k" }),
      fieldRow({ side: "A", fieldPath: "keep", baseline: "k", observed: "k2" }),
    ]);
    // The live target carries an unobserved edit on `name` (but a matching `keep`).
    h.reader.setRecord(APP_B, B_NATIVE, { name: "LIVE_UNOBSERVED_EDIT", keep: "k" });
    const outcome = await h.stage.detect({
      change: makeChange(),
      link: makeLink(),
      context: writeContext({
        targetDriftCheck: driftCheck,
        fields: [
          { targetPath: "name", sourcePath: "name" },
          { targetPath: "keep", sourcePath: "keep" },
        ],
        ...(driftCheck === "read-before-write" ? { targetReadBinding: READ_BINDING } : {}),
      }),
    });
    return { outcome, reads: h.reader.calls.length };
  }

  it("`none` (default) → no pre-read; an unobserved target edit is silently overwritten by design", async () => {
    const { outcome, reads } = await withUnobservedTargetEdit("none");
    expect(planFor(outcome, "name")).toEqual({ kind: "write", targetPath: "name" });
    expect(outcome.conflict).toBeUndefined();
    expect(reads).toBe(0);
  });

  it("`read-before-write` → reads the target first and turns the unobserved edit into a conflict", async () => {
    const { outcome, reads } = await withUnobservedTargetEdit("read-before-write");
    expect(reads).toBe(1);
    expect(outcome.conflict?.resolutions[0]?.targetPath).toBe("name");
    // observedAt(now) > source observedAt → target wins → the fresh edit is protected.
    expect(planFor(outcome, "name")?.kind).toBe("withhold");
  });
});

// ── CF-7: deletes are never auto-resolved against a drifted target ────────────

describe("CF-7 delete conflicts", () => {
  it("HARD INVARIANT (CF-7.6) propagate delete vs DRIFTED target → `conflict`, link stays active, NO delete", async () => {
    const { stage, fieldState, events, metrics } = harness();
    await fieldState.seed([
      fieldRow({ side: "B", fieldPath: "name", baseline: "reconciled", observed: "target-edit" }), // drifted
    ]);

    const outcome = await stage.evaluateDeletion({
      change: makeChange({ changeKind: "delete", observedRecord: undefined }),
      link: makeLink(),
      context: deleteContext({ deletePropagation: "propagate" }),
    });

    expect(outcome.kind).toBe("park");
    expect(outcome.kind === "park" && outcome.driftedFields).toEqual(["name"]);
    expect(events.all()[0]?.status).toBe("conflict");
    expect(metrics.conflicts).toEqual([RULE_ID]);
    // CF returns `park` and never mutates the link — it stays `active`, nothing deleted.
  });

  it("CF-7.4 undrifted target → delete normally, tombstone reason propagated-delete, no conflict", async () => {
    const { stage, fieldState, events } = harness();
    await fieldState.seed([
      fieldRow({ side: "B", fieldPath: "name", baseline: "same", observed: "same" }),
    ]);

    const outcome = await stage.evaluateDeletion({
      change: makeChange({ changeKind: "delete", observedRecord: undefined }),
      link: makeLink(),
      context: deleteContext({ deletePropagation: "propagate" }),
    });

    expect(outcome).toEqual({ kind: "delete", tombstoneReason: "propagated-delete" });
    expect(events.all()).toHaveLength(0);
  });

  it("CF-7.3 a drifted-target delete parks even when LWW would pick the source (never auto-resolved)", async () => {
    const { stage, fieldState } = harness();
    await fieldState.seed([
      // Target drifted; source change is far newer — LWW would pick source for an update,
      // but a delete against drift ALWAYS parks.
      fieldRow({
        side: "B",
        fieldPath: "name",
        baseline: "reconciled",
        observed: "target-edit",
        changeTs: T_EARLY,
        observedAt: T_EARLY,
      }),
      fieldRow({
        side: "A",
        fieldPath: "name",
        observed: "gone",
        changeTs: T_LATE,
        observedAt: T_LATE,
      }),
    ]);

    const outcome = await stage.evaluateDeletion({
      change: makeChange({ changeKind: "delete", observedRecord: undefined }),
      link: makeLink(),
      context: deleteContext({ deletePropagation: "propagate" }),
    });

    expect(outcome.kind).toBe("park");
  });

  it("CF-7.5 deletePropagation = ignore → `skipped-policy`, tombstone reason observed-delete, drift moot", async () => {
    const { stage, events, metrics, reader } = harness();

    const outcome = await stage.evaluateDeletion({
      change: makeChange({ changeKind: "delete", observedRecord: undefined }),
      link: makeLink(),
      context: deleteContext({ deletePropagation: "ignore" }),
    });

    expect(outcome).toEqual({
      kind: "skipped-policy",
      syncEventId: "evt-1",
      tombstoneReason: "observed-delete",
    });
    expect(events.all()[0]?.status).toBe("skipped-policy");
    expect(metrics.conflicts).toHaveLength(0); // a skipped-policy is NOT a conflict
    expect(reader.calls).toHaveLength(0); // drift check moot — nothing read
  });

  it("CF-7.1 read-before-write reads the target first to catch an unobserved edit before a delete", async () => {
    const { stage, fieldState, reader } = harness();
    // Persisted state shows NO drift; the live target carries an unobserved edit.
    await fieldState.seed([
      fieldRow({ side: "B", fieldPath: "name", baseline: "reconciled", observed: "reconciled" }),
    ]);
    reader.setRecord(APP_B, B_NATIVE, { name: "LIVE_EDIT" });

    const outcome = await stage.evaluateDeletion({
      change: makeChange({ changeKind: "delete", observedRecord: undefined }),
      link: makeLink(),
      context: deleteContext({
        deletePropagation: "propagate",
        targetDriftCheck: "read-before-write",
        targetReadBinding: READ_BINDING,
      }),
    });

    expect(reader.calls).toHaveLength(1);
    expect(outcome.kind).toBe("park");
  });
});

// ── Security invariant: no live payload value in the audit event ──────────────

describe("logging / LLM-data-boundary invariant", () => {
  it("a conflict event carries only field paths + dispositions, never a live payload value", async () => {
    const { stage, fieldState, events } = harness();
    await fieldState.seed([
      fieldRow({
        side: "B",
        fieldPath: "name",
        baseline: "reconciled",
        observed: "SUPER_SECRET_TARGET",
        observedAt: T_LATE,
      }),
      fieldRow({
        side: "A",
        fieldPath: "name",
        observed: "SUPER_SECRET_SOURCE",
        observedAt: T_EARLY,
      }),
    ]);

    await stage.detect({ change: makeChange(), link: makeLink(), context: writeContext() });

    const details = events.all()[0]?.details ?? "";
    expect(details).toContain("name"); // the field path is fine (config, not data)
    expect(details).not.toContain("SUPER_SECRET_TARGET");
    expect(details).not.toContain("SUPER_SECRET_SOURCE");
  });
});

// ── SA-4.2 / SA-4.3: the one-shot operator resolution override ─────────────────

describe("SA-4.2 field resolution override threaded into CF.detect", () => {
  it("a manual-resolve field WITH a source-wins override → written, NOT parked", async () => {
    const { stage, fieldState, metrics } = harness();
    await fieldState.seed([
      // Target drifted → without an override, a manual-resolve field parks.
      fieldRow({ side: "B", fieldPath: "name", baseline: "reconciled", observed: "target-edit" }),
      fieldRow({ side: "A", fieldPath: "name", baseline: "reconciled", observed: "new-source" }),
    ]);

    const outcome = await stage.detect({
      change: makeChange(),
      link: makeLink(),
      context: writeContext({
        fields: [{ targetPath: "name", sourcePath: "name", conflictPolicy: "manual-resolve" }],
      }),
      overrides: [{ targetPath: "name", choice: "source-wins" }],
    });

    // The override supersedes the manual-resolve park: the field is written.
    expect(outcome.kind).toBe("write");
    expect(planFor(outcome, "name")).toEqual({ kind: "write", targetPath: "name" });
    expect(outcome.kind === "write" && outcome.conflict?.resolutions).toEqual([
      { targetPath: "name", outcome: "source-wins" },
    ]);
    // Still recorded as a conflict (auto-resolved to the operator's choice) + metric.
    expect(metrics.conflicts).toEqual([RULE_ID]);
  });

  it("a manual-resolve field WITH a target-wins override → withheld, baselines untouched", async () => {
    const { stage, fieldState } = harness();
    const rows = [
      fieldRow({ side: "B", fieldPath: "name", baseline: "reconciled", observed: "target-edit" }),
      fieldRow({ side: "A", fieldPath: "name", baseline: "reconciled", observed: "new-source" }),
    ];
    await fieldState.seed(rows);

    const outcome = await stage.detect({
      change: makeChange(),
      link: makeLink(),
      context: writeContext({
        fields: [{ targetPath: "name", sourcePath: "name", conflictPolicy: "manual-resolve" }],
      }),
      overrides: [{ targetPath: "name", choice: "target-wins" }],
    });

    // Every field withheld → no call; the conflict event stands alone.
    expect(outcome.kind).toBe("no-call");
    expect(outcome.kind === "no-call" && outcome.conflict.resolutions).toEqual([
      { targetPath: "name", outcome: "target-wins" },
    ]);
    // CF forges NO baseline — both sides' persisted `lastSyncedHash` are the seeded ones.
    const persisted = await fieldState.findByLink(LINK_ID);
    const targetRow = persisted.find((row) => row.side === "B" && row.fieldPath === "name");
    const sourceRow = persisted.find((row) => row.side === "A" && row.fieldPath === "name");
    expect(targetRow?.lastSyncedHash).toBe(hashFieldValue("reconciled"));
    expect(sourceRow?.lastSyncedHash).toBe(hashFieldValue("reconciled"));
  });

  it("regression — a drifted field with NO override still parks (manual-resolve)", async () => {
    const { stage, fieldState } = harness();
    await fieldState.seed([
      fieldRow({ side: "B", fieldPath: "name", baseline: "reconciled", observed: "target-edit" }),
      fieldRow({ side: "A", fieldPath: "name", baseline: "reconciled", observed: "new-source" }),
    ]);

    const outcome = await stage.detect({
      change: makeChange(),
      link: makeLink(),
      context: writeContext({
        fields: [{ targetPath: "name", sourcePath: "name", conflictPolicy: "manual-resolve" }],
      }),
      // No overrides.
    });

    expect(outcome.kind).toBe("no-call");
    expect(outcome.kind === "no-call" && outcome.conflict.resolutions).toEqual([
      { targetPath: "name", outcome: "manual-park" },
    ]);
  });

  it("an override on an UNDRIFTED field is inert — the field just writes normally", async () => {
    const { stage, fieldState, events } = harness();
    await fieldState.seed([
      fieldRow({ side: "B", fieldPath: "name", baseline: "same", observed: "same" }),
      fieldRow({ side: "A", fieldPath: "name", baseline: "same", observed: "new-source" }),
    ]);

    const outcome = await stage.detect({
      change: makeChange(),
      link: makeLink(),
      context: writeContext(),
      overrides: [{ targetPath: "name", choice: "target-wins" }],
    });

    // Not drifted → written; the override is never consulted, no conflict recorded.
    expect(outcome.kind).toBe("write");
    expect(planFor(outcome, "name")).toEqual({ kind: "write", targetPath: "name" });
    expect(events.all()).toHaveLength(0);
  });
});

describe("SA-4.3 drifted-delete propagate override threaded into CF.evaluateDeletion", () => {
  it("a drifted delete WITH a propagate override → proceeds to delete (no park)", async () => {
    const { stage, fieldState, events } = harness();
    await fieldState.seed([
      // Target drifted → without an override this parks.
      fieldRow({ side: "B", fieldPath: "name", baseline: "reconciled", observed: "target-edit" }),
    ]);

    const outcome = await stage.evaluateDeletion({
      change: makeChange({ changeKind: "delete", observedRecord: undefined }),
      link: makeLink(),
      context: deleteContext(),
      override: { choice: "propagate" },
    });

    expect(outcome.kind).toBe("delete");
    expect(outcome.kind === "delete" && outcome.tombstoneReason).toBe("propagated-delete");
    // No park recorded — the operator accepted the drift.
    expect(events.all()).toHaveLength(0);
  });

  it("regression — a drifted delete with NO override still parks (nothing deleted)", async () => {
    const { stage, fieldState, events } = harness();
    await fieldState.seed([
      fieldRow({ side: "B", fieldPath: "name", baseline: "reconciled", observed: "target-edit" }),
    ]);

    const outcome = await stage.evaluateDeletion({
      change: makeChange({ changeKind: "delete", observedRecord: undefined }),
      link: makeLink(),
      context: deleteContext(),
    });

    expect(outcome.kind).toBe("park");
    expect(events.all()[0]?.status).toBe("conflict");
  });
});
