/**
 * `@mediator/event-bus` — the mediator's internal Event Bus: a durable,
 * at-least-once transactional outbox with idempotent (dedup-by-event-id)
 * consumers, plus the reconciliation-sweep framework that makes bus loss degrade
 * timeliness, never correctness (see `docs/architecture/overview.md` *Event Bus*).
 *
 * The tables (`event_outbox`, `processed_event`) + their repositories live in
 * `@mediator/db`; this package is the machinery over them: `emit` (transactional
 * append), the dispatcher (claim → deliver → publish/retry), the consumer
 * registry, and the reconciliation framework. Phase 1 carries exactly one event
 * (`SpecIngested`) and no real reconcilers.
 */

// Producer-facing bus.
export { PostgresEventBus, type EventBus } from "./event-bus.js";

// Event envelope handling + construction/parse helpers.
export {
  createMappingApproved,
  createSpecIngested,
  flattenDeliveredEvent,
  parseMappingApproved,
  parseSpecIngested,
  reconstructEvent,
  toOutboxInsert,
  type DeliveredEvent,
} from "./event.js";

// Consumers.
export { ConsumerRegistry, DuplicateConsumerError, type EventConsumer } from "./consumer.js";

// Dispatcher.
export {
  invokeConsumer,
  OutboxDispatcher,
  type ConsumerInvocation,
  type DispatcherOptions,
  type RunOnceResult,
} from "./dispatcher.js";

// Reconciliation-sweep framework.
export {
  DuplicateReconcilerError,
  ReconciliationSweep,
  type Reconciler,
  type ReconciliationSweepResult,
  type ReconcilerOutcome,
} from "./reconciliation.js";
