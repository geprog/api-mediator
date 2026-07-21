import type { AppConfig } from "@mediator/config";
import {
  CredentialStore,
  DbCredentialAccessAuditor,
  DbCredentialPersistence,
  EnvKeyProvider,
  type CredentialStoreLogger,
} from "@mediator/credentials";
import {
  ApiSpecRepository,
  ApprovedMappingRepository,
  AuditLogRepository,
  DownstreamArtifactRepository,
  MappingArtifactsRepository,
  OrderingQueueRepository,
  ParkedConflictRepository,
  RecordLinkRepository,
  RegisteredAppRepository,
  ResourceBindingRepository,
  ScopeCorrespondenceRepository,
  ScopeLinkRepository,
  SyncFieldStateRepository,
  SyncRuleRepository,
  type Database,
} from "@mediator/db";
import {
  AppLoadGovernor,
  BackfillRunner,
  DbSyncEventStore,
  FetchRestProtocolClient,
  InMemoryBackfillInFlightRegistry,
  OutboundCallExecutor,
  RepoRestSourceBindingResolver,
  RepoSingleRecordReadResolver,
  RestSingleRecordTargetReader,
  RestSourceReader,
  RuleEnabler,
  SyncExecutionReconciler,
  SyncPipelineHandler,
  classifyOutboundFailure,
  resolveSingleRecordReadBinding,
  type BackfillMetrics,
  type CredentialApplier,
  type EnableRuleResult,
  type ProtocolClient,
} from "@mediator/outbound";
import {
  ConflictDetectionStage,
  IdentityMatchSeeder,
  IdentityResolutionStage,
  LoopPreventionStage,
  OrderingQueueDispatcher,
  Poller,
  QueueKeyResolver,
  Scheduler,
  ScopeDiscoveryStage,
  TtlRecentlyWrittenCache,
  DbPollStateStore,
  evaluateEnablement,
  type EnablementDegradation,
  type EnablementRequirement,
  type PollRunOutcome,
  type RecentlyWrittenCache,
  type SingleRecordReadResult,
} from "@mediator/sync-engine";
import { getActiveTraceContext } from "@mediator/telemetry";
import { applyFieldMappings } from "@mediator/transform";
import type { FastifyBaseLogger } from "fastify";

import { RepoCounterpartBackfillModeLookup } from "./counterpart-backfill-mode.js";
import { createCredentialApplier } from "./credential-applier.js";
import { resolveEnableRuleInput } from "./enable-resolver.js";
import { RepoPollPlanResolver } from "./poll-plan-resolver.js";
import { RepoSyncPipelineContextLoader } from "./pipeline-context-loader.js";
import { RepoContainerParkSink, RepoPreLinkScopeResolver } from "./pre-link-scope.js";
import { resolveRuleArtifacts, type RuleArtifactRepos } from "./resolution.js";
import {
  RepoContainerParkReader,
  RepoScopeContainerEnumerator,
  ScopeDiscoveryService,
} from "./scope-discovery.js";
import {
  InMemoryScopeDiscoveryInFlightRegistry,
  RepoScopeDiscoveryReadiness,
  ScopeDiscoveryReconciler,
} from "./scope-discovery-reconciler.js";
import {
  RepoTargetCollectionReadResolver,
  RestTargetIdentityLookup,
} from "./target-identity-lookup.js";

/**
 * **The Phase-4 sync-engine runtime composition** (`buildSyncBackground`) — the wiring
 * that finally turns the merged engine pieces into a running system: the
 * Scheduler/Poller change-detection loop, the ordering-queue dispatcher running the
 * per-record pipeline handler (RL/EP/CF/TX/OC) over the real Outbound Call Executor +
 * REST Protocol Client + `withCredential` credential path, and the enable/backfill flow
 * with the RS in-flight registry + the sync-execution reconciler.
 *
 * It follows the existing background-module pattern (`detection/background.ts`): explicit
 * constructor wiring (no DI framework), `unref`'d poll loops, and deterministic
 * `runOnce()`/`tick()`/`pollOnce()` hooks so tests drive the loop without the wall clock.
 * It stands up **no** second `OutboxDispatcher`/`ReconciliationSweep`: it returns its
 * {@link SyncExecutionReconciler} for the composition root to register on the single
 * shared sweep (`buildDetectionBackground`'s `additionalReconcilers`).
 *
 * ## The in-flight bracket (RS)
 *
 * Every enable/backfill run — the operator's enable, and the reconciler's re-trigger —
 * is bracketed on the shared {@link InMemoryBackfillInFlightRegistry}: `markInFlight`
 * **before** the rule's `enabled`+`running` status is persisted (the `RuleEnabler` flips
 * it), and `clear` in a `finally` **after** the terminal (`completed`/`skipped`/`aborted`)
 * status flip commits. That bracket is exactly what lets the reconciler distinguish a
 * live backfill (in flight) from a crash-orphaned one (persisted `running`, not in flight).
 *
 * ## enableRule: synchronous gate, background backfill
 *
 * `enableRule` runs the enablement gate **synchronously** (returns `blocked` +
 * `stillNeeds`, or `accepted`) so an HTTP handler answers immediately, and runs the
 * long backfill **in the background** (in-flight-bracketed). The returned `backfill`
 * promise lets a test — and graceful `stop()` — await the run without the HTTP path
 * blocking on it.
 */

