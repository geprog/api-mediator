import { randomUUID } from "node:crypto";

import {
  ApiSpecRepository,
  ApprovedMappingRepository,
  AuditLogRepository,
  MappingArtifactsRepository,
  RecordLinkRepository,
  RegisteredAppRepository,
  ResourceBindingRepository,
  ScopeCorrespondenceRepository,
  SyncRuleRepository,
  tx,
  type Database,
  type ParkedConflictStore,
  type ParkedWriteEntry,
  type ReactivateParkedResult,
  type ScopeLinkStore,
  type SyncRuleConfigPatch,
} from "@mediator/db";
import type {
  AuditLogEntry,
  ConflictPolicy,
  ParkedConflict,
  ParkedConflictResolutionChoice,
  RecordLink,
  ScopeCorrespondence,
  ScopeIdentityKey,
  ScopeKey,
  ScopeLink,
  SyncRule,
  TombstoneReason,
} from "@mediator/domain";
import { stripUndefined } from "@mediator/domain";
import {
  AMBIGUOUS_CONTAINER_DETAILS_PREFIX,
  buildChangePayload,
  evaluateEnablement,
  parseAmbiguousContainerDetails,
  type DetectedChange,
  type EnablementDegradation,
  type EnablementInput,
  type EnablementRequirement,
  type ManualLinkParams,
  type PollRunOutcome,
  type SingleRecordReadResult,
} from "@mediator/sync-engine";
import { getActiveTraceContext, type ActiveTraceContext } from "@mediator/telemetry";

import { BadRequestError, NotFoundError } from "../../app-errors.js";
import { GraphProjection } from "../graph/index.js";
import type { EnableRuleGateResult } from "./background.js";
import { pollScopeModeView, type PollScopeModeView } from "./poll-scope-mode.js";
import { resolveRuleArtifacts, type RuleArtifactRepos, type RuleArtifacts } from "./resolution.js";
import type { EstablishLinkOutcome, ScopeDiscoveryService } from "./scope-discovery.js";
import { computeRequiredScopeBindings, computeScopeLinkGate } from "./scope-requirements.js";

/**
 * **The Sync HTTP API application service (SA-1..SA-3)** — the seam between the
 * thin operator-API handlers and the Sync Engine runtime. It authenticates/
 * authorizes at the HTTP boundary (the routes) and delegates every invariant here:
 *
 *  - **SA-1** configure a disabled rule ({@link configureRule}), enable it through
 *    the enablement gate ({@link enableRule}), or disable it ({@link disableRule}).
 *  - **SA-2** read rule state + poller lag ({@link listRules}) and the sync audit
 *    log ({@link queryEvents}).
 *  - **SA-3** manually link/unlink records ({@link linkRecords}/{@link unlinkRecord})
 *    and read the ambiguous-match queue ({@link listAmbiguousMatches}).
 *
 * The enablement invariant is **not re-derived** here: {@link enableRule} pre-checks
 * with the engine's own {@link evaluateEnablement} and delegates the authoritative
 * enable to {@link SyncOperatorEngine.enableRule} (which re-gates + runs the backfill
 * in the background). Manual linking delegates to the engine's Identity Resolution
 * stage (RL-5).
 *
 * **Attribution (OA-3).** Every mutation (configure/enable/disable/link/unlink) is
 * attributed to the authenticated identity via a `sync-execution` audit row (the
 * per-rule/record execution family — the concept coins no dedicated "operator
 * action" audit type, and no migration is in scope to add one). The row carries the
 * actor + rule/mapping/link context + a short metadata `details` note — **never**
 * credential material or a payload value.
 */

// ── Ports ────────────────────────────────────────────────────────────────────

/**
 * The narrow slice of the Sync Engine runtime (`buildSyncBackground`) the operator
 * API drives: the synchronous-gate enable, the state-retaining disable, and the
 * Identity Resolution manual link/unlink (RL-5) + the record-link read the
 * unlink 404 needs. `SyncBackground` satisfies this structurally.
 */
export interface SyncOperatorEngine {
  enableRule(
    ruleId: string,
    options?: { readonly backfillSkipped?: boolean },
  ): Promise<EnableRuleGateResult>;
  disableRule(ruleId: string): Promise<void>;
  /**
   * SP-5 — the deterministic poll-trigger hook: run exactly one poll cycle for a rule
   * (detect → enqueue → advance). Exposed here so the TEST/DEV-ONLY poll-trigger route
   * can drive a sync round without the Scheduler's wall clock. `SyncBackground` satisfies
   * this structurally.
   */
  pollOnce(ruleId: string): Promise<PollRunOutcome>;
  readonly identityResolution: {
    linkManually(params: ManualLinkParams): Promise<RecordLink>;
    unlink(linkId: string): Promise<void>;
    /** RL-5.3 — tombstone (never delete) a link; SA-4.3 `sever` tombstones `observed-delete`. */
    processDeletion(link: RecordLink, reason: TombstoneReason): Promise<RecordLink>;
  };
  readonly recordLinks: {
    getById(id: string): Promise<RecordLink | undefined>;
  };
  /** SA-4 — the structured parked-conflict store (the operator queue + resolution reads/writes). */
  readonly parkedConflicts: ParkedConflictStore;
  /**
   * SA-4/SA-5 — the ordering-queue seam. SA-4 `enqueue`s a resolution re-run; SA-5 reads
   * the dead-letter queue (`listParked`) and `reactivate`s a parked write back to
   * `pending` so the running dispatcher re-claims it and re-runs the full pipeline. The
   * replay decision (superseded / key-busy) comes from `reactivate`'s **atomic** result,
   * never a separate read-then-act (which would race a change committing mid-replay).
   */
  readonly orderingQueue: {
    enqueue(queueKey: string, payload: Record<string, unknown>): Promise<string>;
    listParked(limit: number): Promise<ParkedWriteEntry[]>;
    reactivate(id: string, now: Date): Promise<ReactivateParkedResult>;
  };
  /** SA-4.2 — read the CURRENT source record so a source-wins re-run propagates the live value. */
  readSourceRecord(ruleId: string, sourceNativeId: string): Promise<SingleRecordReadResult>;
  /** SS-11 — the scope-discovery service (constant/manual container link + on-demand resolution). */
  readonly scopeDiscovery: ScopeDiscoveryService;
  /** SS-11.5 — the active-link lookup used to drop already-linked containers from the parked queue. */
  readonly scopeLinks: ScopeLinkStore;
}

export interface SyncOperatorServiceDeps {
  readonly db: Database;
  readonly sync: SyncOperatorEngine;
  /** Poll-lag "stuck" threshold: `lagMs > staleMultiplier × expectedIntervalMs` (default 3). */
  readonly staleMultiplier?: number;
  readonly clock?: () => Date;
  readonly newId?: () => string;
  readonly readTraceContext?: () => ActiveTraceContext | null;
  /**
   * GR-2.2 — the incremental sync-edge graph projection. When present, a rule
   * enable/disable recomputes the `sync` `GraphEdge` of its mapping's
   * `(sourceApp → targetApp)` from the direction's current rule aggregate, so the
   * landscape graph reflects the change. Optional: a service built without it (a
   * Phase-1..4 test/harness) simply projects nothing — the recompute is a
   * derived-projection side effect, never a precondition of the enable/disable.
   */
  readonly graphProjection?: GraphProjection;
}

// ── Views (service → route; the DTO mapper converts Date → ISO) ───────────────

