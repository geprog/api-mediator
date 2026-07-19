import { randomUUID } from "node:crypto";

import type {
  AuditLogEntry,
  AuditLogStatus,
  BackfillMode,
  FieldMapping,
  IrRefTarget,
  OutboundLoadLimits,
  RecordLink,
  RecordLinkScopeRef,
  SourceScopeRef,
  SyncFieldState,
  SyncFieldStateSide,
  TombstoneReason,
} from "@mediator/domain";
import { stripUndefined } from "@mediator/domain";
import {
  contentHashOfRecord,
  valuesAgree,
  type DetectedChange,
  type IdentityMatchSeedInput,
  type LoopPreventionContext,
  type MatchedTargetRecord,
  type ObservedRecord,
  type RecordWriteInput,
  type ResolutionContext,
  type ResolutionOutcome,
  type SourceReader,
  type StageTraceContext,
  type SyncEventRecorder,
  type TargetIdentityLookup,
} from "@mediator/sync-engine";
import {
  extractCapturedScope,
  isTransformError,
  readPath,
  type CapturedScope,
  type JsonRecord,
  type JsonValue,
} from "@mediator/transform";

import type { OutboundCall, OutboundCallCommon, OutboundCallResult } from "./executor.js";
import type { ApplyFieldMappingsFn, ResolvedTargetOperation } from "./sync-pipeline-handler.js";

/**
 * **Initial backfill runner** (BE-4 `link-only`, BE-5 `push`;
 * `docs/architecture/sync-engine.md` *Initial backfill*;
 * `docs/requirements/phase-4-backfill-enablement.md` BE-4/BE-5). The one-time
 * reconciliation the enable action triggers before a `SyncRule`'s polling goes live.
 * It lives in `@mediator/outbound` (not `@mediator/sync-engine`) because it composes
 * the `RestSourceReader` + `OutboundCallExecutor` that live here with the
 * `IdentityResolutionStage`/`IdentityMatchSeeder`/`LoopPreventionStage` from
 * sync-engine — and outbound already depends on sync-engine, so a runner in
 * sync-engine reaching into outbound would be a dependency cycle.
 *
 * **Backfill always ENUMERATES** the source's mapped resource via its confirmed
 * collection read (`ResourceBinding.collectionReadRef`), paged to exhaustion — never
 * the delta operation, even for a delta-polling rule (BE-4.1). It reuses the Poller's
 * **abort-on-partial** discipline: a page failure aborts the whole run (never treated
 * as "no more records"), so a truncated fetch can neither seal a partial snapshot nor
 * be misread as an empty collection.
 *
 * The two modes' write behavior is the whole contract:
 *  - **`link-only` (default, BE-4)** — link overlapping records (reusing
 *    {@link IdentityResolutionStage.resolve}, so the RL-4 ambiguous-match guard still
 *    holds: an ambiguous match is NEVER auto-linked) and seed one `SyncFieldState`
 *    baseline per side-field via {@link IdentityMatchSeeder} — **agree** (transform of
 *    the source reproduces the target's stored value) → baseline, **disagree** → no
 *    baseline (reported in the summary). **Writes NOTHING to either app.** Seeding is
 *    **monotone** across the two directions of a bidirectional pair — the store's
 *    never-erasing `seed` (BE-4.5) is relied on, not forked.
 *  - **`push` (BE-5)** — the source is the initial source of truth: mapped field
 *    values are OVERWRITTEN onto matched targets and unmatched source records are
 *    CREATED in the target, through the Outbound Call Executor (idempotency key,
 *    audit, EP-3 baseline capture, recently-written cache). Push runs its **own** write
 *    path with **no Conflict Detection**: declaring the source the source of truth *is*
 *    the conflict decision, made once for the whole run, so a differing matched target
 *    is overwritten — never parked (the opposite of steady-state CF).
 *
 * Every collaborator is injected so the runner is unit-tested with the existing fakes
 * + a fake clock. No live payload **value** ever reaches a `SyncEvent`/log/metric here
 * — only ids/counts/short notes (the LLM-data-boundary + audit-metadata invariant).
 */

// ── Injected collaborator ports (all consumer-defined; the real stages satisfy them) ──

/** The Identity Resolution surface the runner drives (the real `IdentityResolutionStage` satisfies it). */
export interface BackfillIdentityResolution {
  /** RL-1/RL-3 — resolve/establish the record's link (RL-4 ambiguous guard lives inside). */
  resolve(change: DetectedChange, context: ResolutionContext): Promise<ResolutionOutcome>;
  /** RL-2 — write the create-propagation link from a push create response's native id. */
  recordCreatePropagation(
    change: DetectedChange,
    context: ResolutionContext,
    createdNativeId: string,
  ): Promise<RecordLink>;
}

/** The per-link agree/disagree baseline seed (the real `IdentityMatchSeeder` satisfies it). */
export interface BackfillSeeder {
  seed(input: IdentityMatchSeedInput): Promise<SyncFieldState[]>;
}

/** The narrow `SyncFieldState` read the runner needs to report a fresh match's disagreements. */
export interface BackfillFieldStateReader {
  findByLink(recordLinkId: string): Promise<SyncFieldState[]>;
}

