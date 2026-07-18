/**
 * `@mediator/sync-engine` — the Sync Engine's runtime machinery.
 *
 * This slice delivers **OQ-1**: the durable, single-active-worker-per-key ordering
 * queue that is the engine's consistency backbone (`docs/architecture/sync-engine.md`
 * *Ordering and consistency*; `docs/requirements/phase-4-ordering-queue.md`). The
 * `ordering_queue` table + `OrderingQueueRepository` (the raw `FOR UPDATE SKIP LOCKED`
 * claim) live in `@mediator/db`; this package is the machinery over them — the
 * dispatcher/worker loop that claims → runs an injected pipeline handler → settles.
 *
 * Deliberately **out of scope** here (later slices): what the `queue_key` *is*
 * (OQ-2 `RecordLink` / OQ-3 identity-value / native-id), the continuation handoff
 * (OQ-4), the pipeline that runs per entry (RL/EP/CF/TX/OC), and the cursor
 * enqueue-then-advance interaction (SP-5). The key is an **opaque string** here.
 */

export {
  OrderingQueueDispatcher,
  type FailureDisposition,
  type OrderingQueueDispatcherOptions,
  type QueueHandler,
  type QueueHandlerContext,
  type SettledEntry,
  type TickOutcome,
  type TickResult,
} from "./ordering-queue-dispatcher.js";

// In-memory queue that faithfully mirrors the real SKIP LOCKED claim semantics —
// the reference the OQ-2/OQ-3/OQ-4 + pipeline slices unit-test against.
export { FakeOrderingQueue } from "./fake-ordering-queue.js";

// ── Ordering-queue keying + continuation handoff (OQ-2 / OQ-3 / OQ-4) ─────────

// OQ-2 / OQ-3: what the opaque queue_key IS for a change (link id → identity value →
// native id), resolved by the cheap pre-enqueue lookup SP calls before enqueue.
export {
  QueueKeyResolver,
  type ActiveRecordLinkLookup,
  type QueueKeyBasis,
  type QueueKeyChange,
  type QueueKeyContext,
  type ResolvedQueueKey,
} from "./ordering/queue-key-resolver.js";

// OQ-4: the continuation handoff — a decorator over the OQ-1 worker ops that holds a
// link-keyed entry until its establishing pre-link queue drains (one record, one queue).
export {
  establishingQueueKeysOf,
  HandoffGate,
  type EstablishingQueueKeyLookup,
  type HandoffGateOptions,
} from "./ordering/handoff-gate.js";

// ── Identity Resolution — the pipeline's first stage (RL-1..RL-5) ─────────────

export {
  IdentityResolutionStage,
  IncompleteTargetFetchError,
  type IdentityResolutionStageDeps,
  type IdentityResolutionStageOptions,
  type ManualLinkParams,
} from "./identity-resolution/identity-resolution-stage.js";
export {
  IdentityMatchSeeder,
  type IdentityMatchSeedInput,
  type IdentityMatchSeederOptions,
} from "./identity-resolution/field-state-seeder.js";
export { canonicalJson, hashFieldValue, valuesAgree } from "./identity-resolution/hash.js";
export {
  FakeIdentityResolutionMetrics,
  FakeRecordLinkStore,
  FakeSyncEventRecorder,
  FakeSyncFieldStateStore,
  FakeTargetIdentityLookup,
  UniqueActiveLinkViolation,
  type FakeTargetConfig,
} from "./identity-resolution/fakes.js";
export type {
  ChangeKind,
  DetectedChange,
  FetchAllRequest,
  FilteredReadRequest,
  IdentityResolutionMetrics,
  MatchedTargetRecord,
  ResolutionContext,
  ResolutionOutcome,
  ResolvedOutcome,
  AmbiguousFailureOutcome,
  SkippedPolicyOutcome,
  SkippedPolicyReason,
  SeveredTombstoneOutcome,
  StraightCreateOutcome,
  NoLinkDeleteOutcome,
  StageTraceContext,
  SyncEventRecorder,
  TargetFetchResult,
  TargetIdentityLookup,
  TargetLookupCapability,
  TargetReadBinding,
} from "./identity-resolution/types.js";

// ── Scope discovery — establish `ScopeLink`s (SS-11: constant / identity-match / manual) ──

export {
  ScopeDiscoveryStage,
  type DiscoveryPassParams,
  type EstablishContainerLinkParams,
  type ResolveContainerParams,
  type ScopeDiscoveryStageDeps,
  type ScopeDiscoveryStageOptions,
} from "./scope-discovery/scope-discovery-stage.js";
export {
  canonicalScopeSides,
  scopeIdentitySignature,
  type CanonicalScopeSides,
} from "./scope-discovery/canonical.js";
export {
  AMBIGUOUS_CONTAINER_DETAILS_PREFIX,
  formatAmbiguousContainerDetails,
  parseAmbiguousContainerDetails,
  type AmbiguousContainerDetails,
} from "./scope-discovery/details.js";
export { FakeScopeLinkStore } from "./scope-discovery/fakes.js";
export type {
  AmbiguousContainerMatch,
  CapturedSourceScope,
  ContainerResolutionOutcome,
  DiscoveryPassResult,
  ScopeContainerCandidate,
} from "./scope-discovery/types.js";

// ── Loop Prevention — the pipeline's second stage (EP-1..EP-4) ────────────────

