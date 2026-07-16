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
import { resolveRuleArtifacts, type RuleArtifactRepos } from "./resolution.js";
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

  // ── For the composition root: register on the SHARED reconciliation sweep ────
  readonly reconciler: SyncExecutionReconciler;

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
    contextLoader: new RepoSyncPipelineContextLoader(ruleArtifactRepos),
    events: syncEventStore,
    parkedConflicts,
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
    new RepoPollPlanResolver(ruleArtifactRepos),
    new DbPollStateStore(db),
    orderingQueue,
    new QueueKeyResolver(recordLinks),
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
    );
    if (!resolved.ok) {
      logger.error({ ruleId, reason: resolved.reason }, "backfill retrigger: rule did not resolve");
      return;
    }
    await runBracketedEnable(ruleId, resolved.input);
  };

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
    readSourceRecord,
    poller,
    scheduler,
    queueDispatcher,
    inFlightRegistry,
    reconciler,
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