/** The Loop Prevention re-baseline surface push uses (the real `LoopPreventionStage` satisfies it). */
export interface BackfillLoopPrevention {
  /** EP-3 — capture both sides' baselines from the write response + observed source, + cache. */
  recordWrite(input: RecordWriteInput): Promise<SyncFieldState[]>;
}

/** The Outbound Call Executor surface push drives (the real `OutboundCallExecutor` satisfies it). */
export interface BackfillOutbound {
  execute(call: OutboundCall): Promise<OutboundCallResult>;
}

/**
 * Initial-backfill progress/duration metrics (BE-3.4;
 * `docs/architecture/observability.md` *Metrics* — "initial-backfill
 * progress/duration"). Default no-op; the composition root wires OTel gauges.
 * Counts only — never a live value.
 */
export interface BackfillMetrics {
  /** Called once per processed record with the running count and the total to process. */
  recordProgress(ruleId: string, processed: number, total: number): void;
  /** Called once when the run finishes (completed or aborted) with the elapsed wall time. */
  recordDuration(ruleId: string, durationMs: number): void;
}

// ── Per-rule context the (deferred, composition-root) loader resolves ─────────

/** The link-only context — the minimum the match + seed needs (BE-4). */
export interface LinkOnlyBackfillContext {
  readonly ruleId: string;
  readonly mappingId: string;
  readonly sourceAppId: string;
  readonly targetAppId: string;
  /** The mapped resource pair in canonical direction-agnostic form (keys links/state). */
  readonly resourcePairRef: string;
  /** RL's per-rule context (canonical A/B, identity paths, lookup path, create policy, pairings). */
  readonly resolution: ResolutionContext;
  /** This direction's `FieldMapping`s — the seed's pairings. */
  readonly fieldMappings: readonly FieldMapping[];
  /**
   * SS-13 — the **source** resource's confirmed `sourceScopeRef` (SS-7), when it has one,
   * so backfill captures each enumerated record's scope from the record it already fetched
   * (mirroring the Poller's SS-8.2 capture) — the input {@link resolveScopeRef} resolves
   * the container from. Absent on a non-scoped / constant-only rule → no capture.
   */
  readonly sourceScopeRef?: SourceScopeRef;
  /**
   * SS-13/SS-14 — resolve the record's **container** at link establishment on a **scoped**
   * rule. Called per record with its `DetectedChange` (carrying the captured scope); returns
   * the `scopeRef` to freeze on the new link so a later scoped delete routes from stored
   * `RecordLink.scopeRef` (SS-13/SS-12 discharge — L3 `{ kind: "scope-link", scopeLinkId }`
   * or L2 `{ kind: "resolved", values }`), **and** the `targetContainerScope` fill a scoped
   * identity match searches **only within** (SS-14.1 — else the scoped target read cannot be
   * composed and the backfill match fails closed). Both **absent** when the container does not
   * resolve (link scopeRef-less, the fail-safe) or on a non-scoped rule — exactly as before.
   */
  readonly resolveScopeRef?: (change: DetectedChange) => Promise<BackfillContainerResolution>;
}

/**
 * SS-13/SS-14 — a backfilled record's resolved **container**: the `scopeRef` frozen onto the
 * new `RecordLink` (SS-12) and the `targetContainerScope` fill a scoped identity match
 * searches within (SS-14.1). Both absent when the container did not resolve.
 */
export interface BackfillContainerResolution {
  readonly scopeRef?: RecordLinkScopeRef;
  readonly targetContainerScope?: ReadonlyMap<string, string>;
}

/** The push context — everything the dedicated push write path needs on top of {@link LinkOnlyBackfillContext} (BE-5). */
export interface PushBackfillContext extends LinkOnlyBackfillContext {
  /** EP's per-change context (canonical A/B + both directions' field participation) for the re-baseline. */
  readonly loopPrevention: LoopPreventionContext;
  /** The resolved `action = create` target operation (present iff the mapping approved one). */
  readonly createOperation?: ResolvedTargetOperation;
  /** The resolved `action = update` target operation (present iff the mapping approved one). */
  readonly updateOperation?: ResolvedTargetOperation;
  /** The target app's base URL (`RegisteredApp.baseUrl`). */
  readonly targetBaseUrl: string;
  /** The target resource's `ResourceBinding.nativeIdRef` — reads a create's new native id from the response. */
  readonly targetResourceNativeIdRef: IrRefTarget;
  /** The **target** resource ref — the recently-written cache key a successful write marks. */
  readonly targetResourceRef: string;
  /** The target app's resolved outbound ceilings; absent → executor default. */
  readonly targetAppLimits?: OutboundLoadLimits;
  /** The **source** resource's `ResourceBinding.changeTimestampRef` — the observed source's change timestamp. */
  readonly sourceChangeTimestampRef?: string;
  /** The **target** resource's `ResourceBinding.changeTimestampRef` — the written representation's change timestamp. */
  readonly targetChangeTimestampRef?: string;
}

/** The backfill to run — discriminated by mode so the context always matches (BE-4 vs BE-5). */
export type BackfillRunInput =
  | { readonly mode: "link-only"; readonly context: LinkOnlyBackfillContext }
  | { readonly mode: "push"; readonly context: PushBackfillContext };

// ── The per-record note + the run summary (discriminated unions) ──────────────

