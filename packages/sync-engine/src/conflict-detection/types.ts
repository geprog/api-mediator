import type {
  ConflictPolicy,
  DeletePropagation,
  RecordLink,
  TargetDriftCheck,
} from "@mediator/domain";
import type { CapturedScope, JsonRecord, PathRead } from "@mediator/transform";

import type { DetectedChange } from "../identity-resolution/types.js";

/**
 * Types for the **Conflict Detection** stage — the sync pipeline's **third** stage,
 * after Identity Resolution and Loop Prevention, before the Transformation Executor
 * and Outbound Call Executor (`docs/architecture/sync-engine.md` *Conflict handling*,
 * *Ordering and consistency*; `docs/requirements/phase-4-conflict-detection.md`
 * CF-1..CF-7). It runs over persisted `SyncFieldState` observations, decides the
 * winner of a drift, and emits a **per-field write plan** the downstream handler
 * feeds to TX/OC — never sneaking a winning value into reconciled state.
 *
 * Reuses the Identity Resolution stage's {@link DetectedChange},
 * `SyncEventRecorder` and `StageTraceContext` ports (same package, no duplication):
 * CF consumes the resolved `RecordLink` Loop Prevention hands on in its `not-echo`
 * outcome.
 */

// ── CF-5: PATCH vs PUT write shape ────────────────────────────────────────────

/**
 * The shape of the target `update` operation, an **input** to the stage read from
 * the target operation's IR/binding (Phase-1), never sniffed from a live spec here
 * (CF-5):
 *  - `patch` — a partial payload; a withheld field is simply **omitted**.
 *  - `put` — a full replacement; a withheld field must have the target's **current**
 *    value carried through (PUT read-carry) so it is preserved, not clobbered.
 */
export type TargetWriteShape = "patch" | "put";

// ── CF-4 / CF-3: how a contested field resolves ───────────────────────────────

/** Why a contested field is withheld from the write (CF-4 target-wins; CF-3 park). */
export type WithholdReason = "target-wins" | "manual-park";

/**
 * The resolution outcome recorded for one contested field (for the `conflict`
 * `SyncEvent` detail + tests). `source-wins` still records `conflict` (CF-2 crit 4)
 * — nothing is silently lost even when auto-resolved — and lets the write proceed;
 * `target-wins` / `manual-park` withhold it.
 */
export type FieldResolutionOutcome = "source-wins" | WithholdReason;

// ── The per-field descriptor the write path evaluates ─────────────────────────

/**
 * One target field this direction's write touches, projected from its `FieldMapping`
 * by the (deferred) pipeline handler:
 *  - `targetPath` — the field being written; CF compares its target-side
 *    `SyncFieldState.observedHash` against the same row's `lastSyncedHash` (CF-1).
 *  - `sourcePath` — the transform's **primary** source input; its source-side row
 *    carries the source change's observation (change timestamp + observation order)
 *    for last-write-wins (CF-2). The record-level change timestamp is the same across
 *    a side's fields, so the primary input suffices.
 *  - `conflictPolicy` — the peer-peer `manual-resolve` override (CF-3), when set;
 *    forces the field to park instead of auto-resolving. Inert on consumer-provider
 *    rows (the schema makes it unrepresentable there), so it never reaches CF from one.
 */
export interface ConflictField {
  readonly targetPath: string;
  readonly sourcePath: string;
  readonly conflictPolicy?: ConflictPolicy;
}

// ── SA-4.2 / SA-4.3: the one-shot operator resolution override ─────────────────

/** The side an operator chose for a contested field (SA-4.2). */
export type FieldResolutionChoice = "source-wins" | "target-wins";

/**
 * A **one-shot** operator resolution directive for a single contested field,
 * threaded into {@link ConflictDetectionInput} by the SA-4 resolution re-run
 * (`docs/requirements/phase-4-sync-api.md` SA-4.2; `docs/architecture/sync-engine.md`
 * *Conflict handling* — *What resolution does*). It is an **additive** input that
 * keeps the resolution **inside** CF (not a blind bypass): a field with an override
 * skips the `manual-resolve` park / the auto last-write-wins decision and applies the
 * chosen side instead — but **only when the field is actually drifted**, and **every
 * other CF invariant still holds** (an undrifted field writes normally; a `target-wins`
 * override withholds and CF forges **no** baseline; a PUT withhold still read-carries
 * the target's current value). Consumed exactly once — the re-run enqueues it, CF
 * honors it for that one execution, and the parked_conflict row is superseded.
 */
