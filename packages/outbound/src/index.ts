/**
 * `@mediator/outbound` — the **Outbound Call Executor** and the REST **Protocol
 * Client** (Phase 4, OC-1..OC-5 criteria in scope). The single choke point through
 * which all outbound sync traffic passes: the deterministic idempotency key (OC-2),
 * per-app load discipline (OC-3), authenticated REST calls inside a `withCredential`
 * scope through the named Protocol Client seam (OC-1), retry/park routing (OC-4, via
 * the ordering queue), and one `SyncEvent` per resolved call (OC-5 crit 1 & 4).
 * Shared with the Adapter Engine (Phase 5); Phase 4 stands it up for sync.
 *
 * Security invariants realized here: credential material is used only inside
 * `withCredential` and never logged/returned/audited; no live payload value reaches
 * a log, a `SyncEvent`, an error, or an LLM — only hashes/ids/status/short notes.
 */

// The Protocol Client seam + its REST request/response + operation-binding shapes.
export type {
  HttpMethod,
  OutboundRequest,
  OutboundResponse,
  ParameterLocation,
  ProtocolClient,
  RestOperationBinding,
} from "./protocol-client.js";

// The REST implementation of the Protocol Client seam (OC-1).
export {
  FetchRestProtocolClient,
  OutboundTransportError,
  type FetchRestProtocolClientOptions,
  type HttpFetch,
  type HttpFetchInit,
  type HttpFetchResponse,
} from "./rest-protocol-client.js";

// The deterministic idempotency key + payload hash (OC-2).
export {
  canonicalJson,
  computeDeleteIdempotencyKey,
  computePayloadHash,
  computeWriteIdempotencyKey,
  type DeleteKeyInput,
  type PriorReconciledState,
  type WriteKeyInput,
} from "./idempotency.js";

// Per-app load discipline (OC-3).
export {
  AppLoadGovernor,
  type AcquireResult,
  type AppLoadGovernorOptions,
} from "./load-governor.js";

// The REST source reader — the Sync Engine's SourceReader seam, obeying the same OC-3
// per-app ceilings as writes (SP-2 criterion 4). Lives here (not in @mediator/sync-engine)
// because outbound already depends on sync-engine; the reverse would be a cycle.
export {
  RestSourceReader,
  type RestDeltaConvention,
  type RestDeletionConvention,
  type RestPaginationConvention,
  type RestSourceBindingResolver,
  type RestSourceReadBinding,
  type RestSourceReaderOptions,
} from "./rest-source-reader.js";

// The SyncEvent store port + real + fake (OC-2 lookback / OC-5 write).
export { DbSyncEventStore, FakeSyncEventStore, type SyncEventStore } from "./sync-event-store.js";

// The Sync-Engine binding resolvers — IR + confirmed ResourceBinding refs + SyncRule/
// OperationMapping state → the concrete REST wire shapes (source-read binding, write-op
// binding, single-record read binding) the Poller / pipeline handler / Conflict
// Detection consume. The composition seam every Phase-4 slice deferred; never
// fabricates a binding from an unconfirmed ref (docs/architecture/data-model.md
// ResourceBinding: "an unconfirmed ref is used nowhere").
export {
  findMappedTargetOperation,
  RepoRestSourceBindingResolver,
  RepoSingleRecordReadResolver,
  resolveSingleRecordRead,
  resolveSingleRecordReadBinding,
  resolveSourcePollOperation,
  resolveSourceReadBinding,
  resolveWriteOperationBinding,
  writeRecordIdPathParam,
  type ApiSpecReader,
  type ApprovedMappingReader,
  type BindingResolverOptions,
  type BindingResolverRepositories,
  type OperationMappingReader,
  type RegisteredAppReader,
  type ResolvedSingleRecordRead,
  type ResourceBindingReader,
  type SingleRecordReadBinding,
  type SingleRecordReadResolver,
  type SourceReadBindingInput,
  type SyncRuleReader,
  type WriteOperationScopeOptions,
} from "./binding-resolvers.js";

// SS-12 — the write-side `scope-link` (Layer 3) container resolution: fill a target scope
// parameter from the record's resolved `ScopeLink` (create → captured scope→link; linked
// delete/update → the stored `RecordLink.scopeRef`), parking (ContainerUnresolvedError) on
// an absent/unresolvable/unsafe container rather than fabricating one.
export {
  containerScopeParamNames,
  fillContainerScopeParams,
  resolveScopeLinkScopeValues,
  resolveScopeRefFillValues,
  targetScopeKeyOf,
  type ScopeLinkReader,
} from "./container-scope.js";

// Scope path-parameter substitution (SS-4) + the backstop: fill a scoped operation's
// non-record-id path params from confirmed `constant` bindings; detect an unfilled `{…}`
// before it reaches the wire.
export {
  fillScopePathParameters,
  findUnfilledPathParam,
  hasConfirmedScopeLinkBinding,
  perScopeDeferredParamNames,
  scopeParamNamesOf,
} from "./path-template.js";

