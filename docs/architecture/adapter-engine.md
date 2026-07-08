# Adapter / Gateway Engine

The Adapter/Gateway Engine stands up a real, live server for a newly introduced app's `CONSUMER` spec — the OpenAPI spec describing what that app needs from the landscape, rather than an API it exposes itself. Requests to this generated server are resolved on demand by calling into the real registered `PROVIDER` apps, using `ApprovedMapping`s from the same [Mapping Engine](mapping-engine.md) used for data sync.

The generated server is best read as a **virtual provider**: the mediator takes the consumer's wished-for API and hosts it as if it were a registered app, wired to the real landscape through approved mappings. Traffic flows one way — the consumer calls the mediator; **the mediator never calls the consumer**. A consumer-provider `ApprovedMapping` therefore always runs consumer = source, provider = target, and carries two independent transform phases for the round trip: request-phase `FieldMapping`s/`ParameterMapping`s (consumer → backend) and response-phase `FieldMapping`s (backend → consumer) — see [data-model.md](data-model.md). If the software behind a consumer also exposes an API of its own, that API is registered as a `PROVIDER` spec on the same `RegisteredApp` and participates in sync and as an adapter backend for *other* consumers like any provider — the two roles' flows are fully independent.

This is the on-demand counterpart to the [Sync Engine](sync-engine.md): both are consumers of `ApprovedMapping` data, sharing the same Transformation Executor, Outbound Call Executor, Credential Store access pattern, and Audit Log — the Sync Engine pushes proactively, the Adapter Engine resolves on request.

## Binding: decided at composition time, not per request

Bindings are configured once — when mappings are approved and the endpoint is composed — and then only *executed* at request time. When a consumer-provider `ApprovedMapping` is approved, the Adapter Engine derives the affected consumer operations from the mapping's `OperationMapping`s (see [data-model.md](data-model.md)) and, per operation:

- **First approved binding for an operation** → an `AdapterEndpoint` is created and activated immediately with safe defaults: `aggregationStrategy = single`, the binding as `primary`, no caching, non-strict mode. One backend leaves nothing ambiguous to decide, so no human composition step is needed to start serving.
- **A further binding for an operation that already has one** → the new binding attaches as `status = proposed` and the endpoint transitions to `composition-required`: how multiple backends combine (merge vs. union vs. fallback, roles, ordering, strictness, caching) is a business decision the mediator never guesses. The endpoint keeps serving its previous active configuration until a human completes composition. Full walkthrough: [flows/adapter-endpoint-composition.md](../flows/adapter-endpoint-composition.md).

An `AdapterBinding` is a backend app + backend operation + the `ApprovedMapping` that maps between them — `backendOperationId` chosen from that mapping's approved `OperationMapping`s (their target side: consumer-provider mappings always run consumer = source, provider = target) — with a `role` (primary/fallback/supplement) and an `executionOrder`/`dependsOnBindingId` (see [data-model.md](data-model.md)) that decides parallel-vs-sequential execution at request time (see the request pipeline below).

Consumer operations with no approved mapping yet are still served by the Adapter Server Runtime (the runtime hosts the full consumer spec surface), but return a distinct `not-yet-mapped` error — deliberately distinguishable from both a 404 (wrong path) and an upstream failure, so the consumer team can tell "not wired up yet" apart from "broken".

These bindings are **persisted, not re-derived per request** — this favors predictability and performance over full per-request dynamic replanning. At request time, the Resolution Planner loads the persisted bindings and only re-validates their health (e.g., that the underlying mapping is not `stale`, see [extensibility.md](extensibility.md)); it does not re-plan bindings from scratch on every call.

### Role validity per aggregation strategy

`AdapterBinding.role` is only partially meaningful across strategies — the table below is authoritative on which roles a given `aggregationStrategy` actually uses; roles outside this set should not be assigned when configuring an endpoint under that strategy:

| `aggregationStrategy` | Valid `role`(s) | Notes |
|---|---|---|
| `single` | `primary` only | No fallback/supplement possible with one binding. |
| `fanout-merge` | `primary`, `supplement` | `primary` supplies the base object; `supplement` bindings contribute additional fields. No `fallback` — all configured bindings are called every time. |
| `collection-union` | `supplement` only (all bindings equivalent contributors) | There is no "primary" list among equals being unioned; every binding contributes rows to the same result set. `fallback` doesn't apply — a failed contributor is dropped from the union, not substituted. |
| `fanout-first-success` | `primary`, `fallback` | `primary` is tried first; `fallback` bindings are tried in `executionOrder` on failure. No `supplement`. |

