import { randomUUID } from "node:crypto";

import {
  ApiSpecRepository,
  ApprovedMappingRepository,
  AuditLogRepository,
  MappingArtifactsRepository,
  RecordLinkRepository,
  RegisteredAppRepository,
  ResourceBindingRepository,
  SyncRuleRepository,
  tx,
  type Database,
  type SyncRuleConfigPatch,
} from "@mediator/db";
import type { AuditLogEntry, ConflictPolicy, RecordLink, SyncRule } from "@mediator/domain";
import { stripUndefined } from "@mediator/domain";
import {
  evaluateEnablement,
  type EnablementDegradation,
  type EnablementInput,
  type EnablementRequirement,
  type ManualLinkParams,
} from "@mediator/sync-engine";
import { getActiveTraceContext, type ActiveTraceContext } from "@mediator/telemetry";

import { BadRequestError, NotFoundError } from "../../app-errors.js";
import type { EnableRuleGateResult } from "./background.js";
import { resolveRuleArtifacts, type RuleArtifactRepos, type RuleArtifacts } from "./resolution.js";

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
  readonly identityResolution: {
    linkManually(params: ManualLinkParams): Promise<RecordLink>;
    unlink(linkId: string): Promise<void>;
  };
  readonly recordLinks: {
    getById(id: string): Promise<RecordLink | undefined>;
  };
}

export interface SyncOperatorServiceDeps {
  readonly db: Database;
  readonly sync: SyncOperatorEngine;
  /** Poll-lag "stuck" threshold: `lagMs > staleMultiplier × expectedIntervalMs` (default 3). */
  readonly staleMultiplier?: number;
  readonly clock?: () => Date;
  readonly newId?: () => string;
  readonly readTraceContext?: () => ActiveTraceContext | null;
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

const DEFAULT_STALE_MULTIPLIER = 3;
/** Default bound for the audit-log/ambiguous-match scans — never unbounded history. */
const DEFAULT_EVENT_LIMIT = 100;
const AMBIGUOUS_DETAILS_PREFIX = "ambiguous identity match";

export class SyncOperatorService {
  readonly #db: Database;
  readonly #sync: SyncOperatorEngine;
  readonly #staleMultiplier: number;
  readonly #clock: () => Date;
  readonly #newId: () => string;
  readonly #readTraceContext: () => ActiveTraceContext | null;

  readonly #syncRules: SyncRuleRepository;
  readonly #mappingArtifacts: MappingArtifactsRepository;
  readonly #auditLog: AuditLogRepository;
  readonly #repos: RuleArtifactRepos;

  public constructor(deps: SyncOperatorServiceDeps) {
    this.#db = deps.db;
    this.#sync = deps.sync;
    this.#staleMultiplier = deps.staleMultiplier ?? DEFAULT_STALE_MULTIPLIER;
    this.#clock = deps.clock ?? ((): Date => new Date());
    this.#newId = deps.newId ?? ((): string => randomUUID());
    this.#readTraceContext = deps.readTraceContext ?? getActiveTraceContext;

    this.#syncRules = new SyncRuleRepository(deps.db);
    this.#mappingArtifacts = new MappingArtifactsRepository(deps.db);
    this.#auditLog = new AuditLogRepository(deps.db);
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
      views.push(this.#viewFor(rule, artifacts, now));
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
    const decision = evaluateEnablement(this.#enablementInput(artifacts, backfillSkipped));
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
    return this.#reload(ruleId);
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
   */
  public async listAmbiguousMatches(limit = DEFAULT_EVENT_LIMIT): Promise<AmbiguousMatchView[]> {
    const events = await this.#auditLog.querySyncEvents({ status: "failure", limit });
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
    return this.#viewFor(rule, artifacts, this.#clock());
  }

  #viewFor(rule: SyncRule, artifacts: RuleArtifacts | undefined, now: Date): SyncRuleView {
    if (artifacts === undefined) {
      return {
        rule,
        resourcePair: undefined,
        stillNeeds: [],
        pollerLag: pollerLag(rule, null, now, this.#staleMultiplier),
      };
    }
    const decision = evaluateEnablement(this.#enablementInput(artifacts, false));
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
    };
  }

  #enablementInput(artifacts: RuleArtifacts, backfillSkipped: boolean): EnablementInput {
    return {
      rule: artifacts.rule,
      fieldMappings: artifacts.fieldMappings,
      operationMappings: artifacts.operationMappings,
      sourceBinding: artifacts.sourceBinding,
      targetBinding: artifacts.targetBinding,
      sourceCapabilities: artifacts.sourceApp.capabilities,
      targetCapabilities: artifacts.targetApp.capabilities,
      backfillSkipped,
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
