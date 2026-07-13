import type { JsonRecord } from "@mediator/transform";

import type { ChangeKind, DetectedChange } from "../identity-resolution/types.js";
import type { QueueKeyResolver } from "../ordering/queue-key-resolver.js";
import { contentHashOfRecord } from "./content-hash.js";
import {
  buildChangePayload,
  type ChangeEnqueue,
  type EnqueuedChange,
  type PollPlan,
  type PollPlanResolver,
  type PollRunOutcome,
  type PollStateStore,
  type PollerMetrics,
  type SourceReader,
} from "./types.js";

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
}

const DEFAULT_MAX_PAGES = 100_000;

/** A detected change with its pre-resolved queue key + payload, ready to enqueue (SP-5). */
interface PreparedChange {
  readonly queueKey: string;
  readonly changeKind: ChangeKind;
  readonly sourceNativeId: string;
  readonly payload: Record<string, unknown>;
}

export class Poller {
  readonly #reader: SourceReader;
  readonly #resolver: PollPlanResolver;
  readonly #state: PollStateStore;
  readonly #enqueue: ChangeEnqueue;
  readonly #queueKeys: QueueKeyResolver;
  readonly #now: () => Date;
  readonly #metrics: PollerMetrics | undefined;
  readonly #maxPages: number;

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
  }

  /**
   * Run exactly one poll cycle for `ruleId` synchronously (the SP-5 poll-trigger hook):
   * detect → durably enqueue → advance. Returns how the run ended (`completed` /
   * `aborted` / `skipped`) — never throws for an expected outcome; only a genuine
   * infrastructure fault (a store/enqueue error) propagates.
   */
  public async pollOnce(ruleId: string): Promise<PollRunOutcome> {
    const resolution = await this.#resolver.resolve(ruleId);
    if (!resolution.pollable) {
      const outcome: PollRunOutcome = { kind: "skipped", reason: resolution.reason };
      this.#metrics?.recordPollRun(ruleId, outcome);
      return outcome;
    }
    const plan = resolution.plan;
    const outcome =
      plan.mode === "delta" ? await this.#pollDelta(plan) : await this.#pollFullFetch(plan);
    this.#metrics?.recordPollRun(ruleId, outcome);
    return outcome;
  }

  // ── Delta polling (SP-2 delta / SP-3 create-vs-update + reported deletions) ──

  async #pollDelta(plan: PollPlan): Promise<PollRunOutcome> {
    const result = await this.#reader.readDelta(plan.ruleId, plan.cursor);
    if (!result.ok) {
      // SP-4 discipline extended to delta: a failed call never advances the cursor.
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

    // SP-5: durably enqueue every change BEFORE advancing.
    await this.#enqueueAll(prepared);
    // SP-5: advance the cursor (with `lastRunAt`) atomically, and only now.
    const advance: { ruleId: string; lastRunAt: Date; cursor?: string } = {
      ruleId: plan.ruleId,
      lastRunAt: this.#now(),
    };
    if (result.nextCursor !== undefined) {
      advance.cursor = result.nextCursor;
    }
    await this.#state.advance(advance);
    return { kind: "completed", enqueued: toEnqueued(prepared), mode: "delta" };
  }

  // ── Full-fetch polling (SP-2 paged-to-exhaustion + snapshot diff; SP-4) ──────

  async #pollFullFetch(plan: PollPlan): Promise<PollRunOutcome> {
    const prior = await this.#state.loadSnapshot(plan.ruleId);
    const priorEntries = prior?.entries ?? new Map<string, string>();

    // Page to exhaustion. SP-4 (SACRED): any page failure aborts BEFORE any diff, so a
    // truncated fetch can never be misread as mass deletion.
    const fetched = new Map<string, JsonRecord>();
    let continuation: string | undefined;
    for (let page = 0; page < this.#maxPages; page += 1) {
      const outcome = await this.#reader.readCollectionPage(plan.ruleId, continuation);
      if (!outcome.ok) {
        return { kind: "aborted", reason: outcome.reason };
      }
      for (const observed of outcome.records) {
        fetched.set(observed.nativeId, observed.record);
      }
      if (outcome.next.done) {
        return await this.#completeFullFetch(plan, priorEntries, fetched);
      }
      continuation = outcome.next.continuation;
    }
    // Exhaustion never reported within the cap → treat as an unsound fetch and abort.
    return { kind: "aborted", reason: `full fetch exceeded ${String(this.#maxPages)} pages` };
  }

  /**
   * The complete fetch succeeded (every page ok) — now the diff is sound (SP-4.3): a
   * native id in the prior snapshot but absent from this complete fetch is a delete
   * candidate. Build the new snapshot, classify each present/absent record, enqueue,
   * then replace the snapshot + advance `lastRunAt` atomically (SP-5).
   */
  async #completeFullFetch(
    plan: PollPlan,
    priorEntries: ReadonlyMap<string, string>,
    fetched: ReadonlyMap<string, JsonRecord>,
  ): Promise<PollRunOutcome> {
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

    // SP-5: durably enqueue every change BEFORE advancing.
    await this.#enqueueAll(prepared);
    // SP-5: replace the snapshot + set `lastRunAt` atomically, and only now.
    const capturedAt = this.#now();
    await this.#state.advance({
      ruleId: plan.ruleId,
      lastRunAt: capturedAt,
      snapshotEntries: newSnapshot,
      capturedAt,
    });
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
    plan: PollPlan,
    sourceNativeId: string,
    observedRecord: JsonRecord | undefined,
    isDelete: boolean,
    inSnapshot: boolean,
  ): Promise<PreparedChange> {
    const resolved = await this.#queueKeys.resolve(
      {
        resourcePairRef: plan.resourcePairRef,
        sourceAppId: plan.sourceAppId,
        sourceNativeId,
        observedRecord,
      },
      { identitySourcePath: plan.identitySourcePath },
    );
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
    };
    return {
      queueKey: resolved.queueKey,
      changeKind,
      sourceNativeId,
      payload: buildChangePayload(change),
    };
  }

  /** SP-5: durably enqueue every prepared change (each a committed insert) before the advance. */
  async #enqueueAll(prepared: readonly PreparedChange[]): Promise<void> {
    for (const change of prepared) {
      await this.#enqueue.enqueue(change.queueKey, change.payload);
    }
  }
}

function toEnqueued(prepared: readonly PreparedChange[]): EnqueuedChange[] {
  return prepared.map((change) => ({
    queueKey: change.queueKey,
    changeKind: change.changeKind,
    sourceNativeId: change.sourceNativeId,
  }));
}
