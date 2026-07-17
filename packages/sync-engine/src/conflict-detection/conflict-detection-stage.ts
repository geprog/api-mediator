import { randomUUID } from "node:crypto";

import type {
  RecordLink,
  SyncFieldState,
  SyncFieldStateSide,
  TargetDriftCheck,
} from "@mediator/domain";
import { stripUndefined } from "@mediator/domain";
import type { SyncFieldStateStore } from "@mediator/db";
import { readPath, type JsonRecord, type JsonValue, type PathRead } from "@mediator/transform";

import { hashFieldValue } from "../identity-resolution/hash.js";
import type {
  DetectedChange,
  StageTraceContext,
  SyncEventRecorder,
} from "../identity-resolution/types.js";
import type {
  ConflictDetectionInput,
  ConflictDetectionMetrics,
  ConflictDetectionOutcome,
  ConflictRecord,
  DeletionConflictInput,
  DeletionConflictOutcome,
  FieldConflictOverride,
  FieldPlan,
  FieldResolution,
  SingleRecordReadBinding,
  SingleRecordReadResult,
  SingleRecordTargetReader,
  WithholdFieldPlan,
  WithholdReason,
} from "./types.js";

/**
 * **Conflict Detection** — the sync pipeline's **third** stage, after Identity
 * Resolution and Loop Prevention, before the Transformation Executor and Outbound
 * Call Executor (`docs/architecture/sync-engine.md` *Conflict handling*, *Ordering
 * and consistency*; `docs/requirements/phase-4-conflict-detection.md` CF-1..CF-7).
 *
 * It is **detection + the resolution decision**, expressed as a per-field write plan
 * the (deferred) pipeline handler feeds to TX/OC. It runs **inside the ordering
 * queue's single-active-worker-per-key guarantee** (OQ-2) and relies on that
 * serialization: the two directions of a bidirectional pair can never both pass the
 * drift check concurrently (CF-1 crit 3). CF performs no cross-direction reads or
 * writes that would undermine per-key serialization.
 *
 * Method map:
 *  - {@link detect} — the write path (create/update). CF-1 (drift over observed
 *    state), CF-2 (last-write-wins with epsilon → observation-order fallback), CF-3
 *    (`manual-resolve` park), CF-4 (source-wins proceeds / target-wins withholds,
 *    baselines untouched — CF never forges a baseline), CF-5 (PATCH omit vs PUT
 *    read-carry), CF-6 (`read-before-write`).
 *  - {@link evaluateDeletion} — CF-7. A propagated delete against a **drifted**
 *    target **always** parks (never auto-resolved, not even under LWW); `ignore`
 *    records `skipped-policy`.
 *
 * **Hard invariants** (each has a named test): a target-wins outcome makes no write
 * for the contested field and leaves **both** sides' `lastSyncedHash` untouched
 * (CF-4.6); a PUT withhold carries the target's **current** value, not the source's
 * contested value (CF-5.4); a `propagate` delete against a drifted target records
 * `conflict`, leaves the link `active`, and makes no delete call (CF-7.6).
 *
 * **Seams left for the composition slice:** the real single-record target reader
 * (this slice ships a fake; the real REST impl obeys OC-3 — one extra read per
 * write), persisting the **source-side** observation into `SyncFieldState` before CF
 * runs (CF compares over persisted observations — the target side's row, and the
 * source side's row for LWW), re-baselining a source-wins write (EP-3), the actual
 * delete call + link tombstone (RL-5 / OC-2), and the OTel conflict-rate counter.
 */
export interface ConflictDetectionStageDeps {
  readonly fieldState: SyncFieldStateStore;
  /** The `SyncEvent`/`AuditLog` append port — every conflict is recorded `conflict`. */
  readonly events: SyncEventRecorder;
  /** The single-record target read port (CF-5 PUT read-carry, CF-6 read-before-write). */
  readonly targetReader: SingleRecordTargetReader;
}

