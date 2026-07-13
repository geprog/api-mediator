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
