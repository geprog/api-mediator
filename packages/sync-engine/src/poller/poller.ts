import { extractCapturedScope, type JsonRecord } from "@mediator/transform";

import type { ChangeKind, DetectedChange } from "../identity-resolution/types.js";
import type { QueueKeyResolver } from "../ordering/queue-key-resolver.js";
import { contentHashOfRecord } from "./content-hash.js";
import {
  buildChangePayload,
  type ChangeEnqueue,
  type ContainerParkRecord,
  type ContainerParkSink,
  type CrossScopePollPlan,
  type EnqueuedChange,
  type PerScopePollPlan,
  type PerScopeRunResult,
  type PollPlanCommon,
  type PollPlanResolver,
  type PollRunOutcome,
  type PollScope,
  type PollStateStore,
  type PollerMetrics,
  type SourceReader,
} from "./types.js";

/**
 * SS-13.3 — how one scope's (or the cross-scope) poll cycle ended: `completed` (its
 * changes enqueued + its own state advanced) or `aborted` (SP-4, no advance, no false
 * delete). The narrow result `#pollDelta`/`#pollFullFetch` return — assignable to both
 * the whole-run {@link PollRunOutcome} (cross-scope) and a {@link PerScopeRunResult}.
 */
type ScopeRunOutcome =
  | {
      readonly kind: "completed";
      readonly enqueued: readonly EnqueuedChange[];
      readonly mode: "delta" | "full-fetch";
    }
  | { readonly kind: "aborted"; readonly reason: string };

const UNRESOLVED_SCOPE_MARKER = "__unresolved__";

/**
 * The **Poller** — one poll cycle for a `SyncRule`: pull the source's changes (delta
 * or full-fetch), classify them, **durably enqueue** them, and only then advance the
 * cursor/snapshot (`docs/architecture/sync-engine.md` *Polling pull pipeline*;
 * `docs/flows/sync-polling-pull.md` steps 2-4; SP-2..SP-5). This slice owns the
 * pipeline **up to enqueue only** — the per-record pipeline (RL/EP/CF/TX/OC) that the
 * ordering-queue dispatcher runs on each enqueued change is a **later slice**.
 *
 * Two crash-safety invariants are **sacred** (SP-4, SP-5):
 *  - **abort-on-partial** — if any page of a full fetch fails, the run aborts: the
 *    cursor/snapshot/`lastRunAt` do NOT advance and a missing record is NEVER read as
 *    a deletion (a truncated fetch must not delete real records).
 *  - **enqueue-then-advance** — every detected change is durably enqueued onto its
 *    ordering queue (key resolved before enqueue, OQ-3) and ONLY AFTER all are enqueued
 *    is the cursor/snapshot/`lastRunAt` advanced atomically. A crash before the advance
 *    re-detects + re-enqueues next poll (echo/idempotency absorb the dupes); a crash
 *    after loses nothing (the queued changes are durable). **Processing never gates
 *    advancement** — a parked/retrying record is already queued.
 *
 * {@link pollOnce} is the deterministic **poll-trigger hook** (SP-5 criterion 6): it
 * runs exactly one cycle synchronously (detect → enqueue → advance), so an e2e (SU-6)
 * drives a sync round without waiting on the Scheduler's wall clock.
 */
export interface PollerOptions {
  /** Clock seam (default `() => new Date()`); `lastRunAt`/`capturedAt` are stamped from it. */
  readonly now?: () => Date;
  /** Poll-run observability (default no-op). Poller **lag** is the Scheduler's. */
  readonly metrics?: PollerMetrics;
  /**
   * Hard cap on full-fetch pages, a safety valve against a misbehaving reader that
   * never reports exhaustion (a bug, or an API that keeps returning `done: false`).
   * Exceeding it aborts the run (SP-4 discipline: never advance on an unsound fetch).
   * Default 100_000.
   */
  readonly maxPages?: number;
  /**
   * SS-14.3 — the container-link park sink a **scoped** rule routes an unresolved-container
   * record to (parked before enqueue, never enqueued under a guessed key). Required for
   * scoped rules (a park with no sink throws — never a silent drop); omit for non-scoped-only
   * deployments.
   */
  readonly containerPark?: ContainerParkSink;
}

