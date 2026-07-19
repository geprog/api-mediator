import { randomUUID } from "node:crypto";

import type {
  AuditLogEntry,
  AuditLogStatus,
  RecordLink,
  RecordLinkEstablishingQueueKey,
  RecordLinkScopeRef,
  SyncFieldStateSide,
  TombstoneReason,
} from "@mediator/domain";
import { stripUndefined } from "@mediator/domain";
import type { RecordLinkSideRef, RecordLinkStore } from "@mediator/db";
import { readPath, type JsonValue } from "@mediator/transform";

import { scopeQualifiedIdentityKey } from "../ordering/scoped-queue-key.js";
import { stringifyIdentityValue, valuesAgree } from "./hash.js";
import type { IdentityMatchSeeder } from "./field-state-seeder.js";
import type {
  DetectedChange,
  IdentityResolutionMetrics,
  MatchedTargetRecord,
  ResolutionContext,
  ResolutionOutcome,
  SkippedPolicyReason,
  StageTraceContext,
  SyncEventRecorder,
  TargetIdentityLookup,
} from "./types.js";

/**
 * **Identity Resolution** — the sync pipeline's **first** stage
 * (`docs/architecture/sync-engine.md` *Identity correlation*, *Change types*;
 * `docs/requirements/phase-4-identity-record-link.md` RL-1..RL-5). It resolves, or
 * establishes, the `RecordLink` every downstream stage (Loop Prevention, Conflict
 * Detection, Transformation, Outbound) is keyed by.
 *
 * Split by concern:
 *  - {@link resolve} — RL-1 (resolve active link first), RL-3 (identity-key match:
 *    filtered read preferred, fetch-and-match fallback, value used AS-IS, single
 *    match → link + seed + downgrade to update), **RL-4 (ambiguous → manual only:
 *    never picks one, records a `failure` event with candidate ids, ZERO link/write
 *    side effects)**, and RL-5's survivor / resurrection guards over a tombstoned link.
 *  - {@link recordCreatePropagation} — RL-2: write the `create-propagation` link from
 *    a create response's native id, retaining the pre-link ordering-queue key (OQ-4).
 *  - {@link linkManually} / {@link unlink} — RL-5.1/5.2 (SA-3/SU-2 call these).
 *  - {@link processDeletion} — RL-5.3: tombstone (never delete) on a processed delete.
 *
 * **Seams left deliberately** (later slices): the EP-2 recently-written cache fast
 * path may short-circuit *ahead* of {@link resolve} (RL-1.1) — the caller (SP) owns
 * it; the echo check (EP), conflict check (CF), the delete drift decision (CF-7,
 * which decides the `processDeletion` reason), and the keyed ordering queue (OQ,
 * which consumes the retained `establishingQueueKey`) are not built here.
 */
export interface IdentityResolutionStageDeps {
  readonly links: RecordLinkStore;
  /** The per-link identity-match seed (RL-3.4) — wraps the `SyncFieldStateStore`. */
  readonly seeder: IdentityMatchSeeder;
  readonly lookup: TargetIdentityLookup;
  /** The `SyncEvent`/`AuditLog` append port for the stage's own resolution events. */
  readonly events: SyncEventRecorder;
}

export interface IdentityResolutionStageOptions {
  readonly metrics?: IdentityResolutionMetrics;
  readonly clock?: () => Date;
  readonly newId?: () => string;
  /** Reads the active trace context for `SyncEvent` correlation (default: none). */
  readonly readTraceContext?: () => StageTraceContext | null;
  /** The `SyncEvent.actor` for these system-initiated resolution events (default `"system"`). */
  readonly actor?: string;
}

/** Parameters for a manual link (RL-5.1) — the operator supplies both records' native ids. */
export interface ManualLinkParams {
  readonly resourcePairRef: string;
  readonly appAId: string;
  readonly appANativeId: string;
  readonly appBId: string;
  readonly appBNativeId: string;
  /**
   * The pair's identity-key value, when the resource pair has a confirmed identity
   * key: recorded as the link's queue key. Absent → the `both-native-id-queues`
   * marker (the link-keyed queue opens only after both sides' native-id queues drain).
   */
  readonly identityValue?: string;
  /**
   * SS-12 — the record's resolved container, frozen onto `RecordLink.scopeRef` at
   * establishment on a **scoped** rule (so a later delete routes from stored state).
   * Absent on a non-scoped rule; the container-linking UI that supplies it is SS-15.
   */
  readonly scopeRef?: RecordLinkScopeRef;
}

