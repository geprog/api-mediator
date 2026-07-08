# Sync Engine

The Sync Engine executes `ApprovedMapping`s between two `PROVIDER`-role apps on an ongoing basis, keeping their data in sync. It is one of the two consumers of approved mapping data (the other being the [Adapter/Gateway Engine](adapter-engine.md)) — where the adapter resolves requests on demand, the Sync Engine pushes proactively.

## Transports: webhook push and polling pull

Each `SyncRule` (instantiated from an `ApprovedMapping` between two peer apps, see [data-model.md](data-model.md)) runs over one or both transports, chosen per app based on its declared `capabilities`:

- **Webhook push** — used when the source app declares `supportsWebhooks`. The app notifies the mediator's Webhook Receiver of changes; the mediator propagates them near-real-time.
- **Polling pull** — used when the source app only declares `supportsPolling` (or as a supplementary safety net alongside webhooks, to catch missed events). The Poller periodically calls the source app on `SyncRule.pollIntervalOverride` or `RegisteredApp.defaultPollInterval`.

Both transports funnel into the same shared pipeline: **Loop Prevention → Identity Resolution → Transformation Executor → Outbound Call Executor**, so mapping semantics are identical regardless of how a change was detected.

## Webhook push pipeline

1. Source app sends a webhook to the mediator's per-app webhook URL.
2. Webhook Receiver verifies the request signature using the app's `webhookSecret` credential (see [security.md](security.md)). Unsigned/invalid requests are rejected before reaching the pipeline.
3. Receiver resolves the active `SyncRule`(s) for `(sourceApp, resource)`.
4. Loop Prevention checks whether this change is an echo of the mediator's own last write (see below). If so, record `skipped-loop` and stop.
5. Identity Resolution classifies the change as create/update/delete and resolves its `RecordLink` — establishing one first (by identity-key match against the target) for a record the mediator has never seen. See *Identity correlation* and *Change types* below.
6. Transformation Executor applies the `ApprovedMapping`'s `FieldMapping`s (rename/coerce/aggregate/expression) to produce the target payload.
7. Outbound Call Executor obtains the target app's credential via `CredentialStore.withCredential` and calls the target operation selected by the change's action from the mapping's `OperationMapping`s (see [data-model.md](data-model.md)), tagged with a deterministic `idempotencyKey`. For a create, the target's newly assigned native id is captured from the response and persisted on the `RecordLink`.
8. Result recorded as a `SyncEvent`; the "recently written by mediator" cache is updated for the target app's resource.

Full step-by-step walkthrough with sequence diagram: [flows/sync-webhook-push.md](../flows/sync-webhook-push.md).

## Polling pull pipeline

1. Scheduler wakes a `SyncRule` on its configured interval.
2. Poller calls the source app's changed-since operation using the stored `cursor`, if the app declares `capabilities.supportsDeltaQuery`; otherwise it does a full fetch and diffs against the last-seen snapshot by content hash. Deletions are only ever inferred from a **complete** full fetch — if any page fails, the run aborts rather than misreading missing records as deletions (see *Change types* below).
3. Each changed record goes through the same Loop Prevention → Identity Resolution → Transformation → Outbound Call pipeline as webhook push.
4. `SyncRule.cursor` and `lastRunAt` are advanced; a `SyncEvent` is recorded per changed record.

Full step-by-step walkthrough with sequence diagram: [flows/sync-polling-pull.md](../flows/sync-polling-pull.md).

## Identity correlation: RecordLink

Two independently-owned apps assign their own primary ids to the same logical record — nothing guarantees `customer 123` in App A is `cust_9f3` in App B. Every stateful sync behavior (routing an update to the right target record, conflict detection, delete propagation) therefore runs over an explicit, persisted id pairing: the `RecordLink` (see [data-model.md](data-model.md)), scoped to the unordered app pair and shared by both directions of a bidirectional pair, exactly like `SyncFieldState` (which is keyed by it).

A link is established one of three ways:

1. **Create propagation** — the pipeline creates the record in the target and captures the target's newly assigned native id from the create response, writing the `RecordLink` in the same step. This is also what makes the target's own "new record" event recognizable as an echo (see loop prevention below).
2. **Identity-key match** — during initial backfill, or in steady state when a change arrives for a source record with no link yet: the target is looked up by the mapping's confirmed identity `FieldMapping` (`isIdentityKey`, see [data-model.md](data-model.md)) — the business-level key (email, SKU, order number, …) whose values are expected to identify the same record on both sides. A lookup that matches **more than one** target record never picks one silently: the event is recorded as `failure` with the candidate ids in `details` and surfaced for manual linking.
3. **Manual** — the UI supports explicit linking/unlinking for records an identity key cannot disambiguate.