export interface ConflictDetectionStageOptions {
  readonly metrics?: ConflictDetectionMetrics;
  readonly clock?: () => Date;
  readonly newId?: () => string;
  /** Reads the active trace context for `SyncEvent` correlation (default: none). */
  readonly readTraceContext?: () => StageTraceContext | null;
  /** The `SyncEvent.actor` for these system-initiated events (default `"system"`). */
  readonly actor?: string;
  /**
   * CF-2 epsilon (milliseconds): two change timestamps within this window are treated
   * as **inconclusive** and resolution falls back to observation order. **Config-defined**
   * — threaded through here, not hard-coded at a comparison site (default
   * {@link DEFAULT_CONFLICT_EPSILON_MS}).
   */
  readonly epsilonMs?: number;
}

/** The default CF-2 epsilon — a few seconds, overridable per {@link ConflictDetectionStageOptions.epsilonMs}. */
export const DEFAULT_CONFLICT_EPSILON_MS = 2000;

const DEFAULT_ACTOR = "system";

const DELETE_IGNORE_DETAILS =
  "source deletion not propagated (deletePropagation = ignore) — link tombstoned observed-delete";

export class ConflictDetectionStage {
  readonly #fieldState: SyncFieldStateStore;
  readonly #events: SyncEventRecorder;
  readonly #targetReader: SingleRecordTargetReader;
  readonly #metrics: ConflictDetectionMetrics;
  readonly #clock: () => Date;
  readonly #newId: () => string;
  readonly #readTraceContext: () => StageTraceContext | null;
  readonly #actor: string;
  readonly #epsilonMs: number;

  public constructor(
    deps: ConflictDetectionStageDeps,
    options: ConflictDetectionStageOptions = {},
  ) {
    this.#fieldState = deps.fieldState;
    this.#events = deps.events;
    this.#targetReader = deps.targetReader;
    this.#metrics = options.metrics ?? NO_OP_METRICS;
    this.#clock = options.clock ?? ((): Date => new Date());
    this.#newId = options.newId ?? ((): string => randomUUID());
    this.#readTraceContext = options.readTraceContext ?? ((): null => null);
    this.#actor = options.actor ?? DEFAULT_ACTOR;
    this.#epsilonMs = options.epsilonMs ?? DEFAULT_CONFLICT_EPSILON_MS;
  }

