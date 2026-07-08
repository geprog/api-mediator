# Glossary

One-line definitions of every entity and term used across this documentation. See [architecture/data-model.md](architecture/data-model.md) for full entity detail.

## Core components

- **API/UI Layer** — the entry point for humans: registering apps, reviewing/approving mappings, viewing the graph. Credential material passes through it write-only at registration; secrets are never returned.
- **Spec Registry** — stores raw OpenAPI documents and their parsed IR; owns `ApiSpec` versioning and `SpecDiff` computation.
- **Credential Store** — envelope-encrypted storage for `Credential`s; the only component that can decrypt one, and only for the duration of a single outbound call (`withCredential`).
- **Mapping Review/Approval Service** (a.k.a. **Approval Service**) — turns a `MappingProposal` into an `ApprovedMapping` via per-item accept/edit/reject and partial approval.
- **Event Bus** — the internal decoupling layer between producers of state changes (`SpecIngested`, `MappingApproved`, sync writes) and the services that react to them.
- **SpecIngested** — the event emitted by the Spec Registry once a new `ApiSpec` version is parsed and stored; triggers mapping detection.
- **MappingApproved** — the event emitted by the Approval Service once an `ApprovedMapping` is created/updated; triggers `SyncRule`/`AdapterBinding` instantiation and the graph update.
- **Transformation Executor** — applies a mapping's `FieldMapping`s to convert one app's payload shape into another's; shared by the Sync Engine and Adapter Engine.
- **Outbound Call Executor** — makes the authenticated call to a target/backend app using a credential scoped to that one call; shared by the Sync Engine and Adapter Engine.
- **Operator / Viewer** — the two authorization roles on the mediator's own API/UI: `operator` may mutate (register apps, approve mappings, compose endpoints, enable rules), `viewer` is read-only. Every mutation records the authenticated identity (see [architecture/security.md](architecture/security.md)).

## Roles & specs

- **RegisteredApp** — an application in the landscape; may carry a `PROVIDER` spec, a `CONSUMER` spec, or both.
- **ApiSpec** — an OpenAPI document registered for an app, in a given role, parsed into an IR.
- **PROVIDER spec** — an OpenAPI spec describing an API the app actually exposes.
- **CONSUMER spec** — an OpenAPI spec describing what an app needs/expects from the landscape, to be served by a live [Adapter Engine](architecture/adapter-engine.md) endpoint. Never called by the mediator; if the same software also exposes an API, that is a separate, independent `PROVIDER` registration on the same app.
- **IR (Intermediate Representation)** — the normalized, protocol-agnostic form (resources → operations → schemas) that a spec is decomposed into; everything downstream (mapping, sync, adapter) reasons over the IR, not the raw OpenAPI document.
- **Credential** — encrypted per-app auth material (API key, OAuth2, basic auth, webhook secret).
- **Spec Adapter** — the conversion layer that turns any protocol description (OpenAPI today; a future GraphQL SDL/AsyncAPI/gRPC proto) into the shared IR; the seam a future non-REST protocol plugs into.
- **Protocol Client/Server interface pair** — the seam behind the Outbound Call Executor (client side) and Adapter Server Runtime (server side) that a future non-REST protocol implements; REST is the first implementation of both.

## Mapping

