import { randomUUID } from "node:crypto";

import type {
  AuditLogEntry,
  RecordLink,
  SyncFieldState,
  SyncFieldStateSide,
} from "@mediator/domain";
import { stripUndefined } from "@mediator/domain";
import type { SyncFieldStateStore } from "@mediator/db";
import { readPath, type JsonRecord } from "@mediator/transform";

import { hashFieldValue } from "../identity-resolution/hash.js";
import type {
  DetectedChange,
  ResolutionOutcome,
  StageTraceContext,
  SyncEventRecorder,
} from "../identity-resolution/types.js";
import { NullRecentlyWrittenCache } from "./recently-written-cache.js";
import { participatingFieldsForSide } from "./participating-fields.js";
import type {
  EchoVia,
  LoopEchoOutcome,
  LoopPreventionContext,
  LoopPreventionInput,
  LoopPreventionMetrics,
  LoopPreventionOutcome,
  RecentWriteKey,
  RecentlyWrittenCache,
  RecordWriteInput,
} from "./types.js";

/**
 * **Loop Prevention** — the sync pipeline's **second** stage, after Identity
 * Resolution and before Conflict Detection (`docs/architecture/sync-engine.md`
 * *Loop prevention*; `docs/requirements/phase-4-loop-prevention.md` EP-1..EP-4).
 * It drops the echo of the mediator's own write so bidirectional sync cannot
 * ping-pong. "No echo" is a **hard invariant, not a heuristic**.
 *
 * Method map:
 *  - {@link check} — the authoritative post-Identity-Resolution check. EP-2 cache
 *    fast path first, then EP-4 `RecordLink`-state echoes (create / delete /
 *    resurrection), then **EP-1** the durable per-side field-baseline compare. EP-1
 *    is what makes echo detection independent of the cache and of write tags.
 *  - {@link recentlyWritten} / {@link recordCacheEcho} — the EP-2 fast path SP may
 *    run **ahead of** Identity Resolution (the only stage allowed to precede it).
 *  - {@link recordWrite} — EP-3: on a successful mediator write, re-baseline both
 *    sides from the target's *stored* representation + the observed source (the
 *    OC-5 re-baseline deferred here), and populate the recently-written cache.
 *
 * **Seams left for SP/CF:** SP owns the cache wiring (a live
 * {@link TtlRecentlyWrittenCache} vs. the default disabled one), the follow-up read
 * of a written record when the API returns no body (EP-3.1), computing the write-tag
 * flag (EP-2.3), and calling {@link recordWrite} after a successful OC write. CF
 * receives a `not-echo` outcome (with the resolved link) and owns the drift check.
 */
export interface LoopPreventionStageDeps {
  readonly fieldState: SyncFieldStateStore;
  /** The `SyncEvent`/`AuditLog` append port for the stage's skipped-loop / skipped-policy events. */
  readonly events: SyncEventRecorder;
  /** The EP-2 cache (optimization only). Default: disabled ({@link NullRecentlyWrittenCache}). */
  readonly cache?: RecentlyWrittenCache;
}

export interface LoopPreventionStageOptions {
  readonly metrics?: LoopPreventionMetrics;
  readonly clock?: () => Date;
  readonly newId?: () => string;
  /** Reads the active trace context for `SyncEvent` correlation (default: none). */
  readonly readTraceContext?: () => StageTraceContext | null;
  /** The `SyncEvent.actor` for these system-initiated events (default `"system"`). */
  readonly actor?: string;
}

const DEFAULT_ACTOR = "system";

export class LoopPreventionStage {
  readonly #fieldState: SyncFieldStateStore;
  readonly #events: SyncEventRecorder;
  readonly #cache: RecentlyWrittenCache;
  readonly #metrics: LoopPreventionMetrics;
  readonly #clock: () => Date;
  readonly #newId: () => string;
  readonly #readTraceContext: () => StageTraceContext | null;
  readonly #actor: string;

  public constructor(deps: LoopPreventionStageDeps, options: LoopPreventionStageOptions = {}) {
    this.#fieldState = deps.fieldState;
    this.#events = deps.events;
    this.#cache = deps.cache ?? new NullRecentlyWrittenCache();
    this.#metrics = options.metrics ?? NO_OP_METRICS;
    this.#clock = options.clock ?? ((): Date => new Date());
    this.#newId = options.newId ?? ((): string => randomUUID());
    this.#readTraceContext = options.readTraceContext ?? ((): null => null);
    this.#actor = options.actor ?? DEFAULT_ACTOR;
  }