/** One resolved side of a rule's mapped resource pair. */
export interface SyncResourceSide {
  readonly appId: string;
  readonly appName: string;
  readonly resourceRef: string;
}

/** A rule's poller lag (SA-2.2). */
export interface PollerLagView {
  readonly lastRunAt: Date | null;
  readonly expectedIntervalMs: number | null;
  readonly lagMs: number | null;
  readonly stuck: boolean;
}

/** A `SyncRule` enriched for the SA-2 read surface. */
export interface SyncRuleView {
  readonly rule: SyncRule;
  readonly resourcePair:
    { readonly source: SyncResourceSide; readonly target: SyncResourceSide } | undefined;
  readonly stillNeeds: readonly EnablementRequirement[];
  readonly pollerLag: PollerLagView;
  /**
   * SS-13.5 — the poll-enumeration mode surfaced for the operator: the persisted
   * `override`, the `derived` mode, and the `effective` mode the Poller acts on. Absent
   * when the rule's artifacts do not resolve (no source binding to derive from).
   */
  readonly pollScopeMode: PollScopeModeView | undefined;
}

/** The result of an enable attempt (SA-1.2/1.3). */
export type EnableOutcome =
  | {
      readonly kind: "accepted";
      readonly backfillRequired: boolean;
      readonly degradations: readonly EnablementDegradation[];
    }
  | { readonly kind: "blocked"; readonly stillNeeds: readonly EnablementRequirement[] };

/** One ambiguous-match queue entry (SA-3.3). */
export interface AmbiguousMatchView {
  readonly syncEventId: string;
  readonly ruleId: string | undefined;
  readonly sourceAppId: string | undefined;
  readonly sourceNativeId: string | undefined;
  readonly candidateTargetNativeIds: readonly string[];
  readonly observedAt: Date;
  readonly details: string | undefined;
}

/** The SA-1 config payload (mirrors the DTO; `pollIntervalOverride: null` clears). */
export interface SyncRuleConfig {
  readonly pollIntervalOverride?: number | null;
  readonly pollOperationRef?: string;
  readonly deletePropagation?: SyncRuleConfigPatch["deletePropagation"];
  readonly targetDriftCheck?: SyncRuleConfigPatch["targetDriftCheck"];
  /**
   * SS-13.5 — the operator's correction of the derived poll-enumeration mode. A value
   * pins the override; `null` clears it back to the derived mode; absent leaves it.
   */
  readonly pollScopeMode?: SyncRuleConfigPatch["pollScopeMode"];
  readonly fieldConflictPolicies?: readonly {
    readonly fieldMappingId: string;
    readonly conflictPolicy: ConflictPolicy | null;
  }[];
}

/** The SA-1 enable request (mirrors the DTO). */
export type EnableRuleRequest =
  | { readonly action: "backfill"; readonly backfillMode: "link-only" | "push" }
  | { readonly action: "skip-backfill" };

/** The SA-2 event query (mirrors the DTO). */
export interface SyncEventFilter {
  readonly ruleId?: string;
  readonly recordLinkId?: string;
  readonly sourceNativeId?: string;
  readonly status?: AuditLogEntry["status"];
  readonly limit?: number;
}

/** The SA-3 manual-link request (mirrors the DTO). */
export interface ManualLinkRequest {
  readonly ruleId: string;
  readonly sourceNativeId: string;
  readonly targetNativeId: string;
}

/** The SS-11.6 manual **container**-link request (mirrors the DTO). */
export interface ContainerLinkRequest {
  readonly resourcePairRef: string;
  readonly sourceAppId: string;
  readonly sourceScopeKey: ScopeKey;
  readonly targetAppId: string;
  readonly targetScopeKey: ScopeKey;
}

/** One parked container-link the operator must resolve by linking a container (SS-11.5). */
export interface ParkedContainerLinkView {
  readonly syncEventId: string;
  readonly resourcePairRef: string;
  readonly sourceAppId: string;
  readonly sourceScopeKey: ScopeKey;
  /** The candidate target container native ids (empty = unresolvable / no candidate). */
  readonly candidateTargetNativeIds: readonly string[];
  readonly observedAt: Date;
}

/** The SS-15.4 scope-identity-key confirm request (mirrors the DTO). */
export interface ScopeIdentityKeyConfirmRequest {
  readonly resourcePairRef: string;
  readonly scopeIdentityKey: ScopeIdentityKey;
}

/** The SS-15.5 per-pair target-container linking context (mirrors the DTO). */
export interface ScopeLinkCandidateContext {
  readonly resourcePairRef: string;
  readonly targetAppId: string | null;
  readonly targetScopeKeyComponent: string | null;
}

/** The SA-4 resolve request (mirrors the DTO): the operator's chosen resolution. */
export interface ResolveParkedConflictRequest {
  readonly resolution: ParkedConflictResolutionChoice;
}

/**
 * The SA-4 resolve outcome — a discriminated union: `enqueued` (a field / propagate
 * resolution re-ran through the normal pipeline; the row is superseded when that re-run
 * completes) or `applied` (a `sever` tombstoned the link directly — no pipeline re-run).
 * Either way the returned `conflict` carries **no** raw value / credential material.
 */
export type ResolveParkedConflictOutcome =
  | {
      readonly kind: "enqueued";
      readonly conflict: ParkedConflict;
      readonly resolution: ParkedConflictResolutionChoice;
    }
  | {
      readonly kind: "applied";
      readonly conflict: ParkedConflict;
      readonly resolution: ParkedConflictResolutionChoice;
    };

/**
 * The SA-5 replay outcome — a discriminated union the route maps to HTTP:
 *  - **`reactivated`** (2xx) — the parked write was flipped to `pending`, so the
 *    dispatcher re-runs the standard pipeline against current state (never a blind
 *    re-issue of the stale payload).
 *  - **`superseded`** (4xx) — a later same-key change already synced the record
 *    (SA-5.3); replay is a **no-op**.
 *  - **`blocked-key-busy`** (4xx) — another non-terminal entry shares the queue key;
 *    reactivating would break single-active-per-key (OQ).
 *  - **`not-parked`** (4xx) — the entry exists but is not a parked write.
 *  - **`not-found`** (4xx) — no such entry.
 */
export type ReplayParkedWriteOutcome =
  | { readonly kind: "reactivated" }
  | { readonly kind: "superseded" }
  | { readonly kind: "blocked-key-busy" }
  | { readonly kind: "not-parked" }
  | { readonly kind: "not-found" };

const DEFAULT_STALE_MULTIPLIER = 3;
/** Default bound for the audit-log/ambiguous-match scans — never unbounded history. */
const DEFAULT_EVENT_LIMIT = 100;
const AMBIGUOUS_DETAILS_PREFIX = "ambiguous identity match";
/**
 * SS-16 — how many park rows one page of {@link SyncOperatorService.listParkedContainerLinks}
 * fetches, and the hard cap on how many it will scan in total before giving up on filling
 * `limit`. The cap is what keeps the paged read **bounded** (never unbounded history) while
 * still letting droppable rows be skipped rather than consume the operator's window.
 */
const PARKED_SCAN_PAGE = 100;
const PARKED_SCAN_MAX = 1000;

export class SyncOperatorService {
  readonly #db: Database;
  readonly #sync: SyncOperatorEngine;
  readonly #staleMultiplier: number;
  readonly #clock: () => Date;
  readonly #newId: () => string;
  readonly #readTraceContext: () => ActiveTraceContext | null;
  readonly #graphProjection: GraphProjection | undefined;

