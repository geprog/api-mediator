# Flow: Data Sync via Webhook Push

Executed by the [Sync Engine](../architecture/sync-engine.md) for every `SyncRule` whose `transport` includes webhook — available when the rule's source app declares `supportsWebhooks` in its `capabilities` (see [architecture/data-model.md](../architecture/data-model.md)).

## Steps

1. App A (the source) sends a webhook to the mediator's per-app webhook URL, notifying it of a change.
2. The Webhook Receiver verifies the request's signature using App A's `webhookSecret` credential (see [architecture/security.md](../architecture/security.md)). An invalid/unsigned request is rejected here and never reaches the pipeline below.
3. The Receiver resolves the active `SyncRule`(s) for `(App A, resource)`. For a `webhookPayload = thin` or `webhookVerification = none` source, the changed record is first fetched back from App A over the authenticated outbound channel — the webhook body is a trigger, not trusted content (see [architecture/security.md](../architecture/security.md)). The short-TTL "recently written by mediator" cache may short-circuit an obvious echo here, as a fast path.
4. Identity Resolution classifies the change (create/update/delete — see *Change types* in [architecture/sync-engine.md](../architecture/sync-engine.md)) and resolves the record's `RecordLink`, establishing one first by identity-key match for a record the mediator has never seen. A deletion under `deletePropagation = ignore` stops here: recorded as `skipped-policy`, and the link is tombstoned (`observed-delete`).
5. Loop Prevention checks whether this change is an echo of the mediator's own last write to App A: the incoming values are compared field-by-field against App A's side of the link's reconciled baselines in `SyncFieldState`; create and delete echoes are recognized via `RecordLink` state (see [architecture/sync-engine.md](../architecture/sync-engine.md)).
   - If it is an echo, the event is recorded as `SyncEvent.status = skipped-loop` and processing stops.
   - Otherwise, processing continues.
6. Conflict Detection checks whether App B's side has drifted from its own reconciled baseline since the last sync; a drift resolves per the conflict policy — auto-resolve and record `conflict`, or park the field for manual resolution (see *Conflict handling* in [architecture/sync-engine.md](../architecture/sync-engine.md)).
7. The Transformation Executor applies the `ApprovedMapping`'s `FieldMapping`s (rename/coerce/aggregate/expression) to produce App B's expected payload shape.
8. The Outbound Call Executor obtains App B's credential via `CredentialStore.withCredential` and calls the operation selected by the change's action from the mapping's `OperationMapping`s, tagged with a deterministic `idempotencyKey`. For a create, App B's newly assigned native id is captured from the response and persisted on the `RecordLink`.
9. The result is recorded as a `SyncEvent` (success/failure/conflict), and the "recently written by mediator" cache is updated for App B's resource — so App B's own downstream webhook doesn't bounce this change back to App A.

## Sequence diagram

```mermaid
sequenceDiagram
    participant AppA as App A (source)
    participant WH as Webhook Receiver
    participant Id as Identity Resolution
    participant Loop as Loop Prevention
    participant Xf as Transformation Executor
    participant Out as Outbound Call Executor
    participant AppB as App B (target)
    participant Log as Audit/Event Log

    AppA->>WH: POST webhook event
    WH->>WH: verify signature (webhookSecret)
    WH->>Id: classify change (create/update/delete), resolve RecordLink
    Id->>Loop: is this an echo of our own write?
    alt is echo
        Loop-->>Log: SyncEvent(skipped-loop)
    else genuine change
        Loop->>Loop: conflict check (target drift vs its baseline)
        Loop->>Xf: apply FieldMappings
        Xf->>Out: transformed payload + action-selected operation
        Out->>AppB: authenticated call (idempotency key)
        AppB-->>Out: response
        Out->>Out: on create: persist target's new id on RecordLink
        Out-->>Log: SyncEvent(success/failure/conflict)
    end
```

## Related

- Same pipeline (steps 4-8) is shared with [sync-polling-pull.md](sync-polling-pull.md) — only how a change is *detected* differs between the two transports.
- See [architecture/sync-engine.md](../architecture/sync-engine.md) for idempotency, conflict handling, and ordering guarantees.
- See [architecture/observability.md](../architecture/observability.md) for the metrics/traces emitted at each step.