- **Mapping Engine** — the LLM-based, provider-agnostic component that proposes mappings between two specs, in two stages (shortlist, then detail).
- **Shortlist pass (stage 1)** — one summary-level LLM call per *unordered* spec pair that shortlists plausibly-corresponding resource pairs; deliberately recall-biased, reused by both directional analyses.
- **Detail pass (stage 2)** — the full per-resource-pair LLM call producing operation/field correspondences; runs only on shortlisted pairs.
- **ResourceShortlist** — the validated structured output of the shortlist pass (candidate resource pairs with confidence + rationale), persisted on the `MappingProposal` as `shortlistResult` and reviewable via the manual "analyze anyway" escape hatch.
- **MappingProposal** — the output of one Mapping Engine run over one *directional* pair of specs (`sourceSpecId → targetSpecId`); a peer pair A↔B is always two separate proposals, one per direction. A consumer-provider pair is a *single* proposal (consumer as source) whose field items cover both request and response phases.
- **MappingProposalItem** — a single candidate operation- or field-level correspondence within a proposal.
- **confidenceScore** — 0-1 score on a proposal item indicating how certain the Mapping Engine is.
- **ambiguousAlternatives** — alternative plausible targets, surfaced when the top match isn't clearly best; applies to operation-kind and field-kind items alike.
- **unmapped** — flag on a proposal item meaning no counterpart was found for that source element; the item has no `targetRef`.
- **reviewRequired** — flag set on low-confidence items, driving their priority in the review UI.
- **ApprovedMapping** — a human-reviewed, approved mapping; the only thing the Sync Engine and Adapter Engine act on. No transform in it ever runs in reverse: peer-peer mappings are one-directional (two of them, cross-linked, represent a bidirectional sync relationship — see `counterpartMappingId`); consumer-provider mappings run consumer → provider and carry separate request- and response-phase transform sets for the adapter round trip.
- **counterpartMappingId** — the field on `ApprovedMapping` linking it to the reverse-direction `ApprovedMapping` between the same two spec lineages (version-agnostic), when both have been approved. Peer-peer only — consumer-provider mappings have no reverse direction.
- **FieldMapping** — one approved field-level correspondence, with its transform (rename/coerce/aggregate/expression); on consumer-provider mappings each row carries a `phase` (request/response).
- **phase** (`request` | `response`) — which half of the adapter round trip a consumer-provider `FieldMapping` transforms: `request` (consumer → backend) or `response` (backend → consumer). The two phases are independent transform sets, proposed and reviewed together, never inverses of each other.
- **OperationMapping** — one approved operation-level correspondence under an `ApprovedMapping`, carrying an `action` (create/read/update/delete); how the executing engines know which target operation to call.
- **ParameterMapping** — one approved operation-input correspondence (path/query/header parameter) under a consumer-provider `ApprovedMapping`, scoped to its `OperationMapping`; how the adapter fills a backend operation's parameters from the consumer's request. Peer-peer mappings have none — sync fills target parameters from the `RecordLink`.
- **action** — the CRUD classification on an `OperationMapping`, heuristically derived from the target IR and correctable at review; the Sync Engine selects the target operation whose action matches the change type it is propagating.
- **identity key** (`isIdentityKey`) — the one confirmed `FieldMapping` per mapped resource pair whose values identify the same record in both apps; human-confirmed at review, required before a `SyncRule` can be enabled.
- **identityCandidate** — the Mapping Engine's suggested identity key on a field-level proposal item; a suggestion only, never auto-confirmed.
- **LLMMappingProvider** — the pluggable interface the Mapping Engine calls into for both stages (`shortlistResourcePairs` + `generateMappingProposal`); swappable across LLM vendors/models.
- **SpecDiff** — the classification of changes (additive/breaking) between two versions of the same `ApiSpec`.
- **Spec lineage** — the succession of versions of one (app, role) `ApiSpec`; the version-agnostic identity used by `counterpartMappingId` and the re-pinning rule (see [architecture/extensibility.md](architecture/extensibility.md)).
- **Re-pinning** — the automatic update of an active `ApprovedMapping`'s `sourceSpecId`/`targetSpecId` to a newly ingested spec version when the diff proves the mapping's referenced elements are unchanged; keeps active mappings pointing at active spec versions.
- **Successor mapping** — the replacement `ApprovedMapping` produced by re-reviewing a `stale` one against the new spec version; adopting it re-points the stale mapping's `SyncRule`s/`AdapterBinding`s in place (state and composition preserved) and marks the stale row `superseded` (see [architecture/extensibility.md](architecture/extensibility.md)).

## Sync