  readonly #syncRules: SyncRuleRepository;
  readonly #mappingArtifacts: MappingArtifactsRepository;
  readonly #auditLog: AuditLogRepository;
  readonly #scopeCorrespondences: ScopeCorrespondenceRepository;
  readonly #repos: RuleArtifactRepos;

  public constructor(deps: SyncOperatorServiceDeps) {
    this.#db = deps.db;
    this.#sync = deps.sync;
    this.#staleMultiplier = deps.staleMultiplier ?? DEFAULT_STALE_MULTIPLIER;
    this.#clock = deps.clock ?? ((): Date => new Date());
    this.#newId = deps.newId ?? ((): string => randomUUID());
    this.#readTraceContext = deps.readTraceContext ?? getActiveTraceContext;
    this.#graphProjection = deps.graphProjection;

    this.#syncRules = new SyncRuleRepository(deps.db);
    this.#mappingArtifacts = new MappingArtifactsRepository(deps.db);
    this.#auditLog = new AuditLogRepository(deps.db);
    // SS-13.5 — resolve the pair's ScopeCorrespondence for the derived poll-scope mode.
    this.#scopeCorrespondences = new ScopeCorrespondenceRepository(deps.db);
    this.#repos = {
      syncRules: this.#syncRules,
      approvedMappings: new ApprovedMappingRepository(deps.db),
      mappingArtifacts: this.#mappingArtifacts,
      apiSpecs: new ApiSpecRepository(deps.db),
      resourceBindings: new ResourceBindingRepository(deps.db),
      registeredApps: new RegisteredAppRepository(deps.db),
    };
  }

  // ── SA-2: read ─────────────────────────────────────────────────────────────

  /**
   * SA-2.1/2.2 — every `SyncRule` with its status/backfill/poll fields, resolved
   * resource pair, gate `stillNeeds` (empty on an enable-able rule), and poller lag.
   * A rule whose artifacts do not resolve still lists (resource pair absent,
   * `stillNeeds` empty) rather than vanishing. No credential material.
   */
  public async listRules(): Promise<SyncRuleView[]> {
    const rules = await this.#syncRules.listAll();
    const now = this.#clock();
    const views: SyncRuleView[] = [];
    for (const rule of rules) {
      const artifacts = await resolveRuleArtifacts(rule.id, this.#repos);
      views.push(
        await this.#viewFor(rule, artifacts, await this.#pollScopeModeOf(rule, artifacts), now),
      );
    }
    return views;
  }

  /** SA-2.3 — the sync audit log filtered by rule/record/status, bounded. */
  public async queryEvents(filter: SyncEventFilter): Promise<AuditLogEntry[]> {
    return this.#auditLog.querySyncEvents({
      ...(filter.ruleId !== undefined ? { relatedRuleId: filter.ruleId } : {}),
      ...(filter.recordLinkId !== undefined ? { recordLinkId: filter.recordLinkId } : {}),
      ...(filter.sourceNativeId !== undefined ? { sourceNativeId: filter.sourceNativeId } : {}),
      ...(filter.status !== undefined ? { status: filter.status } : {}),
      limit: filter.limit ?? DEFAULT_EVENT_LIMIT,
    });
  }

  // ── SA-1: configure / enable / disable ─────────────────────────────────────

  /**
   * SA-1.1 — configure a **disabled** rule's execution options + per-`FieldMapping`
   * `conflictPolicy`, persisted atomically with the OA-3 attribution row. A rule that
   * is not `disabled` is rejected (the options only take effect at enablement, so
   * changing them on a live rule is refused). A `fieldMappingId` not belonging to the
   * rule's mapping is a 404.
   */
  public async configureRule(
    ruleId: string,
    config: SyncRuleConfig,
    actor: string,
  ): Promise<SyncRuleView> {
    const artifacts = await this.#requireArtifacts(ruleId);
    if (artifacts.rule.status !== "disabled") {
      throw new BadRequestError(
        `Sync rule ${ruleId} is ${artifacts.rule.status}; execution options can only be configured while it is disabled.`,
      );
    }

    const fieldPolicies = config.fieldConflictPolicies ?? [];
    if (fieldPolicies.length > 0) {
      const ownFieldIds = new Set(artifacts.fieldMappings.map((field) => field.id));
      for (const policy of fieldPolicies) {
        if (!ownFieldIds.has(policy.fieldMappingId)) {
          throw new NotFoundError(
            `Field mapping ${policy.fieldMappingId} is not part of sync rule ${ruleId}'s mapping.`,
          );
        }
      }
    }

    const patch = configPatch(config);
    await tx(this.#db, async (txn) => {
      const rules = new SyncRuleRepository(txn);
      const mappingArtifacts = new MappingArtifactsRepository(txn);
      const audit = new AuditLogRepository(txn);
      await rules.updateConfig(ruleId, patch);
      for (const policy of fieldPolicies) {
        await mappingArtifacts.setFieldMappingConflictPolicy(
          policy.fieldMappingId,
          policy.conflictPolicy,
        );
      }
      await audit.insert(
        this.#attribution(actor, "sync rule execution options configured", {
          relatedRuleId: ruleId,
          relatedMappingId: artifacts.mapping.id,
        }),
      );
    });

    return this.#reload(ruleId);
  }

  /**
   * SA-1.2/1.3 — enable a rule with a chosen `backfillMode` or an explicit skip. The
   * engine's gate is pre-checked: **blocked** returns the exact `stillNeeds` list and
   * persists/enables nothing; **enable-able** persists the chosen `backfillMode` (when
   * backfilling) and delegates to the engine's `enableRule` (which re-gates and runs
   * the backfill in the background — the handler never blocks on it). Attribution is
   * recorded on the accepted enable.
   */
  public async enableRule(
    ruleId: string,
    request: EnableRuleRequest,
    actor: string,
  ): Promise<EnableOutcome> {
    const artifacts = await this.#requireArtifacts(ruleId);
    const backfillSkipped = request.action === "skip-backfill";

    // Pre-check with the engine's own gate so a blocked enable changes nothing.
    const decision = evaluateEnablement(await this.#enablementInput(artifacts, backfillSkipped));
    if (decision.kind === "blocked") {
      return { kind: "blocked", stillNeeds: decision.stillNeeds };
    }

    // The operator's chosen backfill mode is persisted before the engine reads it.
    if (request.action === "backfill") {
      await this.#syncRules.updateConfig(ruleId, { backfillMode: request.backfillMode });
    }

    const result = await this.#sync.enableRule(ruleId, { backfillSkipped });
    if (result.kind === "blocked") {
      return { kind: "blocked", stillNeeds: result.stillNeeds };
    }
    if (result.kind === "unresolved") {
      throw new BadRequestError(`Sync rule ${ruleId} could not be enabled: ${result.reason}`);
    }

    const enableDetails =
      request.action === "skip-backfill"
        ? "sync rule enabled (backfill skipped)"
        : `sync rule enabled (backfill ${request.backfillMode})`;
    await this.#auditLog.insert(
      this.#attribution(actor, enableDetails, {
        relatedRuleId: ruleId,
        relatedMappingId: artifacts.mapping.id,
      }),
    );
    // GR-2.2 — the rule is now `enabled`: recompute its sync edge from the direction's
    // current rule aggregate (the edge reflects the enable). A derived-projection side
    // effect, after the enable committed; never blocks or fails the enable.
    await this.#recomputeSyncEdgeFor(artifacts.mapping);
    return {
      kind: "accepted",
      backfillRequired: result.backfillRequired,
      degradations: result.degradations,
    };
  }

  /**
   * SA-1.4 — disable an enabled rule: polling stops; cursor/snapshot/links/field-state
   * are retained (never reset), so re-enabling an already-backfilled rule does not
   * re-backfill. Idempotent on an already-disabled rule. Attributed to the identity.
   */
  public async disableRule(ruleId: string, actor: string): Promise<SyncRuleView> {
    const rule = await this.#syncRules.getById(ruleId);
    if (rule === undefined) {
      throw new NotFoundError(`Sync rule ${ruleId} not found.`);
    }
    await this.#sync.disableRule(ruleId);
    await this.#auditLog.insert(
      this.#attribution(actor, "sync rule disabled", {
        relatedRuleId: ruleId,
        relatedMappingId: rule.approvedMappingId,
      }),
    );
    // GR-2.2 — the rule is now `disabled`: recompute its sync edge from the direction's
    // current rule aggregate (the last enabled rule going down pauses the edge; the
    // last rule of the direction disappearing entirely removes it).
    const mapping = await this.#repos.approvedMappings.getById(rule.approvedMappingId);
    if (mapping !== undefined) {
      await this.#recomputeSyncEdgeFor(mapping);
    }
    return this.#reload(ruleId);
  }

  /**
   * GR-2.2 — recompute the `sync` `GraphEdge` for a rule's mapping direction
   * `(sourceApp → targetApp)` from the direction's current rule aggregate, when the
   * graph projection is wired. A no-op when it is not (a Phase-1..4 harness). Runs in
   * its own transaction: the triggering enable/disable has already committed, and the
   * projection is idempotent, so an eventual recompute converges on the right edge —
   * a projection side effect that never gates the operator action.
   */
  async #recomputeSyncEdgeFor(mapping: {
    readonly sourceAppId: string;
    readonly targetAppId: string;
  }): Promise<void> {
    await this.#graphProjection?.recomputeSyncEdge(mapping.sourceAppId, mapping.targetAppId);
  }

  /**
   * SP-5 — the deterministic poll-trigger hook, exposed for the **TEST/DEV-ONLY**
   * poll-trigger endpoint (its route is registered only when `sync.testPollTrigger` is
   * set). Runs exactly one poll cycle for the rule (detect → enqueue → advance) and
   * returns its {@link PollRunOutcome}; the running ordering-queue worker then processes
   * the enqueued changes, so a single trigger drives a full deterministic sync step. A
   * missing rule is a 404 (never re-implements polling — it delegates to the engine's
   * seam). Not attributed as an operator action: this is a test seam, not concept
   * behavior, and the poll run records its own `SyncEvent`s through the pipeline as usual.
   */
  public async triggerPoll(ruleId: string): Promise<PollRunOutcome> {
    const rule = await this.#syncRules.getById(ruleId);
    if (rule === undefined) {
      throw new NotFoundError(`Sync rule ${ruleId} not found.`);
    }
    return this.#sync.pollOnce(ruleId);
  }

  // ── SA-3: manual link / unlink + ambiguous queue ───────────────────────────

  /**
   * SA-3.1 — manually link a rule's source record to a chosen target record (RL-5).
   * Delegates to the engine's Identity Resolution stage, which creates the
   * `establishedBy = manual` `RecordLink` + its queue key. The pair's canonical A/B
   * assignment comes from the resolved rule; no identity value is supplied, so the
   * link records the `both-native-id-queues` continuation marker (valid on a manual
   * link — the operator API does not re-read the source record just to synthesize a
   * queue key). Attributed to the identity.
   */
  public async linkRecords(request: ManualLinkRequest, actor: string): Promise<RecordLink> {
    const artifacts = await this.#requireArtifacts(request.ruleId);
    const sourceIsA = artifacts.mapping.sourceAppId === artifacts.appAId;
    const params: ManualLinkParams = {
      resourcePairRef: artifacts.rule.resourcePairRef,
      appAId: artifacts.appAId,
      appANativeId: sourceIsA ? request.sourceNativeId : request.targetNativeId,
      appBId: artifacts.appBId,
      appBNativeId: sourceIsA ? request.targetNativeId : request.sourceNativeId,
    };
    const link = await this.#sync.identityResolution.linkManually(params);
    await this.#auditLog.insert(
      this.#attribution(actor, "record link established manually", {
        relatedRuleId: request.ruleId,
        relatedMappingId: artifacts.mapping.id,
        recordLinkId: link.id,
        sourceNativeId: request.sourceNativeId,
        originAppId: artifacts.mapping.sourceAppId,
      }),
    );
    return link;
  }

  /** SA-3.2 — sever a `RecordLink` (RL-5). A missing link is a 404. Attributed. */
  public async unlinkRecord(linkId: string, actor: string): Promise<void> {
    const link = await this.#sync.recordLinks.getById(linkId);
    if (link === undefined) {
      throw new NotFoundError(`Record link ${linkId} not found.`);
    }
    await this.#sync.identityResolution.unlink(linkId);
    await this.#auditLog.insert(
      this.#attribution(actor, "record link severed manually", {
        recordLinkId: linkId,
      }),
    );
  }

  /**
   * SA-3.3 — the ambiguous-match queue: unresolved records whose identity lookup
   * matched more than one target (RL-4), with the candidate target native ids the
   * engine recorded in the `failure` event's `details`. A record is dropped from the
   * queue once an active `RecordLink` exists for it (manually linked, or matched
   * afresh) — the "unresolved" qualifier. Bounded by `limit`.
   *
   * SS-16 — the family discriminator is pushed into the query
   * ({@link SyncEventQuery.detailsPrefix}) rather than filtered in memory afterwards, so
   * `limit` bounds *ambiguous-match* rows instead of being spent on unrelated `failure`
   * rows that would silently empty this queue. Same defect, same fix as the parked
   * container-link queue below; the in-memory `startsWith` stays as the exact re-check.
   */
  public async listAmbiguousMatches(limit = DEFAULT_EVENT_LIMIT): Promise<AmbiguousMatchView[]> {
    const events = await this.#auditLog.querySyncEvents({
      status: "failure",
      detailsPrefix: AMBIGUOUS_DETAILS_PREFIX,
      limit,
    });
    const recordLinks = new RecordLinkRepository(this.#db);
    const ruleRefCache = new Map<string, string | undefined>();
    const matches: AmbiguousMatchView[] = [];

    for (const event of events) {
      if (event.details === undefined || !event.details.startsWith(AMBIGUOUS_DETAILS_PREFIX)) {
        continue;
      }
      // Drop already-resolved records: an active link for (originApp, sourceNativeId).
      if (
        event.relatedRuleId !== undefined &&
        event.originAppId !== undefined &&
        event.sourceNativeId !== undefined
      ) {
        const resourcePairRef = await this.#resourcePairRefOf(event.relatedRuleId, ruleRefCache);
        if (resourcePairRef !== undefined) {
          const active = await recordLinks.findActiveByRecord(resourcePairRef, {
            appId: event.originAppId,
            nativeId: event.sourceNativeId,
          });
          if (active !== undefined) {
            continue;
          }
        }
      }
      matches.push({
        syncEventId: event.id,
        ruleId: event.relatedRuleId,
        sourceAppId: event.originAppId,
        sourceNativeId: event.sourceNativeId,
        candidateTargetNativeIds: parseCandidateNativeIds(event.details),
        observedAt: event.timestamp,
        details: event.details,
      });
    }
    return matches;
  }

  // ── SS-11: scope-link (container) linking ──────────────────────────────────

  /**
   * SS-11.6 — manually link two containers (`establishedBy = manual`, mirroring SA-3's
   * manual record link). A pair with no `ScopeCorrespondence` is a 404; a container
   * already linked to a different counterpart surfaces as a `BadRequestError` (never
   * silently re-pointed). Attributed to the identity (OA-3).
   */
  public async linkContainers(request: ContainerLinkRequest, actor: string): Promise<ScopeLink> {
    const outcome = await this.#sync.scopeDiscovery.linkContainers(
      request.resourcePairRef,
      request.sourceAppId,
      request.sourceScopeKey,
      request.targetAppId,
      request.targetScopeKey,
    );
    const link = this.#unwrapEstablish(outcome, request.resourcePairRef);
    await this.#auditLog.insert(
      this.#attribution(actor, "scope link established manually", {
        originAppId: request.sourceAppId,
      }),
    );
    return link;
  }

  /**
   * SS-11.6 — sever a `ScopeLink` (manual unlink). A missing link is a 404. Attributed
   * to the identity.
   */
  public async unlinkContainer(scopeLinkId: string, actor: string): Promise<void> {
    const removed = await this.#sync.scopeDiscovery.unlinkContainer(scopeLinkId);
    if (!removed) {
      throw new NotFoundError(`Scope link ${scopeLinkId} not found.`);
    }
    await this.#auditLog.insert(this.#attribution(actor, "scope link severed manually", {}));
  }

  /**
   * SS-11.5 — the parked container-linking queue: records whose container could not be
   * resolved to a `ScopeLink` (ambiguous or unresolvable), surfaced from the discovery
   * `failure` `SyncEvent`s so an operator can link the container and replay. A parked
   * entry drops off once an active `ScopeLink` covers its source scope (mirroring the
   * ambiguous-record queue's drop-resolved). Bounded by `limit`. No payload/secret value.
   *
   * ## SS-16 — why this read pages, and what else it drops
   *
   * `audit_log` deliberately holds **no foreign keys**, so a park row **outlives every
   * entity it references**. Two consequences made the pre-SS-16 read able to hide genuine
   * parked containers rather than merely show stale ones — a *functional* defect, because
   * the read is bounded:
   *
   * 1. **The bound was spent on the wrong rows.** The scan asked for the newest `limit`
   *    `failure` rows of *any* family and only then filtered to container parks, so
   *    ordinary write/conflict failures alone could fill the window and return an empty
   *    queue while containers sat parked. Fixed by pushing the family discriminator into
   *    SQL ({@link SyncEventQuery.detailsPrefix}), which makes `limit` a bound on park rows.
   * 2. **Unclearable rows could never leave.** A park is cleared by linking its container,
   *    but once the pair's `ScopeCorrespondence` or the source `RegisteredApp` is gone
   *    (the deregistration cascade) there is nothing left to link *to*:
   *    `lookupByScopeKey` can never return a covering link, `linkContainers` 404s, and no
   *    dismiss route exists. Such rows are **permanently** unresolvable, so they are
   *    dropped here as part of the same lifecycle cascade — no dismissal state to persist,
   *    and therefore **no migration**. The audit row itself is retained untouched
   *    (`docs/architecture/extensibility.md`: "the audit log retains all historical
   *    events"); only its claim on this operator queue lapses.
   *
   * Dropping happens *after* the bounded fetch, so a page can still be consumed entirely
   * by droppable rows. The scan therefore **pages** — up to {@link PARKED_SCAN_MAX} rows —
   * until `limit` live entries are collected, so stale entries can no longer push a genuine
   * parked container out of the response. Still bounded, never unbounded history.
   */
  public async listParkedContainerLinks(
    limit = DEFAULT_EVENT_LIMIT,
  ): Promise<ParkedContainerLinkView[]> {
    const views: ParkedContainerLinkView[] = [];
    // Per-read memo: one pair/app is typically shared by many park rows, so the liveness
    // probes collapse to one query each rather than one per row.
    const liveness = new Map<string, boolean>();
    let scanned = 0;

    while (views.length < limit && scanned < PARKED_SCAN_MAX) {
      const page = await this.#auditLog.querySyncEvents({
        status: "failure",
        detailsPrefix: AMBIGUOUS_CONTAINER_DETAILS_PREFIX,
        offset: scanned,
        limit: Math.min(PARKED_SCAN_PAGE, PARKED_SCAN_MAX - scanned),
      });
      if (page.length === 0) {
        break;
      }
      scanned += page.length;

      for (const event of page) {
        if (views.length >= limit) {
          break;
        }
        if (event.details === undefined) {
          continue;
        }
        const parsed = parseAmbiguousContainerDetails(event.details);
        if (parsed === undefined) {
          continue;
        }
        // Drop already-resolved containers: an active ScopeLink covering the source scope.
        const active = await this.#sync.scopeLinks.lookupByScopeKey(parsed.resourcePairRef, {
          appId: parsed.sourceAppId,
          scopeKey: parsed.sourceScopeKey,
        });
        if (active !== undefined) {
          continue;
        }
        // SS-16 — drop entries no operator action could ever clear (see the doc above).
        if (!(await this.#parkIsActionable(parsed.resourcePairRef, parsed.sourceAppId, liveness))) {
          continue;
        }
        views.push({
          syncEventId: event.id,
          resourcePairRef: parsed.resourcePairRef,
          sourceAppId: parsed.sourceAppId,
          sourceScopeKey: parsed.sourceScopeKey,
          candidateTargetNativeIds: parsed.candidateNativeIds,
          observedAt: event.timestamp,
        });
      }
    }
    return views;
  }

  /**
   * SS-16 — whether a parked container is still **actionable**: both entities the
   * operator's remedy needs must still exist. Linking the container (SS-11.6) resolves
   * the pair's `ScopeCorrespondence` and establishes a `ScopeLink` between two live apps,
   * so a park whose correspondence *or* whose source app is gone can never be cleared and
   * has no business occupying the bounded queue. Memoized per read (`liveness`), keyed by
   * a prefixed key so a pair ref and an app id can never collide.
   */
  async #parkIsActionable(
    resourcePairRef: string,
    sourceAppId: string,
    liveness: Map<string, boolean>,
  ): Promise<boolean> {
    const pairKey = `pair:${resourcePairRef}`;
    let pairLives = liveness.get(pairKey);
    if (pairLives === undefined) {
      pairLives =
        (await this.#scopeCorrespondences.getByResourcePair(resourcePairRef)) !== undefined;
      liveness.set(pairKey, pairLives);
    }
    if (!pairLives) {
      return false;
    }
    const appKey = `app:${sourceAppId}`;
    let appLives = liveness.get(appKey);
    if (appLives === undefined) {
      appLives = (await this.#repos.registeredApps.getById(sourceAppId)) !== undefined;
      liveness.set(appKey, appLives);
    }
    return appLives;
  }

  // ── SS-15: scope identity key confirmation + container-linking context ───────

  /**
   * SS-15.4 (read) — the pair's `ScopeCorrespondence` (SS-10), or `undefined` when the
   * pair has none yet. Home of the mediator's pre-selected candidate `scopeIdentityKey`
   * the confirmation panel confirms/corrects. Config only, no credential material.
   */
  public async getScopeCorrespondence(
    resourcePairRef: string,
  ): Promise<ScopeCorrespondence | undefined> {
    return this.#scopeCorrespondences.getByResourcePair(resourcePairRef);
  }

  /**
   * SS-15.4 (write) — confirm (or correct) the pair's **scope identity key**: replace the
   * correspondence's `scopeIdentityKey` with the operator's pairing(s) and stamp
   * `confirmedBy`/`confirmedAt` (OA-3). A value-altering (non-`rename`) pairing is rejected
   * upstream by the DTO schema (400); the container refs are carried from the existing
   * correspondence untouched — this slice confirms an **established** correspondence, whose
   * creation is SS-10/SS-11's. A pair with no correspondence is a 404.
   */
  public async confirmScopeIdentityKey(
    request: ScopeIdentityKeyConfirmRequest,
    actor: string,
  ): Promise<ScopeCorrespondence> {
    const existing = await this.#scopeCorrespondences.getByResourcePair(request.resourcePairRef);
    if (existing === undefined) {
      throw new NotFoundError(
        `No ScopeCorrespondence for resource pair ${request.resourcePairRef} — its container correspondence (SS-10/SS-11) must be established before its scope identity key can be confirmed.`,
      );
    }
    const confirmed: ScopeCorrespondence = {
      ...existing,
      scopeIdentityKey: request.scopeIdentityKey,
      confirmedBy: actor,
      confirmedAt: this.#clock(),
    };
    const saved = await this.#scopeCorrespondences.confirmOrUpdate(confirmed);
    await this.#auditLog.insert(this.#attribution(actor, "scope identity key confirmed", {}));
    return saved;
  }

  /**
   * SS-15.5 — the per-pair target-container **linking context** the container-linking
   * screen needs to turn a parked entry's chosen candidate target native id into a
   * `POST /api/scope-links` request: the correspondence's target container `appId` and the
   * target addressing scope-key **component name** (a target-side `scope-link` binding's
   * `scopeKeyRef` — the component the chosen native id fills). Each is `null` when the pair
   * has no correspondence or no single resolvable component. Ids / component name only.
   */
  public async getScopeLinkCandidateContext(
    resourcePairRef: string,
  ): Promise<ScopeLinkCandidateContext> {
    const correspondence = await this.#scopeCorrespondences.getByResourcePair(resourcePairRef);
    if (correspondence === undefined) {
      return { resourcePairRef, targetAppId: null, targetScopeKeyComponent: null };
    }
    const targetAppId = correspondence.targetContainerRef.appId;
    const rules = await this.#syncRules.listAll();
    for (const rule of rules) {
      if (rule.resourcePairRef !== resourcePairRef) {
        continue;
      }
      const artifacts = await resolveRuleArtifacts(rule.id, this.#repos);
      if (artifacts === undefined || artifacts.targetApp.id !== targetAppId) {
        continue;
      }
      for (const entry of artifacts.targetBinding.scopePathBindings ?? []) {
        if (entry.kind === "scope-link") {
          return { resourcePairRef, targetAppId, targetScopeKeyComponent: entry.scopeKeyRef };
        }
      }
    }
    return { resourcePairRef, targetAppId, targetScopeKeyComponent: null };
  }

  /** Turn a discovery establish outcome into the established link, or a 4xx. */
  #unwrapEstablish(outcome: EstablishLinkOutcome, resourcePairRef: string): ScopeLink {
    if (outcome.kind === "not-scoped") {
      throw new NotFoundError(
        `No ScopeCorrespondence for resource pair ${resourcePairRef} — confirm the scope identity key first.`,
      );
    }
    const result = outcome.result;
    if (result.kind === "conflict") {
      throw new BadRequestError(
        `A container in this pair is already linked to a different counterpart (existing link ${result.existing.id}); unlink it before re-linking.`,
      );
    }
    return result.link;
  }

  // ── SA-4: resolve a parked conflict ────────────────────────────────────────

  /**
   * SA-4.1 — the parked-conflict queue: the `open` `parked_conflict` rows (manual-resolve
   * fields, withheld fields, drifted deletes), each with the context to decide (rule/
   * record/link, field, kind, the contested-side **hashes**). **No** raw values, **no**
   * credential material. Viewer + operator may read (the route gates it).
   */
  public async listParkedConflicts(limit = DEFAULT_EVENT_LIMIT): Promise<ParkedConflict[]> {
    return this.#sync.parkedConflicts.listOpen(limit);
  }

  /**
   * SA-4.2/4.3 — resolve a parked conflict by an operator's chosen side/outcome.
   *
   * A **field** conflict (`manual-resolve`/`withheld`) resolves `source-wins`/`target-wins`
   * and a drifted-delete `propagate`/`sever`. **source-wins / target-wins / propagate flow
   * through the normal pipeline** (SA-4.2): the service reads current state (the live
   * source record for a field re-run) and enqueues an ordinary queued execution carrying a
   * one-shot resolution directive — CF re-checks drift, EP re-checks echo, and the
   * write/delete goes through the standard write path; the `parked_conflict` row is
   * superseded when that re-run completes (the handler resolves it). **sever** is the one
   * direct action (SA-4.3): it tombstones the link `observed-delete` (RL-5 — keep the
   * survivor, delete nothing) and resolves the row here. Every path is recorded as a
   * `SyncEvent` attributed to the identity (OA-3); nothing is written outside the pipeline
   * except the sever tombstone (a local link-state change, like a manual unlink).
   */
  public async resolveParkedConflict(
    id: string,
    request: ResolveParkedConflictRequest,
    actor: string,
  ): Promise<ResolveParkedConflictOutcome> {
    const parked = await this.#sync.parkedConflicts.getById(id);
    if (parked === undefined) {
      throw new NotFoundError(`Parked conflict ${id} not found.`);
    }
    if (parked.status !== "open") {
      throw new BadRequestError(`Parked conflict ${id} is already resolved.`);
    }

    const choice = request.resolution;
    const isDeleteKind = parked.kind === "drifted-delete";
    const validChoice = isDeleteKind
      ? choice === "propagate" || choice === "sever"
      : choice === "source-wins" || choice === "target-wins";
    if (!validChoice) {
      throw new BadRequestError(
        `Resolution '${choice}' is not valid for a ${parked.kind} parked conflict.`,
      );
    }

    const link = await this.#sync.recordLinks.getById(parked.recordLinkId);
    if (link === undefined) {
      throw new BadRequestError(
        `The record link ${parked.recordLinkId} for parked conflict ${id} no longer exists.`,
      );
    }
    if (link.status !== "active") {
      throw new BadRequestError(
        `The record link ${parked.recordLinkId} is ${link.status}; the conflict can no longer be resolved.`,
      );
    }

    // SA-4.3 sever — a DIRECT tombstone (`observed-delete`): keep the survivor, sever the
    // pair, delete nothing. Not a pipeline re-run (there is nothing to propagate), so the
    // service resolves the row itself; the tombstone (not a hard unlink) prevents a slower
    // poll cycle from resurrecting the record (RL-5 / `docs/architecture/sync-engine.md`).
    if (choice === "sever") {
      await this.#sync.identityResolution.processDeletion(link, "observed-delete");
      const resolved = await this.#sync.parkedConflicts.resolve(id, {
        choice: "sever",
        resolvedBy: actor,
        resolvedAt: this.#clock(),
      });
      await this.#auditLog.insert(
        this.#attribution(
          actor,
          "parked drifted-delete resolved (sever — link tombstoned observed-delete)",
          {
            relatedRuleId: parked.syncRuleId,
            relatedMappingId: parked.mappingId,
            recordLinkId: link.id,
            ...(parked.sourceNativeId !== undefined
              ? { sourceNativeId: parked.sourceNativeId }
              : {}),
          },
        ),
      );
      return { kind: "applied", conflict: resolved ?? parked, resolution: "sever" };
    }

    // SA-4.2 / SA-4.3 propagate — a pipeline RE-RUN against CURRENT state. Enqueue an
    // ordinary queued execution under the record's link-keyed queue carrying the one-shot
    // directive; the dispatcher runs the standard pipeline (never a blind write).
    const artifacts = await this.#requireArtifacts(parked.syncRuleId);
    const sourceNativeId = parked.sourceNativeId ?? sourceNativeIdOfLink(link, artifacts);

    if (isDeleteKind) {
      // choice === "propagate" (sever already returned above).
      const change: DetectedChange = {
        ruleId: parked.syncRuleId,
        mappingId: artifacts.mapping.id,
        sourceAppId: artifacts.mapping.sourceAppId,
        targetAppId: artifacts.mapping.targetAppId,
        resourcePairRef: artifacts.rule.resourcePairRef,
        sourceNativeId,
        changeKind: "delete",
      };
      const directive = {
        overrides: [],
        deleteOverride: { choice: "propagate" as const },
        parkedConflictIds: [parked.id],
        choice: "propagate" as const,
        resolvedBy: actor,
      };
      await this.#sync.orderingQueue.enqueue(link.id, {
        ...buildChangePayload(change),
        resolution: directive,
      });
      await this.#auditLog.insert(
        this.#attribution(actor, "parked drifted-delete resolution enqueued (propagate)", {
          relatedRuleId: parked.syncRuleId,
          relatedMappingId: parked.mappingId,
          recordLinkId: link.id,
          sourceNativeId,
        }),
      );
      return { kind: "enqueued", conflict: parked, resolution: "propagate" };
    }

    // A field conflict (choice ∈ {source-wins, target-wins}). Read the CURRENT source
    // record so a source-wins re-run propagates the live value (against current state).
    const targetPath = parked.fieldPath;
    if (targetPath === undefined) {
      throw new BadRequestError(`Parked field conflict ${id} is missing its target field path.`);
    }
    const read = await this.#sync.readSourceRecord(parked.syncRuleId, sourceNativeId);
    if (!read.found) {
      throw new BadRequestError(
        `The source record ${sourceNativeId} no longer exists — a field conflict cannot be re-run against a deleted source.`,
      );
    }
    const change: DetectedChange = {
      ruleId: parked.syncRuleId,
      mappingId: artifacts.mapping.id,
      sourceAppId: artifacts.mapping.sourceAppId,
      targetAppId: artifacts.mapping.targetAppId,
      resourcePairRef: artifacts.rule.resourcePairRef,
      sourceNativeId,
      changeKind: "update",
      observedRecord: read.record,
    };
    const directive = {
      overrides: [{ targetPath, choice }],
      parkedConflictIds: [parked.id],
      choice,
      resolvedBy: actor,
    };
    await this.#sync.orderingQueue.enqueue(link.id, {
      ...buildChangePayload(change),
      resolution: directive,
    });
    await this.#auditLog.insert(
      this.#attribution(
        actor,
        `parked ${parked.kind} conflict resolution enqueued (${choice} on ${targetPath})`,
        {
          relatedRuleId: parked.syncRuleId,
          relatedMappingId: parked.mappingId,
          recordLinkId: link.id,
          sourceNativeId,
        },
      ),
    );
    return { kind: "enqueued", conflict: parked, resolution: choice };
  }

  // ── SA-5: the dead-letter queue + replay a parked write ────────────────────

  /**
   * SA-5.1 — the dead-letter queue: the `parked` `ordering_queue` writes (dead-lettered
   * at the OC-4 retry ceiling), each as a **safe projection** — ids/refs, the non-secret
   * `lastError` reason, attempts, timestamps, and the `superseded` flag (SA-5.3).
   * **No** raw payload value (never the `observedRecord`), **no** credential material.
   * Viewer + operator may read (the route gates it). Bounded by `limit`.
   */
  public async listDeadLetterWrites(limit = DEFAULT_EVENT_LIMIT): Promise<ParkedWriteEntry[]> {
    return this.#sync.orderingQueue.listParked(limit);
  }

  /**
   * SA-5.2/5.3 — replay a parked write (operator-only; the route gates OA-2).
   *
   * The decision comes entirely from `reactivate`'s **atomic** result — the superseded
   * and single-active-per-key guards are `NOT EXISTS` sub-selects inside the one `UPDATE`,
   * so a change that commits `done` (superseding this write) or enqueues (busying the key)
   * mid-replay is caught rather than raced. A **superseded** entry — a later same-key
   * change already synced the record — is a **no-op** (SA-5.3): an already-superseded
   * write is never re-issued. Otherwise the entry is **reactivated** to `pending`, so the
   * running dispatcher re-claims it and re-runs the **standard pipeline** (RL→EP→CF→TX→OC)
   * against current state — CF re-checks drift, EP re-checks echo, OC re-computes the
   * idempotency key — never a blind re-issue of the stale payload (SA-5.2 /
   * `docs/architecture/sync-engine.md` *Write failures*). The reactivation is attributed
   * to the identity (OA-3); the eventual re-run records its own `SyncEvent` through the
   * pipeline as usual. Nothing outside the queue is written.
   */
  public async replayParkedWrite(id: string, actor: string): Promise<ReplayParkedWriteOutcome> {
    const result = await this.#sync.orderingQueue.reactivate(id, this.#clock());
    if (result.kind !== "reactivated") {
      return { kind: result.kind };
    }
    // OA-3 — attribute the replay to the identity. Only ids are read from the payload
    // (never a value); the entry id (a uuid) identifies the replayed write in `details`.
    // Keys are spread conditionally (exactOptionalPropertyTypes — never pass `undefined`).
    const payload = result.entry.payload;
    const ruleId = readPayloadId(payload, "ruleId");
    const mappingId = readPayloadId(payload, "mappingId");
    const sourceNativeId = readPayloadId(payload, "sourceNativeId");
    await this.#auditLog.insert(
      this.#attribution(actor, `parked write replay reactivated (entry ${result.entry.id})`, {
        ...(ruleId !== undefined ? { relatedRuleId: ruleId } : {}),
        ...(mappingId !== undefined ? { relatedMappingId: mappingId } : {}),
        ...(sourceNativeId !== undefined ? { sourceNativeId } : {}),
      }),
    );
    return { kind: "reactivated" };
  }

  // ── internals ──────────────────────────────────────────────────────────────

  async #requireArtifacts(ruleId: string): Promise<RuleArtifacts> {
    const rule = await this.#syncRules.getById(ruleId);
    if (rule === undefined) {
      throw new NotFoundError(`Sync rule ${ruleId} not found.`);
    }
    const artifacts = await resolveRuleArtifacts(ruleId, this.#repos);
    if (artifacts === undefined) {
      throw new BadRequestError(
        `Sync rule ${ruleId} does not resolve to executable mapping/binding/IR state.`,
      );
    }
    return artifacts;
  }

  async #reload(ruleId: string): Promise<SyncRuleView> {
    const rule = await this.#syncRules.getById(ruleId);
    if (rule === undefined) {
      throw new NotFoundError(`Sync rule ${ruleId} not found.`);
    }
    const artifacts = await resolveRuleArtifacts(ruleId, this.#repos);
    return this.#viewFor(
      rule,
      artifacts,
      await this.#pollScopeModeOf(rule, artifacts),
      this.#clock(),
    );
  }

  /**
   * SS-13.5 — the operator-visible poll-scope mode view (override + derived + effective).
   * Absent when the rule's artifacts do not resolve (no source binding to derive from);
   * else derived from the source binding + the pair's `ScopeCorrespondence`.
   */
  async #pollScopeModeOf(
    rule: SyncRule,
    artifacts: RuleArtifacts | undefined,
  ): Promise<PollScopeModeView | undefined> {
    if (artifacts === undefined) {
      return undefined;
    }
    const correspondence = await this.#scopeCorrespondences.getByResourcePair(rule.resourcePairRef);
    return pollScopeModeView(rule, artifacts.sourceBinding, correspondence);
  }

  async #viewFor(
    rule: SyncRule,
    artifacts: RuleArtifacts | undefined,
    scopeMode: PollScopeModeView | undefined,
    now: Date,
  ): Promise<SyncRuleView> {
    if (artifacts === undefined) {
      return {
        rule,
        resourcePair: undefined,
        stillNeeds: [],
        pollerLag: pollerLag(rule, null, now, this.#staleMultiplier),
        pollScopeMode: scopeMode,
      };
    }
    const decision = evaluateEnablement(await this.#enablementInput(artifacts, false));
    return {
      rule,
      resourcePair: {
        source: {
          appId: artifacts.sourceApp.id,
          appName: artifacts.sourceApp.name,
          resourceRef: artifacts.sourceResourceRef,
        },
        target: {
          appId: artifacts.targetApp.id,
          appName: artifacts.targetApp.name,
          resourceRef: artifacts.targetResourceRef,
        },
      },
      stillNeeds: decision.kind === "blocked" ? decision.stillNeeds : [],
      pollerLag: pollerLag(
        rule,
        artifacts.sourceApp.capabilities.defaultPollInterval,
        now,
        this.#staleMultiplier,
      ),
      pollScopeMode: scopeMode,
    };
  }

  async #enablementInput(
    artifacts: RuleArtifacts,
    backfillSkipped: boolean,
  ): Promise<EnablementInput> {
    return {
      rule: artifacts.rule,
      fieldMappings: artifacts.fieldMappings,
      operationMappings: artifacts.operationMappings,
      sourceBinding: artifacts.sourceBinding,
      targetBinding: artifacts.targetBinding,
      sourceCapabilities: artifacts.sourceApp.capabilities,
      targetCapabilities: artifacts.targetApp.capabilities,
      backfillSkipped,
      requiredScopeBindings: computeRequiredScopeBindings(artifacts, { backfillSkipped }),
      // SS-15.1/15.2 — the mode-aware `scope-link` preconditions (undefined for a non-scoped rule).
      scopeLinkGate: await computeScopeLinkGate(artifacts, {
        correspondences: this.#scopeCorrespondences,
        scopeLinks: this.#sync.scopeLinks,
        repos: this.#repos,
      }),
    };
  }

  async #resourcePairRefOf(
    ruleId: string,
    cache: Map<string, string | undefined>,
  ): Promise<string | undefined> {
    if (cache.has(ruleId)) {
      return cache.get(ruleId);
    }
    const rule = await this.#syncRules.getById(ruleId);
    const ref = rule?.resourcePairRef;
    cache.set(ruleId, ref);
    return ref;
  }

  /**
   * Build the OA-3 attribution audit row: `type = sync-execution`, `actor` = the
   * authenticated identity, the rule/mapping/link/record context, and a metadata-only
   * `details` note. `status` is left unset (an operator action is not a processed sync
   * change). Trace context is stamped when available. No secret or payload value.
   */
  #attribution(
    actor: string,
    details: string,
    refs: {
      readonly relatedRuleId?: string;
      readonly relatedMappingId?: string;
      readonly recordLinkId?: string;
      readonly sourceNativeId?: string;
      readonly originAppId?: string;
    },
  ): AuditLogEntry {
    const trace = this.#readTraceContext();
    return stripUndefined({
      id: this.#newId(),
      type: "sync-execution" as const,
      actor,
      details,
      relatedRuleId: refs.relatedRuleId,
      relatedMappingId: refs.relatedMappingId,
      recordLinkId: refs.recordLinkId,
      sourceNativeId: refs.sourceNativeId,
      originAppId: refs.originAppId,
      traceId: trace?.traceId,
      spanId: trace?.spanId,
      timestamp: this.#clock(),
    });
  }
}

