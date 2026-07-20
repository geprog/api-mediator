import type {
  ApprovedMappingStatus,
  ScopePathBinding,
  SourceScopeRef,
  SyncRule,
} from "@mediator/domain";
import type { CapturedScope, JsonRecord } from "@mediator/transform";

import type { ChangeKind, DetectedChange } from "../identity-resolution/types.js";

/**
 * Types for the **Scheduler + Poller** — the Sync Engine's change-detection driver
 * (`docs/architecture/sync-engine.md` *Change detection: polling pull*, *Polling
 * pull pipeline*, *Change types*, *Ordering and consistency*;
 * `docs/flows/sync-polling-pull.md`; `docs/requirements/phase-4-scheduler-poller.md`
 * SP-1..SP-5). This slice owns the poll pipeline **up to enqueue only**: the Poller
 * pulls the source's changes (delta or full-fetch), classifies them, **durably
 * enqueues** them, and only then advances the cursor/snapshot. The per-record
 * pipeline that the ordering-queue dispatcher runs on each enqueued change
 * (RL/EP/CF/TX/OC) is a **later slice** (assembled after CF lands).
 *
 * The ports are defined by the *consumer* (the Poller/Scheduler), so `@mediator/db`
 * and `@mediator/outbound` are dependencies only at the composition root — the Poller
 * itself is unit-testable against fakes (a fake source with canned pages + injectable
 * page failures, a fake queue/clock, a fake state store that mirrors the real atomic
 * advance).
 */

// ── The source-read seam (SP-2) ──────────────────────────────────────────────

/** One record observed on the source, with its native id already extracted (SP-2). */
export interface ObservedRecord {
  /** The record's native id (`ResourceBinding.nativeIdRef`), stringified. */
  readonly nativeId: string;
  /** The record body as observed this poll — hashed for the snapshot, queue-keyed by identity. */
  readonly record: JsonRecord;
}

/**
 * One page of a full-fetch collection read. `next` is the exhaustion signal: `done`
 * ends the paging loop, otherwise `continuation` is an **opaque** token the Poller
 * hands straight back to {@link SourceReader.readCollectionPage} for the next page —
 * the Poller never interprets it (the pagination convention is the reader's, SP-2).
 *
 * **SP-4 (SACRED):** a page that errored/timed-out/truncated returns `ok: false`, and
 * the Poller **aborts** the whole run — a missing record is NEVER read as a deletion.
 */
export type PageOutcome =
  | {
      readonly ok: true;
      readonly records: readonly ObservedRecord[];
      readonly next:
        { readonly done: true } | { readonly done: false; readonly continuation: string };
    }
  | { readonly ok: false; readonly reason: string };

/**
 * The result of a delta query since `cursor` (SP-2/SP-3). `records` are the changed
 * records; `deletedNativeIds` are deletions the API **explicitly reported** via the
 * confirmed `ResourceBinding.deltaDeletionRef` — **never fabricated**: a reader whose
 * `deltaDeletionRef` is unconfirmed returns `[]` here (SP-3.3). `nextCursor` is where
 * the response says the next cursor lives (`ResourceBinding.deltaCursorRef`);
 * `undefined` leaves the stored cursor unchanged.
 *
 * A failed delta call returns `ok: false` and the Poller aborts (no advance).
 */
export type DeltaOutcome =
  | {
      readonly ok: true;
      readonly records: readonly ObservedRecord[];
      readonly deletedNativeIds: readonly string[];
      readonly nextCursor: string | undefined;
    }
  | { readonly ok: false; readonly reason: string };

/**
 * SS-13.2/13.3 — one **resolved scope** the per-scope Poller polls: the source
 * container's `ScopeLink` (constant / manual / discovered — SS-11) plus the
 * `{ scope path parameter → value }` fill for that container's scoped read. The
 * `scopeLinkId` is the per-`(rule, scope)` state discriminator (cursor/snapshot key —
 * SS-13.3), keying the scope by its `ScopeLink` so every establishment kind fits.
 */
