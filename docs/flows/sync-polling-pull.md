# Flow: Data Sync via Polling Pull

Executed by the [Sync Engine](../architecture/sync-engine.md) for every enabled `SyncRule`. Polling is the mediator's change-detection mechanism: the source app declares `supportsPolling` in its `capabilities` (see [architecture/data-model.md](../architecture/data-model.md)), and the mediator pulls changes on an interval rather than being notified of them.

## Steps

1. The Scheduler wakes a `SyncRule` when its polling interval (`pollIntervalOverride` or the app's `defaultPollInterval`) elapses.
2. The Poller calls the source operation pinned by `SyncRule.pollOperationRef` (see [architecture/data-model.md](../architecture/data-model.md)): App A's delta-query operation with the stored `SyncRule.cursor` (passed via the resource's confirmed `ResourceBinding.deltaCursorRef`) when App A declares `supportsDeltaQuery` and the resource offers one, otherwise the collection read — paged to exhaustion via the resource's confirmed `ResourceBinding.paginationRef` — diffing the result against the last-seen snapshot by content hash, keyed by native id (`ResourceBinding.nativeIdRef`). A record missing from a **complete** fetch is a delete candidate; a truncated or partially failed fetch aborts the run rather than misreading missing pages as deletions — see *Change types* in [architecture/sync-engine.md](../architecture/sync-engine.md).
3. Each changed record is durably enqueued onto its cross-direction queue — the key resolved before enqueue: the record's active `RecordLink`, or its identity-key value while no link exists yet (see *Ordering and consistency* in [architecture/sync-engine.md](../architecture/sync-engine.md)) — so the counterpart rule's processing of the same record can never interleave; the shared pipeline then runs per queued change:
   1. **Identity Resolution** classifies the change (create/update/delete — see *Change types* in [architecture/sync-engine.md](../architecture/sync-engine.md)) and resolves the record's `RecordLink`, establishing one first by identity-key match for a record the mediator has never seen.
   2. **Loop Prevention** checks whether this change is an echo of the mediator's own last write to App A: the incoming values are compared field-by-field against App A's side of the link's reconciled baselines in `SyncFieldState`; create and delete echoes are recognized via `RecordLink` state (see [architecture/sync-engine.md](../architecture/sync-engine.md)). An echo is recorded as `SyncEvent.status = skipped-loop` and processing stops. (The short-TTL "recently written by mediator" cache may short-circuit an obvious echo before the field comparison, as a fast path.)
   3. A genuine (non-echo) **deletion** is handled per `SyncRule.deletePropagation`: under `ignore` it is recorded `skipped-policy`, the link is tombstoned `observed-delete`, and processing stops; under `propagate` it continues to the outbound call below — unless the target side has drifted since the last reconcile, which parks the delete as a manual conflict instead (see *Deletes vs. edits* in [architecture/sync-engine.md](../architecture/sync-engine.md)) — and the link is tombstoned `propagated-delete` (see *Change types* in [architecture/sync-engine.md](../architecture/sync-engine.md)).
   4. **Conflict Detection** checks whether App B's side has drifted from its own reconciled baseline since the last sync; a drift resolves per the conflict policy — auto-resolve and record `conflict`, or park the field for manual resolution (see *Conflict handling* in [architecture/sync-engine.md](../architecture/sync-engine.md)).
   5. The **Transformation Executor** applies the `ApprovedMapping`'s `FieldMapping`s (rename/coerce/aggregate/expression) to produce App B's expected payload shape.
   6. The **Outbound Call Executor** obtains App B's credential via `CredentialStore.withCredential` and calls the operation selected by the change's action from the mapping's `OperationMapping`s (an update/delete's id parameter filled per `targetIdParamRef` from the `RecordLink`), tagged with a deterministic `idempotencyKey`. For a create, App B's newly assigned native id is captured from the response (via App B's `ResourceBinding.nativeIdRef`) and persisted on the `RecordLink`.
   7. The result is recorded as a `SyncEvent` (success/failure/conflict), and the "recently written by mediator" cache is updated for App B's resource — so App B's own next poll doesn't bounce this change back to App A.
4. `SyncRule.cursor` and `lastRunAt` are advanced — and the snapshot replaced — once every detected change has been **durably enqueued**, not once processed: a crash before the advance re-detects and re-enqueues on the next poll (echo checks and idempotency keys absorb the duplicates), and a record sitting in retry backoff or parked never holds the cursor open. A `SyncEvent` is recorded per record as it is processed.

## Sequence diagram

```mermaid
sequenceDiagram
    participant Sched as Scheduler
    participant Poll as Poller
    participant AppA as App A (source)
    participant Id as Identity Resolution
    participant Loop as Loop Prevention
    participant Xf as Transformation Executor
    participant Out as Outbound Call Executor
    participant AppB as App B (target)
    participant Log as Audit/Event Log

    Sched->>Poll: SyncRule due
    Poll->>AppA: GET changed-since(cursor) [or full list + hash diff]
    AppA-->>Poll: changed records
    Poll->>Poll: durably enqueue each change; advance cursor / snapshot / lastRunAt
    loop each queued change
        Poll->>Id: classify change (create/update/delete), resolve RecordLink
        Id->>Loop: is this an echo of our own write?
        alt is echo
            Loop-->>Log: SyncEvent(skipped-loop)
        else genuine change
            Loop->>Xf: conflict check (target drift vs its baseline), apply FieldMappings
            Xf->>Out: transformed payload + action-selected operation
            Out->>AppB: authenticated call (idempotency key)
            AppB-->>Out: response
            Out->>Out: on create: persist target's new id on RecordLink
            Out-->>Log: SyncEvent(success/failure/conflict)
        end
    end
```

## Notes

- Enabling a `SyncRule` triggers its one-time initial backfill; the rule does not start polling until that backfill has completed or been explicitly skipped as part of the enable action, at which point its snapshot and delta cursor are seeded — see *Initial backfill* and *What enablement seeds* in [architecture/sync-engine.md](../architecture/sync-engine.md).
- The poll interval is the freshness bound for this direction: a change in App A is observed at most one interval after it happens, and conflict detection is deferred by at most that same lag (see *Conflict handling* in [architecture/sync-engine.md](../architecture/sync-engine.md)).
- Poller lag (time since `lastRunAt` vs. the expected interval) is tracked as an OpenTelemetry metric and surfaced on the Sync Engine Grafana dashboard — see [architecture/observability.md](../architecture/observability.md).