// ── pure helpers ───────────────────────────────────────────────────────────────

/**
 * The source-side native id of a linked record for the rule's direction — the fallback
 * when a parked row somehow carries none (the handler always records `sourceNativeId`,
 * so this is defensive). The link is canonical A/B; the source is whichever side is the
 * mapping's `sourceAppId`.
 */
function sourceNativeIdOfLink(link: RecordLink, artifacts: RuleArtifacts): string {
  return link.appAId === artifacts.mapping.sourceAppId ? link.appANativeId : link.appBNativeId;
}

/**
 * Read a single **id/ref** field out of a parked write's serialized `DetectedChange`
 * payload for the OA-3 attribution row — a string field or `undefined`. Reads only the
 * named scalar key, never a nested value, so the data boundary holds (SA-5).
 */
function readPayloadId(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key];
  return typeof value === "string" ? value : undefined;
}

/** Build the `SyncRuleConfigPatch` from the config payload, preserving null-vs-absent. */
function configPatch(config: SyncRuleConfig): SyncRuleConfigPatch {
  return {
    ...("pollIntervalOverride" in config
      ? { pollIntervalOverride: config.pollIntervalOverride ?? null }
      : {}),
    ...(config.pollOperationRef !== undefined ? { pollOperationRef: config.pollOperationRef } : {}),
    ...(config.deletePropagation !== undefined
      ? { deletePropagation: config.deletePropagation }
      : {}),
    ...(config.targetDriftCheck !== undefined ? { targetDriftCheck: config.targetDriftCheck } : {}),
    // SS-13.5 — `in` preserves null-vs-absent so `null` clears the override to derived.
    ...("pollScopeMode" in config ? { pollScopeMode: config.pollScopeMode ?? null } : {}),
  };
}

