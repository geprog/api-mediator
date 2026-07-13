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