  /**
   * The write-path conflict check + resolution for one non-echo create/update
   * (CF-1..CF-6). Produces the per-field write plan; records **one** `conflict`
   * `SyncEvent` iff any field was contested (whether auto-resolved or parked).
   */
  public async detect(input: ConflictDetectionInput): Promise<ConflictDetectionOutcome> {
    const { change, link, context } = input;
    const now = this.#clock();
    const sourceSide = sideOf(change.sourceAppId, context.appAId);
    const targetSide = opposite(sourceSide);
    const rowMap = indexRows(await this.#fieldState.findByLink(link.id));

    const readTarget = this.#memoizedReader(change, link, sourceSide, context.targetReadBinding);
    // CF-6: `read-before-write` reads the target up front (detection needs the live value).
    const liveRead =
      context.targetDriftCheck === "read-before-write" ? await readTarget() : undefined;

    const drafts: Draft[] = [];
    const resolutions: FieldResolution[] = [];
    // SA-4.2 — the operator's one-shot resolution directives, indexed by target path.
    const overrideByPath = indexOverrides(input.overrides);

    for (const field of context.fields) {
      const targetRow = rowMap.get(rowKey(targetSide, field.targetPath));
      const baseline = targetRow?.lastSyncedHash;
      const targetObs = observeTarget(field.targetPath, targetRow, context, liveRead, now);
      // CF-1: drift = observed ≠ baseline; an absent baseline (divergent seed) is a
      // conflict by construction (present-together/absent-together on `SyncFieldState`).
      const drifted = baseline === undefined || targetObs.hash !== baseline;
      if (!drifted) {
        drafts.push({ targetPath: field.targetPath, disposition: "write" });
        continue;
      }

      // SA-4.2 — an operator resolution override supersedes the `manual-resolve` park
      // AND the auto last-write-wins decision, but only for a DRIFTED field and only for
      // this one execution (a contained, additive change — the resolution stays *inside*
      // CF, not a blind bypass). `source-wins` writes the winning source value through
      // the normal write path; `target-wins` withholds and forges NO baseline — mirroring
      // an auto `target-wins` exactly (`docs/architecture/sync-engine.md` *What resolution
      // does*). Every other CF invariant (drift detection, PUT read-carry) still holds.
      const override = overrideByPath.get(field.targetPath);
      if (override !== undefined) {
        if (override.choice === "source-wins") {
          drafts.push({ targetPath: field.targetPath, disposition: "write" });
          resolutions.push({ targetPath: field.targetPath, outcome: "source-wins" });
        } else {
          drafts.push({
            targetPath: field.targetPath,
            disposition: "withhold",
            reason: "target-wins",
          });
          resolutions.push({ targetPath: field.targetPath, outcome: "target-wins" });
        }
        continue;
      }

      // CF-3: `manual-resolve` (peer-peer) forces a park — never auto-resolved.
      if (field.conflictPolicy === "manual-resolve") {
        drafts.push({
          targetPath: field.targetPath,
          disposition: "withhold",
          reason: "manual-park",
        });
        resolutions.push({ targetPath: field.targetPath, outcome: "manual-park" });
        continue;
      }

      // CF-2: auto-resolve by last-write-wins → epsilon → observation order.
      const sourceObs = sourceObservation(rowMap.get(rowKey(sourceSide, field.sourcePath)));
      const winner = decideWinner(
        sourceObs,
        targetObs,
        context.changeTimestampsComparable,
        this.#epsilonMs,
      );
      if (winner === "source") {
        // CF-4.1: source wins — the write proceeds; re-baselining is EP-3's job on the
        // write response. CF does NOT forge a baseline here.
        drafts.push({ targetPath: field.targetPath, disposition: "write" });
        resolutions.push({ targetPath: field.targetPath, outcome: "source-wins" });
      } else {
        // CF-4.2: target wins — withhold; baselines stay untouched (CF writes nothing).
        drafts.push({
          targetPath: field.targetPath,
          disposition: "withhold",
          reason: "target-wins",
        });
        resolutions.push({ targetPath: field.targetPath, outcome: "target-wins" });
      }
    }

    const anyWithheld = drafts.some((draft) => draft.disposition === "withhold");
    const anyWrite = drafts.some((draft) => draft.disposition === "write");

    // CF-5: PUT read-carry — a withheld field over a full-replace op carries the
    // target's CURRENT value (one memoized read; under `none` this is the only read).
    const carryByPath = new Map<string, PathRead>();
    if (context.writeShape === "put" && anyWithheld) {
      const read = liveRead ?? (await readTarget());
      for (const draft of drafts) {
        if (draft.disposition === "withhold") {
          carryByPath.set(draft.targetPath, readTargetField(read, draft.targetPath));
        }
      }
    }

    const fields: FieldPlan[] = drafts.map((draft) =>
      draft.disposition === "write"
        ? { kind: "write", targetPath: draft.targetPath }
        : buildWithhold(draft.targetPath, requireReason(draft), carryByPath.get(draft.targetPath)),
    );

    let conflict: ConflictRecord | undefined;
    if (resolutions.length > 0) {
      const writtenCount = drafts.filter((draft) => draft.disposition === "write").length;
      const syncEventId = await this.#recordEvent(
        change,
        link.id,
        "conflict",
        writeConflictDetails(
          resolutions,
          writtenCount,
          anyWithheld ? drafts.length - writtenCount : 0,
        ),
      );
      this.#metrics.recordConflict(change.ruleId); // CF-1.5
      conflict = { syncEventId, resolutions };
    }

    // CF-4.5: every mapped field withheld → no call is made; the conflict event alone.
    if (!anyWrite && conflict !== undefined) {
      return { kind: "no-call", conflict };
    }
    return conflict !== undefined ? { kind: "write", fields, conflict } : { kind: "write", fields };
  }