/** One field-path on one side (a `SyncFieldState` row's identity), for the disagreement summary. */
export interface SideField {
  readonly side: SyncFieldStateSide;
  readonly fieldPath: string;
}

/**
 * The outcome of processing one enumerated source record — a discriminated union so
 * the summary reports exactly what happened per record without optional-field soup:
 */
export type BackfillRecordNote =
  /** BE-4 — linked (existing/fresh) and baselines seeded; `disagreedFields` got NO baseline. */
  | {
      readonly kind: "matched";
      readonly sourceNativeId: string;
      readonly recordLinkId: string;
      readonly disagreedFields: readonly SideField[];
    }
  /** BE-4 — no target match: link-only writes nothing (links up later via steady-state/manual). */
  | { readonly kind: "unmatched"; readonly sourceNativeId: string }
  /** BE-5 — an unmatched source record created in the target. */
  | { readonly kind: "created"; readonly sourceNativeId: string; readonly recordLinkId: string }
  /** BE-5 — a matched target overwritten (source wins; never parked). */
  | { readonly kind: "overwritten"; readonly sourceNativeId: string; readonly recordLinkId: string }
  /** RL-4 — ambiguous identity match: NEVER auto-linked, held for manual linking. */
  | {
      readonly kind: "ambiguous";
      readonly sourceNativeId: string;
      readonly candidateNativeIds: readonly string[];
    }
  /** RL-5 — the record's link is tombstoned (the pair is severed); nothing done. */
  | {
      readonly kind: "severed";
      readonly sourceNativeId: string;
      readonly tombstoneReason: TombstoneReason;
    }
  /** Not propagated by policy (e.g. push with no approved create for an unmatched record). */
  | { readonly kind: "skipped"; readonly sourceNativeId: string; readonly reason: string }
  /** BE-5 — a push write that did not succeed (throttled / failure / no re-baselineable body). */
  | { readonly kind: "write-failed"; readonly sourceNativeId: string; readonly reason: string };

/** Aggregate counts across the run (per-record notes carry the detail). */
export interface BackfillCounts {
  readonly matched: number;
  readonly unmatched: number;
  readonly created: number;
  readonly overwritten: number;
  readonly ambiguous: number;
  readonly severed: number;
  readonly skipped: number;
  readonly writeFailed: number;
  /** Total side-fields left without a baseline (disagreements) across all matched records. */
  readonly disagreedFields: number;
}

/**
 * The run summary — a discriminated union on `outcome`. `completed` carries the full
 * per-record notes + the enumeration's `snapshotEntries` (`native id → content hash`,
 * which the full-fetch rule's `lastSnapshotRef` is seeded from — BE-6.1). `aborted`
 * (abort-on-partial) carries only the reason + how many records were enumerated
 * before the failing page — the caller must NOT seed live polling state from it.
 */
export type BackfillRunResult =
  | {
      readonly outcome: "completed";
      readonly mode: BackfillMode;
      readonly enumeratedCount: number;
      readonly snapshotEntries: ReadonlyMap<string, string>;
      readonly records: readonly BackfillRecordNote[];
      readonly counts: BackfillCounts;
    }
  | {
      readonly outcome: "aborted";
      readonly mode: BackfillMode;
      readonly reason: string;
      readonly enumeratedCount: number;
    };

// ── Construction ──────────────────────────────────────────────────────────────

/** The runner's injected collaborators. `outbound`/`transform`/`loopPrevention` are used by push only. */
export interface BackfillRunnerDeps {
  readonly sourceReader: SourceReader;
  readonly identityResolution: BackfillIdentityResolution;
  readonly seeder: BackfillSeeder;
  readonly fieldState: BackfillFieldStateReader;
  readonly lookup: TargetIdentityLookup;
  readonly loopPrevention: BackfillLoopPrevention;
  readonly outbound: BackfillOutbound;
  readonly transform: ApplyFieldMappingsFn;
  /** The `backfill-run` `SyncEvent` recorder (BE-3.4) — one per processed record. */
  readonly events: SyncEventRecorder;
  readonly metrics: BackfillMetrics;
}

export interface BackfillRunnerOptions {
  readonly clock?: () => Date;
  readonly newId?: () => string;
  /** Reads the active trace context for the `backfill-run` `SyncEvent`s (default: none). */
  readonly readTraceContext?: () => StageTraceContext | null;
  /** The `SyncEvent.actor` for these system-initiated backfill events (default `"system"`). */
  readonly actor?: string;
  /** Hard cap on enumeration pages (a safety valve against a reader that never reports exhaustion). Default 100_000. */
  readonly maxPages?: number;
}

const DEFAULT_ACTOR = "system";
const DEFAULT_MAX_PAGES = 100_000;

export class BackfillRunner {
  readonly #reader: SourceReader;
  readonly #identity: BackfillIdentityResolution;
  readonly #seeder: BackfillSeeder;
  readonly #fieldState: BackfillFieldStateReader;
  readonly #lookup: TargetIdentityLookup;
  readonly #loopPrevention: BackfillLoopPrevention;
  readonly #outbound: BackfillOutbound;
  readonly #transform: ApplyFieldMappingsFn;
  readonly #events: SyncEventRecorder;
  readonly #metrics: BackfillMetrics;
  readonly #clock: () => Date;
  readonly #newId: () => string;
  readonly #readTraceContext: () => StageTraceContext | null;
  readonly #actor: string;
  readonly #maxPages: number;