/** Thrown when a fetch-and-match target fetch aborts on a partial page — never inferred. */
export class IncompleteTargetFetchError extends Error {
  public constructor(targetAppId: string) {
    super(`identity fetch-and-match aborted: incomplete target fetch for app ${targetAppId}`);
    this.name = "IncompleteTargetFetchError";
  }
}

const DEFAULT_ACTOR = "system";

export class IdentityResolutionStage {
  readonly #links: RecordLinkStore;
  readonly #seeder: IdentityMatchSeeder;
  readonly #lookup: TargetIdentityLookup;
  readonly #events: SyncEventRecorder;
  readonly #metrics: IdentityResolutionMetrics;
  readonly #clock: () => Date;
  readonly #newId: () => string;
  readonly #readTraceContext: () => StageTraceContext | null;
  readonly #actor: string;

  public constructor(
    deps: IdentityResolutionStageDeps,
    options: IdentityResolutionStageOptions = {},
  ) {
    this.#links = deps.links;
    this.#seeder = deps.seeder;
    this.#lookup = deps.lookup;
    this.#events = deps.events;
    this.#metrics = options.metrics ?? NO_OP_METRICS;
    this.#clock = options.clock ?? ((): Date => new Date());
    this.#newId = options.newId ?? ((): string => randomUUID());
    this.#readTraceContext = options.readTraceContext ?? ((): null => null);
    this.#actor = options.actor ?? DEFAULT_ACTOR;
  }

  /**
   * RL-1 — resolve the change's `RecordLink` **first**: an existing active link, else
   * (for a never-seen create/update) an identity-key match (RL-3) before treating it
   * as a create; a tombstoned link severs the pair (RL-5.4/5.5). Emits no-match /
   * ambiguous-match metrics (RL-1.5 / RL-4.3).
   */
  public async resolve(
    change: DetectedChange,
    context: ResolutionContext,
  ): Promise<ResolutionOutcome> {
    const record: RecordLinkSideRef = {
      appId: change.sourceAppId,
      nativeId: change.sourceNativeId,
    };

    // RL-1.2: an existing active link is used as-is; no new link is established.
    const active = await this.#links.findActiveByRecord(change.resourcePairRef, record);
    if (active !== undefined) {
      return {
        kind: "resolved",
        link: active,
        effectiveChangeKind: change.changeKind === "delete" ? "delete" : "update",
        establishedByIdentityMatch: false,
      };
    }

    // No active link — a tombstoned link severs the pair (RL-5.4/5.5).
    const tombstoned = await this.#links.findTombstonedByRecord(change.resourcePairRef, record);
    if (tombstoned !== undefined) {
      return this.#resolveTombstoned(change, tombstoned);
    }

    // Never-seen record. A delete has nothing to route or tombstone.
    if (change.changeKind === "delete") {
      return { kind: "no-link-delete" };
    }

    // RL-1.3 / RL-3: attempt an identity-key match before treating it as a create.
    return this.#matchOrCreate(change, context);
  }