  /**
   * CF-7 — evaluate a propagated delete. `deletePropagation = ignore` records
   * `skipped-policy` and stops (the handler tombstones `observed-delete`); otherwise
   * the target's drift is checked (over observed state, or a live read under
   * `read-before-write`) and **any** drift parks — deletes are never auto-resolved,
   * not even under last-write-wins, because destruction is irreversible.
   */
  public async evaluateDeletion(input: DeletionConflictInput): Promise<DeletionConflictOutcome> {
    const { change, link, context } = input;

    // CF-7.5 — `ignore`: recorded skipped-policy, tombstone observed-delete; drift moot.
    if (context.deletePropagation === "ignore") {
      const syncEventId = await this.#recordEvent(
        change,
        link.id,
        "skipped-policy",
        DELETE_IGNORE_DETAILS,
      );
      return { kind: "skipped-policy", syncEventId, tombstoneReason: "observed-delete" };
    }

    const now = this.#clock();
    const sourceSide = sideOf(change.sourceAppId, context.appAId);
    const targetSide = opposite(sourceSide);
    const rowMap = indexRows(await this.#fieldState.findByLink(link.id));

    const readTarget = this.#memoizedReader(change, link, sourceSide, context.targetReadBinding);
    let liveRead: SingleRecordReadResult | undefined;
    if (context.targetDriftCheck === "read-before-write") {
      liveRead = await readTarget(); // CF-7.1 — read the target first, catching unobserved edits.
      if (!liveRead.found) {
        // The target is already gone — nothing to protect; the delete is an idempotent
        // no-op (OC-2). Proceed and tombstone `propagated-delete`.
        return { kind: "delete", tombstoneReason: "propagated-delete" };
      }
    }

    const driftedFields: string[] = [];
    for (const targetPath of context.targetFields) {
      const targetRow = rowMap.get(rowKey(targetSide, targetPath));
      const baseline = targetRow?.lastSyncedHash;
      const targetObs = observeTarget(
        targetPath,
        targetRow,
        { targetDriftCheck: context.targetDriftCheck, changeTimestampsComparable: false },
        liveRead,
        now,
      );
      if (baseline === undefined || targetObs.hash !== baseline) {
        driftedFields.push(targetPath);
      }
    }

    if (driftedFields.length > 0) {
      // SA-4.3 — the operator accepted the drift (propagate the delete after all): skip
      // the park and proceed to delete + tombstone `propagated-delete`. The delete still
      // flows through the pipeline (the handler makes the call, OC-2's delete idempotency
      // key applies) — never a blind delete.
      if (input.override?.choice === "propagate") {
        return { kind: "delete", tombstoneReason: "propagated-delete" };
      }
      // CF-7.2/7.3/7.6 — park: recorded conflict, link left active, nothing deleted.
      const syncEventId = await this.#recordEvent(
        change,
        link.id,
        "conflict",
        deleteParkDetails(driftedFields),
      );
      this.#metrics.recordConflict(change.ruleId); // CF-1.5
      return { kind: "park", syncEventId, driftedFields };
    }
    // CF-7.4 — undrifted: delete normally; the handler tombstones `propagated-delete`.
    return { kind: "delete", tombstoneReason: "propagated-delete" };
  }

  // ── internals ──────────────────────────────────────────────────────────────

  /**
   * A per-execution memoized single-record target read (at most one call — OC-3 load
   * discipline). The target native id comes from the link's target side. Throws if a
   * read is needed but no `targetReadBinding` was supplied (a wiring error).
   */
  #memoizedReader(
    change: DetectedChange,
    link: RecordLink,
    sourceSide: SyncFieldStateSide,
    binding: SingleRecordReadBinding | undefined,
  ): () => Promise<SingleRecordReadResult> {
    let cached: SingleRecordReadResult | undefined;
    return async (): Promise<SingleRecordReadResult> => {
      if (cached !== undefined) {
        return cached;
      }
      if (binding === undefined) {
        throw new Error(
          "Conflict Detection needs a targetReadBinding to read the target record (read-before-write / PUT read-carry)",
        );
      }
      cached = await this.#targetReader.readRecord(
        stripUndefined({
          targetAppId: change.targetAppId,
          nativeId: targetNativeId(link, sourceSide),
          binding,
          // SS-8b — carry the captured scope so a scoped target read-carry / read-before-
          // write fills its `record-derived` scope param from the value the source record
          // carried (the shared value-space). Absent on an unscoped read.
          capturedScope: change.capturedScope,
        }),
      );
      return cached;
    };
  }

  async #recordEvent(
    change: DetectedChange,
    recordLinkId: string,
    status: "conflict" | "skipped-policy",
    details: string,
  ): Promise<string> {
    const syncEventId = this.#newId();
    const trace = this.#readTraceContext();
    await this.#events.record(
      stripUndefined({
        id: syncEventId,
        type: "sync-execution" as const,
        actor: this.#actor,
        status,
        relatedRuleId: change.ruleId,
        relatedMappingId: change.mappingId,
        sourceNativeId: change.sourceNativeId,
        originAppId: change.sourceAppId,
        recordLinkId,
        details,
        traceId: trace?.traceId,
        spanId: trace?.spanId,
        timestamp: this.#clock(),
      }),
    );
    return syncEventId;
  }
}