// The `record-derived` scope pre-resolution (SS-8b): turn a target's confirmed
// `record-derived` scope bindings + a change's captured scope into the
// `{ parameterName → value }` map the shared scope-fill substitutes alongside constants.
export { resolveRecordDerivedScopeValues } from "./record-derived-scope.js";

// The REST single-record target reader — Conflict Detection's SingleRecordTargetReader
// seam (CF-5/CF-6), obeying OC-3 load discipline and returning the target's stored
// representation verbatim so hashFieldValue matches the persisted baseline.
export {
  RestSingleRecordTargetReader,
  type RestSingleRecordTargetReaderOptions,
} from "./rest-single-record-reader.js";

// The failure signals + classifier the ordering queue settles outbound calls with (OC-4).
export {
  CONTAINER_LINK_PARK_REASON,
  ContainerUnresolvedError,
  PermanentOutboundError,
  RetryableOutboundError,
  ThrottledOutboundError,
  classifyOutboundFailure,
  settleOutboundResult,
} from "./errors.js";

// The executor itself (OC-1/2/3/5 + OC-4 disposition).
export {
  OutboundCallExecutor,
  type CredentialAccess,
  type CredentialApplier,
  type OutboundCall,
  type OutboundCallCommon,
  type OutboundCallExecutorOptions,
  type OutboundCallResult,
  type TransformFailureContext,
  type WrittenRepresentation,
} from "./executor.js";

// The Phase-4 sync pipeline handler — the QueueHandler that composes RL/EP/CF/TX/OC
// per enqueued DetectedChange (docs/flows/sync-polling-pull.md steps 3.1–3.7 + 4).
export {
  SyncPipelineHandler,
  parseDetectedChange,
  parseResolutionDirective,
  type ApplyFieldMappingsFn,
  type ConflictDetectionPort,
  type IdentityResolutionPort,
  type LoopPreventionPort,
  type OutboundExecutorPort,
  type ParkedConflictResolutionRecord,
  type ParkedConflictWriter,
  type ResolutionDirective,
  type ResolvedTargetOperation,
  type SyncFieldStateGateway,
  type SyncPipelineContext,
  type SyncPipelineContextLoader,
  type SyncPipelineHandlerDeps,
  type SyncPipelineHandlerOptions,
} from "./sync-pipeline-handler.js";

// The Phase-4 initial-backfill runner — link-only (BE-4) + push (BE-5), enumerating
// the source via collectionReadRef and reusing RL/seeder/EP/OC (docs/architecture/
// sync-engine.md Initial backfill; docs/requirements/phase-4-backfill-enablement.md).
export {
  BackfillRunner,
  FakeBackfillMetrics,
  type BackfillCounts,
  type BackfillContainerResolution,
  type BackfillFanOut,
  type BackfillFieldStateReader,
  type BackfillIdentityResolution,
  type BackfillLoopPrevention,
  type BackfillMetrics,
  type BackfillOutbound,
  type BackfillRecordNote,
  type BackfillRunInput,
  type BackfillRunResult,
  type BackfillRunnerDeps,
  type BackfillRunnerOptions,
  type BackfillBranchOutcome,
  type BackfillScopeOutcome,
  type BackfillScopeResult,
  type BackfillSeeder,
  type LinkOnlyBackfillContext,
  type PushBackfillContext,
  type SideField,
} from "./backfill-runner.js";

// The Phase-4 enable orchestration — the enable action: gate → at-most-one-push →
// status transitions → backfill → deliberately-early go-live seeding (BE-3/BE-5.3/BE-6).
export {
  RuleEnabler,
  FakeSyncRuleEnableStore,
  type BackfillRunnerPort,
  type CounterpartBackfillModeLookup,
  type EnableBackfillOutcome,
  type EnableRuleInput,
  type EnableRuleResult,
  type PollSeedDescriptor,
  type RuleEnablerDeps,
  type RuleEnablerOptions,
  type SyncRuleEnableStore,
} from "./enable-rule.js";

// The Phase-4 sync-execution reconciler — the reconciliation sweep's invariant
// guardian: re-triggers a crash-orphaned `running` backfill so bus loss / restart
// degrades timeliness, never correctness (RS-1/RS-2). Structurally a `Reconciler`;
// the backend registers it on the shared sweep (docs/requirements/
// phase-4-reconciliation-sweep.md).
export {
  DEFAULT_RECONCILE_LIMIT,
  FakeSyncExecutionReconcilerMetrics,
  InMemoryBackfillInFlightRegistry,
  SYNC_EXECUTION_RECONCILER_NAME,
  SyncExecutionReconciler,
  type BackfillInFlightTracker,
  type BackfillRetrigger,
  type EnabledRuleReader,
  type SyncExecutionReconcilerDeps,
  type SyncExecutionReconcilerMetrics,
  type SyncExecutionReconcilerOptions,
} from "./sync-execution-reconciler.js";