  /**
   * RL-2 — create-propagation link write. Called with the target's newly assigned
   * native id (captured by the Outbound Call Executor from the create response's
   * `writtenRepresentation.createdNativeId`) **in the same step** as the create
   * resolves. Retains the establishing execution's **pre-link ordering-queue key**
   * (the record's identity value, else its native id) so the link-keyed queue opens
   * strictly as a continuation of it (OQ-4). A no-create-op change never reaches here
   * — {@link resolve} returns `skipped-policy` for it (RL-2.2).
   */
  public async recordCreatePropagation(
    change: DetectedChange,
    context: ResolutionContext,
    createdNativeId: string,
  ): Promise<RecordLink> {
    const identityValue = this.#readIdentityValue(change, context);
    const preLinkKey = this.#preLinkQueueKey(change, context, identityValue);
    const link = this.#buildLink(change, context, {
      establishedBy: "create-propagation",
      targetNativeId: createdNativeId,
      establishingQueueKey: { kind: "identity-value", value: preLinkKey },
    });
    await this.#links.insert(link);
    return link;
  }

  /**
   * RL-5.1/5.2 — manual link. Establishes an `establishedBy = manual` link for two
   * records an identity key cannot disambiguate. Records the pair's identity value as
   * the queue key when one is supplied, else the `both-native-id-queues` marker.
   */
  public async linkManually(params: ManualLinkParams): Promise<RecordLink> {
    const establishingQueueKey: RecordLinkEstablishingQueueKey =
      params.identityValue !== undefined
        ? { kind: "identity-value", value: params.identityValue }
        : { kind: "both-native-id-queues" };
    const link: RecordLink = {
      id: this.#newId(),
      appAId: params.appAId,
      appANativeId: params.appANativeId,
      appBId: params.appBId,
      appBNativeId: params.appBNativeId,
      resourcePairRef: params.resourcePairRef,
      establishedBy: "manual",
      status: "active",
      establishingQueueKey,
      createdAt: this.#clock(),
      tombstonedAt: null,
      // SS-12 — freeze the record's container (scoped rule) so a later delete routes from it.
      ...(params.scopeRef !== undefined ? { scopeRef: params.scopeRef } : {}),
    };
    await this.#links.insert(link);
    return link;
  }

  /** RL-5.1 — manual unlink: sever (remove) a link an operator judged wrong. */
  public async unlink(linkId: string): Promise<void> {
    await this.#links.unlink(linkId);
  }

  /**
   * RL-5.3 — tombstone (never delete) a link on a processed deletion. `reason` is
   * decided by the caller after the delete is handled: `propagated-delete` (the
   * mediator propagated it — recognizes the other side's delete echo) or
   * `observed-delete` (a source delete not propagated under `deletePropagation =
   * ignore`). The drift decision that gates a propagated delete (park vs. delete) is
   * CF-7, deferred — this method only records the tombstone the caller resolved to.
   */
  public async processDeletion(link: RecordLink, reason: TombstoneReason): Promise<RecordLink> {
    const tombstonedAt = this.#clock();
    await this.#links.tombstone(link.id, reason, tombstonedAt);
    return { ...link, status: "tombstoned", tombstoneReason: reason, tombstonedAt };
  }

  // ── internals ──────────────────────────────────────────────────────────────

  async #resolveTombstoned(
    change: DetectedChange,
    tombstoned: RecordLink,
  ): Promise<ResolutionOutcome> {
    const reason = requireTombstoneReason(tombstoned);
    if (change.changeKind === "delete") {
      // A delete of an already-severed record: nothing to do. The precise delete-echo
      // classification (`skipped-loop`) is the deferred EP seam.
      return { kind: "severed-tombstone", tombstoneReason: reason, link: tombstoned };
    }
    if (reason === "observed-delete") {
      // RL-5.4: counterpart deleted; the survivor is unmanaged until re-linked or
      // re-created (a genuine re-create arrives with a new native id → fresh link).
      return this.#skippedPolicy(change, "counterpart-deleted", tombstoned);
    }
    // propagated-delete: RL-5.5 resurrection prevention — no create, no write. EP will
    // record the delete echo as `skipped-loop`; the stage only refuses to re-create.
    return { kind: "severed-tombstone", tombstoneReason: reason, link: tombstoned };
  }

  async #matchOrCreate(
    change: DetectedChange,
    context: ResolutionContext,
  ): Promise<ResolutionOutcome> {
    const identityValue = this.#readIdentityValue(change, context);

    // RL-3.5: neither lookup path → match-first unavailable (documented duplicate
    // risk). A missing identity value likewise cannot be matched by any path.
    if (context.targetLookup.kind === "none" || identityValue === undefined) {
      return this.#createDecision(change, context, context.targetLookup.kind !== "none");
    }

    const matches = await this.#findMatches(change, context, identityValue);

    if (matches.length === 0) {
      this.#metrics.recordNoMatch(change.ruleId); // RL-1.5
      return this.#createDecision(change, context, true);
    }

    if (matches.length > 1) {
      // ── RL-4: THE HARD GUARD ──────────────────────────────────────────────────
      // More than one target matched. NEVER pick one. Record a `failure` event with
      // the candidate ids and hold the record for manual linking (SU-2). No link is
      // established, no create is made, no target write happens.
      return this.#recordAmbiguous(change, matches);
    }

    // RL-3.4: exactly one match → link + seed + downgrade to update.
    return this.#establishByIdentityMatch(change, context, identityValue, requireFirst(matches));
  }

  /**
   * Run the identity lookup, choosing the path per {@link ResolutionContext.targetLookup}
   * and using the identity value **AS-IS** (RL-3.3 — never a transform). For
   * fetch-and-match the target is compared in-memory on the confirmed identity target
   * path; an incomplete (partial) fetch aborts with {@link IncompleteTargetFetchError}
   * so no match/no-match is ever inferred from a truncated read.
   */
  async #findMatches(
    change: DetectedChange,
    context: ResolutionContext,
    identityValue: JsonValue,
  ): Promise<readonly MatchedTargetRecord[]> {
    const lookup = context.targetLookup;
    // SS-14.1 — a scoped rule's lookup fills the target collection read's container `{…}`
    // from `targetContainerScope`, so it searches ONLY within the record's resolved target
    // container; a non-scoped rule passes none (the app-wide read, unchanged).
    const containerScope =
      context.targetContainerScope !== undefined
        ? { containerScope: context.targetContainerScope }
        : {};
    if (lookup.kind === "filtered-read") {
      return this.#lookup.filteredRead({
        targetAppId: change.targetAppId,
        binding: lookup.binding,
        lookupParamRef: lookup.lookupParamRef,
        value: identityValue,
        ...containerScope,
      });
    }
    if (lookup.kind === "fetch-and-match") {
      const result = await this.#lookup.fetchAll({
        targetAppId: change.targetAppId,
        binding: lookup.binding,
        ...containerScope,
      });
      if (!result.complete) {
        throw new IncompleteTargetFetchError(change.targetAppId);
      }
      // In-memory comparison on the identity target path — value used AS-IS.
      return result.records.filter((candidate) => {
        const read = readPath(candidate.record, context.identityTargetPath);
        return read.present && valuesAgree(read.value, identityValue);
      });
    }
    // `none` is handled before this is called.
    return [];
  }

  async #establishByIdentityMatch(
    change: DetectedChange,
    context: ResolutionContext,
    identityValue: JsonValue,
    matched: MatchedTargetRecord,
  ): Promise<ResolutionOutcome> {
    const link = this.#buildLink(change, context, {
      establishedBy: "identity-match",
      targetNativeId: matched.nativeId,
      establishingQueueKey: {
        kind: "identity-value",
        value: this.#preLinkQueueKey(change, context, identityValue),
      },
    });
    await this.#links.insert(link);

    // RL-3.4: seed the new link's SyncFieldState from the matched target + observed
    // source (agree/disagree — the BE-4 seed, invoked here).
    const { sourceSide, targetSide } = sidesOf(change, context);
    await this.#seeder.seed({
      recordLinkId: link.id,
      sourceSide,
      targetSide,
      fieldMappings: context.fieldMappings,
      observedSource: change.observedRecord ?? {},
      matchedTarget: matched.record,
    });

    return {
      kind: "resolved",
      link,
      effectiveChangeKind: "update", // a matched create is downgraded to an update.
      establishedByIdentityMatch: true,
    };
  }

  async #createDecision(
    change: DetectedChange,
    context: ResolutionContext,
    matchFirstAvailable: boolean,
  ): Promise<ResolutionOutcome> {
    if (!context.hasApprovedCreateOperation) {
      // RL-2.2: no approved `action = create` operation → skipped-policy, no create,
      // no link. Visible, never silent.
      return this.#skippedPolicy(change, "no-create-op", undefined);
    }
    return { kind: "straight-create", matchFirstAvailable };
  }

  async #recordAmbiguous(
    change: DetectedChange,
    matches: readonly MatchedTargetRecord[],
  ): Promise<ResolutionOutcome> {
    const candidateNativeIds = matches.map((match) => match.nativeId);
    this.#metrics.recordAmbiguousMatch(change.ruleId); // RL-4.3 — distinct from no-match.
    const syncEventId = this.#newId();
    await this.#events.record(
      this.#buildEvent({
        id: syncEventId,
        status: "failure",
        change,
        details: `ambiguous identity match: ${String(candidateNativeIds.length)} candidates [${candidateNativeIds.join(", ")}]`,
      }),
    );
    return { kind: "ambiguous-failure", candidateNativeIds, syncEventId };
  }

  async #skippedPolicy(
    change: DetectedChange,
    reason: SkippedPolicyReason,
    tombstoned: RecordLink | undefined,
  ): Promise<ResolutionOutcome> {
    const syncEventId = this.#newId();
    await this.#events.record(
      this.#buildEvent({
        id: syncEventId,
        status: "skipped-policy",
        change,
        details: skippedPolicyDetails(reason),
        recordLinkId: tombstoned?.id,
      }),
    );
    return {
      kind: "skipped-policy",
      reason,
      syncEventId,
      ...(tombstoned !== undefined ? { recordLink: tombstoned } : {}),
    };
  }

  #buildLink(
    change: DetectedChange,
    context: ResolutionContext,
    opts: {
      readonly establishedBy: "create-propagation" | "identity-match";
      readonly targetNativeId: string;
      readonly establishingQueueKey: RecordLinkEstablishingQueueKey;
    },
  ): RecordLink {
    const { sourceSide } = sidesOf(change, context);
    const sourceIsA = sourceSide === "A";
    return {
      id: this.#newId(),
      appAId: context.appAId,
      appANativeId: sourceIsA ? change.sourceNativeId : opts.targetNativeId,
      appBId: context.appBId,
      appBNativeId: sourceIsA ? opts.targetNativeId : change.sourceNativeId,
      resourcePairRef: change.resourcePairRef,
      establishedBy: opts.establishedBy,
      status: "active",
      establishingQueueKey: opts.establishingQueueKey,
      createdAt: this.#clock(),
      tombstonedAt: null,
      // SS-12.2/12.7 — freeze the record's resolved container onto the new link (scoped
      // rule) so a linked delete/no-capture read routes from `scopeRef`, not a captured
      // scope. Absent on a non-scoped rule (and when the container did not resolve).
      ...(context.scopeRefForNewLink !== undefined ? { scopeRef: context.scopeRefForNewLink } : {}),
    };
  }

  /**
   * SS-14.2 — the establishing **pre-link ordering-queue key** retained on the new link, so
   * the OQ-4 continuation gate recognizes the pre-link queue as this link's establishing
   * queue. Recomputes the **exact same** string the `QueueKeyResolver` produced at enqueue:
   * the stringified identity value, **scope-qualified** by the record's resolved container
   * (`context.scopeRefForNewLink`, resolved from the same captured scope → same `ScopeLink`)
   * on a scoped rule; the record's own native id when it carries no identity value (the
   * OQ-3.2 fallback, never scope-qualified).
   */
  #preLinkQueueKey(
    change: DetectedChange,
    context: ResolutionContext,
    identityValue: JsonValue | undefined,
  ): string {
    if (identityValue === undefined) {
      return change.sourceNativeId;
    }
    const identityKey = stringifyIdentityValue(identityValue);
    return context.scopeRefForNewLink !== undefined
      ? scopeQualifiedIdentityKey(context.scopeRefForNewLink, identityKey)
      : identityKey;
  }

  #readIdentityValue(change: DetectedChange, context: ResolutionContext): JsonValue | undefined {
    if (change.observedRecord === undefined) {
      return undefined;
    }
    const read = readPath(change.observedRecord, context.identitySourcePath);
    return read.present ? read.value : undefined;
  }

  #buildEvent(fields: {
    readonly id: string;
    readonly status: AuditLogStatus;
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

