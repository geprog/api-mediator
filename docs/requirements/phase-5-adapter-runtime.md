# Phase 5 — Adapter Server Runtime

The **serving surface** slice: a second HTTP server, separate from the operator API, that hosts each
`CONSUMER` spec's **full operation surface** as a virtual provider — routes mounted **from the consumer spec's
IR**, not hand-written — so that a consumer operation the landscape cannot serve yet answers a distinct
`not-yet-mapped` rather than a 404 or a plausible-but-wrong body.

This is the server side of the concept's **Protocol Client/Server interface pair**: REST is the first
implementation, and nothing OpenAPI-specific may leak into the planning/aggregation core behind it.

**What already exists:** the operator API (Fastify, Phase 1-4) and the `adapter_endpoint` /
`adapter_binding` tables with `status` enums including `composition-required` (Phase-3 AI-2). Nothing of the
runtime exists — `apps/backend/src/http/adapter-runtime` and `packages/adapter-engine` are unbuilt.

**Actor:** consumer-app developer (the caller); operator (observes); system (mounts).

**Concept references (whole file):** [adapter-engine.md](../architecture/adapter-engine.md) (intro — *virtual
provider*, *Request pipeline* steps 1/3, *Error and partial-failure semantics*, *Observability hooks*);
[adapter-request-resolution.md](../flows/adapter-request-resolution.md) steps 1-3 and *Notes*;
[adapter-endpoint-composition.md](../flows/adapter-endpoint-composition.md) closing paragraph;
[extensibility.md](../architecture/extensibility.md) *Beyond REST/OpenAPI*, *App lifecycle*;
[security.md](../architecture/security.md) (the mediator accepts no unauthenticated inbound traffic);
[observability.md](../architecture/observability.md) *Traces*, *Metrics*; [glossary.md](../glossary.md)
`Adapter Server Runtime`, `Virtual provider`, `not-yet-mapped (error)`, `endpoint-disabled (error)`,
`Protocol Client/Server interface pair`. E2e landscapes:
[scenarios/README.md](../../scenarios/README.md) (host ports `1<scenario>900` reserved for the adapter server).

> **Bind address, port, framework wiring, and error-body shape are the implementation choice; the *served
> surface* and the *distinguishability of outcomes* are authoritative.** The runtime hosts every operation of
> every active consumer spec; a request that cannot be served must say **why** in a machine-readable way, never
> by returning something that merely looks like data.

---

## RT-1 — A second server instance, isolated from the operator API

**As a** landscape operator, **I** run the adapter surface as its own server on its own port, **so that**
consumer traffic can never reach operator routes and the two surfaces' auth models stay separate.

### Acceptance criteria

1. **Given** the mediator starts, **when** the runtime boots, **then** it listens on a **separate,
   config-defined port** from the operator API (the scenarios reserve `1<scenario>900` —
   [scenarios/README.md](../../scenarios/README.md)), and both servers run in the same process over the same
   persistent store ([overview.md](../architecture/overview.md) *Deployment model*).
2. **Given** a request for an operator-API route (e.g. `/apps`, `/proposals`) arrives on the **adapter** port,
   **when** it is handled, **then** it is not served by the operator API — the operator surface is not mounted
   on this listener ([security.md](../architecture/security.md) *Summary of trust boundaries*).
3. **Given** a request for a consumer-spec route arrives on the **operator** port, **when** it is handled,
   **then** it is not served there either — the adapter surface is not reachable through the operator API.
4. **Given** the runtime is unreachable or the process is down, **when** a consumer calls, **then** the failure
   is plain unavailability — the concept accepts single-instance deployment with supervised restart and no
   adapter-side HA ([overview.md](../architecture/overview.md) *Deployment model*).
5. **Given** the runtime is the **server side of the Protocol Client/Server seam**, **when** it is structured,
   **then** REST/OpenAPI specifics (path templating, HTTP verbs, status codes, header handling) live behind that
   seam and the planner/aggregator core consumes a protocol-neutral request/response shape
   ([extensibility.md](../architecture/extensibility.md) *Beyond REST/OpenAPI*).

### Out of scope

- Token validation — AT-2 (the Auth Gateway sits in front of this runtime).
- Multi-tenancy or per-consumer TLS/host isolation — single-tenant by design
  ([overview.md](../architecture/overview.md) *Deployment model*).