  public constructor(deps: BackfillRunnerDeps, options: BackfillRunnerOptions = {}) {
    this.#reader = deps.sourceReader;
    this.#identity = deps.identityResolution;
    this.#seeder = deps.seeder;
    this.#fieldState = deps.fieldState;
    this.#lookup = deps.lookup;
    this.#loopPrevention = deps.loopPrevention;
    this.#outbound = deps.outbound;
    this.#transform = deps.transform;
    this.#events = deps.events;
    this.#metrics = deps.metrics;
    this.#clock = options.clock ?? ((): Date => new Date());
    this.#newId = options.newId ?? ((): string => randomUUID());
    this.#readTraceContext = options.readTraceContext ?? ((): null => null);
    this.#actor = options.actor ?? DEFAULT_ACTOR;
    this.#maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  }

  /**
   * Run the one-time backfill. Enumerates the source to exhaustion (abort-on-partial),
   * processes each record per the mode, and returns the discriminated summary. Never
   * advances any live polling state — the caller ({@link RuleEnabler}) seeds cursor /
   * snapshot from {@link BackfillRunResult.snapshotEntries} at go-live (BE-6).
   */
  public async run(input: BackfillRunInput): Promise<BackfillRunResult> {
    const startedAt = this.#clock();
    const { context } = input;
    const enumeration = await this.#enumerate(context.ruleId);
    if (!enumeration.ok) {
      // Abort-on-partial (BE-4.1): a truncated fetch is NOT "no more records".
      this.#metrics.recordDuration(context.ruleId, this.#elapsed(startedAt));
      return {
        outcome: "aborted",
        mode: input.mode,
        reason: enumeration.reason,
        enumeratedCount: enumeration.partialCount,
      };
    }

    const records = enumeration.records;
    // The complete enumeration doubles as the first snapshot (BE-6.1).
    const snapshotEntries = new Map<string, string>();
    for (const record of records) {
      snapshotEntries.set(record.nativeId, contentHashOfRecord(record.record));
    }

    const notes: BackfillRecordNote[] = [];
    const counts = newCounts();
    let processed = 0;
    for (const record of records) {
      const change = this.#changeOf(context, record);
      const note =
        input.mode === "link-only"
          ? await this.#processLinkOnly(input.context, change)
          : await this.#processPush(input.context, change);
      notes.push(note);
      tally(counts, note);
      await this.#recordBackfillEvent(change, note);
      processed += 1;
      this.#metrics.recordProgress(context.ruleId, processed, records.length);
    }

    this.#metrics.recordDuration(context.ruleId, this.#elapsed(startedAt));
    return {
      outcome: "completed",
      mode: input.mode,
      enumeratedCount: records.length,
      snapshotEntries,
      records: notes,
      counts,
    };
  }

  // ── Enumeration (paged to exhaustion, abort-on-partial — mirrors the Poller) ──

  async #enumerate(
    ruleId: string,
  ): Promise<
    | { readonly ok: true; readonly records: readonly ObservedRecord[] }
    | { readonly ok: false; readonly reason: string; readonly partialCount: number }
  > {
    const byNativeId = new Map<string, ObservedRecord>();
    let continuation: string | undefined;
    for (let page = 0; page < this.#maxPages; page += 1) {
      const outcome = await this.#reader.readCollectionPage(ruleId, continuation);
      if (!outcome.ok) {
        return { ok: false, reason: outcome.reason, partialCount: byNativeId.size };
      }
      for (const record of outcome.records) {
        byNativeId.set(record.nativeId, record);
      }
      if (outcome.next.done) {
        return { ok: true, records: [...byNativeId.values()] };
      }
      continuation = outcome.next.continuation;
    }
    return {
      ok: false,
      reason: `backfill enumeration exceeded ${String(this.#maxPages)} pages`,
      partialCount: byNativeId.size,
    };
  }

  // ── link-only (BE-4): link + seed baselines, write NOTHING ───────────────────

