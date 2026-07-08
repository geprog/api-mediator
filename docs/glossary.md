# Glossary

One-line definitions of every entity and term used across this documentation. See [architecture/data-model.md](architecture/data-model.md) for full entity detail.

## Roles & specs

- **RegisteredApp** — an application in the landscape; may carry a `PROVIDER` spec, a `CONSUMER` spec, or both.
- **ApiSpec** — an OpenAPI document registered for an app, in a given role, parsed into an IR.
- **PROVIDER spec** — an OpenAPI spec describing an API the app actually exposes.
- **CONSUMER spec** — an OpenAPI spec describing what an app needs/expects from the landscape, to be served by a live [Adapter Engine](architecture/adapter-engine.md) endpoint.
- **IR (Intermediate Representation)** — the normalized, protocol-agnostic form (resources → operations → schemas) that a spec is decomposed into; everything downstream (mapping, sync, adapter) reasons over the IR, not the raw OpenAPI document.
- **Credential** — encrypted per-app auth material (API key, OAuth2, basic auth, webhook secret).

## Mapping

- **Mapping Engine** — the LLM-based, provider-agnostic component that proposes mappings between two specs.
- **MappingProposal** — the output of one Mapping Engine run over a pair of specs.
- **MappingProposalItem** — a single candidate operation- or field-level correspondence within a proposal.
- **confidenceScore** — 0-1 score on a proposal item indicating how certain the Mapping Engine is.
- **ambiguousAlternatives** — alternative plausible targets for a field, surfaced when the top match isn't clearly best.
- **reviewRequired** — flag set on low-confidence items, driving their priority in the review UI.
- **ApprovedMapping** — a human-reviewed, approved mapping; the only thing the Sync Engine and Adapter Engine act on.
- **FieldMapping** — one approved field-level correspondence, with its transform (rename/coerce/aggregate/expression).
- **LLMMappingProvider** — the pluggable interface the Mapping Engine calls into; swappable across LLM vendors/models.
- **SpecDiff** — the classification of changes (additive/breaking) between two versions of the same `ApiSpec`.

## Sync

- **Sync Engine** — executes approved peer-to-peer mappings on an ongoing basis (push and/or pull).
- **SyncRule** — the ongoing sync configuration instantiated from a peer-peer `ApprovedMapping`.
- **Webhook Receiver** — the Sync Engine subcomponent that accepts inbound change notifications from apps.
- **Poller** — the Sync Engine subcomponent that periodically pulls changes from apps that don't push webhooks.
- **Loop Prevention** — the mechanism that detects and skips propagating a mediator-originated write back to its own source (prevents infinite sync ping-pong).
- **Idempotency key** — a deterministic identifier per outbound write used to detect and skip duplicate deliveries.
- **SyncEvent / AuditLog** — the durable, business-level record of every sync execution, adapter call, mapping decision, and credential access.

## Adapter

- **Adapter/Gateway Engine** — hosts a live server implementing a `CONSUMER` spec, resolving requests on demand against real backend apps.
- **AdapterEndpoint** — one operation of a consumer spec, with an aggregation strategy.
- **AdapterBinding** — a binding from one `AdapterEndpoint` to a specific backend app + operation + `ApprovedMapping`.
- **Aggregation strategy** — how an `AdapterEndpoint` combines results from multiple `AdapterBinding`s (`single` / `fanout-merge` / `collection-union` / `fanout-first-success`).

## Landscape overview

- **Graph/Overview Service** — maintains the always-available graph of registered apps and their connections.
- **GraphEdge** — a materialized projection of one mapping/sync/adapter-dependency relationship, for graph rendering.

## Observability

- **OpenTelemetry (OTel)** — the instrumentation standard used across all components for traces, metrics, and logs.
- **OpenTelemetry Collector** — aggregates telemetry from all components and routes it to backing stores.
- **Grafana** — the visualization and alerting layer on top of the telemetry backing stores.
- **Trace / span** — one end-to-end operation (trace) and its per-component-hop breakdown (spans); correlated to `SyncEvent`/`AuditLog` entries via `traceId`/`spanId`.