Because a wrong identity key makes the engine silently merge unrelated records — its worst possible failure mode — the identity `FieldMapping` is proposed by the Mapping Engine (`identityCandidate`, see [mapping-engine.md](mapping-engine.md)) but only ever set by explicit reviewer confirmation, and a `SyncRule` cannot be enabled without exactly one confirmed identity key per mapped resource pair (see [flows/mapping-review-and-approval.md](../flows/mapping-review-and-approval.md)).

## Change types: create, update, delete

A detected change carries an action, and "calls the mapped operation" always means *the target operation whose `OperationMapping.action` matches that action* (see [data-model.md](data-model.md)). Detection per transport:

- **Webhook** — the event-type field, when the source app's webhook payloads declare one; otherwise inferred from `RecordLink` state (no link and no identity match → create; link exists → update).
- **Delta query** — deletions only when the API explicitly reports deleted records; a delta API that doesn't report deletions cannot drive delete detection on its own.
- **Full-fetch diff** — a record present in the last snapshot but absent from a **complete** fetch is a delete candidate. This inference is only valid when every page of the fetch succeeded; a truncated or partially failed fetch aborts the run rather than misreading missing pages as mass deletion.

Per action:

- **Create** — before creating, the pipeline first attempts an identity-key match: the record may already exist in the target, created there independently or predating the sync. A match links the records and downgrades the change to an update; no match calls the `action = create` operation, captures the new target id from the response, and writes the `RecordLink`.
- **Update** — routed to the target's native id via the `RecordLink`; a record with no link takes the same match-first path as a create.
- **Delete** — governed by `SyncRule.deletePropagation`, default `ignore`: deletion is the one destructive thing the mediator can do to an app, so propagation is opt-in per rule. Ignored deletions are recorded as `SyncEvent.status = skipped-policy` — visible in the audit log and the graph's activity metadata, never silently dropped. Under `propagate`, the `action = delete` operation is called via the link, and the `RecordLink` is **tombstoned** (not deleted): the tombstone is what recognizes the other side's delete echo and prevents a slower poll cycle from resurrecting the record (see loop prevention below).

## Initial backfill

Enabling a `SyncRule` between two apps that already hold data raises a question steady-state sync never answers: what about the records that exist *now*? Each rule therefore starts with a one-time backfill run — tracked as `SyncRule.backfillStatus`, see [data-model.md](data-model.md) — before its transports go live. Skipping it is an explicit choice (`skipped`), not a default.

1. The Poller does a complete fetch of the source's mapped resource.
2. Each record is resolved against existing `RecordLink`s, then by identity-key match; matches produce links.
3. What happens beyond linking is `SyncRule.backfillMode`:
   - **`link-only` (default)** — links are written and `SyncFieldState` baselines are seeded from the current values, but **nothing is written to either app**. Fields whose two sides already disagree get no baseline (there is no last-reconciled value to record) and are reported in the backfill summary; the first subsequent change to such a field is a conflict by construction and resolves per the normal conflict policy below.
   - **`push`** — the source is declared the initial source of truth for this direction: mapped field values are pushed to matched target records, and unmatched source records are created in the target — all through the normal pipeline (loop-prevention tagging, idempotency keys, audit). On a bidirectional pair, at most one of the two rules may use `push`; pushing both directions is a contradiction.
4. Backfill executions are ordinary `SyncEvent`s (`type = backfill-run`), and changes arriving over webhook mid-backfill queue behind it in the per-record ordering queue (see *Ordering and consistency* below) rather than racing it.

The two rules of a bidirectional pair share links and field state, so whichever backfills first does the bulk of the matching. The second direction's backfill still enumerates *its* source's records — records existing only in that app were never seen by the first run — but finds the overlap already linked.

## Loop prevention

Bidirectional sync — two paired one-way `ApprovedMapping`s / `SyncRule`s, see [data-model.md](data-model.md) — creates a real risk: App A changes → synced to App B by the A→B `SyncRule` → App B's own webhook/poll detects that change → the B→A `SyncRule` syncs it back to App A → infinite ping-pong.