const DEFAULT_MAX_PAGES = 100_000;

/** A detected change with its pre-resolved queue key + payload, ready to enqueue (SP-5). */
interface PreparedEnqueue {
  readonly kind: "enqueue";
  readonly queueKey: string;
  readonly changeKind: ChangeKind;
  readonly sourceNativeId: string;
  readonly payload: Record<string, unknown>;
}

/** SS-14.3 — a scoped change whose container did not resolve: parked, never enqueued. */
interface PreparedPark {
  readonly kind: "park";
  readonly park: ContainerParkRecord;
}

/** One prepared detected change: enqueue it, or (SS-14.3) park its unresolved container. */
type PreparedChange = PreparedEnqueue | PreparedPark;

export class Poller {
  readonly #reader: SourceReader;
  readonly #resolver: PollPlanResolver;
  readonly #state: PollStateStore;
  readonly #enqueue: ChangeEnqueue;
  readonly #queueKeys: QueueKeyResolver;
  readonly #now: () => Date;
  readonly #metrics: PollerMetrics | undefined;
  readonly #maxPages: number;
  readonly #containerPark: ContainerParkSink | undefined;
  /** Per-rule tail of the serialized poll-cycle chain (one cycle at a time — see {@link pollOnce}). */
  readonly #inFlight = new Map<string, Promise<PollRunOutcome>>();

  public constructor(
    reader: SourceReader,
    resolver: PollPlanResolver,
    state: PollStateStore,
    enqueue: ChangeEnqueue,
    queueKeys: QueueKeyResolver,
    options: PollerOptions = {},
  ) {
    this.#reader = reader;
    this.#resolver = resolver;
    this.#state = state;
    this.#enqueue = enqueue;
    this.#queueKeys = queueKeys;
    this.#now = options.now ?? ((): Date => new Date());
    this.#metrics = options.metrics;
    this.#maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
    this.#containerPark = options.containerPark;
  }

  /**
   * Run exactly one poll cycle for `ruleId` synchronously (the SP-5 poll-trigger hook):
   * detect → durably enqueue → advance. Returns how the run ended (`completed` /
   * `aborted` / `skipped`) — never throws for an expected outcome; only a genuine
   * infrastructure fault (a store/enqueue error) propagates.
   */
  public async pollOnce(ruleId: string): Promise<PollRunOutcome> {
    // One cycle per rule at a time, SERIALIZED rather than overlapped. Two concurrent
    // cycles both load the same prior snapshot and the one that commits last overwrites
    // the other's advance — dropping a just-detected record from the baseline, while the
    // losing run reports zero changes for a change that really happened (silent
    // under-reporting on a full-fetch feed, one step from an absence→delete inference).
    //
    // Queueing behind the in-flight cycle rather than refusing keeps the caller's request
    // honoured: a `poll now` still runs a real cycle and reports its OWN true result. The
    // predecessor's failure never cancels the successor — each cycle stands alone.
    //
    // LIMITATION — this guard is **in-process only**, and is the first piece of per-process
    // Poller state in a system whose components are otherwise stateless over the shared
    // store (`docs/architecture/overview.md` *Availability*). It is sufficient for the
    // single-instance and active-passive standby deployments named there (only one instance
    // polls), but NOT for active-active: two instances would each hold their own map and
    // reintroduce exactly the overlapping-cycle lost update above, invisibly to every test
    // here. Making the Poller multi-instance-safe therefore requires moving this mutual
    // exclusion into the shared store — a Postgres advisory lock taken on the rule id for
    // the duration of the cycle, or a `poll_run` row keyed by `sync_rule_id` claimed and
    // released around it — not a second in-memory guard.
    const previous = this.#inFlight.get(ruleId);
    const run = (async (): Promise<PollRunOutcome> => {
      if (previous !== undefined) {
        await previous.catch((): undefined => undefined);
      }
      return this.#runCycle(ruleId);
    })();
    this.#inFlight.set(ruleId, run);
    try {
      return await run;
    } finally {
      // Only the tail clears the slot: a later call may already have chained onto it.
      if (this.#inFlight.get(ruleId) === run) {
        this.#inFlight.delete(ruleId);
      }
    }
  }