Write operations constrain this further: a write endpoint is always `single` — see *Write operations* below.

`executionOrder` and `dependsOnBindingId` are similarly strategy-scoped:

- Under the parallel strategies (`fanout-merge`, `collection-union`), equal `executionOrder` means parallel execution. `dependsOnBindingId` is valid under `fanout-merge` only — the "one backend's output feeds another's input" case, e.g. a `supplement` that needs an id from the `primary`'s response — and forces sequencing regardless of order values.
- Under `fanout-first-success`, `executionOrder` is a **strict total order** over the fallback chain — ties are invalid and rejected at composition, because "try two in parallel and take whichever succeeds first" is a different (unsupported) semantic than fallback. `dependsOnBindingId` does not apply: the bindings are alternatives, not collaborators.
- Under `single`, neither field is meaningful.

## Stale bindings at request time

If the Resolution Planner finds that a loaded `AdapterBinding`'s `ApprovedMapping` is `stale` (see [extensibility.md](extensibility.md)), this is treated as a distinct failure mode from a live backend-call failure — it's reported as a `mapping-stale` error, not a generic upstream error, so operators and callers can tell "the backend is unreachable" apart from "this integration needs re-review." It otherwise follows the same primary/fallback/supplement semantics as a call failure below: a stale `primary`/`fanout-first-success` binding fails the request; a stale `supplement` binding degrades gracefully (or fails the whole request in strict mode). Because an `AdapterBinding` failure is externally visible to a live caller — unlike a `SyncRule` going stale, which only pauses an invisible background job (see [extensibility.md](extensibility.md)) — stale adapter bindings warrant a lower alerting threshold than stale sync rules; see [observability.md](observability.md).

## Request pipeline

1. Inbound HTTP request hits the Adapter Server Runtime at the path bound to a consumer operation.
2. An Auth Gateway validates the caller's mediator-issued adapter token (see [security.md](security.md)).
3. Request Router matches the operation to its `AdapterEndpoint`.
4. Resolution Planner loads the endpoint's `AdapterBinding`(s) and their `ApprovedMapping`s, re-validating that none are `stale` (see *Stale bindings at request time* below).
5. Transformation Executor maps the inbound request to each backend's expected shape, per binding: the mapping's **request-phase** `FieldMapping`s for body fields, plus its `OperationMapping`'s `ParameterMapping`s for path/query/header inputs (see [data-model.md](data-model.md)).
6. Outbound Call Executor calls the backend app(s) grouped by `executionOrder` — bindings sharing an `executionOrder` run in parallel; a binding with `dependsOnBindingId` set runs only after that binding's response is available and receives it as input.
7. Transformation Executor maps each backend response back to the consumer's response schema via the mapping's **response-phase** `FieldMapping`s — an independent approved transform set, never an inversion of the request phase.
8. Response Aggregator merges/aggregates results per the endpoint's `aggregationStrategy`.
9. The aggregated response is validated against the consumer OpenAPI response schema and returned; the response cache is updated if `cacheTtl` is set.

Full step-by-step walkthrough with sequence diagram: [flows/adapter-request-resolution.md](../flows/adapter-request-resolution.md).

## Aggregation strategies

Configured per `AdapterEndpoint`:

- **`single`** — one backend binding, no aggregation.
- **`fanout-merge`** — combine fields from multiple backends into one consumer object (e.g., profile fields from a CRM merged with entitlement fields from a billing system).
- **`collection-union`** — merge list results from multiple backends into one consumer list (e.g., "list customers" spanning two systems). Duplicates are collapsed only where the mediator can *know* two rows are the same record: if the contributing backends are peer-synced, existing `RecordLink`s (see [data-model.md](data-model.md)) identify cross-backend duplicates and linked pairs merge into one row (field conflicts resolved by `executionOrder` precedence); alternatively a **dedup key** — a field of the consumer schema — can be configured at composition time (see [flows/adapter-endpoint-composition.md](../flows/adapter-endpoint-composition.md)). With neither links nor a key, no dedup is attempted: duplicates are expected, and each row is annotated with its source backend rather than pretending a merge happened.
- **`fanout-first-success`** — try the `primary` binding, fall back to the next binding on failure.

## Write operations