export interface PollScope {
  /** The resolved `ScopeLink` id — the per-scope cursor/snapshot state key (SS-13.3). */
  readonly scopeLinkId: string;
  /**
   * The scope path parameters filled for this container's scoped source read (a Gitea
   * `{ owner: "alice", repo: "phoenix" }`), resolved from the `ScopeLink`'s source-side
   * scope key (SS-12's container fill, source side). The reader substitutes these into
   * the still-templated source read path.
   */
  readonly fillValues: ReadonlyMap<string, string>;
}

/**
 * SS-13 fail-loud — a source container the per-scope resolution could **not** resolve
 * to a `ScopeLink` (SS-11.5 / SS-12.6). The Poller records it as a **parked** scope in
 * the run outcome and **never polls a guessed container** — surfaced for manual
 * container linking, never silently skipped.
 */
export interface PollScopeUnresolved {
  /** A human id of the unresolved container (for the parked-scope surface). */
  readonly container: string;
  readonly reason: string;
}

/**
 * The source-read port (SP-2). Delta where the source supports it, else a paged
 * collection read. Faked in unit tests (canned pages/delta + injectable failures);
 * the real {@link RestSourceReader} wires `ProtocolClient` + `CredentialAccess` + the
 * `AppLoadGovernor` so reads obey the **same OC-3 per-app ceilings as writes** (SP-2
 * criterion 4). Keyed by `ruleId`: the reader owns the per-rule transport binding
 * (base URL, operation, pagination/delta conventions, native-id path).
 *
 * SS-13 — the optional `scope` fills a **per-scope** read's container path parameters
 * (SS-13.2). Absent (cross-scope mode, SS-13.1) the read is exactly as before — one
 * cross-scope call, no container fill. The trailing-optional shape keeps every existing
 * caller/implementor source-compatible.
 */
export interface SourceReader {
  /** Read one page of the collection read; `continuation` is the reader's own token (SP-2). */
  readCollectionPage(
    ruleId: string,
    continuation: string | undefined,
    scope?: PollScope,
  ): Promise<PageOutcome>;
  /** Read the delta batch since `cursor` (SP-2/SP-3). */
  readDelta(ruleId: string, cursor: string | undefined, scope?: PollScope): Promise<DeltaOutcome>;
}

// ── The poll plan (SP-2/SP-3 resolution; SS-13 scope mode) ────────────────────

/**
 * The fields every poll plan shares, whatever its scope mode: the ids the enqueued
 * {@link DetectedChange} carries, the poll `mode` (delta vs full-fetch), and the
 * confirmed identity **source** path the queue key is computed from
 * (`docs/architecture/sync-engine.md` *Ordering and consistency*).
 */
export interface PollPlanCommon {
  readonly ruleId: string;
  readonly mappingId: string;
  readonly sourceAppId: string;
  readonly targetAppId: string;
  /** The mapped resource pair in canonical direction-agnostic form (keys links/state). */
  readonly resourcePairRef: string;
  readonly mode: "delta" | "full-fetch";
  /**
   * The confirmed identity `FieldMapping`'s **source** IR path — read AS-IS (no
   * transform) for the pre-link ordering key, exactly as Identity Resolution reads it.
   */
  readonly identitySourcePath: string;
  /**
   * The **source** resource's confirmed `sourceScopeRef` (SS-7), when it has one — the
   * keyed component set the Poller extracts each polled record's **captured scope** from
   * (SS-8.2). `undefined` for a non-scoped / constant-only rule (no confirmed
   * `sourceScopeRef`), in which case the Poller captures nothing (constant rules
   * unaffected).
   */
  readonly sourceScopeRef?: SourceScopeRef | undefined;
  /**
   * SS-14 — the **target** resource's scope path bindings when the rule is **scoped** (has a
   * confirmed `record-derived`/`scope-link` container binding). Its presence flips the
   * pre-link ordering-queue key to the scope-qualified form (SS-14.2) and enables the
   * unresolved-container park (SS-14.3). **Absent** on a non-scoped rule (keying unchanged),
   * so the plan and the resolved key stay byte-for-byte identical for those rules.
   */
  readonly targetScopePathBindings?: readonly ScopePathBinding[] | undefined;
}

/**
 * SS-13.1 — the **cross-scope** plan (the recommended default): one cross-scope
 * collection read and the **single per-rule `cursor`/snapshot** unchanged from SS-8.
 * Riding `sourceScopeRef` on it needs no new persisted poll state — capture is purely
 * per-record and in-flight.
 */