  /** One poll cycle, already guarded against a concurrent cycle for the same rule. */
  async #runCycle(ruleId: string): Promise<PollRunOutcome> {
    const resolution = await this.#resolver.resolve(ruleId);
    if (!resolution.pollable) {
      const outcome: PollRunOutcome = { kind: "skipped", reason: resolution.reason };
      this.#metrics?.recordPollRun(ruleId, outcome);
      return outcome;
    }
    const plan = resolution.plan;
    const outcome =
      plan.scopeMode === "cross-scope"
        ? await this.#pollCrossScope(plan)
        : await this.#pollPerScope(plan);
    this.#metrics?.recordPollRun(ruleId, outcome);
    return outcome;
  }

  // ── Cross-scope polling (SS-13.1) — SS-8's single cursor, UNCHANGED ──────────

  /**
   * SS-13.1 — the cross-scope poll: one call, the single per-rule `cursor`/snapshot
   * (scope `undefined` throughout). Byte-for-byte the SP-5 behaviour — adding per-scope
   * state must not alter it.
   */
  async #pollCrossScope(plan: CrossScopePollPlan): Promise<PollRunOutcome> {
    return plan.mode === "delta"
      ? this.#pollDelta(plan, plan.cursor, undefined)
      : this.#pollFullFetch(plan, undefined);
  }

  // ── Per-scope polling (SS-13.2/13.3/13.4) ────────────────────────────────────

  /**
   * SS-13.3 — enumerate the resolved scopes and poll each container's scoped read with
   * its **own** cursor/snapshot. Per-scope isolation is the whole contract: one scope's
   * abort (SP-4 per scope) or write/enqueue failure **never** aborts or advances another
   * scope — each scope's run is independent, and an unresolvable scope is **parked** (SS-13
   * fail-loud), never polled with a guessed container and never silently skipped.
   */
  async #pollPerScope(plan: PerScopePollPlan): Promise<PollRunOutcome> {
    const scopes: PerScopeRunResult[] = [];
    // SS-13 fail-loud — surface every unresolvable container as a parked scope first.
    for (const unresolved of plan.unresolvedScopes) {
      scopes.push({
        scopeLinkId: UNRESOLVED_SCOPE_MARKER,
        result: {
          kind: "parked",
          reason: `unresolved container ${unresolved.container}: ${unresolved.reason}`,
        },
      });
    }
    for (const scope of plan.scopes) {
      // Isolate each scope: a thrown store/enqueue fault for one scope is confined to it
      // (recorded as that scope's abort) so the remaining scopes still poll and advance.
      let result: ScopeRunOutcome;
      try {
        result =
          plan.mode === "delta"
            ? await this.#pollDelta(
                plan,
                await this.#state.loadScopeCursor(plan.ruleId, scope.scopeLinkId),
                scope,
              )
            : await this.#pollFullFetch(plan, scope);
      } catch (error) {
        result = { kind: "aborted", reason: `scope run failed: ${describeError(error)}` };
      }
      scopes.push({ scopeLinkId: scope.scopeLinkId, result });
    }
    // SP-1 — stamp the RULE's own `lastRunAt`. Each scope has already advanced its own
    // `poll_scope_state` row; none of those touch `SyncRule.lastRunAt`, and a NULL one
    // reads to the Scheduler as "never polled → due now", so the rule would be re-polled
    // every tick forever, ignoring its interval. Mirrors SP-4's cross-scope rule: a cycle
    // in which EVERY scope aborted made no progress, so it does not advance — poller lag
    // keeps growing and the stuck-poller alert still fires. A cycle with at least one
    // completed (or parked) scope did run, and per-scope isolation forbids one scope's
    // abort from holding the whole rule's schedule hostage.
    if (!everyScopeAborted(scopes)) {
      await this.#state.advanceRuleRun(plan.ruleId, this.#now());
    }
    return { kind: "completed-per-scope", scopes };
  }

  // ── Delta polling (SP-2 delta / SP-3 create-vs-update + reported deletions) ──

  async #pollDelta(
    plan: PollPlanCommon,
    cursor: string | undefined,
    scope: PollScope | undefined,
  ): Promise<ScopeRunOutcome> {
    const result = await this.#reader.readDelta(plan.ruleId, cursor, scope);
    if (!result.ok) {
      // SP-4 discipline extended to delta: a failed call never advances the cursor
      // (per scope in per-scope mode — this scope's cursor stays put, others proceed).
      return { kind: "aborted", reason: result.reason };
    }

    const prepared: PreparedChange[] = [];
    for (const observed of result.records) {
      // A delta record with no link is a create (RL downgrades to update on a match);
      // an existing link is an update. `inSnapshot` is irrelevant to delta (no snapshot).
      prepared.push(
        await this.#prepareChange(plan, observed.nativeId, observed.record, false, false),
      );
    }
    for (const deletedNativeId of result.deletedNativeIds) {
      // SP-3.2: a deletion ONLY because the API explicitly reported it (the reader
      // returns [] when `deltaDeletionRef` is unconfirmed — never fabricated).
      prepared.push(await this.#prepareChange(plan, deletedNativeId, undefined, true, false));
    }

    // SP-5: durably enqueue every change (SS-14.3: or park it) BEFORE advancing.
    await this.#persistChanges(prepared);
    // SP-5: advance the cursor (with `lastRunAt`) atomically, and only now — keyed to
    // this scope in per-scope mode (SS-13.3), the whole rule cross-scope.
    const advance: { ruleId: string; scopeKey?: string; lastRunAt: Date; cursor?: string } = {
      ruleId: plan.ruleId,
      lastRunAt: this.#now(),
    };
    if (scope !== undefined) {
      advance.scopeKey = scope.scopeLinkId;
    }
    if (result.nextCursor !== undefined) {
      advance.cursor = result.nextCursor;
    }
    await this.#state.advance(advance);
    return { kind: "completed", enqueued: toEnqueued(prepared), mode: "delta" };
  }

  // ── Full-fetch polling (SP-2 paged-to-exhaustion + snapshot diff; SP-4) ──────

  async #pollFullFetch(
    plan: PollPlanCommon,
    scope: PollScope | undefined,
  ): Promise<ScopeRunOutcome> {
    const prior = await this.#state.loadSnapshot(plan.ruleId, scope?.scopeLinkId);
    const priorEntries = prior?.entries ?? new Map<string, string>();

    // Page to exhaustion. SP-4 (SACRED): any page failure aborts BEFORE any diff, so a
    // truncated fetch can never be misread as mass deletion — per scope in per-scope
    // mode (this scope's snapshot/cursor stay put; the other scopes still poll).
    const fetched = new Map<string, JsonRecord>();
    let continuation: string | undefined;
    for (let page = 0; page < this.#maxPages; page += 1) {
      const outcome = await this.#reader.readCollectionPage(plan.ruleId, continuation, scope);
      if (!outcome.ok) {
        return { kind: "aborted", reason: outcome.reason };
      }
      for (const observed of outcome.records) {
        fetched.set(observed.nativeId, observed.record);
      }
      if (outcome.next.done) {
        return await this.#completeFullFetch(plan, priorEntries, fetched, scope);
      }
      continuation = outcome.next.continuation;
    }
    // Exhaustion never reported within the cap → treat as an unsound fetch and abort.
    return { kind: "aborted", reason: `full fetch exceeded ${String(this.#maxPages)} pages` };
  }

  /**
   * The complete fetch succeeded (every page ok) — now the diff is sound (SP-4.3): a
   * native id in the prior snapshot but absent from this complete fetch is a delete
   * candidate. Build the new snapshot (keyed by native id **within this scope** — SS-13
   * foreshadowing SS-14.5), classify each present/absent record, enqueue, then replace
   * the snapshot + advance `lastRunAt` atomically (SP-5, per scope).
   */
  async #completeFullFetch(
    plan: PollPlanCommon,
    priorEntries: ReadonlyMap<string, string>,
    fetched: ReadonlyMap<string, JsonRecord>,
    scope: PollScope | undefined,
  ): Promise<ScopeRunOutcome> {
    const newSnapshot = new Map<string, string>();
    const prepared: PreparedChange[] = [];

    for (const [nativeId, record] of fetched) {
      const hash = contentHashOfRecord(record);
      newSnapshot.set(nativeId, hash);
      const priorHash = priorEntries.get(nativeId);
      if (priorHash === hash) {
        // SP-2.3: unchanged since the snapshot → not re-processed.
        continue;
      }
      const inSnapshot = priorHash !== undefined;
      prepared.push(await this.#prepareChange(plan, nativeId, record, false, inSnapshot));
    }

    // SP-3.4: present in the last snapshot but absent from this COMPLETE fetch → delete.
    for (const nativeId of priorEntries.keys()) {
      if (!fetched.has(nativeId)) {
        prepared.push(await this.#prepareChange(plan, nativeId, undefined, true, true));
      }
    }

    // SP-5: durably enqueue every change (SS-14.3: or park it) BEFORE advancing.
    await this.#persistChanges(prepared);
    // SP-5: replace the snapshot + set `lastRunAt` atomically, and only now — keyed to
    // this scope in per-scope mode (SS-13.3).
    const capturedAt = this.#now();
    const advance: {
      ruleId: string;
      scopeKey?: string;
      lastRunAt: Date;
      snapshotEntries: ReadonlyMap<string, string>;
      capturedAt: Date;
    } = {
      ruleId: plan.ruleId,
      lastRunAt: capturedAt,
      snapshotEntries: newSnapshot,
      capturedAt,
    };
    if (scope !== undefined) {
      advance.scopeKey = scope.scopeLinkId;
    }
    await this.#state.advance(advance);
    return { kind: "completed", enqueued: toEnqueued(prepared), mode: "full-fetch" };
  }

  // ── Classification + queue keying (SP-3 / OQ-3) ──────────────────────────────

  /**
   * Resolve one change's queue key (OQ-3, **before** enqueue) and classify it (SP-3).
   * The queue-key basis doubles as the cheap "existing link?" signal: an active
   * `RecordLink` (basis `record-link`) makes a non-delete an **update**; otherwise a
   * record already in the snapshot (changed hash) is an update and a brand-new one is a
   * create (Identity Resolution downgrades a matched create to update later — RL owns
   * that, out of SP scope). A delete stays a delete.
   */
  async #prepareChange(
    plan: PollPlanCommon,
    sourceNativeId: string,
    observedRecord: JsonRecord | undefined,
    isDelete: boolean,
    inSnapshot: boolean,
  ): Promise<PreparedChange> {
    // SS-8.2 — when the source resource has a confirmed `sourceScopeRef`, capture THIS
    // record's scope from the record already fetched (the cross-scope collection read
    // needs no special handling — one call, single cursor; the NEW work is purely the
    // per-record capture). Captured FIRST because SS-14.2 scope-qualifies the pre-link
    // queue key from it. A partial record yields a partial map (SS-7's helper omits an
    // absent component) which a `record-derived` fill later refuses on rather than
    // fabricating (SS-8.3). No capture without a confirmed ref, or on a delete (the record
    // is gone) — constant rules unaffected. An empty capture is treated as "no scope".
    let capturedScope: DetectedChange["capturedScope"];
    if (observedRecord !== undefined && plan.sourceScopeRef !== undefined) {
      const captured = extractCapturedScope(observedRecord, plan.sourceScopeRef);
      if (Object.keys(captured).length > 0) {
        capturedScope = captured;
      }
    }

    const resolved = await this.#queueKeys.resolve(
      {
        resourcePairRef: plan.resourcePairRef,
        sourceAppId: plan.sourceAppId,
        targetAppId: plan.targetAppId,
        sourceNativeId,
        ...(observedRecord !== undefined ? { observedRecord } : {}),
        ...(capturedScope !== undefined ? { capturedScope } : {}),
      },
      {
        identitySourcePath: plan.identitySourcePath,
        // SS-14.2/14.3 — a scoped rule qualifies the pre-link key by container (and parks an
        // unresolved one); a non-scoped rule passes no scope config → key unchanged.
        ...(plan.targetScopePathBindings !== undefined
          ? { scope: { targetScopePathBindings: plan.targetScopePathBindings } }
          : {}),
      },
    );

    if (resolved.outcome === "park-container") {
      // SS-14.3 — the container did not resolve, so the record cannot be safely scope-keyed:
      // park it for manual container linking BEFORE enqueue, never enqueue under a guessed key.
      return {
        kind: "park",
        park: {
          ruleId: plan.ruleId,
          mappingId: plan.mappingId,
          sourceAppId: plan.sourceAppId,
          sourceNativeId,
          resourcePairRef: plan.resourcePairRef,
          capturedScope,
          reason: resolved.reason,
        },
      };
    }

    const changeKind: ChangeKind = isDelete
      ? "delete"
      : resolved.basis === "record-link" || inSnapshot
        ? "update"
        : "create";

    const change: DetectedChange = {
      ruleId: plan.ruleId,
      mappingId: plan.mappingId,
      sourceAppId: plan.sourceAppId,
      targetAppId: plan.targetAppId,
      resourcePairRef: plan.resourcePairRef,
      sourceNativeId,
      changeKind,
      ...(observedRecord !== undefined ? { observedRecord } : {}),
      ...(capturedScope !== undefined ? { capturedScope } : {}),
    };
    return {
      kind: "enqueue",
      queueKey: resolved.queueKey,
      changeKind,
      sourceNativeId,
      payload: buildChangePayload(change),
    };
  }

  /**
   * SP-5 — durably persist every detected change (each a committed insert) before the
   * advance: an `enqueue` change is enqueued onto its ordering queue; a `park` change
   * (SS-14.3) is recorded on the container-park surface (never enqueued). Both are durable
   * before the cursor/snapshot advances, so a crash before the advance re-detects them.
   */
  async #persistChanges(prepared: readonly PreparedChange[]): Promise<void> {
    for (const change of prepared) {
      if (change.kind === "park") {
        await this.#recordPark(change.park);
        continue;
      }
      await this.#enqueue.enqueue(change.queueKey, change.payload);
    }
  }

  /** SS-14.3 — record a container-link park (fail loud when a scoped rule has no sink wired). */
  async #recordPark(park: ContainerParkRecord): Promise<void> {
    if (this.#containerPark === undefined) {
      throw new Error(
        `container-link park for record ${park.sourceNativeId} but no ContainerParkSink is configured`,
      );
    }
    await this.#containerPark.park(park);
  }
}

/**
 * Did this cycle make no progress at all — at least one scope, and every one of them
 * aborted (SP-4)? Such a cycle must not advance the rule's `lastRunAt`, so a persistently
 * failing source still surfaces as a stuck poller. A cycle with no scopes at all (every
 * container parked/unresolved) DID run its enumeration and is not "aborted" — it advances,
 * so a rule awaiting manual container linking is not re-polled every tick.
 */
function everyScopeAborted(scopes: readonly PerScopeRunResult[]): boolean {
  return scopes.length > 0 && scopes.every((scope) => scope.result.kind === "aborted");
}

function toEnqueued(prepared: readonly PreparedChange[]): EnqueuedChange[] {
  return prepared
    .filter((change): change is PreparedEnqueue => change.kind === "enqueue")
    .map((change) => ({
      queueKey: change.queueKey,
      changeKind: change.changeKind,
      sourceNativeId: change.sourceNativeId,
    }));
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