Prevention mechanism:

- Every mediator-originated write is tagged (via a passthrough header/field when the target API supports metadata, or via a content-hash record when it doesn't).
- A short-TTL "recently written by mediator" cache is kept per `(appId, resourceId)`.
- When a webhook fires or a poll detects a change, the pipeline first checks: does this change's content match what the mediator itself just wrote to this resource? If yes, the event is recorded as `SyncEvent.status = skipped-loop` and propagation stops there.

Two cases content matching cannot cover are handled via `RecordLink` state instead:

- **Create echoes** — when the mediator creates a record in the target, the `RecordLink` written at propagation time (carrying the target's new native id) is what identifies the target's subsequent "new record" webhook/poll hit as the mediator's own create rather than a genuine new record.
- **Delete echoes** — a deletion has no content to hash; the tombstoned `RecordLink` is the marker. An observed deletion of a record whose link the mediator just tombstoned by its own delete propagation is recorded `skipped-loop`. The tombstone also prevents *resurrection*: a slower poll cycle on the other side, still seeing the record in an old snapshot diff, must not re-create what the pair just deleted.

## Idempotency

Every outbound write carries a deterministic `idempotencyKey` — a hash of the source event, the mapping id, and the resulting payload. Before executing, the Outbound Call Executor checks `SyncEvent` history for that key; a duplicate delivery (webhook retry, overlapping poll) is deduplicated rather than re-applied. The key is also passed through to the target API's own idempotency-key mechanism when it has one.

## Conflict handling

A conflict is detected when both sides of a mapped field have changed since the last successful sync. The mediator tracks this via `SyncFieldState` (see [data-model.md](data-model.md)) — one row per mapped field pair per linked record (`RecordLink`), storing the last-reconciled value hash. Critically, `SyncFieldState` is keyed by the *field pairing*, not by a single `SyncRule`: a bidirectional pair (two `SyncRule`s, one per direction) shares the same state, so a conflict is detected correctly regardless of which direction wrote last. When either direction's pipeline is about to write, it compares the incoming value against `SyncFieldState.lastSyncedValueHash`; if the *other* app's side has also changed since that hash was recorded, it's a conflict.

- **Default policy: last-write-wins by source timestamp.** The side with the more recent change timestamp/version wins. This relies on the two apps' reported timestamps being meaningfully comparable, which cannot be assumed across independently-operated external systems with unsynchronized clocks. To keep this from silently picking the wrong side on clock skew: if the two candidate timestamps are within a configurable epsilon (e.g. a few seconds) of each other, timestamp comparison is treated as inconclusive and the mediator falls back to the order in which it *observed* the two changes (webhook arrival / poll detection order) as the tiebreaker, rather than trusting sub-epsilon timestamp differences from two unrelated clocks. Either way, the event is still recorded with `SyncEvent.status = conflict` in the Audit Log, so nothing is silently lost from the record even though it's auto-resolved.
- A `FieldMapping` can set its `conflictPolicy` field to `manual-resolve` (see [data-model.md](data-model.md) — this is a sibling field to `transformConfig`, not a value inside it) to override this default and force the conflict to surface in the UI instead of auto-resolving — useful for fields where auto-resolution would be unacceptable. Since `conflictPolicy` lives on `FieldMapping`, it's only meaningful for `FieldMapping`s that belong to a peer-peer `ApprovedMapping`; it has no effect on consumer-provider `FieldMapping`s, which the Adapter Engine never reconciles against a prior state.

## Ordering and consistency

Sync is asynchronous and eventually consistent:

- **Per-record ordering is guaranteed.** A per-`(mapping, resourceId)` sequential queue ensures two updates to the same record are applied in the order they occurred.
- **Cross-record/cross-mapping ordering is not guaranteed and not required.** Different resources or different mappings may be processed out of order relative to each other.

## Observability hooks

Sync success/failure/skipped-loop/skipped-policy/conflict rates, webhook delivery latency, poller lag (time since `lastRunAt` vs. expected interval), initial-backfill progress/duration, and identity-resolution failures (no-match and ambiguous-match rates) are emitted per `SyncRule` as OpenTelemetry metrics; each individual sync execution is a trace correlated to its `SyncEvent` via `traceId`/`spanId`. See [observability.md](observability.md).