export interface FieldConflictOverride {
  /** The contested **target** field path this directive resolves (matches a {@link ConflictField}). */
  readonly targetPath: string;
  readonly choice: FieldResolutionChoice;
}

// ── CF-5 / CF-6: the single-record target read port (real impl deferred) ──────

/**
 * The confirmed single-record read of the target resource — where the target's one
 * record lives by its native id. A minimal, transport-agnostic descriptor kept
 * decoupled from `@mediator/outbound` to avoid the dependency cycle; the real
 * REST-backed reader resolves it to HTTP at the composition/BE seam (exactly as RL
 * deferred the real `ProtocolClient` and SP the real binding resolver).
 */
export interface SingleRecordReadBinding {
  /** IR operation id of the target's confirmed single-record read operation. */
  readonly readOperationId: string;
  /** The read operation's id parameter the target native id fills. */
  readonly idParamRef: string;
}

/** A single-record read of the target: the target's own record by its native id. */
export interface SingleRecordReadRequest {
  readonly targetAppId: string;
  /** The target's native id (from the `RecordLink`'s target side). */
  readonly nativeId: string;
  readonly binding: SingleRecordReadBinding;
  /**
   * The change's **captured scope** (SS-8b) — fills a `record-derived` scope path
   * parameter of a *scoped* target single-record read (e.g. a repo-scoped by-id read)
   * from the value the source record carried, exactly as the write side fills it. Absent
   * for an unscoped / constant-only read; the resolver then fills constants only.
   */
  readonly capturedScope?: CapturedScope | undefined;
  /**
   * SS-12.3 — a **linked** read's container fill (`{ parameterName → value }`) resolved from
   * the record's stored `RecordLink.scopeRef`, so a `read-before-write` drift-read / PUT
   * read-carry of a *scoped* record routes to the **stored** container (the arbitrary
   * target id) even when the change carries no captured scope (a delete). Takes precedence
   * over `capturedScope`; absent for an unscoped read. Resolved once by the pipeline
   * handler, which parks (`ContainerUnresolvedError`) when it cannot resolve.
   */
  readonly resolvedScopeValues?: ReadonlyMap<string, string> | undefined;
}

/**
 * The result of a single-record target read: the record, or a distinguished
 * **not-found** (the target record no longer exists). Never a fabricated record.
 */
export type SingleRecordReadResult =
  { readonly found: true; readonly record: JsonRecord } | { readonly found: false };

/**
 * The **single-record target read** port CF owns — used only for CF-5 (PUT
 * read-carry: fetch the target's current value for a withheld field) and CF-6
 * (`read-before-write`: read the target immediately before writing to catch an
 * unobserved edit). Faked in unit tests; the real REST implementation is deferred to
 * the composition/BE seam and will obey OC-3 load discipline — **one extra read per
 * write** (CF memoizes the read so at most one happens per execution).
 */
export interface SingleRecordTargetReader {
  readRecord(request: SingleRecordReadRequest): Promise<SingleRecordReadResult>;
}

// ── CF-1.5: metrics ───────────────────────────────────────────────────────────

/**
 * Conflict-detection metrics (`docs/architecture/observability.md` *Metrics* — the
 * conflict rate per `SyncRule`, CF-1.5). A single counter: an auto-resolved conflict
 * and a parked (manual / delete) conflict both increment it — every recorded
 * `conflict` `SyncEvent` is one conflict. Default no-op; SP/telemetry wires the OTel
 * counter.
 */
export interface ConflictDetectionMetrics {
  /** One recorded `conflict` `SyncEvent` for the rule (CF-1.5). */
  recordConflict(ruleId: string): void;
}

// ── The write-path context + input ────────────────────────────────────────────

/**
 * The per-execution context the (deferred) handler assembles for a write-path
 * conflict check, from this direction's `ApprovedMapping`, the `SyncRule`, both
 * apps' `capabilities`, and both resources' `ResourceBinding`s.
 */