### Dependencies

Blocked by AD-6. Precedes RT-2, AT-2, RP-1.

---

## RT-2 — Mount routes dynamically from the consumer spec

**As a** consumer-app developer, **I** find every operation my `CONSUMER` spec declares reachable on the
adapter server, **so that** I can code against the API I described, whether or not it is wired to a backend
yet.

### Acceptance criteria

1. **Given** an `active` `CONSUMER` `ApiSpec` with N operations, **when** the runtime mounts it, **then** all N
   operations are routable — the runtime **hosts the full consumer spec surface**, derived from the spec's IR,
   with no hand-written route table ([adapter-engine.md](../architecture/adapter-engine.md) *Binding: decided at
   composition time*, final paragraph).
2. **Given** a path/method **not** declared in any mounted consumer spec, **when** it is requested, **then**
   the response is a plain **404** — deliberately distinguishable from `not-yet-mapped`
   ([adapter-engine.md](../architecture/adapter-engine.md); [glossary.md](../glossary.md)
   `not-yet-mapped (error)`).
3. **Given** several consumer apps are registered, **when** their specs are mounted on the same listener,
   **then** each request is resolved **within the consumer app the caller's token identifies**, so identical
   paths in two consumer specs (`/todos` in both) can never be confused for one another (README open
   question 1 records the recommended resolution and its alternative).
4. **Given** the mounted routes come from the IR, **when** a consumer spec declares path templating, query
   parameters, headers, and a request body, **then** all of them are captured and passed to the router — the
   mount does not narrow the surface to a subset of parameter locations
   ([adapter-request-resolution.md](../flows/adapter-request-resolution.md) step 3).
5. **Given** the same operation is mounted twice (restart, re-ingestion), **when** the runtime boots or
   re-mounts, **then** mounting is **idempotent** — no duplicate route registration and no port-bind race.

### Out of scope

- Validating the inbound request against the schema — RP-2.
- Choosing which backend serves it — RP-3.

### Dependencies

Blocked by RT-1, Phase-1 SI-1 (the IR). Precedes RT-3, RP-1.

---

## RT-3 — `not-yet-mapped`, `endpoint-disabled`, and 404 are three different answers

**As a** consumer-app developer, **I** can tell "not wired up yet" from "deliberately switched off" from
"wrong path", **so that** I never mistake an unmapped operation for a broken one — or for data.

### Acceptance criteria

1. **Given** a mounted consumer operation with **no** `AdapterEndpoint`, or with an endpoint that has **no**
   `active` binding, **when** it is called, **then** the response is the distinct **`not-yet-mapped`** error
   carrying a machine-readable cause — never a 404, never an empty success body, never an empty collection
   ([adapter-engine.md](../architecture/adapter-engine.md) *Binding: decided at composition time*;
   [adapter-endpoint-composition.md](../flows/adapter-endpoint-composition.md) closing paragraph).
2. **Given** an `AdapterEndpoint` whose `status = disabled`, **when** it is called, **then** the response is the
   distinct **`endpoint-disabled`** error — configured but switched off, distinguishable from `not-yet-mapped`
   and from every backend failure ([data-model.md](../architecture/data-model.md) `AdapterEndpoint.status`;
   [glossary.md](../glossary.md) `endpoint-disabled (error)`).
3. **Given** an endpoint in `composition-required` that still has a previously-composed `active`
   configuration, **when** it is called, **then** it **keeps serving that configuration** — it does **not**
   answer `not-yet-mapped` ([adapter-endpoint-composition.md](../flows/adapter-endpoint-composition.md) step 3 /
   *Notes*).
4. **Given** an endpoint in `composition-required` that has **never** had an `active` configuration, **when**
   it is called, **then** it answers `not-yet-mapped` (there is nothing to serve), and this is reported the same
   way as criterion 1 — an endpoint row existing is not, by itself, a served endpoint.
5. **Given** each of these three outcomes, **when** a client inspects the response, **then** the cause is
   machine-readable (a stable cause token in the body and/or a response header), independent of the HTTP status
   code chosen (README open question 2 fixes the recommended status mapping).

### Out of scope