  async #processLinkOnly(
    context: LinkOnlyBackfillContext,
    change: DetectedChange,
  ): Promise<BackfillRecordNote> {
    // SS-13 — freeze the record's resolved container onto the new link (scoped rule), so
    // a backfilled record's later scoped delete routes from stored state (SS-12 discharge).
    const resolution = await this.#resolutionForRecord(context, change);
    const outcome = await this.#identity.resolve(change, resolution);
    switch (outcome.kind) {
      case "ambiguous-failure":
        // RL-4: never auto-link an ambiguous match — held for manual linking.
        return {
          kind: "ambiguous",
          sourceNativeId: change.sourceNativeId,
          candidateNativeIds: outcome.candidateNativeIds,
        };
      case "straight-create":
      case "skipped-policy":
        // No target match (or no create op) — link-only writes NOTHING.
        return { kind: "unmatched", sourceNativeId: change.sourceNativeId };
      case "severed-tombstone":
        return {
          kind: "severed",
          sourceNativeId: change.sourceNativeId,
          tombstoneReason: outcome.tombstoneReason,
        };
      case "no-link-delete":
        // Backfill enumerates creates, never deletes — defensive.
        return {
          kind: "skipped",
          sourceNativeId: change.sourceNativeId,
          reason: "unexpected delete change during backfill enumeration",
        };
      case "resolved": {
        const link = outcome.link;
        const disagreedFields = outcome.establishedByIdentityMatch
          ? // A fresh identity match: `resolve` already seeded from the matched record —
            // read the persisted rows to report which side-fields have no baseline.
            noBaselineFields(await this.#fieldState.findByLink(link.id))
          : // A pre-existing link (the bidirectional second direction / a re-run): seed
            // THIS direction's baselines monotonically (BE-4.5 — the store never erases).
            await this.#seedExistingLink(context, change, link, resolution);
        return {
          kind: "matched",
          sourceNativeId: change.sourceNativeId,
          recordLinkId: link.id,
          disagreedFields,
        };
      }
    }
  }

  /**
   * Seed the bidirectional second direction's baselines onto an already-linked record
   * (BE-4.5). `resolve` short-circuits on an existing active link without seeding, so
   * the runner fetches this direction's counterpart via the identity lookup and calls
   * the seeder itself — relying on the store's **monotone** `seed` (never erases the
   * first run's baseline; only adds baselines to rows that have none). Returns the
   * side-fields this direction left without a baseline (its disagreements).
   */
  async #seedExistingLink(
    context: LinkOnlyBackfillContext,
    change: DetectedChange,
    link: RecordLink,
    resolution: ResolutionContext,
  ): Promise<readonly SideField[]> {
    // SS-14.1 — use the per-record (container-scoped) resolution so the counterpart lookup
    // searches only within the record's target container, never globally.
    const matched = await this.#lookupCounterpart(resolution, change);
    if (matched !== undefined) {
      const { sourceSide, targetSide } = sidesOf(change, resolution);
      // Monotone: the store's `seed` (ON CONFLICT DO NOTHING) never erases the first
      // run's baseline; it only adds baselines to rows that have none (BE-4.5).
      await this.#seeder.seed({
        recordLinkId: link.id,
        sourceSide,
        targetSide,
        fieldMappings: context.fieldMappings,
        observedSource: change.observedRecord ?? {},
        matchedTarget: matched,
      });
    }
    // Report the record's actual persisted disagreements (a first-run baseline that
    // survived a disagreeing second pairing is correctly NOT reported here).
    return noBaselineFields(await this.#fieldState.findByLink(link.id));
  }

  /**
   * Fetch a single counterpart record by the identity value (used AS-IS) — the same
   * filtered-read / fetch-and-match lookup ports {@link IdentityResolutionStage} uses,
   * driven directly here only for the pre-existing-link seed. Returns the record iff
   * exactly one matches (0 / >1 / an incomplete fetch → `undefined`, no seed).
   */
  async #lookupCounterpart(
    resolution: ResolutionContext,
    change: DetectedChange,
  ): Promise<JsonRecord | undefined> {
    const identity = readPath(change.observedRecord ?? {}, resolution.identitySourcePath);
    if (!identity.present) {
      return undefined;
    }
    const lookup = resolution.targetLookup;
    // SS-14.1 — a scoped resolution fills the target read's container so the counterpart
    // lookup searches only within it; a non-scoped resolution passes none (unchanged).
    const containerScope =
      resolution.targetContainerScope !== undefined
        ? { containerScope: resolution.targetContainerScope }
        : {};
    let matches: readonly MatchedTargetRecord[];
    if (lookup.kind === "filtered-read") {
      matches = await this.#lookup.filteredRead({
        targetAppId: change.targetAppId,
        binding: lookup.binding,
        lookupParamRef: lookup.lookupParamRef,
        value: identity.value,
        ...containerScope,
      });
    } else if (lookup.kind === "fetch-and-match") {
      const result = await this.#lookup.fetchAll({
        targetAppId: change.targetAppId,
        binding: lookup.binding,
        ...containerScope,
      });
      if (!result.complete) {
        return undefined;
      }
      matches = result.records.filter((candidate) => {
        const read = readPath(candidate.record, resolution.identityTargetPath);
        return read.present && valuesAgree(read.value, identity.value);
      });
    } else {
      return undefined;
    }
    return matches.length === 1 ? matches[0]?.record : undefined;
  }

  // ── push (BE-5): source is the initial source of truth (its OWN write path) ───

  async #processPush(
    context: PushBackfillContext,
    change: DetectedChange,
  ): Promise<BackfillRecordNote> {
    // SS-13 — same per-record container resolution as link-only, threaded into both the
    // identity-match link (via `resolve`) and the create-propagation link (`#pushCreate`).
    const resolution = await this.#resolutionForRecord(context, change);
    const outcome = await this.#identity.resolve(change, resolution);
    switch (outcome.kind) {
      case "ambiguous-failure":
        // RL-4 still applies under push — an ambiguous match is never auto-linked.
        return {
          kind: "ambiguous",
          sourceNativeId: change.sourceNativeId,
          candidateNativeIds: outcome.candidateNativeIds,
        };
      case "skipped-policy":
        // No approved create operation → an unmatched record cannot be created.
        return {
          kind: "skipped",
          sourceNativeId: change.sourceNativeId,
          reason: "no approved create operation — unmatched source record not created",
        };
      case "severed-tombstone":
        return {
          kind: "severed",
          sourceNativeId: change.sourceNativeId,
          tombstoneReason: outcome.tombstoneReason,
        };
      case "no-link-delete":
        return {
          kind: "skipped",
          sourceNativeId: change.sourceNativeId,
          reason: "unexpected delete change during backfill enumeration",
        };
      case "straight-create":
        return this.#pushCreate(context, change, resolution);
      case "resolved":
        return this.#pushOverwrite(context, change, outcome.link);
    }
  }

  /** BE-5.1 — an unmatched source record is CREATED in the target (normal pipeline: OC + EP-3). */
  async #pushCreate(
    context: PushBackfillContext,
    change: DetectedChange,
    resolution: ResolutionContext,
  ): Promise<BackfillRecordNote> {
    const observed = change.observedRecord ?? {};
    const operation = context.createOperation;
    if (operation === undefined) {
      return {
        kind: "skipped",
        sourceNativeId: change.sourceNativeId,
        reason: "push create: no resolved create operation on this mapping",
      };
    }
    const payload = this.#buildPayload(context, observed);
    if (!payload.ok) {
      return { kind: "skipped", sourceNativeId: change.sourceNativeId, reason: payload.reason };
    }
    // A create establishes state — there is no prior reconciled value (push has none).
    const call: OutboundCall = {
      ...this.#commonCall(context, change, operation, undefined),
      action: "create",
      payload: payload.output,
      priorReconciledState: { kind: "none" },
    };
    const result = await this.#outbound.execute(call);
    if (result.outcome !== "success") {
      return this.#writeNonSuccess(change, result);
    }
    const stored = result.writtenRepresentation.body;
    const createdNativeId = result.writtenRepresentation.createdNativeId;
    if (createdNativeId === undefined) {
      return {
        kind: "write-failed",
        sourceNativeId: change.sourceNativeId,
        reason: "push create: response carried no native id — cannot establish RecordLink",
      };
    }
    if (!isJsonRecord(stored)) {
      return {
        kind: "write-failed",
        sourceNativeId: change.sourceNativeId,
        reason: "push create: response carried no object representation to re-baseline from",
      };
    }
    const link = await this.#identity.recordCreatePropagation(change, resolution, createdNativeId);
    await this.#recordWrite(context, change, {
      recordLinkId: link.id,
      stored,
      observed,
      targetNativeId: createdNativeId,
    });
    return { kind: "created", sourceNativeId: change.sourceNativeId, recordLinkId: link.id };
  }

  /**
   * BE-5.2 — a matched target is OVERWRITTEN (source wins). NO Conflict Detection runs:
   * the source-of-truth declaration IS the conflict decision, so every mapped field is
   * transformed and written — a differing target is overwritten, never parked. The
   * baseline is captured from the write response (EP-3), so the echo is later recognized.
   */
  async #pushOverwrite(
    context: PushBackfillContext,
    change: DetectedChange,
    link: RecordLink,
  ): Promise<BackfillRecordNote> {
    const observed = change.observedRecord ?? {};
    const operation = context.updateOperation;
    if (operation === undefined) {
      // No update op to overwrite a matched target with — visible, never silent.
      return {
        kind: "skipped",
        sourceNativeId: change.sourceNativeId,
        reason: "push overwrite: no resolved update operation on this mapping",
      };
    }
    const payload = this.#buildPayload(context, observed);
    if (!payload.ok) {
      return { kind: "skipped", sourceNativeId: change.sourceNativeId, reason: payload.reason };
    }
    const sourceSide = sideOf(change, context.resolution.appAId);
    const targetNativeId = targetNativeIdOf(link, sourceSide);
    const call: OutboundCall = {
      ...this.#commonCall(context, change, operation, link.id),
      action: "update",
      payload: payload.output,
      // Push has no prior reconciled state — the source-of-truth declaration overwrites.
      priorReconciledState: { kind: "none" },
      targetNativeId,
    };
    const result = await this.#outbound.execute(call);
    if (result.outcome !== "success") {
      return this.#writeNonSuccess(change, result);
    }
    const stored = result.writtenRepresentation.body;
    if (!isJsonRecord(stored)) {
      return {
        kind: "write-failed",
        sourceNativeId: change.sourceNativeId,
        reason: "push overwrite: response carried no object representation to re-baseline from",
      };
    }
    await this.#recordWrite(context, change, {
      recordLinkId: link.id,
      stored,
      observed,
      targetNativeId,
    });
    return { kind: "overwritten", sourceNativeId: change.sourceNativeId, recordLinkId: link.id };
  }

  #buildPayload(
    context: PushBackfillContext,
    observed: JsonRecord,
  ):
    | { readonly ok: true; readonly output: JsonRecord }
    | { readonly ok: false; readonly reason: string } {
    try {
      return { ok: true, output: this.#transform(context.fieldMappings, observed).output };
    } catch (error) {
      if (isTransformError(error)) {
        return { ok: false, reason: `push: transform error: ${error.kind}` };
      }
      throw error;
    }
  }

  /** EP-3 canonical-form capture + recently-written cache after a successful push write. */
  async #recordWrite(
    context: PushBackfillContext,
    change: DetectedChange,
    fields: {
      readonly recordLinkId: string;
      readonly stored: JsonRecord;
      readonly observed: JsonRecord;
      readonly targetNativeId: string;
    },
  ): Promise<void> {
    const sourceSide = sideOf(change, context.resolution.appAId);
    const targetSide = opposite(sourceSide);
    const input: RecordWriteInput = stripUndefined({
      recordLinkId: fields.recordLinkId,
      mappingId: change.mappingId,
      writtenSide: targetSide,
      sourceSide,
      fieldMappings: context.fieldMappings,
      storedRepresentation: fields.stored,
      observedSource: fields.observed,
      writtenRecord: {
        appId: change.targetAppId,
        resource: context.targetResourceRef,
        nativeId: fields.targetNativeId,
      },
      writtenChangeTimestamp: readChangeTimestamp(fields.stored, context.targetChangeTimestampRef),
      sourceChangeTimestamp: readChangeTimestamp(fields.observed, context.sourceChangeTimestampRef),
    });
    await this.#loopPrevention.recordWrite(input);
  }

  #commonCall(
    context: PushBackfillContext,
    change: DetectedChange,
    operation: ResolvedTargetOperation,
    recordLinkId: string | undefined,
  ): OutboundCallCommon {
    return stripUndefined({
      targetAppId: change.targetAppId,
      baseUrl: context.targetBaseUrl,
      operation: operation.operation,
      operationMapping: operation.operationMapping,
      sourceNativeId: change.sourceNativeId,
      targetResourceNativeIdRef: context.targetResourceNativeIdRef,
      relatedRuleId: change.ruleId,
      recordLinkId,
      targetAppLimits: context.targetAppLimits,
    });
  }

  #writeNonSuccess(change: DetectedChange, result: OutboundCallResult): BackfillRecordNote {
    // A push write that did not commit does NOT abort the run — backfill is
    // state-convergent, so a later steady-state sync (or manual replay) supersedes it.
    if (result.outcome === "throttled") {
      return {
        kind: "write-failed",
        sourceNativeId: change.sourceNativeId,
        reason: `push write throttled (retry after ${String(result.retryAfterMs)}ms)`,
      };
    }
    if (result.outcome === "skipped-duplicate") {
      // A prior success for this key inside the lookback — already pushed this run.
      return {
        kind: "skipped",
        sourceNativeId: change.sourceNativeId,
        reason: "push write deduplicated (already pushed this run)",
      };
    }
    return {
      kind: "write-failed",
      sourceNativeId: change.sourceNativeId,
      reason: `push write failed: ${result.outcome === "failure" ? result.reason : "unknown"}`,
    };
  }

  // ── shared helpers ────────────────────────────────────────────────────────

  /**
   * SS-13 (SS-12 discharge) — the per-record {@link ResolutionContext}: the rule's shared
   * context, plus the record's resolved container frozen as `scopeRefForNewLink` when the
   * scoped-rule `resolveScopeRef` hook is supplied and resolves a container. When the hook
   * is absent (non-scoped rule) or the container does not resolve, the shared context is
   * used unchanged and the new link carries no `scopeRef` (the pre-SS-13 fail-safe).
   */
  async #resolutionForRecord(
    context: LinkOnlyBackfillContext,
    change: DetectedChange,
  ): Promise<ResolutionContext> {
    if (context.resolveScopeRef === undefined) {
      return context.resolution;
    }
    const container = await context.resolveScopeRef(change);
    // SS-13 — freeze the container onto the new link; SS-14.1 — scope the identity match to it.
    return {
      ...context.resolution,
      ...(container.scopeRef !== undefined ? { scopeRefForNewLink: container.scopeRef } : {}),
      ...(container.targetContainerScope !== undefined
        ? { targetContainerScope: container.targetContainerScope }
        : {}),
    };
  }

  #changeOf(context: LinkOnlyBackfillContext, record: ObservedRecord): DetectedChange {
    // SS-13 — capture this record's scope from the record already fetched (mirroring the
    // Poller's SS-8.2 capture) so `resolveScopeRef` can freeze its container on the new
    // link (the SS-12 discharge). Absent/empty on a non-scoped rule → no capture.
    let capturedScope: CapturedScope | undefined;
    if (context.sourceScopeRef !== undefined) {
      const captured = extractCapturedScope(record.record, context.sourceScopeRef);
      if (Object.keys(captured).length > 0) {
        capturedScope = captured;
      }
    }
    // Backfill classifies every enumerated record as a `create`: it may already exist
    // in the target (Identity Resolution downgrades a match to an update).
    return {
      ruleId: context.ruleId,
      mappingId: context.mappingId,
      sourceAppId: context.sourceAppId,
      targetAppId: context.targetAppId,
      resourcePairRef: context.resourcePairRef,
      sourceNativeId: record.nativeId,
      changeKind: "create",
      observedRecord: record.record,
      ...(capturedScope !== undefined ? { capturedScope } : {}),
    };
  }

  /** BE-3.4 — one `backfill-run` `SyncEvent` per processed record (metadata only). */
  async #recordBackfillEvent(change: DetectedChange, note: BackfillRecordNote): Promise<void> {
    const described = describeNote(note);
    if (described === undefined) {
      // An ambiguous match already recorded its own `failure` `SyncEvent` inside
      // Identity Resolution (RL-4) — don't double-record it.
      return;
    }
    const trace = this.#readTraceContext();
    const entry: AuditLogEntry = stripUndefined({
      id: this.#newId(),
      type: "backfill-run" as const,
      actor: this.#actor,
      status: described.status,
      relatedRuleId: change.ruleId,
      relatedMappingId: change.mappingId,
      sourceNativeId: change.sourceNativeId,
      originAppId: change.sourceAppId,
      recordLinkId: described.recordLinkId,
      details: described.details,
      traceId: trace?.traceId,
      spanId: trace?.spanId,
      timestamp: this.#clock(),
    });
    await this.#events.record(entry);
  }

  #elapsed(startedAt: Date): number {
    return Math.max(0, this.#clock().getTime() - startedAt.getTime());
  }
}

