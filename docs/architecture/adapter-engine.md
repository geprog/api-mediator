# Adapter / Gateway Engine

The Adapter/Gateway Engine stands up a real, live server for a newly introduced app's `CONSUMER` spec — the OpenAPI spec describing what that app needs from the landscape, rather than an API it exposes itself. Requests to this generated server are resolved on demand by calling into the real registered `PROVIDER` apps, using `ApprovedMapping`s from the same [Mapping Engine](mapping-engine.md) used for data sync.

This is the on-demand counterpart to the [Sync Engine](sync-engine.md): both are consumers of `ApprovedMapping` data, sharing the same Transformation Executor, Outbound Call Executor, Credential Store access pattern, and Audit Log — the Sync Engine pushes proactively, the Adapter Engine resolves on request.

## Binding: decided at approval time, not per request

When a consumer-provider `ApprovedMapping` is approved, the Adapter Engine instantiates:

- An `AdapterEndpoint` per operation in the consumer spec, with an `aggregationStrategy`.
- One or more `AdapterBinding`s under it — each binding a backend app + backend operation + the `ApprovedMapping` that maps between them, with a `role` (primary/fallback/supplement).

These bindings are **persisted, not re-derived per request** — this favors predictability and performance over full per-request dynamic replanning. At request time, the Resolution Planner loads the persisted bindings and only re-validates their health (e.g., that the underlying mapping is not `stale`, see [extensibility.md](extensibility.md)); it does not re-plan bindings from scratch on every call.

## Request pipeline

1. Inbound HTTP request hits the Adapter Server Runtime at the path bound to a consumer operation.
2. An Auth Gateway validates the caller's mediator-issued adapter token (see [security.md](security.md)).
3. Request Router matches the operation to its `AdapterEndpoint`.
4. Resolution Planner loads the endpoint's `AdapterBinding`(s) and their `ApprovedMapping`s.
5. Transformation Executor maps the inbound request's params/body to each backend's expected shape, per binding.
6. Outbound Call Executor calls the backend app(s) — in parallel when bindings are independent, sequentially when one backend's output feeds another's input.
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

## Caching

Responses are cached per `(adapterEndpointId, normalized request params)` with the endpoint's configured `cacheTtl`. Cache entries are invalidated by the same `SyncEvent`s the Sync Engine already produces for the underlying resources — this reuses sync activity as the cache-invalidation signal rather than building a second, separate change-detection mechanism for the adapter.

## Observability hooks

Request rate, latency, and error rate per `AdapterEndpoint`, cache hit rate, and partial-failure/degraded-response rate are emitted as OpenTelemetry metrics. Each inbound request is a trace with spans for auth check, planning, each backend call, transform, and aggregation. See [observability.md](observability.md).