const NO_OP_METRICS: ConflictDetectionMetrics = {
  recordConflict(): void {
    /* default: no metric backend wired */
  },
};

// ── module-level pure helpers ─────────────────────────────────────────────────

/** An intermediate per-field decision, before PUT read-carry fills the withhold value. */
interface Draft {
  readonly targetPath: string;
  readonly disposition: "write" | "withhold";
  readonly reason?: WithholdReason;
}

/** A side's observation of one field, for drift detection + LWW/observation-order. */
interface Observation {
  /** The current value hash on this side (`undefined` only when the row is missing). */
  readonly hash: string | undefined;
  /** The app-reported change timestamp accompanying the observation, or `null`. */
  readonly changeTs: Date | null;
  /** When the mediator observed this value (`null` when unknown). */
  readonly observedAt: Date | null;
}

/** The subset of context {@link observeTarget} reads — satisfied by the write + delete contexts. */
interface TargetObservationOptions {
  readonly targetDriftCheck: TargetDriftCheck;
  readonly changeTimestampsComparable: boolean;
  readonly targetChangeTimestampRef?: string;
}

/**
 * The target side's current observation of one field. Under `read-before-write` the
 * freshly-read record is authoritative (observedAt = now; change timestamp from the
 * live record when comparable); otherwise the persisted `SyncFieldState` row — CF-1's
 * observed-only default path, which reads the target **not at all**.
 */
function observeTarget(
  targetPath: string,
  targetRow: SyncFieldState | undefined,
  opts: TargetObservationOptions,
  liveRead: SingleRecordReadResult | undefined,
  now: Date,
): Observation {
  if (opts.targetDriftCheck === "read-before-write") {
    if (liveRead === undefined || !liveRead.found) {
      // Target not found (or read absent) → treat the mapped field as absent (null).
      return { hash: hashFieldValue(null), changeTs: null, observedAt: now };
    }
    const read = readPath(liveRead.record, targetPath);
    const changeTs =
      opts.changeTimestampsComparable && opts.targetChangeTimestampRef !== undefined
        ? readChangeTimestamp(liveRead.record, opts.targetChangeTimestampRef)
        : null;
    return { hash: hashFieldValue(read.present ? read.value : null), changeTs, observedAt: now };
  }
  if (targetRow === undefined) {
    return { hash: undefined, changeTs: null, observedAt: null };
  }
  return {
    hash: targetRow.observedHash,
    changeTs: targetRow.observedChangeTimestamp,
    observedAt: targetRow.observedAt,
  };
}

/** The source side's observation — always the persisted source-side row (never re-read). */
function sourceObservation(sourceRow: SyncFieldState | undefined): Observation {
  if (sourceRow === undefined) {
    return { hash: undefined, changeTs: null, observedAt: null };
  }
  return {
    hash: sourceRow.observedHash,
    changeTs: sourceRow.observedChangeTimestamp,
    observedAt: sourceRow.observedAt,
  };
}

/**
 * CF-2 — decide the winner of a contested field. Last-write-wins by change timestamp
 * only when both are comparable and present and differ by more than the epsilon;
 * within the epsilon, or when timestamps are unusable, observation order (the rows'
 * `observedAt`). An exact tie or missing observation is inconclusive → **target-wins**
 * (never overwrite on uncertainty, never sneak a value into reconciled state).
 */