// ── Public surface ─────────────────────────────────────────────────────────────

export interface SyncBackgroundDeps {
  readonly db: Database;
  readonly config: AppConfig;
  readonly logger: FastifyBaseLogger;
  /**
   * Override the Protocol Client. Production omits it (a real {@link FetchRestProtocolClient});
   * the integration test passes a fake standing in for the two external apps.
   */
  readonly protocolClient?: ProtocolClient;
  /** Override how a decrypted secret becomes request auth (default {@link createCredentialApplier}). */
  readonly credentialApplier?: CredentialApplier;
  /** How often the schedule loop ticks, in ms (default {@link DEFAULT_SCHEDULE_INTERVAL_MS}). */
  readonly scheduleIntervalMs?: number;
  /**
   * Override the EP-2 recently-written cache (default a live {@link TtlRecentlyWrittenCache}).
   * Correctness never depends on it; a test injects a `NullRecentlyWrittenCache` to prove
   * the cache-independent EP-1 durable-baseline echo path end to end.
   */
  readonly recentlyWrittenCache?: RecentlyWrittenCache;
}

/** The verdict of the synchronous half of {@link SyncBackground.enableRule}. */
export type EnableRuleGateResult =
  | { readonly kind: "unresolved"; readonly reason: string }
  | { readonly kind: "blocked"; readonly stillNeeds: readonly EnablementRequirement[] }
  | {
      readonly kind: "accepted";
      readonly backfillRequired: boolean;
      readonly degradations: readonly EnablementDegradation[];
      /** The in-flight-bracketed background enable/backfill run (await for determinism / graceful stop). */
      readonly backfill: Promise<EnableRuleResult>;
    };

export interface SyncBackground {
  // ── Composition seams the SA-api slice's HTTP handlers call ──────────────────
  /**
   * The enable action (BE-3): resolve + gate synchronously, then run the backfill in the
   * background (in-flight-bracketed). Returns the gate verdict immediately.
   */
  enableRule(
    ruleId: string,
    options?: { readonly backfillSkipped?: boolean },
  ): Promise<EnableRuleGateResult>;
  /** Disable a rule: stop polling (status → `disabled`); retain cursor/snapshot/links/field-state — never reset. */
  disableRule(ruleId: string): Promise<void>;
  /** The deterministic poll trigger (SP-5): one poll cycle for a rule (detect → enqueue → advance). */
  pollOnce(ruleId: string): Promise<PollRunOutcome>;

  // ── Deterministic hooks (tests drive the loop without the wall clock) ────────
  /** One scheduler tick: evaluate every candidate rule and poll each due one. */
  runScheduleOnce(): Promise<void>;
  /** One ordering-queue worker tick: claim + run the pipeline handler on one entry, settle it. */
  runQueueOnce(): Promise<void>;
  /** Await every in-flight background enable/backfill run (determinism + graceful shutdown). */
  awaitBackfills(): Promise<void>;