  /**
   * EP-2's pure probe — the **only** fast path allowed to run ahead of Identity
   * Resolution (EP-1.6). No side effects: SP calls it before resolving the link and,
   * on a hit, short-circuits with {@link recordCacheEcho}. A miss (cold cache) means
   * nothing — the authoritative EP-1 check catches the echo either way (EP-2.4).
   */
  public recentlyWritten(key: RecentWriteKey): boolean {
    return this.#cache.isRecentlyWritten(key);
  }

  /**
   * Record the skipped-loop event for an EP-2 cache fast-path hit taken **ahead of**
   * Identity Resolution (so no link is resolved yet). The pipeline position for the
   * durable check is {@link check}; this is only the accelerator's recording path.
   */
  public async recordCacheEcho(change: DetectedChange): Promise<LoopEchoOutcome> {
    const syncEventId = await this.#recordSkippedLoop(
      change,
      undefined,
      "recently-written cache fast path — echo of the mediator's own write",
    );
    return { kind: "echo", via: "recently-written-cache", syncEventId };
  }

  /**
   * The authoritative Loop Prevention check for one change, run **after** Identity
   * Resolution (EP-1.6). Order:
   *  1. EP-2 fast path — a live cache entry (or the write tag) short-circuits ahead
   *     of the field compare (also caught here if SP did not pre-probe);
   *  2. EP-4 `RecordLink`-state echoes — create echo, delete echo, and resurrection
   *     prevention over a tombstoned link;
   *  3. **EP-1** — the durable per-side field-baseline compare (no cache dependency).
   */
  public async check(input: LoopPreventionInput): Promise<LoopPreventionOutcome> {
    const { change, context, resolution } = input;
    const linkId = linkIdOf(resolution);

    // ── EP-2 fast path (optimization only; correctness never depends on it) ──────
    if (input.carriesMediatorWriteTag === true) {
      return this.#echo(change, "write-tag", linkId);
    }
    if (
      this.#cache.isRecentlyWritten({
        appId: change.sourceAppId,
        resource: input.resource,
        nativeId: change.sourceNativeId,
      })
    ) {
      return this.#echo(change, "recently-written-cache", linkId);
    }

    // ── EP-4 / EP-1 authoritative checks, per the resolution kind ────────────────
    switch (resolution.kind) {
      case "severed-tombstone":
        return this.#handleTombstone(change, resolution.link, resolution.tombstoneReason);
      case "straight-create":
        // A genuine new record with no link and no match — nothing was written, so
        // it cannot be an echo. Continue to create it.
        return { kind: "not-echo" };
      case "resolved":
        return this.#handleResolved(
          change,
          context,
          resolution.link,
          resolution.effectiveChangeKind,
        );
      default:
        // The terminal IR outcomes (ambiguous-failure / skipped-policy /
        // no-link-delete) already recorded their event and must stop before EP.
        throw new Error(
          `Loop Prevention received a terminal resolution outcome '${resolution.kind}' — SP must stop before EP`,
        );
    }
  }

  /**
   * EP-3 — canonical-form capture + cache populate, called after a **successful**
   * mediator write. Re-baselines both sides in their **own** canonical
   * representation: the **written** side from the target's *stored* representation
   * (`storedRepresentation` — never what the mediator sent), the **source** side from
   * the observed source value the write was computed from. Then marks the written
   * target recently-written (EP-2.1). Returns the rows written (for tests/inspection).
   *
   * The hash used here is the **same** `hashFieldValue` the seeder and {@link check}
   * use (one function, one canonical serializer), so a baseline captured here and a
   * value re-observed by {@link check} are comparable **byte-for-byte** — a target
   * that normalized a value echoes the normalized value, which matches the captured
   * baseline and is dropped `skipped-loop` (EP-3.3), no ping-pong over formatting.
   */
  public async recordWrite(input: RecordWriteInput): Promise<SyncFieldState[]> {
    const now = this.#clock();
    const byKey = new Map<string, SyncFieldState>();
    const put = (
      side: SyncFieldStateSide,
      fieldPath: string,
      source: JsonRecord,
      mappingId: string | undefined,
      changeTimestamp: Date | null,
    ): void => {
      const read = readPath(source, fieldPath);
      const hash = hashFieldValue(read.present ? read.value : null);
      const row: SyncFieldState = stripUndefined({
        id: this.#newId(),
        recordLinkId: input.recordLinkId,
        side,
        fieldPath,
        lastSyncedHash: hash,
        lastSyncedAt: now,
        observedHash: hash,
        observedAt: now,
        observedChangeTimestamp: changeTimestamp,
        lastWrittenByMappingId: mappingId,
        status: "active" as const,
      });
      byKey.set(`${side} ${fieldPath}`, row);
    };

    const writtenTs = input.writtenChangeTimestamp ?? null;
    const sourceTs = input.sourceChangeTimestamp ?? null;
    for (const field of input.fieldMappings) {
      // Written (target) side — baseline from the target's stored representation.
      put(
        input.writtenSide,
        field.targetPath,
        input.storedRepresentation,
        input.mappingId,
        writtenTs,
      );
      // Source side — baseline from the observed source value(s) the write used. The
      // source side was read, not written, so it carries no `lastWrittenByMappingId`.
      for (const inputPath of inputPaths(field)) {
        put(input.sourceSide, inputPath, input.observedSource, undefined, sourceTs);
      }
    }

    const rows = [...byKey.values()];
    await this.#fieldState.reBaseline(rows);
    this.#cache.markWritten(input.writtenRecord);
    return rows;
  }

  // ── internals ──────────────────────────────────────────────────────────────

  async #handleResolved(
    change: DetectedChange,
    context: LoopPreventionContext,
    link: RecordLink,
    effectiveChangeKind: DetectedChange["changeKind"],
  ): Promise<LoopPreventionOutcome> {
    // EP-4.1 — a create-change that resolved to an active create-propagation link is
    // the mediator's OWN create coming back (the target's "new record" poll hit), not
    // a genuine new record — an echo, even when no content baseline exists yet.
    if (change.changeKind === "create" && link.establishedBy === "create-propagation") {
      return this.#echo(change, "create-propagation-link", link.id);
    }

    // A delete over an ACTIVE link is a genuine source deletion (→ CF-7 drift /
    // propagate), never an echo — a delete echo arrives over a *tombstoned* link. It
    // has no content to compare, so EP-1 does not apply.
    if (effectiveChangeKind === "delete") {
      return { kind: "not-echo", recordLink: link };
    }

    // EP-1 — the authoritative durable field-baseline compare.
    if (await this.#isContentEcho(change, context, link)) {
      return this.#echo(change, "field-baseline", link.id);
    }
    return { kind: "not-echo", recordLink: link };
  }

  /**
   * EP-1 — compare the incoming change **field-by-field** against **side X's own**
   * reconciled baselines (the per-side `SyncFieldState` rows for side X, each in
   * side X's canonical `lastSyncedHash`). Covers **every** side-X field participating
   * in *either* direction's mapping (EP-1.2). Returns `true` iff **every** such field
   * matches its baseline — the echo of the mediator's own write (or a no-op). A
   * missing row, or a row with no baseline (a divergent seed), is *not* a match: the
   * change carries something unreconciled, so it is not a pure content echo.
   *
   * The echo always arrives on the **last-written** side, so this compare is always
   * **same-representation** (never across a transform), and it is **durable** — it
   * holds hours after the write, with the cache cold (EP-1.4 / EP-1.5).
   */
  async #isContentEcho(
    change: DetectedChange,
    context: LoopPreventionContext,
    link: RecordLink,
  ): Promise<boolean> {
    const observed = change.observedRecord;
    if (observed === undefined) {
      return false; // no content (a delete) — not a content echo
    }
    const side = sideOf(change, context);
    const fields = participatingFieldsForSide(side, context.directions);
    if (fields.length === 0) {
      return false; // nothing to compare against — cannot be proven an echo
    }
    const baselineBySide = await this.#baselineHashes(link.id, side);
    for (const path of fields) {
      const baseline = baselineBySide.get(path);
      if (baseline === undefined) {
        return false; // no reconciled baseline for a participating field → not an echo
      }
      const read = readPath(observed, path);
      const observedHash = hashFieldValue(read.present ? read.value : null);
      if (observedHash !== baseline) {
        return false; // a participating field differs → a genuine change
      }
    }
    return true; // every participating side-X field matches its baseline → echo
  }

  /** The `lastSyncedHash` of each side-`side` row of the link that has a baseline. */
  async #baselineHashes(
    recordLinkId: string,
    side: SyncFieldStateSide,
  ): Promise<Map<string, string>> {
    const rows = await this.#fieldState.findByLink(recordLinkId);
    const bySide = new Map<string, string>();
    for (const row of rows) {
      if (row.side === side && row.lastSyncedHash !== undefined) {
        bySide.set(row.fieldPath, row.lastSyncedHash);
      }
    }
    return bySide;
  }

  async #handleTombstone(
    change: DetectedChange,
    link: RecordLink,
    tombstoneReason: RecordLink["tombstoneReason"],
  ): Promise<LoopPreventionOutcome> {
    if (tombstoneReason === "propagated-delete") {
      // EP-4.2 — the mediator propagated the deletion; the other side's delete echo
      // (a delete change) is that deletion coming back → skipped-loop.
      if (change.changeKind === "delete") {
        return this.#echo(change, "propagated-delete-tombstone", link.id);
      }
      // EP-4.4 — a non-delete change over a propagated-delete tombstone is a slower
      // poll still showing the record in an old snapshot: resurrection prevented — not
      // re-created, recorded skipped-loop.
      const syncEventId = await this.#recordSkippedLoop(
        change,
        link.id,
        "resurrection prevented — change over a propagated-delete tombstone (record already deleted by the mediator)",
      );
      return {
        kind: "resurrection-prevented",
        syncEventId,
        recordLinkId: link.id,
        tombstoneReason: "propagated-delete",
      };
    }

    // EP-4.3 — an observed-delete tombstone marks a severed pair (no propagation): a
    // change on the surviving side expects no echo → skipped-policy (counterpart
    // deleted), DISTINCT from a skipped-loop echo. Also prevents resurrection.
    const syncEventId = await this.#recordSkippedPolicy(change, link.id);
    return {
      kind: "skipped-policy",
      reason: "counterpart-deleted",
      syncEventId,
      recordLinkId: link.id,
    };
  }

  /** Record a `skipped-loop` echo and emit the skipped-loop metric (EP-1.3 / EP-4.5). */
  async #echo(
    change: DetectedChange,
    via: EchoVia,
    recordLinkId: string | undefined,
  ): Promise<LoopEchoOutcome> {
    const syncEventId = await this.#recordSkippedLoop(change, recordLinkId, echoDetails(via));
    return stripUndefined({ kind: "echo" as const, via, syncEventId, recordLinkId });
  }

  async #recordSkippedLoop(
    change: DetectedChange,
    recordLinkId: string | undefined,
    details: string,
  ): Promise<string> {
    const syncEventId = this.#newId();
    await this.#events.record(
      this.#buildEvent({ id: syncEventId, status: "skipped-loop", change, details, recordLinkId }),
    );
    this.#metrics.recordSkippedLoop(change.ruleId); // EP-4.5
    return syncEventId;
  }

  async #recordSkippedPolicy(change: DetectedChange, recordLinkId: string): Promise<string> {
    const syncEventId = this.#newId();
    await this.#events.record(
      this.#buildEvent({
        id: syncEventId,
        status: "skipped-policy",
        change,
        details:
          "counterpart record deleted (link tombstoned observed-delete) — change not propagated",
        recordLinkId,
      }),
    );
    this.#metrics.recordSkippedPolicy(change.ruleId);
    return syncEventId;
  }

  #buildEvent(fields: {
    readonly id: string;
    readonly status: "skipped-loop" | "skipped-policy";
    readonly change: DetectedChange;
    readonly details: string;
    readonly recordLinkId?: string | undefined;
  }): AuditLogEntry {
    const trace = this.#readTraceContext();
    return stripUndefined({
      id: fields.id,
      type: "sync-execution" as const,
      actor: this.#actor,
      status: fields.status,
      relatedRuleId: fields.change.ruleId,
      relatedMappingId: fields.change.mappingId,
      sourceNativeId: fields.change.sourceNativeId,
      originAppId: fields.change.sourceAppId,
      recordLinkId: fields.recordLinkId,
      details: fields.details,
      traceId: trace?.traceId,
      spanId: trace?.spanId,
      timestamp: this.#clock(),
    });
  }
}

