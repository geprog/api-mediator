# Phase 5 — Response caching & coarse invalidation

Read responses are cached per `(adapterEndpointId, normalized request params)` with the endpoint's configured
`cacheTtl` — default: **no caching until composed otherwise**. Invalidation has three documented sources with
honestly different coverage (sync activity, adapter writes, TTL) and is deliberately **coarse**: a change
signal for a backend resource drops *all* cached responses of *every* endpoint bound to that resource.

Coarse invalidation costs cache hit rate; it never costs correctness — and that principle is what this slice
extends to the one case the concept does not enumerate: a change to an endpoint's own **configuration or
binding health** (README open question 13).

**Actor:** system (cache + invalidator); operator (sets `cacheTtl` at composition).

**Concept references (whole file):** [adapter-engine.md](../architecture/adapter-engine.md) *Caching*, *Write
operations* — *Caching*, *Request pipeline* step 9; [adapter-request-resolution.md](../flows/adapter-request-resolution.md)
*Notes* (cache hit short-circuits backend calls); [adapter-endpoint-composition.md](../flows/adapter-endpoint-composition.md)
step 4 (the UI states which invalidation signals cover the backends involved);
[data-model.md](../architecture/data-model.md) `AdapterEndpoint.cacheTtl`, `SyncEvent / AuditLog`;
[overview.md](../architecture/overview.md) *Components* (Event Bus feeds cache invalidation);
[observability.md](../architecture/observability.md) *Metrics* (cache hit rate).

> **Authoritative:** the cache key; that only **complete, valid** responses are cached; that invalidation is
> coarse per backend resource; that TTL is the only *guaranteed* staleness bound. **Implementation choice:**
> where the cache lives (in-process is sufficient for the single-instance deployment model — a restart simply
> empties it, which is correctness-safe), eviction policy, key normalization details.

---

## CH-1 — Cache read responses per endpoint and normalized params

**As a** landscape operator, **I** can make a hot read endpoint cheap without changing its semantics, **so
that** fan-out and union endpoints stay affordable.

### Acceptance criteria

1. **Given** an endpoint with `cacheTtl` set and a **read** operation, **when** a request is served
   successfully, **then** the response is cached under `(adapterEndpointId, normalized request params)` and a
   subsequent equivalent request within the TTL is served from cache, **short-circuiting all backend calls**
   ([adapter-engine.md](../architecture/adapter-engine.md) *Caching*;
   [adapter-request-resolution.md](../flows/adapter-request-resolution.md) *Notes*).
2. **Given** parameter normalization, **when** two requests differ only in parameter ordering/encoding of the
   same values, **then** they hit the same cache entry; **when** they differ in any parameter *value*, **then**
   they do not ([adapter-engine.md](../architecture/adapter-engine.md) *Caching*).
3. **Given** an endpoint with **no** `cacheTtl`, **when** requests are served, **then** nothing is cached — no
   caching is the default until composed otherwise
   ([data-model.md](../architecture/data-model.md) `AdapterEndpoint.cacheTtl`).
4. **Given** the TTL elapses, **when** the next request arrives, **then** the backends are called again — TTL is
   the only **guaranteed** bound on staleness ([adapter-engine.md](../architecture/adapter-engine.md)
   *Caching*).
5. **Given** a cache hit or miss, **when** metrics are emitted, **then** cache hit rate per endpoint is
   observable ([observability.md](../architecture/observability.md) *Metrics*).
6. **Given** a cache hit, **when** the request is served, **then** the Auth Gateway still validates the token
   first (AT-2) — caching short-circuits backend calls, never authentication.

### Out of scope

- Cache warming/prefetch — not in the concept.

### Dependencies

Blocked by AG-1, AD-1. Precedes CH-2..CH-5, WR-4.

---

## CH-2 — Only complete, valid responses enter the cache

**As a** consumer-app developer, **I** never get a transient failure frozen into every response for the next
`cacheTtl` seconds, **so that** one bad minute doesn't become one bad hour.

### Acceptance criteria

1. **Given** a response that **failed** consumer-schema validation (`mediator-transform-error`, AG-7), **when**
   caching is considered, **then** it is **not** cached
   ([adapter-engine.md](../architecture/adapter-engine.md) *Caching*).
2. **Given** a **degraded** response (a failed `supplement`, AG-2/AG-3), **when** caching is considered,
   **then** it is **not** cached ([adapter-engine.md](../architecture/adapter-engine.md) *Caching*).
3. **Given** any **error** response (all six named causes and upstream errors), **when** caching is considered,
   **then** it is **not** cached ([adapter-engine.md](../architecture/adapter-engine.md) *Caching*).
4. **Given** a **write** response, **when** caching is considered, **then** it is never cached (WR-4
   criterion 4) ([adapter-engine.md](../architecture/adapter-engine.md) *Write operations* — *Caching*).
5. **Given** a union response produced with a **dropped** contributor (AG-3 criterion 2), **when** caching is
   considered, **then** it counts as degraded and is not cached — the same rule as criterion 2.

### Out of scope

- Negative caching of `not-yet-mapped` — excluded by criterion 3.

### Dependencies

Blocked by CH-1, AG-2, AG-3, AG-7.

---

## CH-3 — `SyncEvent`-driven invalidation (the cache ↔ invalidator seam)

**As a** landscape operator, **I** have sync activity drop cached adapter responses for the resources it
changed, **so that** the mediator reuses its own change-detection signal instead of building a second one.

