# Architecture Overview

## Purpose

The mediator sits in the middle of a software landscape of REST APIs (each described by an OpenAPI spec) and provides two capabilities on top of a shared foundation of spec ingestion and AI-assisted mapping:

1. **Cross-app data mapping & sync** — keep data consistent across independently-owned apps.
2. **Live adapter server generation** — let a newly introduced app describe what it needs from the landscape, and have the mediator serve that need immediately from real data.

Both capabilities are built on the same core idea: a **mapping** between two OpenAPI specs, detected with LLM assistance, reviewed and approved by a human, and then executed — either proactively (sync) or on demand (adapter).

## Components

| Component | Responsibility |
|---|---|
| **API/UI Layer** | Entry point for humans: registering apps, reviewing/approving mappings, viewing the landscape graph, viewing monitoring links. Never touches raw credentials directly — always goes through the Credential Store's scoped accessor. |
| **Spec Registry** | Stores raw OpenAPI documents and a normalized Intermediate Representation (IR: resources → operations → schemas). Owns spec versioning and diffing (see [extensibility.md](extensibility.md)). |
| **Credential Store** | Envelope-encrypted storage of per-app credentials (API keys, OAuth2 tokens, basic auth, webhook secrets). Exposes only a scoped accessor that decrypts for the duration of a single outbound call — see [security.md](security.md). |
| **Mapping Engine** | LLM-based, provider-agnostic. Decomposes pairs of specs into a form suitable for LLM reasoning and proposes operation/field-level mappings with confidence scores. See [mapping-engine.md](mapping-engine.md). |
| **Mapping Review/Approval Service** | Turns a `MappingProposal` into an `ApprovedMapping`. Supports per-item edit/accept/reject and partial approval — nothing executes until approved. |
| **Sync Engine** | Executes approved peer-to-peer mappings on an ongoing basis, via a Webhook Receiver and/or a Poller. See [sync-engine.md](sync-engine.md). |
| **Adapter/Gateway Engine** | Hosts live server endpoints for "consumer" specs (what a new app needs), resolving inbound requests on demand against one or more backend apps using approved mappings. See [adapter-engine.md](adapter-engine.md). |
| **Graph/Overview Service** | Maintains a materialized graph projection of the landscape (nodes = apps/adapters, edges = mappings) for the always-available overview. See [flows/graph-overview.md](../flows/graph-overview.md). |
| **Audit/Event Log** | Durable, business-level record of sync events, adapter calls, mapping decisions, and credential accesses. Drives loop prevention and the graph's activity metadata. Distinct from operational telemetry (see [observability.md](observability.md)). |
| **Event Bus (internal)** | Decouples producers of state changes (`SpecIngested`, `MappingApproved`, sync writes) from the services that react to them (Sync Engine, Adapter Engine, Graph Service, cache invalidation). |
| **Observability / Telemetry** (cross-cutting) | Every component above is instrumented with OpenTelemetry (traces, metrics, logs), exported via a Collector to backing stores that Grafana visualizes. See [observability.md](observability.md). |

Two design points recur throughout the rest of this documentation:

- **The Sync Engine and Adapter Engine are both just consumers of `ApprovedMapping` data.** One pushes data proactively; the other resolves requests on demand. They share the same Transformation Executor, Outbound Call Executor, Credential Store access pattern, and Audit Log.
- **The Mapping Engine is used identically for both capabilities.** The only difference is which spec pairs get analyzed (provider ↔ provider for sync candidates; consumer ↔ provider for adapter candidates) and what the resulting `ApprovedMapping` is later used for.

## Component diagram

```mermaid
flowchart TB
    UI[API / UI Layer] --> Registry[Spec Registry]
    UI --> Approval[Mapping Review & Approval Service]
    UI --> Graph[Graph / Overview Service]

    Registry -- SpecIngested --> Bus[(Event Bus)]
    Bus --> MappingEngine[Mapping Engine] <--> LLM[Pluggable LLM Provider Interface]
    MappingEngine --> Approval

    Approval -- MappingApproved --> Bus
    Bus --> SyncEngine[Sync Engine]
    Bus --> AdapterEngine[Adapter / Gateway Engine]
    Bus --> Graph

    SyncEngine --> ExternalApps[(Registered Apps' REST APIs)]
    AdapterEngine --> ExternalApps
    SyncEngine & AdapterEngine --> Creds[Credential Store]
    SyncEngine & AdapterEngine --> AuditLog[(Audit / Event Log)]

    UI -.otel traces/metrics/logs.-> Otel[OpenTelemetry Collector]
    Registry -.-> Otel
    MappingEngine -.-> Otel
    SyncEngine -.-> Otel
    AdapterEngine -.-> Otel
    Graph -.-> Otel
    Otel --> Grafana[Grafana Dashboards / Alerting]
```

## Key interfaces (informal contracts)

- `SpecRegistry.registerApp(appMeta, credential, specDoc, role) -> RegisteredApp`
- `SpecRegistry.diffSpec(appId, fromVersion, toVersion) -> SpecDiff`
- `MappingEngine.proposeMappings(sourceSpecRef, targetSpecRef) -> MappingProposal`
- `LLMMappingProvider.shortlistResourcePairs(shortlistContext) -> ResourceShortlist` — stage 1 of the pluggable AI abstraction: shortlists plausible resource pairs per spec pair (see [mapping-engine.md](mapping-engine.md))
- `LLMMappingProvider.generateMappingProposal(promptContext) -> MappingSuggestionSet` — stage 2: full detail analysis per shortlisted resource pair (see [mapping-engine.md](mapping-engine.md))
- `ApprovalService.updateItem(proposalId, itemId, edits)`, `.approve(proposalId, selection)`, `.reject(proposalId, itemIds)` — emits `MappingApproved(ApprovedMapping)`
- `CredentialStore.withCredential(appId, fn)` — the only way to use a credential; raw secrets never leave this scope
- `GraphService.getGraph(filter) -> { nodes, edges }`

## Deployment model

Single-tenant, self-hosted: one mediator instance manages one organization's landscape. There is no tenant-isolation concern in any component, which keeps the credential and auth model in [security.md](security.md) simpler than a multi-tenant SaaS would require.

## Scale assumption

The landscape is expected to be small (on the order of 15-20 registered apps), **each with a modest number of resource groups**. Even at this scale, exhaustive per-resource-pair analysis would explode in the wrong dimension: ~20 apps × ~10 resource groups each is a cross-product of tens of thousands of candidate resource pairs. The Mapping Engine therefore detects in two stages — a cheap summary-level *shortlist* call per spec pair, then a full *detail* call only for the resource pairs shortlisted as plausible (see [mapping-engine.md](mapping-engine.md)). That brings a full landscape pass to roughly a thousand LLM calls and, just as importantly, keeps the human review queue proportional to genuine correspondences rather than to the cross-product. The assumption still has limits: shortlist cost grows quadratically with app count (one call per spec pair), and very large per-spec resource counts grow the summary prompt itself — either growing substantially is the trigger to revisit (e.g. batching shortlist calls, or adding a non-LLM pre-filter in front of stage 1).
