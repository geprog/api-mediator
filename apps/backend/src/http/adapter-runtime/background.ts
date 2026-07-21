import type { MountManager } from "@mediator/adapter-engine";
import type { DbTransaction } from "@mediator/db";
import {
  parseSpecIngested,
  type DeliveredEvent,
  type EventConsumer,
  type Reconciler,
} from "@mediator/event-bus";
import { SPEC_INGESTED_EVENT_TYPE } from "@mediator/domain";

/**
 * The mount-lifecycle reactions (RT-4). Like the other module backgrounds under
 * `apps/backend/src/modules` this builds **no** dispatcher/sweep
 * of its own — it returns a `SpecIngested` {@link EventConsumer} and a
 * {@link Reconciler} for the single shared `OutboxDispatcher`/`ReconciliationSweep`
 * to register (see the composition root).
 *
 * Both do the same idempotent thing: `mountManager.reconcile()`. The consumer makes
 * a newly-ingested `CONSUMER` spec routable **live** (RT-4.1); the periodic
 * reconciler is the safety net that also catches lifecycle transitions with no event
 * of their own — an app **disabled** or **deregistered** (RT-4.2/4.3) — and any
 * missed delivery, since the desired surface is always re-derived from persisted
 * state (RT-4.5).
 *
 * The consumer does its work through the pooled db that the `MountManager`'s store
 * holds, not the dispatcher's transaction handle: the reconcile only reads
 * already-committed state (the spec the Spec Registry committed before emitting
 * `SpecIngested`) and swaps an in-memory route table, so it neither needs nor should
 * hold the dispatcher transaction open on unrelated work.
 */
export interface AdapterMountReactions {
  readonly consumer: EventConsumer<DbTransaction>;
  readonly reconciler: Reconciler;
}

/** The consumer name it deduplicates under (`processed_event.consumer_name`); stable. */
const CONSUMER_NAME = "adapter-runtime-mount";
/** The reconciler's stable name in the sweep. */
const RECONCILER_NAME = "adapter-runtime-mount";

export function buildAdapterMountReactions(mountManager: MountManager): AdapterMountReactions {
  const consumer: EventConsumer<DbTransaction> = {
    name: CONSUMER_NAME,
    handles: (type) => type === SPEC_INGESTED_EVENT_TYPE,
    handle: async (event: DeliveredEvent) => {
      // Only a CONSUMER spec changes the adapter surface; a PROVIDER ingest cannot,
      // so skip it rather than recompute an identical surface.
      const ingested = parseSpecIngested(event);
      if (ingested.role !== "CONSUMER") {
        return;
      }
      await mountManager.reconcile();
    },
  };

  const reconciler: Reconciler = {
    name: RECONCILER_NAME,
    reconcile: () => mountManager.reconcile(),
  };

  return { consumer, reconciler };
}