export interface CrossScopePollPlan extends PollPlanCommon {
  readonly scopeMode: "cross-scope";
  /** The stored per-rule delta cursor (delta mode only); `undefined` seeds from the beginning. */
  readonly cursor: string | undefined;
}

/**
 * SS-13.2/13.3/13.4 — the **per-scope** plan: the Poller enumerates the resolved
 * `scopes` and polls each container's scoped read, keeping a **cursor/snapshot per
 * scope** (loaded/advanced from `poll_scope_state` by `scopeLinkId`, not carried on
 * the plan). `unresolvedScopes` are surfaced/parked, never guessed (SS-13 fail-loud).
 */
export interface PerScopePollPlan extends PollPlanCommon {
  readonly scopeMode: "per-scope";
  readonly scopes: readonly PollScope[];
  readonly unresolvedScopes: readonly PollScopeUnresolved[];
}

/**
 * The resolved, transport-agnostic plan for one rule's poll — a discriminated union on
 * `scopeMode` (SS-13.5, derive-then-correct): a `cross-scope` rule keeps SS-8's single
 * cursor, a `per-scope` rule enumerates scopes and keeps per-scope state. SP assembles
 * it from the `SyncRule` + `ApprovedMapping` + source `ResourceBinding`s (+ the rule's
 * resolved `ScopeLink`s for the per-scope variant).
 */
export type PollPlan = CrossScopePollPlan | PerScopePollPlan;

/**
 * Why a rule cannot be polled right now — the runtime **backstop** (SP-2.5): an
 * unconfirmed `pollOperationRef`/binding ref is used nowhere. BE-1's enablement gate
 * prevents this state going live; the Poller refuses anyway.
 */
export type NotPollableReason =
  | "unconfirmed-poll-operation"
  | "unconfirmed-native-id"
  | "missing-identity-key"
  | "rule-not-found";

/** The resolution of a rule into a {@link PollPlan}, or the reason it cannot poll. */
export type PollPlanResolution =
  | { readonly pollable: true; readonly plan: PollPlan }
  | { readonly pollable: false; readonly reason: NotPollableReason };

/**
 * Resolves a named rule into its {@link PollPlan} (or a not-pollable reason). Injected
 * so the Poller is testable without the DB/IR; the real resolver loads the rule +
 * mapping + source bindings + app and checks ref confirmations (the SP-2.5 backstop).
 */
export interface PollPlanResolver {
  resolve(ruleId: string): Promise<PollPlanResolution>;
}

// ── The poll-state store: the atomic cursor/snapshot advance (SP-5) ───────────

/**
 * A full-fetch rule's prior snapshot — the `native id → content hash` map the Poller
 * diffs the complete fetch against (SP-2). `snapshotRef` is the `poll_snapshot` row id
 * the rule's `lastSnapshotRef` points at.
 */
export interface PollSnapshotState {
  readonly snapshotRef: string;
  readonly entries: ReadonlyMap<string, string>;
}

/**
 * The atomic advance a poll run applies **after every detected change is durably
 * enqueued** (SP-5, SACRED). `lastRunAt` always advances (with the cursor); a delta
 * rule advances `cursor`; a full-fetch rule replaces `snapshotEntries`. The store
 * applies all of it in **one transaction** — cursor, snapshot, and `lastRunAt` move
 * together or not at all.
 *
 * SS-13.3 — `scopeKey` (a scope's `ScopeLink` id) routes the advance to that scope's
 * **own** `poll_scope_state` row + scoped `poll_snapshot` (one atomic tx per scope);
 * **absent** it is the cross-scope advance over `sync_rule` + the sentinel snapshot,
 * unchanged from SP-5. A per-scope advance therefore never touches another scope's — nor
 * the cross-scope — state (per-scope isolation).
 */
export interface PollAdvance {
  readonly ruleId: string;
  readonly lastRunAt: Date;
  /** SS-13.3 — the scope's `ScopeLink` id (per-scope mode); absent = cross-scope. */
  readonly scopeKey?: string;
  /** Delta rules only: the new cursor. `undefined` leaves the cursor unchanged. */
  readonly cursor?: string;
  /** Full-fetch rules only: the replacement `native id → content hash` snapshot. */
  readonly snapshotEntries?: ReadonlyMap<string, string>;
  /** When the complete fetch was captured (stamped on the snapshot). */
  readonly capturedAt?: Date;
}

