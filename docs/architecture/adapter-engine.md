# Adapter / Gateway Engine

The Adapter/Gateway Engine stands up a real, live server for a newly introduced app's `CONSUMER` spec — the OpenAPI spec describing what that app needs from the landscape, rather than an API it exposes itself. Requests to this generated server are resolved on demand by calling into the real registered `PROVIDER` apps, using `ApprovedMapping`s from the same [Mapping Engine](mapping-engine.md) used for data sync.

This is the on-demand counterpart to the [Sync Engine](sync-engine.md): both are consumers of `ApprovedMapping` data, sharing the same Transformation Executor, Outbound Call Executor, Credential Store access pattern, and Audit Log — the Sync Engine pushes proactively, the Adapter Engine resolves on request.

## Binding: decided at approval time, not per request

When a consumer-provider `ApprovedMapping` is approved, the Adapter Engine instantiates:

- An `AdapterEndpoint` per operation in the consumer spec, with an `aggregationStrategy`.
- One or more `AdapterBinding`s under it — each binding a backend app + backend operation + the `ApprovedMapping` that maps between them, with a `role` (primary/fallback/supplement) and an `executionOrder`/`dependsOnBindingId` (see [data-model.md](data-model.md)) that decides parallel-vs-sequential execution at request time (see the request pipeline below).

These bindings are **persisted, not re-derived per request** — this favors predictability and performance over full per-request dynamic replanning. At request time, the Resolution Planner loads the persisted bindings and only re-validates their health (e.g., that the underlying mapping is not `stale`, see [extensibility.md](extensibility.md)); it does not re-plan bindings from scratch on every call.

### Role validity per aggregation strategy

`AdapterBinding.role` is only partially meaningful across strategies — the table below is authoritative on which roles a given `aggregationStrategy` actually uses; roles outside this set should not be assigned when configuring an endpoint under that strategy:

| `aggregationStrategy` | Valid `role`(s) | Notes |
|---|---|---|
| `single` | `primary` only | No fallback/supplement possible with one binding. |
| `fanout-merge` | `primary`, `supplement` | `primary` supplies the base object; `supplement` bindings contribute additional fields. No `fallback` — all configured bindings are called every time. |
| `collection-union` | `supplement` only (all bindings equivalent contributors) | There is no "primary" list among equals being unioned; every binding contributes rows to the same result set. `fallback` doesn't apply — a failed contributor is dropped from the union, not substituted. |
| `fanout-first-success` | `primary`, `fallback` | `primary` is tried first; `fallback` bindings are tried in `executionOrder` on failure. No `supplement`. |

## Stale bindings at request time

If the Resolution Planner finds that a loaded `AdapterBinding`'s `ApprovedMapping` is `stale` (see [extensibility.md](extensibility.md)), this is treated as a distinct failure mode from a live backend-call failure — it's reported as a `mapping-stale` error, not a generic upstream error, so operators and callers can tell "the backend is unreachable" apart from "this integration needs re-review." It otherwise follows the same primary/fallback/supplement semantics as a call failure below: a stale `primary`/`fanout-first-success` binding fails the request; a stale `supplement` binding degrades gracefully (or fails the whole request in strict mode). Because an `AdapterBinding` failure is externally visible to a live caller — unlike a `SyncRule` going stale, which only pauses an invisible background job (see [extensibility.md](extensibility.md)) — stale adapter bindings warrant a lower alerting threshold than stale sync rules; see [observability.md](observability.md).

## Request pipeline

1. Inbound HTTP request hits the Adapter Server Runtime at the path bound to a consumer operation.
2. An Auth Gateway validates the caller's mediator-issued adapter token (see [security.md](security.md)).
3. Request Router matches the operation to its `AdapterEndpoint`.
4. Resolution Planner loads the endpoint's `AdapterBinding`(s) and their `ApprovedMapping`s, re-validating that none are `stale` (see *Stale bindings at request time* below).
5. Transformation Executor maps the inbound request's params/body to each backend's expected shape, per binding.
6. Outbound Call Executor calls the backend app(s) grouped by `executionOrder` — bindings sharing an `executionOrder` run in parallel; a binding with `dependsOnBindingId` set runs only after that binding's response is available and receives it as input.
7. Transformation Executor maps each backend response back to the consumer's response schema.
8. Response Aggregator merges/aggregates results per the endpoint's `aggregationStrategy`.
9. The aggregated response is validated against the consumer OpenAPI response schema and returned; the response cache is updated if `cacheTtl` is set.

Full step-by-step walkthrough with sequence diagram: [flows/adapter-request-resolution.md](../flows/adapter-request-resolution.md).

## Aggregation strategies

Configured per `AdapterEndpoint`:

- **`single`** — one backend binding, no aggregation.
- **`fanout-merge`** — combine fields from multiple backends into one consumer object (e.g., profile fields from a CRM merged with entitlement fields from a billing system).
- **`collection-union`** — merge list results from multiple backends into one consumer list (e.g., "list customers" spanning two systems).
- **`fanout-first-success`** — try the `primary` binding, fall back to the next binding on failure.

## Error and partial-failure semantics

- **Primary binding failure** → the request fails with an upstream-error response describing which backend failed.
- **Supplement binding failure** → the request degrades gracefully: partial data is returned along with a warning/metadata field, unless the endpoint is configured in strict mode, in which case any binding failure fails the whole request.
- **Stale binding** → see *Stale bindings at request time* above: same primary/fallback/supplement semantics as a call failure, but reported as `mapping-stale` rather than an upstream error.

## Caching

Responses are cached per `(adapterEndpointId, normalized request params)` with the endpoint's configured `cacheTtl`. Cache entries are invalidated by the same `SyncEvent`s the Sync Engine already produces for the underlying resources — this reuses sync activity as the cache-invalidation signal rather than building a second, separate change-detection mechanism for the adapter.

## Observability hooks

Request rate, latency, and error rate per `AdapterEndpoint`, cache hit rate, and partial-failure/degraded-response rate are emitted as OpenTelemetry metrics. Each inbound request is a trace with spans for auth check, planning, each backend call, transform, and aggregation. See [observability.md](observability.md).