// ── module-level pure helpers ─────────────────────────────────────────────────

interface MutableCounts {
  matched: number;
  unmatched: number;
  created: number;
  overwritten: number;
  ambiguous: number;
  severed: number;
  skipped: number;
  writeFailed: number;
  disagreedFields: number;
}

function newCounts(): MutableCounts {
  return {
    matched: 0,
    unmatched: 0,
    created: 0,
    overwritten: 0,
    ambiguous: 0,
    severed: 0,
    skipped: 0,
    writeFailed: 0,
    disagreedFields: 0,
  };
}

function tally(counts: MutableCounts, note: BackfillRecordNote): void {
  switch (note.kind) {
    case "matched":
      counts.matched += 1;
      counts.disagreedFields += note.disagreedFields.length;
      break;
    case "unmatched":
      counts.unmatched += 1;
      break;
    case "created":
      counts.created += 1;
      break;
    case "overwritten":
      counts.overwritten += 1;
      break;
    case "ambiguous":
      counts.ambiguous += 1;
      break;
    case "severed":
      counts.severed += 1;
      break;
    case "skipped":
      counts.skipped += 1;
      break;
    case "write-failed":
      counts.writeFailed += 1;
      break;
  }
}

/** The `SyncEvent` shape for a note, or `undefined` to skip (RL already recorded it). */
function describeNote(
  note: BackfillRecordNote,
): { status: AuditLogStatus; details: string; recordLinkId?: string } | undefined {
  switch (note.kind) {
    case "matched":
      return {
        status: "success",
        recordLinkId: note.recordLinkId,
        details:
          note.disagreedFields.length === 0
            ? "backfill link-only: matched, all pairings agree (baselines seeded)"
            : `backfill link-only: matched, ${String(note.disagreedFields.length)} side-field(s) disagreed (no baseline)`,
      };
    case "unmatched":
      return {
        status: "success",
        details: "backfill link-only: no target match — nothing written",
      };
    case "created":
      return {
        status: "success",
        recordLinkId: note.recordLinkId,
        details: "backfill push: unmatched source record created in target",
      };
    case "overwritten":
      return {
        status: "success",
        recordLinkId: note.recordLinkId,
        details: "backfill push: matched target overwritten (source wins)",
      };
    case "ambiguous":
      return undefined;
    case "severed":
      return {
        status: "skipped-policy",
        details: `backfill: record link tombstoned (${note.tombstoneReason}) — pair severed`,
      };
    case "skipped":
      return { status: "skipped-policy", details: note.reason };
    case "write-failed":
      return { status: "failure", details: note.reason };
  }
}