/**
 * The poll-state persistence port (SP-5). The real `DbPollStateStore` runs
 * {@link advance} inside a `tx()` over the `sync_rule` + `poll_snapshot` (cross-scope)
 * or `poll_scope_state` + `poll_snapshot` (per-scope, SS-13.3) tables; the
 * `FakePollStateStore` mirrors that atomicity (it mutates the per-`(rule, scope)` state
 * synchronously with no intervening `await`), so the enqueue-then-advance invariant and
 * per-scope isolation can be unit-tested.
 *
 * The optional `scopeKey` selects a **scope's** state (SS-13.3); absent it is the
 * cross-scope state (SS-13.1) — every SP-5 caller passing none keeps SP-5 behaviour.
 */
export interface PollStateStore {
  /** The (rule, scope)'s current snapshot (full-fetch), or `undefined` when it has none yet. */
  loadSnapshot(ruleId: string, scopeKey?: string): Promise<PollSnapshotState | undefined>;
  /**
   * SS-13.3 — one **scope's** stored delta cursor (per-scope mode). `undefined` when the
   * scope has no cursor yet (its first delta poll seeds from the beginning). A
   * cross-scope rule never calls this — its cursor rides the {@link CrossScopePollPlan}.
   */
  loadScopeCursor(ruleId: string, scopeKey: string): Promise<string | undefined>;
  /**
   * Atomically advance the rule's (or one scope's) live polling state (SP-5). Called ONLY
   * after every detected change of that (scope's) run is durably enqueued.
   */
  advance(advance: PollAdvance): Promise<void>;
  /**
   * SS-13.3 — stamp the **rule's own** `SyncRule.lastRunAt` after a per-scope fan-out,
   * touching nothing else (no cursor, no snapshot, no scope row).
   *
   * A per-scope run's {@link advance} calls all carry a `scopeKey`, so they write only
   * `poll_scope_state` — which leaves `SyncRule.lastRunAt` NULL forever. That is not a
   * cosmetic gap: the Scheduler's SP-1 due-ness gate reads `SyncRule.lastRunAt`, and a
   * NULL one means "never polled → due now", so a per-scope rule would be re-polled on
   * **every tick** regardless of its configured interval (breaking SP-1.1, flooding the
   * source against OC-3, and racing any concurrent poll trigger). The per-scope state
   * keeps its own `last_run_at` for per-scope staleness; this is the rule-level one.
   */
  advanceRuleRun(ruleId: string, lastRunAt: Date): Promise<void>;
}

// ── The durable enqueue seam (SP-5) ──────────────────────────────────────────

/**
 * The narrow durable-enqueue port the Poller drives (SP-5): the OQ-1
 * `OrderingQueueRepository.enqueue` (real) or the `FakeOrderingQueue` (unit tests),
 * both structurally an `OrderingQueueEnqueueOps`. The Poller never interprets the
 * queue key (OQ-2/OQ-3 own it, resolved by the `QueueKeyResolver` before enqueue).
 */
export interface ChangeEnqueue {
  enqueue(queueKey: string, payload: Record<string, unknown>): Promise<string>;
}

/**
 * SS-14.3 — the per-record **container-link park** sink. When the Poller's pre-enqueue scope
 * resolution cannot resolve a scoped record's container (no active `ScopeLink`), the record
 * **cannot be safely scope-keyed**, so it is **parked for manual container linking BEFORE it
 * is enqueued** (routed to the SS-11.5 parked-container surface, never enqueued under a
 * guessed / un-scoped key — SS-12.6 consistent). The real implementation records a
 * container-park `SyncEvent` (deduped across polls); a fake mirrors it in tests. Injected via
 * {@link PollerOptions}; a scoped rule that reaches a park with no sink wired is a **fail-loud**
 * configuration error (the Poller throws rather than silently drop a record).
 */
export interface ContainerParkSink {
  park(park: ContainerParkRecord): Promise<void>;
}

