import type {
  FieldMapping,
  RecordLink,
  SyncFieldStateSide,
  TombstoneReason,
} from "@mediator/domain";
import type { JsonRecord } from "@mediator/transform";

import type { DetectedChange, ResolutionOutcome } from "../identity-resolution/types.js";

/**
 * Types for the **Loop Prevention** stage — the sync pipeline's **second** stage,
 * after Identity Resolution and before Conflict Detection
 * (`docs/architecture/sync-engine.md` *Loop prevention*;
 * `docs/requirements/phase-4-loop-prevention.md` EP-1..EP-4). It drops the echo of
 * the mediator's own write so bidirectional sync (A→B→B's poll→A→…) cannot
 * ping-pong. "No echo" is a **hard invariant, not a heuristic**: the authoritative
 * check (EP-1) is the durable per-side `SyncFieldState` baseline compare, which
 * works with the cache cold and the target supporting no write metadata.
 *
 * Reuses the Identity Resolution stage's {@link DetectedChange},
 * {@link ResolutionOutcome}, {@link SyncEventRecorder} and {@link StageTraceContext}
 * ports (same package, no duplication) — this stage consumes the resolution the
 * previous stage produced.
 */

// ── EP-2: the recently-written cache (optimization only) ──────────────────────

/**
 * The `(appId, resource, native id)` key the recently-written cache is keyed by
 * (`docs/architecture/sync-engine.md` *Loop prevention* — fast path). `resource` is
 * the target resource ref the write landed on (and, on the probe side, the source
 * resource ref of the polling rule — the same physical resource).
 */
export interface RecentWriteKey {
  readonly appId: string;
  readonly resource: string;
  readonly nativeId: string;
}

/**
 * The short-TTL "recently written by mediator" cache (EP-2) — an **in-memory**
 * accelerator, never the correctness backstop. Populated when a mediator write
 * commits (EP-3 {@link RecordWriteInput}); probed by the fast path. Injecting the
 * clock is the whole point of the interface: TTL expiry is deterministic in tests,
 * and a `NullRecentlyWrittenCache` (always-miss) proves EP-1 still catches the echo
 * with the cache disabled.
 */
export interface RecentlyWrittenCache {
  /** Mark a target resource as recently written by the mediator (starts the TTL). */
  markWritten(key: RecentWriteKey): void;
  /** Whether a live (un-expired) entry exists for the key. */
  isRecentlyWritten(key: RecentWriteKey): boolean;
}

// ── EP-4.5 / EP-1: metrics ────────────────────────────────────────────────────

/**
 * Loop-prevention metrics (`docs/architecture/observability.md` *Metrics* —
 * skipped-loop rate per `SyncRule`; EP-4.5). `skipped-loop` and `skipped-policy`
 * are **distinct** rates — a delete echo / resurrection prevented (`skipped-loop`)
 * is never conflated with a counterpart-deleted survivor change (`skipped-policy`).
 * Default no-op; SP/telemetry wires OTel counters.
 */
export interface LoopPreventionMetrics {
  /** An echo / resurrection dropped `skipped-loop` (EP-4.5). */
  recordSkippedLoop(ruleId: string): void;
  /** A counterpart-deleted survivor change dropped `skipped-policy` (EP-4.3). */
  recordSkippedPolicy(ruleId: string): void;
}

// ── EP-1.2: which side-fields an echo must match ──────────────────────────────

/**
 * One direction of a resource pair, for computing the side-field participation set
 * (EP-1.2). `sourceSide` is which side (A|B, as the `RecordLink` defines them) this
 * direction's **source** app occupies; `fieldMappings` are that direction's
 * `FieldMapping`s. A one-way rule supplies one entry; a bidirectional pair supplies
 * two, and the echo compare covers the **union** of both.
 */
export interface MappingDirection {
  readonly sourceSide: SyncFieldStateSide;
  readonly fieldMappings: readonly FieldMapping[];
}

// ── The stage's per-change context ────────────────────────────────────────────

/**
 * The per-change context SP assembles for the stage from the resource pair's two
 * `ApprovedMapping`s + the canonical A/B assignment. `directions` carries **both**
 * directions' `FieldMapping`s so EP-1 can cover every side-X field participating in
 * *either* direction (EP-1.2), keeping the check well-defined under asymmetric
 * pairings and multi-input transforms.
 */
export interface LoopPreventionContext {
  /** Canonical A/B app assignment for the link's `resourcePairRef` (stable, not by direction). */
  readonly appAId: string;
  readonly appBId: string;
  /** Both directions' participation (1 entry one-way, 2 bidirectional) — EP-1.2. */
  readonly directions: readonly MappingDirection[];
}

// ── The stage input (EP-1 / EP-2 / EP-4) ──────────────────────────────────────

/**
 * The stage's per-change input, run **after** Identity Resolution (EP-1.6). Only
 * the {@link ResolutionOutcome}s Loop Prevention acts on reach it — `resolved`,
 * `straight-create`, `severed-tombstone`; the terminal IR outcomes
 * (`ambiguous-failure`, `skipped-policy`, `no-link-delete`) already recorded their
 * event and stop before EP.
 */