function noBaselineFields(rows: readonly SyncFieldState[]): SideField[] {
  return rows
    .filter((row) => row.lastSyncedHash === undefined)
    .map((row) => ({ side: row.side, fieldPath: row.fieldPath }));
}

function sidesOf(
  change: DetectedChange,
  resolution: ResolutionContext,
): { readonly sourceSide: SyncFieldStateSide; readonly targetSide: SyncFieldStateSide } {
  const sourceSide = sideOf(change, resolution.appAId);
  return { sourceSide, targetSide: opposite(sourceSide) };
}

function sideOf(change: DetectedChange, appAId: string): SyncFieldStateSide {
  return change.sourceAppId === appAId ? "A" : "B";
}

function opposite(side: SyncFieldStateSide): SyncFieldStateSide {
  return side === "A" ? "B" : "A";
}

function targetNativeIdOf(link: RecordLink, sourceSide: SyncFieldStateSide): string {
  return sourceSide === "A" ? link.appBNativeId : link.appANativeId;
}

function isJsonRecord(value: JsonValue | undefined): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Read + parse a record's change timestamp (epoch millis / Date-parseable string); `null` when absent. */
function readChangeTimestamp(record: JsonRecord, ref: string | undefined): Date | null {
  if (ref === undefined) {
    return null;
  }
  const read = readPath(record, ref);
  if (!read.present) {
    return null;
  }
  return toDate(read.value);
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

// ── Fake metrics (unit tests) ─────────────────────────────────────────────────

/** Records backfill progress/duration signals for assertions (BE-3.4). */
export class FakeBackfillMetrics implements BackfillMetrics {
  public readonly progress: { ruleId: string; processed: number; total: number }[] = [];
  public readonly durations: { ruleId: string; durationMs: number }[] = [];

  public recordProgress(ruleId: string, processed: number, total: number): void {
    this.progress.push({ ruleId, processed, total });
  }

  public recordDuration(ruleId: string, durationMs: number): void {
    this.durations.push({ ruleId, durationMs });
  }
}