/** One record whose container did not resolve at queue-key time (SS-14.3) — parked, not enqueued. */
export interface ContainerParkRecord {
  readonly ruleId: string;
  readonly mappingId: string;
  readonly sourceAppId: string;
  readonly sourceNativeId: string;
  readonly resourcePairRef: string;
  /** The record's captured scope — the impl derives the container's scope key from it (SS-11.5 dedup). */
  readonly capturedScope: CapturedScope | undefined;
  /** The unresolved-container reason (a non-secret note — scope keys are operator config). */
  readonly reason: string;
}

/**
 * The enqueued work descriptor — a serialized {@link DetectedChange} the ordering-queue
 * dispatcher later hands to the per-record pipeline handler (RL/EP/CF/TX/OC, a **later
 * slice**). SP carries the classified `changeKind` so that handler selects the target
 * `OperationMapping` whose `action` matches (SP-3.5). It is exactly the `DetectedChange`
 * shape (all JSON-serializable); {@link buildChangePayload} materializes it as the
 * `Record<string, unknown>` the durable enqueue takes, and the post-CF handler parses
 * it back verbatim.
 */
export type PollChangePayload = DetectedChange;

/** Serialize a {@link DetectedChange} into the opaque enqueue payload (SP-5). */
export function buildChangePayload(change: DetectedChange): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    ruleId: change.ruleId,
    mappingId: change.mappingId,
    sourceAppId: change.sourceAppId,
    targetAppId: change.targetAppId,
    resourcePairRef: change.resourcePairRef,
    sourceNativeId: change.sourceNativeId,
    changeKind: change.changeKind,
  };
  // Omit (not `undefined`) on a delete — the record is gone; keep the jsonb clean.
  if (change.observedRecord !== undefined) {
    payload.observedRecord = change.observedRecord;
  }
  // SS-8.5 — the captured scope rides WITH the change through the ordering-queue payload
  // (an in-flight attribute, not persisted sync state). Omitted for a non-scoped /
  // constant-only rule, keeping the payload backward-compatible.
  if (change.capturedScope !== undefined) {
    payload.capturedScope = change.capturedScope;
  }
  return payload;
}

// ── Poll-run outcome (SP-4/SP-5) ─────────────────────────────────────────────

/** One enqueued change, for the run outcome (observability / tests). */
export interface EnqueuedChange {
  readonly queueKey: string;
  readonly changeKind: ChangeKind;
  readonly sourceNativeId: string;
}

/**
 * How **one scope** of a per-scope run ended (SS-13.3) — the per-scope analog of a
 * whole cross-scope run's outcome, so per-scope isolation is observable/testable: a
 * `parked` scope (SS-13 fail-loud, an unresolvable container) or an `aborted` scope
 * (SP-4 per scope) sits **beside** the other scopes' `completed` results without
 * stopping them.
 */
export interface PerScopeRunResult {
  /** The scope's `ScopeLink` id (`"__unresolved__"` for a parked, unresolvable scope). */
  readonly scopeLinkId: string;
  readonly result:
    | {
        readonly kind: "completed";
        readonly enqueued: readonly EnqueuedChange[];
        readonly mode: "delta" | "full-fetch";
      }
    | { readonly kind: "aborted"; readonly reason: string }
    // SS-13 fail-loud — an unresolvable scope is parked, never polled with a guessed container.
    | { readonly kind: "parked"; readonly reason: string };
}

/**
 * How one poll cycle ended (the deterministic poll-trigger hook returns this):
 *  - `completed` — the run detected `enqueued.length` changes, durably enqueued them
 *    all, and advanced the cursor/snapshot/`lastRunAt` (SP-5). `enqueued` is empty on a
 *    no-change poll (which still advances).
 *  - `aborted` — a page/delta read failed (SP-4, SACRED): NO enqueue, NO advance, NO
 *    false deletion. Poller lag keeps growing (surfaces as a stuck poller, SP-4.4).
 *  - `skipped` — the rule is not pollable right now (an unconfirmed ref backstop, or
 *    the named rule was not found).
 *  - `completed-per-scope` (SS-13.3) — a per-scope run: `scopes` carries each resolved
 *    scope's own completed/aborted result **plus** each unresolvable scope's `parked`
 *    result. One scope aborting/parking never aborts the whole run — the others still
 *    complete and advance their own state (per-scope isolation).
 */
