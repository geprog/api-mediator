# Flow: Adapter Endpoint Composition

How approved consumer-provider mappings become live `AdapterEndpoint`s — and who decides the aggregation semantics when more than one backend can serve the same consumer operation. The split follows the same philosophy as mapping approval (see [mapping-review-and-approval.md](mapping-review-and-approval.md)): anything with only one sensible answer happens automatically; anything that is a real decision is made by a human, never guessed. Mapping review decides the *data* semantics (which fields/operations correspond); composition decides the *serving* semantics (how multiple approved backends combine into one endpoint).

## Steps

1. The Approval Service emits `MappingApproved` for a consumer-provider `ApprovedMapping` (see [mapping-review-and-approval.md](mapping-review-and-approval.md)).
2. The Adapter Engine reads the mapping's `OperationMapping`s (see [architecture/data-model.md](../architecture/data-model.md)) to determine which consumer operations now have an approved backend correspondence, and per operation finds the existing `AdapterEndpoint` or creates one.
3. Per consumer operation:
   - **No prior binding** → the endpoint is created with safe defaults — `aggregationStrategy = single`, the new `AdapterBinding` as `primary` (its `backendOperationId` taken from the `OperationMapping`), no caching, non-strict mode — and set `active` immediately. One backend leaves nothing ambiguous, so it starts serving without further ceremony.
   - **Existing binding(s)** → the new binding attaches with `status = proposed` and the endpoint transitions to `composition-required`. The previously active configuration keeps serving unchanged — approving a new mapping never disrupts a live endpoint.
4. `composition-required` endpoints surface in the UI (and as a Grafana alert, see [architecture/observability.md](../architecture/observability.md)) for an explicit composition decision. The composer chooses:
   - the `aggregationStrategy` (`single` / `fanout-merge` / `collection-union` / `fanout-first-success`),
   - each binding's `role`, constrained by the role-validity table in [architecture/adapter-engine.md](../architecture/adapter-engine.md),
   - `executionOrder` / `dependsOnBindingId` for parallel, sequential, or chained execution,
   - strict vs. degraded partial-failure mode, and `cacheTtl` (default: no caching).
5. The Adapter Engine validates the composition — role-validity table, and write operations must remain `single` (see *Write operations* in [architecture/adapter-engine.md](../architecture/adapter-engine.md)) — then activates it: `proposed` bindings become `active` and the endpoint returns to `active`.
6. The Graph Service upserts the adapter-dependency `GraphEdge`s for the new/changed bindings (see [graph-overview.md](graph-overview.md)).

Consumer operations that have no approved mapping at all are still served by the Adapter Server Runtime, as a distinct `not-yet-mapped` error — visible to the caller, but clearly distinguished from a 404 or an upstream failure (see [architecture/adapter-engine.md](../architecture/adapter-engine.md)).

## Sequence diagram

```mermaid
sequenceDiagram
    participant Appr as Approval Service
    participant Bus as Event Bus
    participant Adapt as Adapter Engine
    participant U as User (composer)
    participant Graph as Graph Service

    Appr-->>Bus: MappingApproved (consumer-provider)
    Bus->>Adapt: derive affected consumer operations (OperationMappings)
    alt first binding for this operation
        Adapt->>Adapt: create endpoint (single/primary, no cache), activate
    else endpoint already has binding(s)
        Adapt->>Adapt: attach binding as proposed; endpoint -> composition-required
        U->>Adapt: choose strategy, roles, order, strictness, cacheTtl
        Adapt->>Adapt: validate (role table; write => single); activate
    end
    Adapt-->>Graph: upsert adapter-dependency edge(s)
```

## Notes

- Recomposition reuses this same flow: changing an `active` endpoint's strategy, roles, or `cacheTtl` is the same UI action minus the triggering approval. A binding whose mapping goes `stale` (see [architecture/extensibility.md](../architecture/extensibility.md)) keeps its composed configuration and resumes serving when the mapping is re-approved — staleness pauses a binding, it does not decompose the endpoint.
- The single-binding auto-activation is what keeps the common case ("one provider offers what the consumer asked for") zero-friction: registering a consumer app whose needs each map to exactly one backend produces a fully live adapter server with no composition step at all.