const NO_OP_METRICS: LoopPreventionMetrics = {
  recordSkippedLoop(): void {
    /* default: no metric backend wired */
  },
  recordSkippedPolicy(): void {
    /* default: no metric backend wired */
  },
};

/** Which side of the link the change's source app is (mirrors Identity Resolution). */
function sideOf(change: DetectedChange, context: LoopPreventionContext): SyncFieldStateSide {
  return change.sourceAppId === context.appAId ? "A" : "B";
}

/** The link id an outcome carries, when it resolved one (for the echo event / outcome). */
function linkIdOf(resolution: ResolutionOutcome): string | undefined {
  if (resolution.kind === "resolved" || resolution.kind === "severed-tombstone") {
    return resolution.link.id;
  }
  return undefined;
}

/** A field's input paths: the primary `sourcePath` plus any additional inputs. */
function inputPaths(field: RecordWriteInput["fieldMappings"][number]): readonly string[] {
  return [field.sourcePath, ...(field.transformConfig?.additionalInputPaths ?? [])];
}

function echoDetails(via: EchoVia): string {
  switch (via) {
    case "recently-written-cache":
      return "recently-written cache fast path — echo of the mediator's own write";
    case "write-tag":
      return "mediator write tag present — echo of the mediator's own write";
    case "field-baseline":
      return "all participating fields match their reconciled baseline — echo of the mediator's own write";
    case "create-propagation-link":
      return "create resolved to a create-propagation RecordLink — the mediator's own create echo";
    case "propagated-delete-tombstone":
      return "delete echo — the mediator's own propagated deletion coming back";
  }
}