/**
 * Poller lag (SA-2.2): `lagMs` = now − `lastRunAt`; `expectedIntervalMs` =
 * `pollIntervalOverride` else the source app's `defaultPollInterval`; `stuck` =
 * an `enabled` rule whose lag exceeds `staleMultiplier ×` the expected interval.
 */
function pollerLag(
  rule: SyncRule,
  sourceDefaultPollInterval: number | null,
  now: Date,
  staleMultiplier: number,
): PollerLagView {
  const expectedIntervalMs = rule.pollIntervalOverride ?? sourceDefaultPollInterval ?? null;
  const lastRunAt = rule.lastRunAt ?? null;
  const lagMs = lastRunAt !== null ? now.getTime() - lastRunAt.getTime() : null;
  const stuck =
    rule.status === "enabled" &&
    lagMs !== null &&
    expectedIntervalMs !== null &&
    lagMs > staleMultiplier * expectedIntervalMs;
  return { lastRunAt, expectedIntervalMs, lagMs, stuck };
}

/**
 * Parse the candidate target native ids out of an ambiguous-match `failure` event's
 * `details` (`docs/architecture/sync-engine.md` RL-4 — the only place the engine
 * persists them): `"ambiguous identity match: N candidates [id1, id2, …]"`. Returns
 * `[]` when the bracket is absent/empty.
 */
function parseCandidateNativeIds(details: string): string[] {
  const match = /\[(.*)\]\s*$/.exec(details);
  const inner = match?.[1]?.trim();
  if (inner === undefined || inner === "") {
    return [];
  }
  return inner
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id !== "");
}