function decideWinner(
  source: Observation,
  target: Observation,
  changeTimestampsComparable: boolean,
  epsilonMs: number,
): "source" | "target" {
  if (changeTimestampsComparable && source.changeTs !== null && target.changeTs !== null) {
    const diffMs = source.changeTs.getTime() - target.changeTs.getTime();
    if (Math.abs(diffMs) > epsilonMs) {
      return diffMs > 0 ? "source" : "target"; // the more recent change timestamp wins
    }
    // CF-2.2: within epsilon → inconclusive → fall through to observation order.
  }
  if (source.observedAt !== null && target.observedAt !== null) {
    const orderMs = source.observedAt.getTime() - target.observedAt.getTime();
    if (orderMs > 0) {
      return "source"; // the later-observed change wins
    }
    if (orderMs < 0) {
      return "target";
    }
  }
  return "target";
}

/** A single-record read's value at a target field path (for PUT read-carry, CF-5). */
function readTargetField(read: SingleRecordReadResult, targetPath: string): PathRead {
  return read.found ? readPath(read.record, targetPath) : { present: false };
}

/** Read + parse a record's change timestamp (epoch millis, or a Date-parseable string). */
function readChangeTimestamp(record: JsonRecord, ref: string): Date | null {
  const read = readPath(record, ref);
  return read.present ? toDate(read.value) : null;
}

function toDate(value: JsonValue): Date | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? new Date(value) : null;
  }
  if (typeof value === "string") {
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? null : new Date(ms);
  }
  return null;
}

function buildWithhold(
  targetPath: string,
  reason: WithholdReason,
  carry: PathRead | undefined,
): WithholdFieldPlan {
  return carry === undefined
    ? { kind: "withhold", targetPath, reason }
    : { kind: "withhold", targetPath, reason, carry };
}

function requireReason(draft: Draft): WithholdReason {
  if (draft.reason === undefined) {
    throw new Error(`withhold draft for '${draft.targetPath}' is missing its reason`);
  }
  return draft.reason;
}

/** The record's target native id — the opposite side of the change's source side. */
function targetNativeId(link: RecordLink, sourceSide: SyncFieldStateSide): string {
  return sourceSide === "A" ? link.appBNativeId : link.appANativeId;
}

function sideOf(sourceAppId: string, appAId: string): SyncFieldStateSide {
  return sourceAppId === appAId ? "A" : "B";
}

function opposite(side: SyncFieldStateSide): SyncFieldStateSide {
  return side === "A" ? "B" : "A";
}

/** `SyncFieldState` map key — an escaped-space separator (never a NUL byte). */
function rowKey(side: SyncFieldStateSide, fieldPath: string): string {
  return `${side} ${fieldPath}`;
}

function indexRows(rows: readonly SyncFieldState[]): Map<string, SyncFieldState> {
  const map = new Map<string, SyncFieldState>();
  for (const row of rows) {
    map.set(rowKey(row.side, row.fieldPath), row);
  }
  return map;
}

/** SA-4.2 — index the operator's field resolution directives by their target path. */
function indexOverrides(
  overrides: readonly FieldConflictOverride[] | undefined,
): Map<string, FieldConflictOverride> {
  const map = new Map<string, FieldConflictOverride>();
  for (const override of overrides ?? []) {
    map.set(override.targetPath, override);
  }
  return map;
}

/** Metadata-only conflict detail — field paths + counts + dispositions, never a live value. */
function writeConflictDetails(
  resolutions: readonly FieldResolution[],
  writtenCount: number,
  withheldCount: number,
): string {
  const parts = resolutions.map((resolution) => `${resolution.targetPath}=${resolution.outcome}`);
  return `conflict on ${String(resolutions.length)} field(s) [${parts.join(", ")}] — wrote ${String(writtenCount)}, withheld ${String(withheldCount)}`;
}

function deleteParkDetails(driftedFields: readonly string[]): string {
  return `propagated delete parked as a manual conflict — target drifted on ${String(driftedFields.length)} field(s) [${driftedFields.join(", ")}]; link left active, nothing deleted (deletes are never auto-resolved against a drifted target)`;
}