export interface ConflictDetectionContext {
  /** Canonical A/B app assignment for the link's `resourcePairRef` (stable, not by direction). */
  readonly appAId: string;
  readonly appBId: string;
  /** The target fields this write touches (projected from this direction's `FieldMapping`s). */
  readonly fields: readonly ConflictField[];
  /** PATCH (partial) vs PUT (full-replace) target `update` op shape — CF-5. */
  readonly writeShape: TargetWriteShape;
  /** `SyncRule.targetDriftCheck` — `none` (observed-only) or `read-before-write` (CF-6). */
  readonly targetDriftCheck: TargetDriftCheck;
  /**
   * CF-2's last-write-wins gate: **true iff both apps declare
   * `capabilities.supportsChangeTimestamps` AND both resources have a confirmed
   * `ResourceBinding.changeTimestampRef`** (the handler computes this AND). When
   * false, timestamp comparison is skipped entirely and observation order is the
   * policy (CF-2 crit 3).
   */
  readonly changeTimestampsComparable: boolean;
  /**
   * The target resource's `changeTimestampRef` path, used only under
   * `read-before-write` to read the freshly-fetched target record's change timestamp
   * for LWW. Absent → the live read contributes no timestamp (observation order).
   */
  readonly targetChangeTimestampRef?: string;
  /**
   * The single-record read binding, required when a target read may happen —
   * `read-before-write` (CF-6) or a withheld field on a PUT (CF-5). Absent is valid
   * only for the default `none` + PATCH path, which never reads the target (CF-1.2).
   */
  readonly targetReadBinding?: SingleRecordReadBinding;
}

/**
 * One write-path change entering Conflict Detection — carrying the resolved active
 * `RecordLink` Loop Prevention produced (its `not-echo` outcome). Only a genuine,
 * non-echo `create`/`update` reaches here; deletes take {@link DeletionConflictInput}.
 */
export interface ConflictDetectionInput {
  readonly change: DetectedChange;
  readonly link: RecordLink;
  readonly context: ConflictDetectionContext;
  /**
   * SA-4.2 — the operator's one-shot resolution directives for this execution (absent
   * on an ordinary poll-driven change). A directive supersedes the `manual-resolve`
   * park / auto last-write-wins **for its field only, when that field is drifted**; all
   * other CF invariants still hold. See {@link FieldConflictOverride}.
   */
  readonly overrides?: readonly FieldConflictOverride[];
  /**
   * SS-12.3 — the linked record's container fill resolved from `RecordLink.scopeRef`, so a
   * PUT read-carry routes to the stored container. Absent on an unscoped rule; the handler
   * resolves it once and parks (`ContainerUnresolvedError`) before CF when unresolvable.
   */
  readonly resolvedContainerScopeValues?: ReadonlyMap<string, string>;
}

// ── The per-field write plan + stage outcome (write path) ─────────────────────

/** Write this target field normally — no drift, or source won the auto-resolution. */
export interface WriteFieldPlan {
  readonly kind: "write";
  readonly targetPath: string;
}

/**
 * Withhold this target field from the write (CF-4 target-wins, or CF-3 manual park).
 * On a **PUT** (full-replace) op, `carry` is the target's **current** value the
 * downstream handler must place into the full payload for this field, preserving it
 * (CF-5) — never the contested source value. On a **PATCH** op, `carry` is absent:
 * withholding is simply omitting the field.
 */
export interface WithholdFieldPlan {
  readonly kind: "withhold";
  readonly targetPath: string;
  readonly reason: WithholdReason;
  readonly carry?: PathRead;
}

/** Per-field disposition — a discriminated union, never a `written?: boolean` flag. */
export type FieldPlan = WriteFieldPlan | WithholdFieldPlan;

/** One contested field's resolution — the `conflict` event detail + test assertions. */
export interface FieldResolution {
  readonly targetPath: string;
  readonly outcome: FieldResolutionOutcome;
}

/**
 * The recorded conflict for one execution: the id of the single `conflict`
 * `SyncEvent` CF wrote, plus every contested field's resolution. One event per
 * execution that had **any** contested field (whether auto-resolved or parked) —
 * nothing silently lost (CF-2 crit 4).
 */
export interface ConflictRecord {
  readonly syncEventId: string;
  readonly resolutions: readonly FieldResolution[];
}

/**
 * The write-path stage outcome — a discriminated union so the handler can never
 * mistake an all-withheld no-op for a genuine write:
 *  - `write` — a call **is** made with the per-field {@link FieldPlan}; `conflict` is
 *    present iff ≥1 field was contested (some may still be withheld — a partial
 *    conflict, CF-5 crit 1: the rest of the record still syncs).
 *  - `no-call` — **every** field ended up withheld (CF-4 crit 5): no call is made and
 *    the `conflict` event is recorded alone.
 */
export type ConflictDetectionOutcome = ConflictWriteOutcome | ConflictNoCallOutcome;

/** A call is made; `fields` is the per-field write/withhold plan. */
export interface ConflictWriteOutcome {
  readonly kind: "write";
  readonly fields: readonly FieldPlan[];
  readonly conflict?: ConflictRecord;
}