  // ── Stores / queue seams the link / resolve / replay / read handlers use ─────
  readonly identityResolution: IdentityResolutionStage;
  readonly recordLinks: RecordLinkRepository;
  readonly syncFieldState: SyncFieldStateRepository;
  readonly orderingQueue: OrderingQueueRepository;
  /** SA-4 — the structured parked-conflict store (the operator queue + resolution reads/writes). */
  readonly parkedConflicts: ParkedConflictRepository;
  /** SS-11 — the scope-discovery service (constant/manual container link + enablement/harvest/on-demand). */
  readonly scopeDiscovery: ScopeDiscoveryService;
  /** SS-11 — the `ScopeLink` store (the parked-container-link queue's drop-resolved lookup). */
  readonly scopeLinks: ScopeLinkRepository;
  /**
   * SA-4.2 — read the CURRENT source record for a resolution re-run (a single-record
   * read of the rule's source, obeying the same OC-3 load discipline as any read). The
   * re-run enqueues this as the change's `observedRecord`, so the source-wins value
   * that propagates is the source's live value — against current state, never a stored
   * park-time value. `{ found: false }` when the source record is gone (e.g. it was
   * deleted since the park).
   */
  readSourceRecord(ruleId: string, sourceNativeId: string): Promise<SingleRecordReadResult>;
  readonly poller: Poller;
  readonly scheduler: Scheduler;
  readonly queueDispatcher: OrderingQueueDispatcher;
  /** The RS in-flight registry (shared with the reconciler) — exposed for observability/tests. */
  readonly inFlightRegistry: InMemoryBackfillInFlightRegistry;
  /**
   * The shared per-app load governor (OC-3). Exposed so the Phase-5 Adapter Engine's
   * backend calls go through the **same** instance — adapter fan-out and sync
   * polling/backfill then compete for one per-app ceiling, adapter traffic not exempt
   * (`docs/requirements/phase-5-transform-execution.md` TE-2.4).
   */
  readonly loadGovernor: AppLoadGovernor;

  // ── For the composition root: register on the SHARED reconciliation sweep ────
  readonly reconciler: SyncExecutionReconciler;
  /** SS-11.7 — the scope-discovery sweep re-trigger (registered on the same shared sweep). */
  readonly scopeDiscoveryReconciler: ScopeDiscoveryReconciler;

  // ── Lifecycle ────────────────────────────────────────────────────────────────
  /** Start the ordering-queue dispatcher and the `unref`'d schedule loop. */
  start(): void;
  /** Stop the loops (an in-flight poll / queue pass / backfill is allowed to finish). */
  stop(): Promise<void>;
}

/** How often the schedule loop ticks by default (the per-rule interval is the real cadence). */
export const DEFAULT_SCHEDULE_INTERVAL_MS = 1_000;
/** The recently-written cache TTL (EP-2 fast path; correctness never depends on it). */
const RECENTLY_WRITTEN_TTL_MS = 5 * 60 * 1000;

const NO_OP_BACKFILL_METRICS: BackfillMetrics = {
  recordProgress: (): void => {},
  recordDuration: (): void => {},
};

