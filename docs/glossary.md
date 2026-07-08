# Glossary

One-line definitions of every entity and term used across this documentation. See [architecture/data-model.md](architecture/data-model.md) for full entity detail.

## Core components

- **API/UI Layer** — the entry point for humans: registering apps, reviewing/approving mappings, viewing the graph. Never touches raw credentials directly.
- **Spec Registry** — stores raw OpenAPI documents and their parsed IR; owns `ApiSpec` versioning and `SpecDiff` computation.
- **Credential Store** — envelope-encrypted storage for `Credential`s; the only component that can decrypt one, and only for the duration of a single outbound call (`withCredential`).
- **Mapping Review/Approval Service** (a.k.a. **Approval Service**) — turns a `MappingProposal` into an `ApprovedMapping` via per-item accept/edit/reject and partial approval.
- **Event Bus** — the internal decoupling layer between producers of state changes (`SpecIngested`, `MappingApproved`, sync writes) and the services that react to them.
- **SpecIngested** — the event emitted by the Spec Registry once a new `ApiSpec` version is parsed and stored; triggers mapping detection.
- **MappingApproved** — the event emitted by the Approval Service once an `ApprovedMapping` is created/updated; triggers `SyncRule`/`AdapterBinding` instantiation and the graph update.
- **Transformation Executor** — applies a mapping's `FieldMapping`s to convert one app's payload shape into another's; shared by the Sync Engine and Adapter Engine.
- **Outbound Call Executor** — makes the authenticated call to a target/backend app using a credential scoped to that one call; shared by the Sync Engine and Adapter Engine.

## Roles & specs

- **RegisteredApp** — an application in the landscape; may carry a `PROVIDER` spec, a `CONSUMER` spec, or both.
- **ApiSpec** — an OpenAPI document registered for an app, in a given role, parsed into an IR.
- **PROVIDER spec** — an OpenAPI spec describing an API the app actually exposes.
- **CONSUMER spec** — an OpenAPI spec describing what an app needs/expects from the landscape, to be served by a live [Adapter Engine](architecture/adapter-engine.md) endpoint.
- **IR (Intermediate Representation)** — the normalized, protocol-agnostic form (resources → operations → schemas) that a spec is decomposed into; everything downstream (mapping, sync, adapter) reasons over the IR, not the raw OpenAPI document.
- **Credential** — encrypted per-app auth material (API key, OAuth2, basic auth, webhook secret).
- **Spec Adapter** — the conversion layer that turns any protocol description (OpenAPI today; a future GraphQL SDL/AsyncAPI/gRPC proto) into the shared IR; the seam a future non-REST protocol plugs into.
- **Protocol Client/Server interface pair** — the seam behind the Outbound Call Executor (client side) and Adapter Server Runtime (server side) that a future non-REST protocol implements; REST is the first implementation of both.

## Mapping

- **Mapping Engine** — the LLM-based, provider-agnostic component that proposes mappings between two specs.
- **MappingProposal** — the output of one Mapping Engine run over one *directional* pair of specs (`sourceSpecId → targetSpecId`); a peer pair A↔B is always two separate proposals, one per direction.
- **MappingProposalItem** — a single candidate operation- or field-level correspondence within a proposal.
- **confidenceScore** — 0-1 score on a proposal item indicating how certain the Mapping Engine is.
- **ambiguousAlternatives** — alternative plausible targets, surfaced when the top match isn't clearly best; applies to operation-kind and field-kind items alike.
- **unmapped** — flag on a proposal item meaning no counterpart was found for that source element; the item has no `targetRef`.
- **reviewRequired** — flag set on low-confidence items, driving their priority in the review UI.
- **ApprovedMapping** — a human-reviewed, approved mapping; the only thing the Sync Engine and Adapter Engine act on. Always one-directional; two of them, cross-linked, represent a bidirectional sync relationship (see `counterpartMappingId`).
- **counterpartMappingId** — the field on `ApprovedMapping` linking it to the reverse-direction `ApprovedMapping` between the same two specs, when both have been approved.
- **FieldMapping** — one approved field-level correspondence, with its transform (rename/coerce/aggregate/expression).
- **LLMMappingProvider** — the pluggable interface the Mapping Engine calls into; swappable across LLM vendors/models.
- **SpecDiff** — the classification of changes (additive/breaking) between two versions of the same `ApiSpec`.

## Sync

- **Sync Engine** — executes approved peer-to-peer mappings on an ongoing basis (push and/or pull).
- **SyncRule** — the ongoing sync configuration instantiated from one (one-directional) peer-peer `ApprovedMapping`.
- **Scheduler** — the Sync Engine subcomponent that wakes a `SyncRule` when its polling interval elapses.
- **Webhook Receiver** — the Sync Engine subcomponent that accepts inbound change notifications from apps.
- **Poller** — the Sync Engine subcomponent that periodically pulls changes from apps that don't push webhooks.
- **Loop Prevention** — the mechanism that detects and skips propagating a mediator-originated write back to its own source (prevents infinite sync ping-pong).
- **Idempotency key** — a deterministic identifier per outbound write used to detect and skip duplicate deliveries.
- **SyncFieldState** — the last-reconciled value per mapped field per record, shared across both directions of a bidirectional pair; what conflict detection compares incoming changes against.
- **SyncEvent / AuditLog** — the durable, business-level record of every sync execution, adapter call, mapping decision, and credential access.

## Adapter

- **Adapter/Gateway Engine** — hosts a live server implementing a `CONSUMER` spec, resolving requests on demand against real backend apps.
- **Adapter Server Runtime** — the live server process itself, hosting the generated endpoints for a `CONSUMER` spec.
- **Auth Gateway** — validates a caller's mediator-issued adapter token in front of the Adapter Server Runtime.
- **Request Router** — matches an inbound request to its `AdapterEndpoint`.
- **Resolution Planner** — loads an `AdapterEndpoint`'s persisted `AdapterBinding`(s) at request time and re-validates they aren't `stale`; does not re-plan bindings from scratch.
- **Response Aggregator** — merges/aggregates multiple backends' responses per the endpoint's `aggregationStrategy`.
- **AdapterEndpoint** — one operation of a consumer spec, with an aggregation strategy.
- **AdapterBinding** — a binding from one `AdapterEndpoint` to a specific backend app + operation + `ApprovedMapping`, with a `role` and execution order.
- **Aggregation strategy** — how an `AdapterEndpoint` combines results from multiple `AdapterBinding`s (`single` / `fanout-merge` / `collection-union` / `fanout-first-success`).
- **mapping-stale (error)** — the distinct failure reported when a request resolves to an `AdapterBinding` whose `ApprovedMapping` has been marked `stale`, as opposed to a live backend-call failure.

## Landscape overview

- **Graph/Overview Service** — maintains the always-available graph of registered apps and their connections.
- **GraphEdge** — a materialized projection of one mapping/sync/adapter-dependency relationship, for graph rendering.

## Observability

- **OpenTelemetry (OTel)** — the instrumentation standard used across all components for traces, metrics, and logs.
- **OpenTelemetry Collector** — aggregates telemetry from all components and routes it to backing stores.
- **Grafana** — the visualization and alerting layer on top of the telemetry backing stores.
- **Trace / span** — one end-to-end operation (trace) and its per-component-hop breakdown (spans); correlated to `SyncEvent`/`AuditLog` entries via `traceId`/`spanId`.