/** Every field withheld → no call; the `conflict` event stands alone (CF-4 crit 5). */
export interface ConflictNoCallOutcome {
  readonly kind: "no-call";
  readonly conflict: ConflictRecord;
}

// ── CF-7: the delete-path context, input, and outcome ─────────────────────────

/**
 * The per-execution context for evaluating a **propagated delete** (CF-7). A delete
 * is never auto-resolved against a drifted target — not even under LWW — so this
 * context needs no timestamp/epsilon inputs: any drift parks.
 */
export interface DeletionConflictContext {
  readonly appAId: string;
  readonly appBId: string;
  /** `SyncRule.deletePropagation` — `ignore` (default) or `propagate`. */
  readonly deletePropagation: DeletePropagation;
  /** `SyncRule.targetDriftCheck` — under `read-before-write` the target is read first (CF-7.1). */
  readonly targetDriftCheck: TargetDriftCheck;
  /** The mapped target field paths whose drift gates the delete (CF-7.1). */
  readonly targetFields: readonly string[];
  /** The single-record read binding — required under `read-before-write` (CF-7.1). */
  readonly targetReadBinding?: SingleRecordReadBinding;
}

/**
 * SA-4.3 — the operator's one-shot directive telling CF-7 the operator **accepted the
 * drift**: proceed with the propagated delete after all instead of parking it
 * (`docs/requirements/phase-4-sync-api.md` SA-4.3; `docs/architecture/sync-engine.md`
 * *Conflict handling* — *Deletes vs. edits*). The only choice modeled here is
 * `propagate` — `sever` never re-runs the delete pipeline (it tombstones the link
 * `observed-delete` directly, deleting nothing), so it needs no CF override.
 */
export interface DeletionConflictOverride {
  readonly choice: "propagate";
}

/** A delete entering Conflict Detection — carrying the resolved **active** link. */
export interface DeletionConflictInput {
  readonly change: DetectedChange;
  readonly link: RecordLink;
  readonly context: DeletionConflictContext;
  /**
   * SA-4.3 — the operator's one-shot "propagate the drifted delete after all"
   * directive (absent on an ordinary poll-driven delete). When present, CF-7 skips the
   * drift park and proceeds to delete. See {@link DeletionConflictOverride}.
   */
  readonly override?: DeletionConflictOverride;
  /**
   * SS-12.3/12.4 — the linked record's container fill resolved from `RecordLink.scopeRef`,
   * so a `read-before-write` drift-read of a scoped delete routes to the stored container
   * (a delete carries no captured scope). Absent on an unscoped rule; the handler resolves
   * it once and parks (`ContainerUnresolvedError`) before CF when unresolvable — closing the
   * L2/L3 record-derived-delete gap where the drift-read threw a generic transient today.
   */
  readonly resolvedContainerScopeValues?: ReadonlyMap<string, string>;
}

/**
 * The delete-path stage outcome (CF-7) — a discriminated union:
 *  - `delete` — undrifted target: delete normally; the handler tombstones the link
 *    `propagated-delete` (RL-5) and OC-2's delete idempotency key applies (CF-7.4).
 *  - `park` — the target drifted: recorded `conflict`, **link left active**, nothing
 *    deleted — for the operator to resolve (CF-7.2/7.3/7.6).
 *  - `skipped-policy` — `deletePropagation = ignore` (default): recorded
 *    `skipped-policy`, the handler tombstones the link `observed-delete`, stop; the
 *    drift check is moot (CF-7.5).
 */
export type DeletionConflictOutcome =
  DeleteProceedOutcome | DeleteParkOutcome | DeleteSkippedPolicyOutcome;

/** CF-7.4 — undrifted: proceed to the delete call, then tombstone `propagated-delete`. */
export interface DeleteProceedOutcome {
  readonly kind: "delete";
  readonly tombstoneReason: "propagated-delete";
}

/** CF-7.2/7.3/7.6 — drifted target: park as a manual conflict, link stays active, nothing deleted. */
export interface DeleteParkOutcome {
  readonly kind: "park";
  readonly syncEventId: string;
  readonly driftedFields: readonly string[];
}

/** CF-7.5 — `deletePropagation = ignore`: recorded `skipped-policy`, tombstone `observed-delete`. */
export interface DeleteSkippedPolicyOutcome {
  readonly kind: "skipped-policy";
  readonly syncEventId: string;
  readonly tombstoneReason: "observed-delete";
}
