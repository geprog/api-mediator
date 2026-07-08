# Flow: Data Sync via Webhook Push

Executed by the [Sync Engine](../architecture/sync-engine.md) whenever a source app declares `supportsWebhooks` on its `SyncRule`.

## Steps

1. App A (the source) sends a webhook to the mediator's per-app webhook URL, notifying it of a change.
2. The Webhook Receiver verifies the request's signature using App A's `webhookSecret` credential (see [architecture/security.md](../architecture/security.md)). An invalid/unsigned request is rejected here and never reaches the pipeline below.
3. The Receiver resolves the active `SyncRule`(s) for `(App A, resource)`.
4. Loop Prevention checks whether this change is an echo of the mediator's own last write to App A (via the short-TTL "recently written by mediator" cache, see [architecture/sync-engine.md](../architecture/sync-engine.md)).
   - If it is an echo, the event is recorded as `SyncEvent.status = skipped-loop` and processing stops.
   - Otherwise, processing continues.
5. The Transformation Executor applies the `ApprovedMapping`'s `FieldMapping`s (rename/coerce/aggregate/expression) to produce App B's expected payload shape.
6. The Outbound Call Executor obtains App B's credential via `CredentialStore.withCredential` and calls the mapped operation on App B, tagged with a deterministic `idempotencyKey`.
7. The result is recorded as a `SyncEvent` (success/failure/conflict), and the "recently written by mediator" cache is updated for App B's resource — so App B's own downstream webhook doesn't bounce this change back to App A.

## Sequence diagram

```mermaid
sequenceDiagram
    participant AppA as App A (source)
    participant WH as Webhook Receiver
    participant Loop as Loop Prevention
    participant Xf as Transformation Executor
    participant Out as Outbound Call Executor
    participant AppB as App B (target)
    participant Log as Audit/Event Log

    AppA->>WH: POST webhook event
    WH->>WH: verify signature (webhookSecret)
    WH->>Loop: is this an echo of our own write?
    alt is echo
        Loop-->>Log: SyncEvent(skipped-loop)
    else genuine change
        Loop->>Xf: apply FieldMappings
        Xf->>Out: transformed payload + target operation
        Out->>AppB: authenticated call (idempotency key)
        AppB-->>Out: response
        Out-->>Log: SyncEvent(success/failure/conflict)
    end
```

## Related

- Same pipeline (steps 4-7) is shared with [sync-polling-pull.md](sync-polling-pull.md) — only how a change is *detected* differs between the two transports.
- See [architecture/sync-engine.md](../architecture/sync-engine.md) for idempotency, conflict handling, and ordering guarantees.
- See [architecture/observability.md](../architecture/observability.md) for the metrics/traces emitted at each step.