export function buildSyncBackground(deps: SyncBackgroundDeps): SyncBackground {
  const { db, config, logger } = deps;
  const scheduleIntervalMs = deps.scheduleIntervalMs ?? DEFAULT_SCHEDULE_INTERVAL_MS;

  // ── Repositories (pooled db) ───────────────────────────────────────────────
  const syncRules = new SyncRuleRepository(db);
  const approvedMappings = new ApprovedMappingRepository(db);
  const mappingArtifacts = new MappingArtifactsRepository(db);
  const apiSpecs = new ApiSpecRepository(db);
  const resourceBindings = new ResourceBindingRepository(db);
  const registeredApps = new RegisteredAppRepository(db);
  const recordLinks = new RecordLinkRepository(db);
  const syncFieldState = new SyncFieldStateRepository(db);
  const auditLog = new AuditLogRepository(db);
  const orderingQueue = new OrderingQueueRepository(db);
  const parkedConflicts = new ParkedConflictRepository(db);
  const downstreamArtifacts = new DownstreamArtifactRepository(db);

  const ruleArtifactRepos: RuleArtifactRepos = {
    syncRules,
    approvedMappings,
    mappingArtifacts,
    apiSpecs,
    resourceBindings,
    registeredApps,
  };

  // ── Credential path: withCredential over the real store (write-only, decrypt-for-use) ──
  const credentialLogger: CredentialStoreLogger = {
    info: (message, fields) => {
      logger.info(fields, message);
    },
  };
  const credentialStore = new CredentialStore(
    new DbCredentialPersistence(db),
    new EnvKeyProvider(config.credentials.masterKey),
    credentialLogger,
    { auditor: new DbCredentialAccessAuditor(db), readTraceContext: getActiveTraceContext },
  );
  const applyCredential = deps.credentialApplier ?? createCredentialApplier();

  // ── Shared outbound primitives (OC-3: ALL traffic to an app shares ONE governor) ──
  const protocol: ProtocolClient = deps.protocolClient ?? new FetchRestProtocolClient();
  const governor = new AppLoadGovernor();
  const syncEventStore = new DbSyncEventStore(auditLog);
  const executor = new OutboundCallExecutor(protocol, credentialStore, syncEventStore, governor, {
    applyCredential,
  });

  // ── Binding resolvers + REST readers (IR + confirmed refs → wire shapes) ─────
  const bindingResolverRepos = {
    syncRules,
    approvedMappings,
    apiSpecs,
    resourceBindings,
    registeredApps,
  };
  const sourceBindingResolver = new RepoRestSourceBindingResolver(bindingResolverRepos);
  const sourceReader = new RestSourceReader(
    sourceBindingResolver,
    protocol,
    credentialStore,
    governor,
    {
      applyCredential,
    },
  );
  const singleRecordReader = new RestSingleRecordTargetReader(
    new RepoSingleRecordReadResolver(apiSpecs, registeredApps, resourceBindings),
    protocol,
    credentialStore,
    governor,
    { applyCredential },
  );
  const targetIdentityLookup = new RestTargetIdentityLookup(
    new RepoTargetCollectionReadResolver({ apiSpecs, resourceBindings, registeredApps }),
    protocol,
    credentialStore,
    governor,
    { applyCredential },
  );

  // ── SS-11 scope discovery: establish `ScopeLink`s (constant / identity-match / manual) ──
  // Reads only (container enumeration via the shared identity-lookup reader) + link
  // persistence; it NEVER writes to either app (SS-11.8).
  const scopeLinks = new ScopeLinkRepository(db);
  const scopeCorrespondences = new ScopeCorrespondenceRepository(db);
  // SS-11.7 — dedup a container park across sweeps/polls (reuse an open park's event id
  // rather than minting a new `failure` event every pass); shared by the discovery stage
  // and the SS-14.3 poller container-park sink.
  const containerParkReader = new RepoContainerParkReader(auditLog, scopeLinks);
  const scopeDiscoveryStage = new ScopeDiscoveryStage({
    links: scopeLinks,
    events: syncEventStore,
    parkReader: containerParkReader,
  });
  const scopeDiscovery = new ScopeDiscoveryService({
    stage: scopeDiscoveryStage,
    links: scopeLinks,
    enumerator: new RepoScopeContainerEnumerator(
      { apiSpecs, resourceBindings, registeredApps },
      targetIdentityLookup,
    ),
    correspondences: scopeCorrespondences,
    repos: { apiSpecs, resourceBindings, registeredApps },
  });

  // ── Pipeline stages (real repos; the SAME syncFieldState instance the handler holds) ──
  const seeder = new IdentityMatchSeeder(syncFieldState);
  const identityResolution = new IdentityResolutionStage({
    links: recordLinks,
    seeder,
    lookup: targetIdentityLookup,
    events: syncEventStore,
  });
  const loopPrevention = new LoopPreventionStage({
    fieldState: syncFieldState,
    events: syncEventStore,
    cache: deps.recentlyWrittenCache ?? new TtlRecentlyWrittenCache(RECENTLY_WRITTEN_TTL_MS),
  });
  const conflictDetection = new ConflictDetectionStage({
    fieldState: syncFieldState,
    events: syncEventStore,
    targetReader: singleRecordReader,
  });

  // ── The pipeline handler + the ordering-queue dispatcher/worker ──────────────
  const pipelineHandler = new SyncPipelineHandler({
    identityResolution,
    loopPrevention,
    conflictDetection,
    transform: applyFieldMappings,
    outbound: executor,
    fieldState: syncFieldState,
    contextLoader: new RepoSyncPipelineContextLoader(ruleArtifactRepos, scopeLinks),
    events: syncEventStore,
    parkedConflicts,
    // SS-12 — the ScopeLink read port a linked delete/update fills its container from
    // (via the record's stored RecordLink.scopeRef).
    scopeLinks,
  });
  const queueDispatcher = new OrderingQueueDispatcher(orderingQueue, pipelineHandler.handle, {
    // OC-4: park a transform/permanent failure immediately, defer a throttle, retry-then-park the rest.
    classifyFailure: classifyOutboundFailure,
    onError: (error) => {
      logger.error({ err: describeError(error) }, "ordering-queue dispatcher pass failed");
    },
  });

  // ── Poller + Scheduler (change detection) ────────────────────────────────────
  const poller = new Poller(
    sourceReader,
    // SS-13 — the resolver derives the poll-enumeration mode (+ honors the operator
    // override) and, for a per-scope rule, resolves its scope set from the pair's
    // ScopeCorrespondence + established ScopeLinks.
    new RepoPollPlanResolver(
      ruleArtifactRepos,
      {
        scopeCorrespondences: scopeCorrespondences,
        scopeLinks,
      },
      // SS-17.1 — the SS-11 discovery service drives the poll-time live container re-list
      // for a per-scope-enumerated rule (the "enumerate scopes" step of the poll, riding
      // the existing per-rule cadence — SS-17.2, NOT a second scheduler; the sweep is
      // untouched). The re-list REUSES the SS-11 establishment pass, never a fork.
      scopeDiscovery,
    ),
    new DbPollStateStore(db),
    orderingQueue,
    // SS-14.2/14.3 — for a scoped rule the pre-link ordering-queue key is scope-qualified via
    // the shared ScopeLink (resolved from the captured scope), so both directions compute the
    // same key and different containers never collide; an unresolved container is parked.
    new QueueKeyResolver(recordLinks, new RepoPreLinkScopeResolver(scopeLinks)),
    {
      // SS-14.3 — an unresolved-container record is parked BEFORE enqueue onto the SS-11.5
      // parked-container surface (never enqueued under a guessed / un-scoped key).
      containerPark: new RepoContainerParkSink(syncEventStore, containerParkReader),
    },
  );
  const scheduler = new Scheduler(syncRules, poller, {
    onError: (error) => {
      logger.error({ err: describeError(error) }, "sync scheduler tick failed");
    },
  });

  // ── Enable / backfill flow + the RS in-flight registry ───────────────────────
  const inFlightRegistry = new InMemoryBackfillInFlightRegistry();
  const backfillRunner = new BackfillRunner({
    sourceReader,
    identityResolution,
    seeder,
    fieldState: syncFieldState,
    lookup: targetIdentityLookup,
    loopPrevention,
    outbound: executor,
    transform: applyFieldMappings,
    events: syncEventStore,
    metrics: NO_OP_BACKFILL_METRICS,
  });
  const ruleEnabler = new RuleEnabler({
    rules: syncRules,
    pollState: new DbPollStateStore(db),
    backfillRunner,
    sourceReader,
    counterpart: new RepoCounterpartBackfillModeLookup({
      syncRules,
      approvedMappings,
      rulesByMapping: downstreamArtifacts,
    }),
  });

  // ── Background-run tracking (graceful shutdown awaits every in-flight enable) ─
  const activeBackfills = new Set<Promise<unknown>>();

  // ── SS-11 scope discovery: the enablement-time pass + the sweep re-trigger ─────
  const scopeDiscoveryInFlight = new InMemoryScopeDiscoveryInFlightRegistry();
  /**
   * Run the enablement-time container-discovery pass for a pair (SS-11.2), bracketed
   * in-flight so the sweep can tell a live pass from a crash-orphaned one (SS-11.7). A
   * non-scoped / not-confirmed / source-not-enumerable pair is a cheap no-op-with-reason;
   * the pass is idempotent + reads only (never writes to either app — SS-11.8). Best-effort:
   * a failure degrades timeliness (the sweep re-triggers), never the enable.
   */
  const runDiscoveryPass = async (resourcePairRef: string): Promise<void> => {
    scopeDiscoveryInFlight.markInFlight(resourcePairRef);
    try {
      const outcome = await scopeDiscovery.runEnablementDiscoveryPass(resourcePairRef);
      if (outcome.kind === "incomplete-fetch") {
        logger.warn(
          { resourcePairRef, side: outcome.side },
          "scope discovery pass aborted on a partial container fetch (will retry on the sweep)",
        );
      }
    } catch (error) {
      logger.error(
        { resourcePairRef, err: describeError(error) },
        "scope discovery pass failed (will retry on the sweep)",
      );
    } finally {
      scopeDiscoveryInFlight.clear(resourcePairRef);
    }
  };

  /**
   * The in-flight bracket (RS): `markInFlight` BEFORE the enable action flips the rule
   * `enabled`+`running`, `clear` in a `finally` AFTER the terminal status flip commits.
   * Tracked so graceful `stop()` awaits it, and its rejection is HANDLED (never floated)
   * so a transient DB fault mid-enable degrades timeliness, not the process.
   */
  const runBracketedEnable = (
    ruleId: string,
    input: Parameters<RuleEnabler["enable"]>[0],
  ): Promise<EnableRuleResult> => {
    inFlightRegistry.markInFlight(ruleId);
    const run = (async (): Promise<EnableRuleResult> => {
      try {
        // SS-11.2 — the container-level link-only discovery pass runs at enablement
        // BEFORE the record backfill seeds, so a both-enumerable pair's `ScopeLink`s are
        // established before records route through them (a no-op for a non-scoped rule).
        await runDiscoveryPass(input.enablement.rule.resourcePairRef);
        return await ruleEnabler.enable(input);
      } finally {
        inFlightRegistry.clear(ruleId);
      }
    })();
    return trackBackgroundRun(run, activeBackfills, (error) => {
      logger.error({ ruleId, err: describeError(error) }, "sync enable/backfill run failed");
    });
  };

  const enableRule = async (
    ruleId: string,
    options: { readonly backfillSkipped?: boolean } = {},
  ): Promise<EnableRuleGateResult> => {
    const resolved = await resolveEnableRuleInput(
      ruleId,
      { backfillSkipped: options.backfillSkipped ?? false },
      ruleArtifactRepos,
      scopeLinks,
      scopeCorrespondences,
      // SS-17.4 — drives the SS-17.1 live re-list for a per-scope-enumerated rule's backfill
      // fan-out (per-scope-pinned fans out with no re-list; cross-scope attaches none).
      scopeDiscovery,
    );
    if (!resolved.ok) {
      return { kind: "unresolved", reason: resolved.reason };
    }
    // BE-1/BE-2 — the gate runs synchronously so the HTTP handler answers immediately.
    const decision = evaluateEnablement(resolved.input.enablement);
    if (decision.kind === "blocked") {
      return { kind: "blocked", stillNeeds: decision.stillNeeds };
    }
    // Accepted — run the status flips + backfill + go-live seed in the background.
    const backfill = runBracketedEnable(ruleId, resolved.input);
    return {
      kind: "accepted",
      backfillRequired: decision.backfillRequired,
      degradations: decision.degradations,
      backfill,
    };
  };

  const retriggerBackfill = async (ruleId: string): Promise<void> => {
    // RS-1.2 — re-run the crash-orphaned backfill through the same in-flight-bracketed
    // path; backfill is idempotent (echo checks + idempotency keys absorb the re-run).
    const resolved = await resolveEnableRuleInput(
      ruleId,
      { backfillSkipped: false },
      ruleArtifactRepos,
      scopeLinks,
      scopeCorrespondences,
      // SS-17.4 — same fan-out scope-set resolution as the operator enable path.
      scopeDiscovery,
    );
    if (!resolved.ok) {
      logger.error({ ruleId, reason: resolved.reason }, "backfill retrigger: rule did not resolve");
      return;
    }
    await runBracketedEnable(ruleId, resolved.input);
  };

  // SS-11.7 — the sweep re-trigger for a lost/crashed enablement discovery pass. NOT a
  // second scheduler: it registers on the SHARED reconciliation sweep (like the backfill
  // reconciler) and re-triggers the idempotent pass only for a scoped, confirmed pair
  // with no active `ScopeLink` yet and no pass in flight.
  const scopeDiscoveryReconciler = new ScopeDiscoveryReconciler({
    rules: syncRules,
    retrigger: { retriggerDiscovery: runDiscoveryPass },
    inFlight: scopeDiscoveryInFlight,
    readiness: new RepoScopeDiscoveryReadiness({
      correspondences: scopeCorrespondences,
      links: scopeLinks,
    }),
  });

  const reconciler = new SyncExecutionReconciler({
    rules: syncRules,
    retrigger: { retriggerBackfill },
    inFlight: inFlightRegistry,
  });

  const disableRule = async (ruleId: string): Promise<void> => {
    // Stop polling only — the Scheduler's `listPollCandidates` excludes a disabled rule.
    // Cursor / snapshot / RecordLinks / SyncFieldState are deliberately retained.
    await syncRules.applyEnableTransition(ruleId, { status: "disabled" });
  };

  /**
   * SA-4.2 — read the CURRENT source record for a resolution re-run via a single-record
   * source read (the same `RestSingleRecordTargetReader` used for CF's target reads,
   * pointed at the rule's source app), so it obeys the same `withCredential` + OC-3
   * load-governor discipline as any other read. The re-run enqueues the returned record
   * as the change's `observedRecord`, so a source-wins resolution propagates the source's
   * **live** value through the normal write path — never a stored park-time value.
   */
  const readSourceRecord = async (
    ruleId: string,
    sourceNativeId: string,
  ): Promise<SingleRecordReadResult> => {
    const artifacts = await resolveRuleArtifacts(ruleId, ruleArtifactRepos);
    if (artifacts === undefined) {
      throw new Error(
        `sync resolution: rule ${ruleId} did not resolve to executable mapping/binding/IR state`,
      );
    }
    const binding = resolveSingleRecordReadBinding(artifacts.sourceGroup, artifacts.sourceBinding);
    if (binding === undefined) {
      throw new Error(
        `sync resolution: rule ${ruleId}'s source resource offers no confirmed single-record read — cannot re-read the source record for a field resolution`,
      );
    }
    return singleRecordReader.readRecord({
      targetAppId: artifacts.mapping.sourceAppId,
      nativeId: sourceNativeId,
      binding,
    });
  };

  // ── The `unref`'d schedule loop (mirrors detection's sweep loop) ─────────────
  let scheduleTimer: NodeJS.Timeout | undefined;
  let scheduleRunning = false;
  let currentTick: Promise<void> | undefined;

  const tickOnce = async (): Promise<void> => {
    try {
      await scheduler.tick();
    } catch (error) {
      logger.error({ err: describeError(error) }, "sync schedule loop tick failed");
    }
  };
  const scheduleNext = (): void => {
    const timer = setTimeout(() => {
      currentTick = tickOnce().finally(() => {
        currentTick = undefined;
        if (scheduleRunning) {
          scheduleNext();
        }
      });
    }, scheduleIntervalMs);
    timer.unref();
    scheduleTimer = timer;
  };

  return {
    enableRule,
    disableRule,
    pollOnce: (ruleId: string): Promise<PollRunOutcome> => poller.pollOnce(ruleId),
    runScheduleOnce: (): Promise<void> => tickOnce(),
    runQueueOnce: async (): Promise<void> => {
      await queueDispatcher.runOnce();
    },
    awaitBackfills: async (): Promise<void> => {
      await Promise.allSettled([...activeBackfills]);
    },
    identityResolution,
    recordLinks,
    syncFieldState,
    orderingQueue,
    parkedConflicts,
    scopeDiscovery,
    scopeLinks,
    readSourceRecord,
    poller,
    scheduler,
    queueDispatcher,
    inFlightRegistry,
    loadGovernor: governor,
    reconciler,
    scopeDiscoveryReconciler,
    start(): void {
      queueDispatcher.start();
      if (!scheduleRunning) {
        scheduleRunning = true;
        scheduleNext();
      }
    },
    async stop(): Promise<void> {
      scheduleRunning = false;
      if (scheduleTimer !== undefined) {
        clearTimeout(scheduleTimer);
        scheduleTimer = undefined;
      }
      // Let an in-flight schedule tick, the queue dispatcher's in-flight pass, and any
      // in-flight backfill finish (graceful).
      if (currentTick !== undefined) {
        await currentTick;
      }
      await queueDispatcher.stop();
      await Promise.allSettled([...activeBackfills]);
    },
  };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Track a background run (an in-flight enable/backfill) for graceful shutdown, with its
 * rejection **handled** so it can never float as an unhandled rejection.
 *
 * A single-instance process runs enable/backfill work off the request path; its promise
 * is added to `active` (so `stop()` can await it via `Promise.allSettled`) and gets a
 * `catch(onError)` handler attached — which both reports a transient fault (a DB error
 * mid-enable) and marks the promise **handled**, so ignoring the returned promise (an
 * HTTP handler answering `202` before the backfill finishes) does not crash the process
 * under Node's `--unhandled-rejections=throw`. The returned promise is the original run,
 * so a caller that DOES await it (a test, graceful stop) still observes the real error.
 */
export function trackBackgroundRun<T>(
  run: Promise<T>,
  active: Set<Promise<unknown>>,
  onError: (error: unknown) => void,
): Promise<T> {
  active.add(run);
  void run.catch(onError).finally(() => {
    active.delete(run);
  });
  return run;
}