export {
  LoopPreventionStage,
  type LoopPreventionStageDeps,
  type LoopPreventionStageOptions,
} from "./loop-prevention/loop-prevention-stage.js";
export {
  NullRecentlyWrittenCache,
  TtlRecentlyWrittenCache,
} from "./loop-prevention/recently-written-cache.js";
export { participatingFieldsForSide } from "./loop-prevention/participating-fields.js";
export { FakeLoopPreventionMetrics } from "./loop-prevention/fakes.js";
export type {
  EchoVia,
  LoopEchoOutcome,
  LoopPreventionContext,
  LoopPreventionInput,
  LoopPreventionMetrics,
  LoopPreventionOutcome,
  LoopSkippedPolicyOutcome,
  MappingDirection,
  NotEchoOutcome,
  RecentWriteKey,
  RecentlyWrittenCache,
  RecordWriteInput,
  ResurrectionPreventedOutcome,
} from "./loop-prevention/types.js";

// ── Conflict Detection — the pipeline's third stage (CF-1..CF-7) ──────────────

export {
  ConflictDetectionStage,
  DEFAULT_CONFLICT_EPSILON_MS,
  type ConflictDetectionStageDeps,
  type ConflictDetectionStageOptions,
} from "./conflict-detection/conflict-detection-stage.js";
export {
  FakeConflictDetectionMetrics,
  FakeSingleRecordTargetReader,
} from "./conflict-detection/fakes.js";
export type {
  ConflictDetectionContext,
  ConflictDetectionInput,
  ConflictDetectionMetrics,
  ConflictDetectionOutcome,
  ConflictField,
  ConflictNoCallOutcome,
  ConflictRecord,
  ConflictWriteOutcome,
  DeleteParkOutcome,
  DeleteProceedOutcome,
  DeleteSkippedPolicyOutcome,
  DeletionConflictContext,
  DeletionConflictInput,
  DeletionConflictOutcome,
  DeletionConflictOverride,
  FieldConflictOverride,
  FieldPlan,
  FieldResolution,
  FieldResolutionChoice,
  FieldResolutionOutcome,
  SingleRecordReadBinding,
  SingleRecordReadRequest,
  SingleRecordReadResult,
  SingleRecordTargetReader,
  TargetWriteShape,
  WithholdFieldPlan,
  WithholdReason,
  WriteFieldPlan,
} from "./conflict-detection/types.js";

// ── Scheduler + Poller — the change-detection driver (SP-1..SP-5) ─────────────

// SP-2..SP-5: the Poller (one poll cycle up to enqueue) + its deterministic
// poll-trigger hook (`pollOnce`, used by SU-6). The per-record pipeline the ordering
// queue runs on each enqueued change (RL/EP/CF/TX/OC) is a later slice.
export { Poller, type PollerOptions } from "./poller/poller.js";
// SP-1: the Scheduler + its pure eligibility gate.
export { Scheduler, decidePoll, type SchedulerOptions } from "./poller/scheduler.js";
// SP-5: the Postgres-backed atomic cursor/snapshot advance store.
export { DbPollStateStore } from "./poller/db-poll-state-store.js";
// The record content hash the full-fetch snapshot keys on (SP-2).
export { contentHashOfRecord } from "./poller/content-hash.js";
// The ports the Poller/Scheduler are defined by (consumer-side), + the enqueue payload.
export { buildChangePayload } from "./poller/types.js";
export type {
  ChangeEnqueue,
  DeltaOutcome,
  EnqueuedChange,
  NotPollableReason,
  ObservedRecord,
  PageOutcome,
  PollAdvance,
  PollCandidateSource,
  PollCandidateView,
  PollChangePayload,
  PollDecision,
  PollHoldReason,
  PollPlan,
  PollPlanResolution,
  PollPlanResolver,
  PollRunOutcome,
  PollSnapshotState,
  PollStateStore,
  PollTrigger,
  PollerMetrics,
  SchedulerMetrics,
  SourceReader,
} from "./poller/types.js";
// The fakes downstream slices (SU-6, the pipeline handler) unit-test against.
export {
  FakePollCandidateSource,
  FakePollPlanResolver,
  FakePollStateStore,
  FakePollerMetrics,
  FakeSchedulerMetrics,
  FakeSourceReader,
  type FakeDeltaBatch,
  type FakePage,
  type FakePollState,
} from "./poller/fakes.js";

// ── SyncRule enablement gate (BE-1 / BE-2) ────────────────────────────────────

// The safety-critical precondition check deciding whether a disabled `SyncRule` may
// be turned on — the record-merge-prevention boundary (a confirmed identity key, a
// confirmed `pollOperationRef`, the approved target operations for what it propagates,
// and both sides' required `ResourceBinding` refs). Pure evaluation over already-loaded
// domain objects: SA-1 loads them and calls `evaluateEnablement`; the backfill *runner*
// (BE-3..BE-6) is a later slice.
export { evaluateEnablement } from "./enablement/enablement-gate.js";
export type {
  BindingRefName,
  BindingRefRequirement,
  BindingRefUse,
  BlockedDecision,
  ConstantScopeBindingRequirement,
  EnableDecision,
  EnablementDecision,
  EnablementDegradation,
  EnablementInput,
  EnablementRequirement,
  EnablementSide,
  IdentityKeyRequirement,
  IdentityLookupPathRequirement,
  LwwObservationOrderDegradation,
  MatchFirstUnavailableDegradation,
  PollOperationRequirement,
  PropagatableOperationRequirement,
  RecordDerivedScopeBindingRequirement,
  ScopeBindingRequirement,
  ScopeBindingUnconfirmedRequirement,
  SourceScopeRefUnconfirmedRequirement,
  TargetOperationRequirement,
} from "./enablement/types.js";