- The other four causes (`mapping-stale`, `mapping-suspended`, `backend-disabled`, `mediator-transform-error`)
  — RP-3 and AG-7 own those; RP-5 asserts all six are mutually distinguishable.

### Dependencies

Blocked by RT-2. Precedes RP-3, RP-5.

---

## RT-4 — Mount lifecycle: ingestion, disable, deregistration

**As a** landscape operator, **I** see the adapter surface follow app and spec lifecycle without a restart,
**so that** a disabled or deregistered consumer stops being served and a newly ingested consumer spec starts
being served.

### Acceptance criteria

1. **Given** a new `CONSUMER` `ApiSpec` is ingested (Phase-1 `SpecIngested`), **when** the runtime reacts,
   **then** its operations become routable without a process restart
   ([adapter-engine.md](../architecture/adapter-engine.md) intro).
2. **Given** a consumer `RegisteredApp` is **disabled**, **when** its adapter surface is called, **then** the
   surface stops serving and its adapter token stops validating (AT-4) — a disabled app is not served
   ([extensibility.md](../architecture/extensibility.md) *App lifecycle*;
   [security.md](../architecture/security.md)).
3. **Given** a consumer `RegisteredApp` is **deregistered**, **when** its surface is called afterwards, **then**
   callers hit **nothing** — not `not-yet-mapped` — because its `AdapterEndpoint`s and bindings are deleted and
   the surface stops being served entirely ([extensibility.md](../architecture/extensibility.md) *App
   lifecycle*, deregister cascade).
4. **Given** a **backend** (provider) app is disabled, **when** a consumer operation bound to it is called,
   **then** the consumer surface stays mounted — this is a per-binding `backend-disabled` condition resolved by
   the planner (RP-3), not an unmount ([extensibility.md](../architecture/extensibility.md) *App lifecycle*).
5. **Given** the runtime restarts, **when** it comes back, **then** the mounted surface is re-derived from
   persisted state alone (specs + endpoints + bindings) — the runtime holds no mount state that isn't
   re-derivable ([overview.md](../architecture/overview.md) *Components*, Event Bus/reconciliation principle).

### Out of scope

- Spec **versioning** and `SpecDiff`-driven staleness — Phase 6; Phase 5 serves version-1 consumer specs, and
  handles `stale` bindings only as the planner's runtime condition (RP-3).

### Dependencies

Blocked by RT-2, Phase-1 EB-1. Precedes CU-4.

---

## RT-5 — Every request is traced and audited

**As a** landscape operator, **I** get one trace and one durable business record per adapter request, **so
that** I can debug a live consumer's failure and count how often each cause fires.

### Acceptance criteria

1. **Given** any inbound adapter request, **when** it completes (successfully or not), **then** exactly one
   `adapter-request` `SyncEvent`/`AuditLog` row is written, carrying the endpoint, the binding(s) involved, the
   outcome, and the failure **cause** where applicable (AD-5)
   ([data-model.md](../architecture/data-model.md) `SyncEvent / AuditLog`).
2. **Given** the same request, **when** it is traced, **then** the trace has spans for **auth check, planning,
   each backend call, transform, and aggregation**, and the audit row carries the matching `traceId`/`spanId`
   ([observability.md](../architecture/observability.md) *Traces*;
   [adapter-engine.md](../architecture/adapter-engine.md) *Observability hooks*).
3. **Given** requests are served, **when** metrics are emitted, **then** they include request rate, latency, and
   error rate **per `AdapterEndpoint`**, cache hit rate, and partial-failure/degraded-response rate
   ([observability.md](../architecture/observability.md) *Metrics*).
4. **Given** a `mediator-transform-error` occurs, **when** it is recorded, **then** it is logged and alertable
   as its own signal — each occurrence is a defect to fix, not an operational blip
   ([observability.md](../architecture/observability.md) *Alerting*).
5. **Given** audit rows and telemetry are written, **when** their content is inspected, **then** neither
   contains request/response payload values, the adapter token, or any credential material
   ([security.md](../architecture/security.md) *Audit logging*).

### Out of scope

- Grafana dashboard/panel work — Phase 6 polish; Phase 5 emits what those panels read.

### Dependencies

Blocked by AD-5, RT-2. Cross-cuts every serving story (RP/TE/AG/WR/CH).
