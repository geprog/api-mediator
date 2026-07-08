# AI-Based API Mediator — Documentation

This documentation describes the architecture and logical concept for the API mediator. This is a documentation-only phase — no implementation exists yet. Everything here is the design that a future implementation must follow.

## Scope

- Manages a software landscape of applications that each expose (or want to consume) a REST API described by an [OpenAPI](https://www.openapis.org/) specification. No other protocols (GraphQL, gRPC, etc.) are in scope for the initial version, though the design leaves room for them later (see [extensibility](architecture/extensibility.md)).
- Single-tenant, self-hosted: one mediator instance manages one organization's software landscape. No multi-tenant isolation is required.
- Two core capabilities:
  1. **Cross-app data mapping & sync** — detect, review/approve, and continuously execute data mappings between registered apps.
  2. **Live adapter server generation** — stand up a real, running server that implements what a newly introduced app needs from the landscape, resolving requests on demand against the real registered apps.
- A landscape graph view is always available, showing all registered apps and their mapping/sync/adapter connections.
- Mapping detection is LLM-based, behind a provider-agnostic interface — no vendor lock-in.
- The system is instrumented with OpenTelemetry and monitored via Grafana.

## How to read this documentation

Start with [architecture/overview.md](architecture/overview.md) for the component breakdown, then [architecture/data-model.md](architecture/data-model.md) for the entities everything else refers to. The remaining `architecture/` documents each cover one component or cross-cutting concern in depth. The `flows/` documents walk through the system end-to-end for each key scenario, referencing the components and entities defined in `architecture/`. [glossary.md](glossary.md) gives a one-line definition of every term used throughout.

## Architecture

- [overview.md](architecture/overview.md) — components, responsibilities, component diagram
- [data-model.md](architecture/data-model.md) — entities, relationships, ER diagram
- [mapping-engine.md](architecture/mapping-engine.md) — spec decomposition, LLM interface, confidence, versioning
- [sync-engine.md](architecture/sync-engine.md) — webhook/poll execution, loop prevention, consistency/conflict handling
- [adapter-engine.md](architecture/adapter-engine.md) — binding, transformation pipeline, aggregation, caching
- [security.md](architecture/security.md) — credential handling, inbound auth, audit logging
- [extensibility.md](architecture/extensibility.md) — spec versioning lifecycle & future-protocol seams
- [observability.md](architecture/observability.md) — OpenTelemetry instrumentation, Collector pipeline, Grafana dashboards & alerting

## Flows

- [app-registration-and-mapping-detection.md](flows/app-registration-and-mapping-detection.md)
- [mapping-review-and-approval.md](flows/mapping-review-and-approval.md)
- [adapter-endpoint-composition.md](flows/adapter-endpoint-composition.md)
- [sync-webhook-push.md](flows/sync-webhook-push.md)
- [sync-polling-pull.md](flows/sync-polling-pull.md)
- [adapter-request-resolution.md](flows/adapter-request-resolution.md)
- [graph-overview.md](flows/graph-overview.md)

## Reference

- [glossary.md](glossary.md)