A consumer spec is not read-only — it can declare create/update/delete operations the consumer wants to perform against the landscape. These are supported, with one deliberate restriction: **a write endpoint always uses `aggregationStrategy = single`, with exactly one active binding.** Fanning a write out to multiple backends is a distributed transaction (partial success leaves the landscape inconsistent, with no compensation mechanism), and `fanout-first-success` is unsafe for writes: a primary that timed out may in fact have succeeded, so retrying against a fallback duplicates the side effect. Neither is worth the complexity at this system's scale — a consumer that needs the same data in multiple backends gets it via peer-peer sync *between those backends*, not via a fanned-out adapter write.

- **Phases** — a write's request body is transformed via the mapping's request-phase `FieldMapping`s (plus `ParameterMapping`s for path/query inputs); the backend's response — typically the stored resource — maps back via the response phase, exactly like a read (see [data-model.md](data-model.md)).
- **Idempotency** — write requests get the same deterministic idempotency treatment as sync writes, via the shared Outbound Call Executor: a caller-supplied idempotency key (if the consumer operation declares one) is passed through; otherwise a deterministic key is derived from the request. Duplicate deliveries are deduplicated exactly as in [sync-engine.md](sync-engine.md).
- **Caching** — write responses are never cached, and a successful write immediately invalidates cached entries for endpoints backed by the same backend resource, complementing the `SyncEvent`-driven invalidation below.
- **Interplay with sync** — an adapter write to a backend that also participates in peer-peer sync is a *genuine* change from the Sync Engine's perspective: it is deliberately **not** tagged in the loop-prevention cache, so the backend's own webhook/poll picks it up and propagates it to that backend's sync peers like any other edit. Loop-prevention tagging is only for the Sync Engine's own writes, which must not bounce back to their source.
- **Failure semantics** — strict by definition: any error fails the request with the upstream error surfaced. There is no partial/degraded response for a write.

## Error and partial-failure semantics

- **Primary binding failure** → the request fails with an upstream-error response describing which backend failed.
- **Supplement binding failure** → the request degrades gracefully: partial data is returned along with a warning/metadata field, unless the endpoint is configured in strict mode, in which case any binding failure fails the whole request.
- **Stale binding** → see *Stale bindings at request time* above: same primary/fallback/supplement semantics as a call failure, but reported as `mapping-stale` rather than an upstream error.
- **Disabled backend** → a binding whose backend app has been disabled (see app lifecycle in [extensibility.md](extensibility.md)) follows the same role/strictness semantics as a call failure, reported with a distinct `backend-disabled` cause.
- **Consumer-schema validation failure** (pipeline step 9) → the aggregated response failed validation against the consumer's OpenAPI response schema. This is a mediator-side mapping/composition defect, not a backend failure, and is reported as a distinct `mediator-transform-error` — the mediator never returns a response that violates the contract the consumer coded against. Occurrences are logged and alerted (see [observability.md](observability.md)): each one is a bug to fix, not an operational blip.

## Caching

Responses of read operations are cached per `(adapterEndpointId, normalized request params)` with the endpoint's configured `cacheTtl` (default: no caching until composed otherwise). Invalidation has three sources, with honestly different coverage:

- **Sync activity** — the same `SyncEvent`s the Sync Engine already produces for the underlying resources; this reuses sync as the change-detection signal rather than building a second mechanism. It only covers backends that actually participate in peer-peer sync.
- **Adapter writes** — a successful write through the adapter invalidates entries backed by the same backend resource (see *Write operations* above).
- **TTL** — the only *guaranteed* bound on staleness. A backend resource that is neither peer-synced nor written through the adapter has **no change-detection signal at all**; for such endpoints the TTL is the entire freshness story, and the composition UI states this when `cacheTtl` is being set (see [flows/adapter-endpoint-composition.md](../flows/adapter-endpoint-composition.md)).

Invalidation granularity is deliberately coarse: a change signal for a backend resource drops **all** cached responses of every endpoint bound to that resource, rather than attempting to compute which parameterized queries contain the changed record. Coarse invalidation costs cache hit rate; it never costs correctness.

## Observability hooks

Request rate, latency, and error rate per `AdapterEndpoint`, cache hit rate, and partial-failure/degraded-response rate are emitted as OpenTelemetry metrics. Each inbound request is a trace with spans for auth check, planning, each backend call, transform, and aggregation. See [observability.md](observability.md).
