# Extensibility & Versioning

## Spec update lifecycle

Registered apps evolve their APIs over time. The mediator must react to a new `ApiSpec` version without either silently breaking or forcing disruptive full re-approval every time.

1. A new `ApiSpec` version is ingested by the Spec Registry (see [data-model.md](data-model.md)), which parses it into IR and computes a `SpecDiff` against the previous active version.
2. `SpecDiff` classifies each change:
   - **Additive** — new operation, new optional field, new schema. Nothing existing is affected.
   - **Breaking** — removed operation/field, renamed field, changed type, newly-required field that wasn't required before.
3. **Additive changes** trigger the [Mapping Engine](mapping-engine.md) to run an incremental analysis scoped only to the new elements, producing a small delta `MappingProposal` for review. All existing `ApprovedMapping`s remain active and untouched.
4. **Breaking changes** mark only the `ApprovedMapping` (and derived `SyncRule`/`AdapterBinding`) records that actually reference the changed elements as `status = stale`, pausing their execution. This is a deliberate **delta-review model**: everything else for that app — mappings unaffected by the specific change — keeps running uninterrupted. The user is prompted to re-review just the affected mappings, not the app's entire mapping set.

This lifecycle applies identically whether the changed spec is a `PROVIDER` spec (affecting sync `SyncRule`s) or a `CONSUMER` spec (affecting `AdapterBinding`s) — both are driven by the same `SpecDiff` → stale-marking → targeted re-review path.

**The mechanism is identical, but the operational impact of going `stale` is not.** A stale `SyncRule` pauses a background job silently — nothing external notices until someone checks the graph or a Grafana alert fires. A stale `AdapterBinding`, by contrast, is externally visible the moment a live caller hits that operation: see *Stale bindings at request time* in [adapter-engine.md](adapter-engine.md) for the distinct `mapping-stale` failure this produces. Treat "delta-review model applies identically" as a statement about *how staleness is computed and scoped*, not about *how urgently a human needs to act on it* — adapter staleness should generally be reviewed faster than sync staleness, since it directly breaks a live consumer in the meantime.

## Beyond REST/OpenAPI

The initial version is scoped to REST APIs described by OpenAPI (see [overview.md](overview.md)). The architecture keeps this replaceable through two seams, so that adding a future protocol does not require rewriting the mapping/sync/adapter core:

1. **Spec Adapter** — a conversion layer that turns any protocol description (OpenAPI today; a future GraphQL SDL, AsyncAPI, or gRPC proto definition) into the same internal IR (resources → operations → schemas) used everywhere else in the system. The Mapping Engine, Approval Service, and data model already operate purely on this IR — they have no OpenAPI-specific logic baked in.
2. **Protocol Client/Server interface pair** — behind the Sync Engine's Outbound Call Executor (the client side, calling out to a registered app) and the Adapter Engine's Adapter Server Runtime (the server side, serving a consumer spec). REST is the first implementation of both sides of this pair.

Adding a new protocol later means implementing a new Spec Adapter and a new Protocol Client/Server pair — not touching the Mapping Engine, Approval Service, Sync Engine's transformation/loop-prevention logic, or the Adapter Engine's binding/aggregation logic.
