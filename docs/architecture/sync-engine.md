# Sync Engine

The Sync Engine executes `ApprovedMapping`s between two `PROVIDER`-role apps on an ongoing basis, keeping their data in sync. It is one of the two consumers of approved mapping data (the other being the [Adapter/Gateway Engine](adapter-engine.md)) — where the adapter resolves requests on demand, the Sync Engine pushes proactively.

## Transports: webhook push and polling pull

Each `SyncRule` (instantiated from an `ApprovedMapping` between two peer apps, see [data-model.md](data-model.md)) runs over one or both transports, chosen per app based on its declared `capabilities`:

- **Webhook push** — used when the source app declares `supportsWebhooks`. The app notifies the mediator's Webhook Receiver of changes; the mediator propagates them near-real-time.
- **Polling pull** — used when the source app only declares `supportsPolling` (or as a supplementary safety net alongside webhooks, to catch missed events). The Poller periodically calls the source app on `SyncRule.pollIntervalOverride` or `RegisteredApp.defaultPollInterval`.

Both transports funnel into the same shared pipeline: **Loop Prevention → Transformation Executor → Outbound Call Executor**, so mapping semantics are identical regardless of how a change was detected.

## Webhook push pipeline

1. Source app sends a webhook to the mediator's per-app webhook URL.
2. Webhook Receiver verifies the request signature using the app's `webhookSecret` credential (see [security.md](security.md)). Unsigned/invalid requests are rejected before reaching the pipeline.
3. Receiver resolves the active `SyncRule`(s) for `(sourceApp, resource)`.
4. Loop Prevention checks whether this change is an echo of the mediator's own last write (see below). If so, record `skipped-loop` and stop.
5. Transformation Executor applies the `ApprovedMapping`'s `FieldMapping`s (rename/coerce/aggregate/expression) to produce the target payload.
6. Outbound Call Executor obtains the target app's credential via `CredentialStore.withCredential` and calls the mapped operation, tagged with a deterministic `idempotencyKey`.
7. Result recorded as a `SyncEvent`; the "recently written by mediator" cache is updated for the target app's resource.

Full step-by-step walkthrough with sequence diagram: [flows/sync-webhook-push.md](../flows/sync-webhook-push.md).

## Polling pull pipeline

1. Scheduler wakes a `SyncRule` on its configured interval.
2. Poller calls the source app's changed-since operation using the stored `cursor`, if the API supports delta queries; otherwise it does a full fetch and diffs against the last-seen snapshot by content hash.
3. Each changed record goes through the same Loop Prevention → Transformation → Outbound Call pipeline as webhook push.
4. `SyncRule.cursor` and `lastRunAt` are advanced; a `SyncEvent` is recorded per changed record.

Full step-by-step walkthrough with sequence diagram: [flows/sync-polling-pull.md](../flows/sync-polling-pull.md).

## Loop prevention

Bidirectional mappings create a real risk: App A changes → synced to App B → App B's own webhook/poll detects that change → synced back to App A → infinite ping-pong.

Prevention mechanism:

- Every mediator-originated write is tagged (via a passthrough header/field when the target API supports metadata, or via a content-hash record when it doesn't).
- A short-TTL "recently written by mediator" cache is kept per `(appId, resourceId)`.
- When a webhook fires or a poll detects a change, the pipeline first checks: does this change's content match what the mediator itself just wrote to this resource? If yes, the event is recorded as `SyncEvent.status = skipped-loop` and propagation stops there.

## Idempotency

Every outbound write carries a deterministic `idempotencyKey` — a hash of the source event, the mapping id, and the resulting payload. Before executing, the Outbound Call Executor checks `SyncEvent` history for that key; a duplicate delivery (webhook retry, overlapping poll) is deduplicated rather than re-applied. The key is also passed through to the target API's own idempotency-key mechanism when it has one.

## Conflict handling

A conflict is detected when both sides of a mapped field have changed since the last successful sync (the mediator keeps a last-synced snapshot hash per mapped field to detect this).

- **Default policy: last-write-wins by source timestamp.** The side with the more recent change timestamp/version wins. The event is still recorded with `SyncEvent.status = conflict` in the Audit Log, so nothing is silently lost from the record even though it's auto-resolved.
- A `FieldMapping` can be flagged `manual-resolve` in its `transformConfig` to override this default and force the conflict to surface in the UI instead of auto-resolving — useful for fields where auto-resolution would be unacceptable.

## Ordering and consistency

Sync is asynchronous and eventually consistent:

- **Per-record ordering is guaranteed.** A per-`(mapping, resourceId)` sequential queue ensures two updates to the same record are applied in the order they occurred.
- **Cross-record/cross-mapping ordering is not guaranteed and not required.** Different resources or different mappings may be processed out of order relative to each other.

## Observability hooks

Sync success/failure/skipped-loop/conflict rates, webhook delivery latency, and poller lag (time since `lastRunAt` vs. expected interval) are emitted per `SyncRule` as OpenTelemetry metrics; each individual sync execution is a trace correlated to its `SyncEvent` via `traceId`/`spanId`. See [observability.md](observability.md).