- **Sync Engine** — executes approved peer-to-peer mappings on an ongoing basis (push and/or pull).
- **SyncRule** — the ongoing sync configuration for one mapped resource pair of a (one-directional) peer-peer `ApprovedMapping` — the unit that owns its identity key, backfill, poll cursor, snapshot, and webhook subscription.
- **Scheduler** — the Sync Engine subcomponent that wakes a `SyncRule` when its polling interval elapses.
- **Webhook Receiver** — the Sync Engine subcomponent that accepts inbound change notifications from apps.
- **Poller** — the Sync Engine subcomponent that periodically pulls changes from apps that don't push webhooks.
- **Loop Prevention** — the mechanism that detects and skips propagating a mediator-originated write back to its own source (prevents infinite sync ping-pong); covers content echoes via per-side reconciled baselines in `SyncFieldState` (with the recently-written cache as fast path) and create/delete echoes via `RecordLink` state.
- **Identity Resolution** — the pipeline stage that classifies a detected change (create/update/delete) and resolves — or establishes — the record's `RecordLink`.
- **RecordLink** — the persisted pairing of one record's native id in app A with the same logical record's native id in app B; established by create propagation, identity-key match, or manual linking; tombstoned (not deleted) on deletion.
- **Tombstone** — the `tombstoned` state of a `RecordLink` after either side's record is deleted: reason `propagated-delete` (the mediator's own deletion — recognizes the other side's delete echo) or `observed-delete` (deletion seen but not propagated — the pair is severed). Either prevents a slower poll cycle from resurrecting the record.
- **Initial backfill** — the one-time reconciliation run when a `SyncRule` is first enabled, before its transports go live; `link-only` (default: link + seed baselines, write nothing) or `push` (source is the initial source of truth).
- **deletePropagation** — per-`SyncRule` policy for source-side deletions: `ignore` (default; recorded as `skipped-policy` and the link tombstoned `observed-delete`, never silently dropped) or `propagate`.
- **Idempotency key** — a deterministic identifier per outbound write (hashing the mapping, the source record's native id, the payload, *and* the prior reconciled state — a distinguished *none* marker for creates — so value reverts aren't misread as duplicates) used to detect and skip duplicate deliveries within a bounded lookback window.
- **Parked (dead-letter) event** — a sync write that exhausted its retry ceiling; recorded, alerted, and skipped past so it doesn't block its record's queue. Superseded by any later successful sync of the same record; manually replayable through the normal pipeline.
- **SyncFieldState** — the last-reconciled value per mapped field per linked record (`RecordLink`), hashed **per side** in each side's own canonical representation, plus each side's latest observed hash; shared across both directions of a bidirectional pair. What echo and conflict detection compare against — always same-side, never across the transform.
- **SyncEvent / AuditLog** — the durable, business-level record of every sync execution, adapter call, mapping decision, and credential access.

## Adapter

- **Adapter/Gateway Engine** — hosts a live server implementing a `CONSUMER` spec, resolving requests on demand against real backend apps.
- **Virtual provider** — how to read a generated adapter server: the mediator hosts the consumer's wished-for API as if it were a registered provider app, wired to the real backends via approved mappings; the mediator never calls the consumer itself.
- **Adapter Server Runtime** — the live server process itself, hosting the generated endpoints for a `CONSUMER` spec.
- **Auth Gateway** — validates a caller's mediator-issued adapter token in front of the Adapter Server Runtime.
- **Request Router** — matches an inbound request to its `AdapterEndpoint`.
- **Resolution Planner** — loads an `AdapterEndpoint`'s persisted `AdapterBinding`(s) at request time and re-validates they aren't `stale`; does not re-plan bindings from scratch.
- **Response Aggregator** — merges/aggregates multiple backends' responses per the endpoint's `aggregationStrategy`.
- **AdapterEndpoint** — one operation of a consumer spec, with an aggregation strategy.
- **AdapterBinding** — a binding from one `AdapterEndpoint` to a specific backend app + operation + `ApprovedMapping`, with a `role` and execution order.
- **Aggregation strategy** — how an `AdapterEndpoint` combines results from multiple `AdapterBinding`s (`single` / `fanout-merge` / `collection-union` / `fanout-first-success`).
- **Endpoint composition** — the human decision that combines multiple approved bindings into one serving `AdapterEndpoint` (strategy, roles, execution order, strictness, caching); single-binding endpoints skip it and activate automatically. See [flows/adapter-endpoint-composition.md](flows/adapter-endpoint-composition.md).
- **composition-required** — `AdapterEndpoint` status while a newly attached `proposed` binding awaits a composition decision; the endpoint keeps serving its previous active configuration meanwhile.
- **mapping-stale (error)** — the distinct failure reported when a request resolves to an `AdapterBinding` whose `ApprovedMapping` has been marked `stale`, as opposed to a live backend-call failure.
- **not-yet-mapped (error)** — the distinct response for a consumer operation that has no approved binding yet; deliberately distinguishable from a 404 and from an upstream failure.
- **mediator-transform-error** — the distinct failure when an aggregated response fails validation against the consumer's response schema: a mediator-side mapping/composition defect, never returned as if it were valid data.
- **backend-disabled** — the distinct failure cause when a request resolves to a binding whose backend app has been disabled (see app lifecycle in [architecture/extensibility.md](architecture/extensibility.md)).

## Landscape overview

- **Graph/Overview Service** — maintains the always-available graph of registered apps and their connections.
- **GraphEdge** — a materialized projection of one mapping/sync/adapter-dependency relationship, for graph rendering.

## Observability

- **OpenTelemetry (OTel)** — the instrumentation standard used across all components for traces, metrics, and logs.
- **OpenTelemetry Collector** — aggregates telemetry from all components and routes it to backing stores.
- **Grafana** — the visualization and alerting layer on top of the telemetry backing stores.
- **Trace / span** — one end-to-end operation (trace) and its per-component-hop breakdown (spans); correlated to `SyncEvent`/`AuditLog` entries via `traceId`/`spanId`.