export type PollRunOutcome =
  | {
      readonly kind: "completed";
      readonly enqueued: readonly EnqueuedChange[];
      readonly mode: "delta" | "full-fetch";
    }
  | { readonly kind: "aborted"; readonly reason: string }
  | { readonly kind: "skipped"; readonly reason: NotPollableReason }
  | { readonly kind: "completed-per-scope"; readonly scopes: readonly PerScopeRunResult[] };

/**
 * Poll-run observability (optional; default no-op). The Poller reports each run's
 * outcome so the Sync Engine dashboard can chart poll-run throughput / abort rate
 * (`docs/architecture/observability.md` *Metrics*). Poller **lag** and the stuck-poller
 * alert are the Scheduler's ({@link SchedulerMetrics}).
 */
export interface PollerMetrics {
  recordPollRun(ruleId: string, outcome: PollRunOutcome): void;
}

// ── Scheduler (SP-1) ─────────────────────────────────────────────────────────

/**
 * The Scheduler's per-rule candidate: the enabled `SyncRule` plus its mapping status
 * and source polling capability + default interval — the exact `PollCandidate` the
 * `SyncRuleRepository.listPollCandidates` join returns. Re-declared as a narrow port
 * (`listPollCandidates`) so the Scheduler is testable against a fake.
 */
export interface PollCandidateSource {
  listPollCandidates(): Promise<PollCandidateView[]>;
}

/** The per-rule inputs the eligibility gate decides on (mirrors `@mediator/db`'s `PollCandidate`). */
export interface PollCandidateView {
  readonly rule: SyncRule;
  readonly mappingStatus: ApprovedMappingStatus;
  readonly sourceAppId: string;
  readonly sourceSupportsPolling: boolean;
  readonly sourceDefaultPollInterval: number;
}

/** Why the Scheduler is holding a rule back this tick (never mutates `SyncRule.status`). */
export type PollHoldReason =
  // SP-1.3: staleness/suspension lives on the mapping — the rule pauses, status untouched.
  | "mapping-stale"
  | "mapping-suspended"
  // SP-1.2: an enabled rule whose backfill is still pending/running polls nothing yet.
  | "backfill-not-done"
  // SP-1.2: the mapping is neither active nor stale/suspended (superseded/archived).
  | "mapping-not-active"
  // SP-1.4: a source that declares `supportsPolling = false` cannot be a source (backstop).
  | "source-not-pollable"
  // Defensive: a non-enabled row slipped into the candidate set.
  | "not-enabled";

/**
 * The Scheduler's decision for one rule this tick (SP-1) — a discriminated union so
 * the caller can never confuse "hold, do nothing" with "not yet due" or "poll now".
 */
export type PollDecision =
  | { readonly kind: "poll"; readonly intervalMs: number; readonly lastRunAt: Date | undefined }
  | {
      readonly kind: "not-due";
      readonly intervalMs: number;
      readonly dueInMs: number;
      readonly lastRunAt: Date;
    }
  | { readonly kind: "hold"; readonly reason: PollHoldReason };

/**
 * The poll-trigger the Scheduler drives per eligible rule — one synchronous poll
 * cycle (detect → enqueue → advance). The `Poller.pollOnce` is exactly this shape, and
 * so is the deterministic hook an e2e (SU-6) calls directly.
 */
export interface PollTrigger {
  pollOnce(ruleId: string): Promise<PollRunOutcome>;
}

/**
 * Poller-lag + stuck-poller observability (SP-1.5; `docs/architecture/observability.md`
 * *Metrics*, *Alerting*). Default no-op. `recordPollerLag` is emitted per actively-
 * scheduled rule every tick; `recordStuckPoller` fires the alert when a rule has had no
 * successful poll past N× its expected interval — the explicit, monitorable staleness
 * bound (an aborted run leaves lag growing, SP-4.4).
 */
export interface SchedulerMetrics {
  recordPollerLag(ruleId: string, lagMs: number, intervalMs: number): void;
  recordStuckPoller(ruleId: string, lagMs: number, intervalMs: number): void;
}