const NO_OP_METRICS: IdentityResolutionMetrics = {
  recordNoMatch(): void {
    /* default: no metric backend wired */
  },
  recordAmbiguousMatch(): void {
    /* default: no metric backend wired */
  },
};

/** Which side of the link the change's source app is, and the opposite (target) side. */
function sidesOf(
  change: DetectedChange,
  context: ResolutionContext,
): { readonly sourceSide: SyncFieldStateSide; readonly targetSide: SyncFieldStateSide } {
  const sourceSide: SyncFieldStateSide = change.sourceAppId === context.appAId ? "A" : "B";
  return { sourceSide, targetSide: sourceSide === "A" ? "B" : "A" };
}

function skippedPolicyDetails(reason: SkippedPolicyReason): string {
  switch (reason) {
    case "no-create-op":
      return "no approved action=create OperationMapping on the target — create not propagated";
    case "counterpart-deleted":
      return "counterpart record deleted (link tombstoned observed-delete) — change not propagated";
  }
}

/** A tombstoned link must carry its reason (DB + domain enforce it); guard the invariant. */
function requireTombstoneReason(link: RecordLink): TombstoneReason {
  if (link.tombstoneReason === undefined) {
    throw new Error(`tombstoned RecordLink ${link.id} is missing its tombstoneReason`);
  }
  return link.tombstoneReason;
}

function requireFirst(matches: readonly MatchedTargetRecord[]): MatchedTargetRecord {
  const first = matches[0];
  if (first === undefined) {
    throw new Error("expected at least one match");
  }
  return first;
}