export interface LoopPreventionInput {
  readonly change: DetectedChange;
  readonly context: LoopPreventionContext;
  /** The Identity Resolution outcome this change carries into Loop Prevention. */
  readonly resolution: ResolutionOutcome;
  /** The source resource ref, for the EP-2 cache probe key (`appId = change.sourceAppId`). */
  readonly resource: string;
  /**
   * EP-2's **second** optimization (a seam): SP/OC computed that the incoming change
   * carries the mediator's passthrough write tag (the target API supports write
   * metadata). Optional — correctness **never** depends on it.
   */
  readonly carriesMediatorWriteTag?: boolean;
}

// ── EP-3: canonical-form capture (recordWrite / reBaseline) ────────────────────

/**
 * The re-baseline inputs the pipeline hands EP after a **successful** mediator write
 * (EP-3 — the OC-5 re-baseline OC deferred to Loop Prevention). Captures each side's
 * baseline in its **own** canonical representation: the **written** side from the
 * target's *stored* representation (`storedRepresentation` — the write response body,
 * or a follow-up read when the API returns none — NOT what the mediator sent), the
 * **source** side from the observed source value the write was computed from.
 */
export interface RecordWriteInput {
  readonly recordLinkId: string;
  /** The `ApprovedMapping` (direction) that produced this write — the written side's `lastWrittenByMappingId`. */
  readonly mappingId: string;
  /** The side the mediator wrote (its baseline comes from `storedRepresentation`). */
  readonly writtenSide: SyncFieldStateSide;
  /** The opposite side the write was computed from (its baseline comes from `observedSource`). */
  readonly sourceSide: SyncFieldStateSide;
  /** This direction's `FieldMapping`s — which fields to baseline on each side. */
  readonly fieldMappings: readonly FieldMapping[];
  /**
   * The target's **stored representation** — the write response body when the API
   * returns the updated resource (the common REST case), else a follow-up read of
   * the written record (the read left a seam SP/OC provides). Captured so target
   * normalization (trim/reformat/defaults) doesn't defeat echo detection (EP-3.1/3.3).
   */
  readonly storedRepresentation: JsonRecord;
  /** The observed source values the write was computed from (EP-3.2). */
  readonly observedSource: JsonRecord;
  /** The written target's cache key — populated into the recently-written cache (EP-2.1). */
  readonly writtenRecord: RecentWriteKey;
  /** The app-reported change timestamp of the target's stored representation, if any. */
  readonly writtenChangeTimestamp?: Date | null;
  /** The app-reported change timestamp of the observed source, if any. */
  readonly sourceChangeTimestamp?: Date | null;
}

// ── The discriminated stage outcome ───────────────────────────────────────────

/**
 * The stage's outcome for one change — a discriminated union so SP can never
 * mistake, say, a resurrection guard for a genuine change:
 *
 * - `echo` — the change is the echo of the mediator's own write (content echo,
 *   cache/tag hit, create echo, or delete echo); recorded `skipped-loop`, **stop**.
 * - `not-echo` — a genuine change; continue to Conflict Detection (carrying the link).
 * - `skipped-policy` — a change to a survivor whose counterpart was deleted
 *   (`observed-delete` tombstone); recorded `skipped-policy`, **stop** — distinct
 *   from an echo.
 * - `resurrection-prevented` — a stale snapshot still showing a record the mediator
 *   deleted (`propagated-delete` tombstone); recorded `skipped-loop`, **not**
 *   re-created (EP-4.4).
 */
export type LoopPreventionOutcome =
  LoopEchoOutcome | NotEchoOutcome | LoopSkippedPolicyOutcome | ResurrectionPreventedOutcome;

/** How an echo was recognized — for audit/debugging, not correctness. */
export type EchoVia =
  | "recently-written-cache"
  | "write-tag"
  | "field-baseline"
  | "create-propagation-link"
  | "propagated-delete-tombstone";

/** EP-1.3 / EP-2 / EP-4.1 / EP-4.2 — the echo of the mediator's own write. */
export interface LoopEchoOutcome {
  readonly kind: "echo";
  readonly via: EchoVia;
  readonly syncEventId: string;
  /** The record's link, when one was resolved (absent on a pre-resolution cache echo). */
  readonly recordLinkId?: string;
}

/** A genuine, non-echo change — continue to Conflict Detection. */
export interface NotEchoOutcome {
  readonly kind: "not-echo";
  /** The resolved link to carry to CF; absent for a straight-create (no link yet). */
  readonly recordLink?: RecordLink;
}

/** EP-4.3 — a change to a survivor whose counterpart was deleted (`observed-delete`). */
export interface LoopSkippedPolicyOutcome {
  readonly kind: "skipped-policy";
  readonly reason: "counterpart-deleted";
  readonly syncEventId: string;
  readonly recordLinkId: string;
}

/** EP-4.4 — a stale snapshot showing a `propagated-delete`-tombstoned record; not re-created. */
export interface ResurrectionPreventedOutcome {
  readonly kind: "resurrection-prevented";
  readonly syncEventId: string;
  readonly recordLinkId: string;
  readonly tombstoneReason: TombstoneReason;
}