### Acceptance criteria

1. **Given** the Sync Engine produces a `SyncEvent` for a backend resource, **when** the invalidator consumes
   it, **then** **all** cached responses of **every** `AdapterEndpoint` with a binding to that backend resource
   are dropped — no attempt is made to compute which parameterized queries contained the changed record
   ([adapter-engine.md](../architecture/adapter-engine.md) *Caching*).
2. **Given** the seam between them, **when** it is implemented, **then** the invalidation input is an explicit
   `(backendAppId, resourceRef)`-shaped signal and the cache exposes an explicit "drop everything for this
   backend resource" operation — so a unit test can assert the mapping from a `SyncEvent` to the exact set of
   dropped keys, with no engine running (the Phase-4 lesson: pin every cross-component contract).
3. **Given** an endpoint bound to **several** backend resources, **when** one of them signals, **then** the
   endpoint's entries are dropped (coarse, per endpoint) rather than partially retained
   ([adapter-engine.md](../architecture/adapter-engine.md) *Caching*).
4. **Given** the Event Bus loses a delivery, **when** the reconciliation principle applies, **then** the worst
   outcome is staleness bounded by `cacheTtl` — never a correctness break, and never an unbounded stale entry
   ([overview.md](../architecture/overview.md) *Components*;
   [adapter-engine.md](../architecture/adapter-engine.md) *Caching*).
5. **Given** a backend that does **not** participate in peer-peer sync, **when** its data changes externally,
   **then** there is **no change-detection signal at all** and TTL is the entire freshness story — a documented
   coverage limit the composition UI must state (CU-2 criterion 4)
   ([adapter-engine.md](../architecture/adapter-engine.md) *Caching*).

### Out of scope

- Producing `SyncEvent`s — Phase 4.

### Dependencies

Blocked by CH-1, Phase-4 SD-4/SP-*. Precedes CU-2.

---

## CH-4 — Adapter-write and TTL invalidation

**As a** consumer-app developer, **I** see my own write reflected in my next read, **so that** the mediator's
cache never hides the change I just made through it.

### Acceptance criteria

1. **Given** a **successful** adapter write, **when** it completes, **then** cached entries for endpoints backed
   by the **same backend resource** are invalidated immediately, complementing sync-driven invalidation
   ([adapter-engine.md](../architecture/adapter-engine.md) *Write operations* — *Caching*, *Caching*).
2. **Given** a write and a read endpoint over the same backend resource, **when** the write succeeds and the
   read is called next, **then** the read is a cache **miss** and reflects the write — the e2e-assertable form
   of criterion 1.
3. **Given** the write invalidation path, **when** it is implemented, **then** it reuses the **same**
   `(backendAppId, resourceRef)` invalidation seam as CH-3 — not a parallel mechanism (contract pinned by one
   test over both producers).
4. **Given** TTL expiry, **when** an entry ages out, **then** it is removed/ignored without any external signal
   — TTL works when neither of the other two sources covers the backend
   ([adapter-engine.md](../architecture/adapter-engine.md) *Caching*).

### Out of scope

- Loop-prevention tagging — deliberately absent for adapter writes (WR-4 criterion 1).

### Dependencies

Blocked by CH-3, WR-4.

---

## CH-5 — Invalidate on configuration and binding-health changes

**As a** landscape operator, **I** have a recomposed or newly-degraded endpoint stop serving cached responses
produced under its old configuration, **so that** a composition change takes effect immediately instead of
being masked for up to `cacheTtl`.

### Acceptance criteria

1. **Given** an endpoint's serving configuration changes — strategy, roles, order/chaining, `postMerge*`, dedup,
   strictness, or `cacheTtl` itself (CO-6) — **when** the change commits, **then** **all** of that endpoint's
   cached entries are dropped ([adapter-engine.md](../architecture/adapter-engine.md) *Caching*, coarse-
   invalidation principle: "never costs correctness"). *Not enumerated in the concept — README open
   question 13.*
2. **Given** a binding's `status` changes (`proposed` → `active`, `active` → `disabled`) or a binding is added
   or removed, **when** the change commits, **then** its endpoint's cached entries are dropped.
3. **Given** a binding's `ApprovedMapping` transitions to `stale`/`suspended`/`superseded`, or its **backend
   app** is disabled/deregistered, **when** the transition is observed, **then** cached entries of every
   endpoint with that binding are dropped — a cached response must not outlive the health of the bindings that
   produced it ([extensibility.md](../architecture/extensibility.md) *Spec update lifecycle*, *App lifecycle*).
4. **Given** successor adoption (CO-7), **when** the successor is adopted, **then** the affected endpoints'
   cached entries are dropped, since the correspondence content that produced them changed
   ([extensibility.md](../architecture/extensibility.md) *Successor adoption*).
5. **Given** an endpoint is disabled and later re-enabled, **when** it resumes serving, **then** it serves no
   entries cached before it was disabled.
6. **Given** all of the above, **when** they are implemented, **then** they route through the **same** explicit
   invalidation seam as CH-3/CH-4 (by endpoint id rather than backend resource) — one mechanism, two key kinds.

### Out of scope

- Fine-grained "only invalidate the affected parameter sets" — the concept's answer is coarse invalidation.

### Dependencies

Blocked by CH-3, CO-6. Re-checked by CO-7.
