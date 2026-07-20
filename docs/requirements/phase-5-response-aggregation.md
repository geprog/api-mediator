# Phase 5 — Response Aggregator (the four strategies) & response validation

Steps 8-9 of the request pipeline: combine the per-binding result envelopes per the endpoint's
`aggregationStrategy`, then validate the aggregated response against the **consumer's own OpenAPI response
schema** before returning it. The aggregator is a pure function of (plan + envelopes), so every strategy,
role rule, degradation rule, and tiebreak is unit-testable without a backend.

The role-validity table in [adapter-engine.md](../architecture/adapter-engine.md) is **authoritative** on which
`role`s each strategy uses; this slice executes it, CO-2 enforces it at composition.

**Actor:** system (aggregator); consumer-app developer (receives the result).

**Concept references (whole file):** [adapter-engine.md](../architecture/adapter-engine.md) *Role validity per
aggregation strategy*, *Aggregation strategies*, *Error and partial-failure semantics*, *Request pipeline*
steps 8-9; [adapter-request-resolution.md](../flows/adapter-request-resolution.md) steps 8-9;
[data-model.md](../architecture/data-model.md) `AdapterEndpoint.postMergeFilters`/`postMergeSorts`/
`postMergePagination`, `RecordLink`, `ResourceBinding.nativeIdRef`;
[observability.md](../architecture/observability.md) *Metrics*, *Alerting*; [glossary.md](../glossary.md)
`Response Aggregator`, `Aggregation strategy`, `postMergeFilters`, `postMergeSorts / postMergePagination`,
`mediator-transform-error`.

> **Authoritative:** the role-validity table; that a failed union contributor is **dropped**, never substituted;
> that sort and pagination are **never pushed down**; that dedup happens **only** where the mediator can *know*
> two rows are the same record; that a degraded response is signaled **out of band** and still validates against
> the consumer schema; that an invalid aggregated response is a **`mediator-transform-error`**, never returned
> as data. **Implementation choice:** merge algorithms, header names, internal data structures.

---

## AG-1 — `single`: one binding, no aggregation

**As a** consumer-app developer, **I** get the one composed backend's mapped response, **so that** the common
"one provider offers what I asked for" case works with zero composition ceremony.

### Acceptance criteria

1. **Given** a `single` endpoint with one `primary` binding that succeeded, **when** the aggregator runs,
   **then** the consumer response **is** that envelope's consumer-shape payload, unmodified
   ([adapter-engine.md](../architecture/adapter-engine.md) *Aggregation strategies*).
2. **Given** a `single` endpoint whose binding **failed**, **when** the aggregator runs, **then** the request
   fails with that envelope's cause (upstream error naming the backend, or the specific planner cause) — there
   is no fallback under `single` ([adapter-engine.md](../architecture/adapter-engine.md) *Role validity*,
   *Error and partial-failure semantics*).
3. **Given** a `single` endpoint, **when** its roles are read, **then** only `primary` is meaningful, and
   `executionOrder`/`dependsOnBindingId` are not
   ([adapter-engine.md](../architecture/adapter-engine.md) *Role validity per aggregation strategy*).
4. **Given** an endpoint auto-activated from a first approved binding (CO-1), **when** it serves, **then** it
   serves under exactly this strategy with no caching and non-strict mode — the documented safe defaults
   ([adapter-engine.md](../architecture/adapter-engine.md) *Binding: decided at composition time*).

### Out of scope

- Response validation — AG-7 (applies to every strategy).

### Dependencies

Blocked by TE-5. Precedes AG-7 and the thin end-to-end slice.

---

## AG-2 — `fanout-merge`: base object plus supplements, with degradation rules

**As a** consumer-app developer, **I** get one object assembled from several backends, and a clear failure when
a missing part would make the object a lie, **so that** partial data is never silently passed off as complete.

### Acceptance criteria

1. **Given** a `fanout-merge` endpoint, **when** the aggregator runs, **then** the `primary` binding supplies
   the base object and `supplement` bindings contribute additional fields; **no** `fallback` role participates —
   all configured bindings are called every time
   ([adapter-engine.md](../architecture/adapter-engine.md) *Role validity per aggregation strategy*).
2. **Given** the `primary` binding failed (call failure or any planner cause), **when** the aggregator runs,
   **then** the whole request fails with that cause
   ([adapter-engine.md](../architecture/adapter-engine.md) *Error and partial-failure semantics*).
3. **Given** a `supplement` binding failed and the endpoint is **non-strict**, **when** every consumer field
   that supplement supplies is **optional** in the consumer response schema, **then** those fields are omitted,
   the response still validates, and the degradation is signaled **out of band** via a response header naming
   the failed backend — never injected into the body
   ([adapter-engine.md](../architecture/adapter-engine.md) *Error and partial-failure semantics*).
4. **Given** a `supplement` binding failed and **any** field it supplies is **required** in the consumer
   response schema, **when** the aggregator runs, **then** there is no valid degraded response and the **whole
   request fails**, exactly as in strict mode — the supplement is load-bearing
   ([adapter-engine.md](../architecture/adapter-engine.md) *Error and partial-failure semantics*;
   [adapter-endpoint-composition.md](../flows/adapter-endpoint-composition.md) step 4).
5. **Given** the endpoint is in **strict** mode, **when** any binding fails, **then** the whole request fails
   regardless of role ([adapter-engine.md](../architecture/adapter-engine.md) *Error and partial-failure
   semantics*).
6. **Given** two bindings write the **same** consumer field, **when** they are merged, **then** precedence
   follows `executionOrder`, with an order tie broken deterministically by binding id — the same rule the union
   uses for field conflicts ([adapter-engine.md](../architecture/adapter-engine.md) *Aggregation strategies*).
7. **Given** a degraded response was produced, **when** metrics/audit are written, **then** it is counted as a
   degraded response and recorded as such (AD-5 criterion 3;
   [observability.md](../architecture/observability.md) *Metrics*).

### Out of scope

- Determining *which* consumer fields each supplement supplies and whether they are required — CO-4 computes
  and surfaces that at composition; this story consumes the composed decision.

### Dependencies

Blocked by AG-1, TE-3 (chained supplements). Precedes AG-7.

---

## AG-3 — `collection-union`: merge rows, and dedup only where identity is *known*

**As a** consumer-app developer, **I** get one list spanning several backends where duplicates are collapsed
only when the mediator can prove two rows are the same record, **so that** the list is never silently
mis-merged.

### Acceptance criteria

1. **Given** a `collection-union` endpoint, **when** the aggregator runs, **then** **every** binding is an
   equivalent contributor with role `supplement`; there is no `primary` and no `fallback`
   ([adapter-engine.md](../architecture/adapter-engine.md) *Role validity per aggregation strategy*).
2. **Given** a contributing binding **failed**, **when** the aggregator runs in non-strict mode, **then** that
   contributor is **dropped from the union** (never substituted by another), the merged result is returned, and
   the failure is signaled out of band via a response header naming the failed backend; in **strict** mode the
   whole request fails ([adapter-engine.md](../architecture/adapter-engine.md) *Role validity*, *Error and
   partial-failure semantics*).
3. **Given** the contributing backends are peer-synced and **link-based dedup** is configured, **when** rows are
   merged, **then** rows whose backend-native ids (TE-4 provenance) are paired by an existing `RecordLink`
   collapse into **one** row, with field conflicts resolved by `executionOrder` precedence and an order tie
   broken deterministically by binding id ([adapter-engine.md](../architecture/adapter-engine.md) *Aggregation
   strategies*; [data-model.md](../architecture/data-model.md) `RecordLink`).
4. **Given** a configured **dedup key** (a consumer-schema field), **when** rows are merged, **then** rows with
   equal key values collapse by the same precedence rule
   ([adapter-endpoint-composition.md](../flows/adapter-endpoint-composition.md) step 4).
5. **Given** **neither** links nor a dedup key are configured, **when** rows are merged, **then** **no dedup is
   attempted**: duplicates are returned exactly as mapped — the mediator never guesses row identity
   ([adapter-engine.md](../architecture/adapter-engine.md) *Aggregation strategies*).
6. **Given** any union response, **when** it is returned, **then** **no per-row source annotation is injected
   into the body** (the body must stay consumer-schema-valid); per-row provenance lives in the request's trace,
   and a **response header** names the contributing backends
   ([adapter-engine.md](../architecture/adapter-engine.md) *Aggregation strategies*). *This contradicts the
   scenario-4 consumer fixture's `source` field comment — see README open question 10.*

### Out of scope

- Post-merge filter/sort/pagination — AG-4. The materialization bound — AG-5.
- Establishing `RecordLink`s — Phase-4 RL-*; the union only reads them.

### Dependencies

Blocked by TE-4 (row provenance), TE-5, CO-3 (dedup configuration). Precedes AG-4.

---

## AG-4 — Union post-merge filter, sort, and pagination

**As a** consumer-app developer, **I** get my filter/sort/page parameters honored over the *merged* result,
**so that** page 2 of the union is page 2 of the union — not page 2 of each backend stapled together.

### Acceptance criteria

1. **Given** a filter parameter mapped in **every** contributing binding, **when** a request uses it, **then**
   it is **pushed down** to each backend ([adapter-engine.md](../architecture/adapter-engine.md) *Aggregation
   strategies*).
2. **Given** a filter parameter **not** mapped in every binding but covered by a `postMergeFilters` entry,
   **when** a request uses it, **then** the mediator applies that entry's `consumerFieldPath` + `operator` to
   the **merged** result ([data-model.md](../architecture/data-model.md) `AdapterEndpoint.postMergeFilters`).
3. **Given** sort and pagination, **when** a request uses them, **then** they are **never pushed down**: the
   mediator sorts the merged result per the matching `postMergeSorts` entry (field + direction, selected by
   parameter value for value-driven sort parameters) and paginates it per `postMergePagination`
   ([adapter-engine.md](../architecture/adapter-engine.md) *Aggregation strategies*;
   [data-model.md](../architecture/data-model.md) `postMergeSorts`, `postMergePagination`).
4. **Given** a filter/sort/pagination parameter with neither pushdown nor configured semantics, **when** a
   request uses it, **then** the request was already **rejected at validation** (RP-2 criteria 2-3) — the
   aggregator never sees it, and never answers unfiltered/unsorted/mispaged.
5. **Given** any configured sort — or none — **when** the merged result is ordered, **then** a **deterministic
   tiebreak** (contributing backend, then native id) is applied, so pages are stable across identical repeated
   requests ([adapter-engine.md](../architecture/adapter-engine.md) *Aggregation strategies*).
6. **Given** the ordering of operations, **when** a union request executes, **then** it is: fetch (with
   pushed-down filters) → merge → dedup → post-merge filter → sort → paginate — the complete (filtered) merged
   collection is materialized before sorting and paginating
   ([adapter-engine.md](../architecture/adapter-engine.md) *Aggregation strategies*).

### Out of scope

- Configuring `postMerge*` semantics — CO-3 (derive-then-confirm).

### Dependencies

Blocked by AG-3, RP-2. Precedes AG-5.

---

## AG-5 — Bound the union's materialization; fail loudly rather than truncate

**As a** landscape operator, **I** have a union endpoint over large collections fail with a clear reason
instead of exhausting memory or silently returning a partial union, **so that** "correctness over efficiency"
does not become "unbounded by accident".

### Acceptance criteria

1. **Given** a union request, **when** each contributing backend's collection is fetched, **then** it is paged
   through that resource's confirmed `ResourceBinding.paginationRef` up to a **config-defined per-request row
   ceiling** — the fetch is never unbounded
   ([adapter-engine.md](../architecture/adapter-engine.md) *Aggregation strategies*, final sentences;
   [data-model.md](../architecture/data-model.md) `ResourceBinding.paginationRef`).
2. **Given** the ceiling is exceeded, **when** the request is answered, **then** it **fails** with a cause
   naming the contributing backend and the ceiling — the union is **never truncated silently**, because a
   truncated union is exactly the plausible-but-wrong answer the concept forbids
   ([adapter-engine.md](../architecture/adapter-engine.md) *Error and partial-failure semantics*). *Whether this
   deserves its own named cause is README open question 11.*
3. **Given** a contributing backend resource with **no confirmed** `paginationRef` while its collection read is
   paged, **when** composition is attempted, **then** the union is not composable over it (CO-3 criterion 5) —
   at request time the mediator never assumes "one response is the whole collection".
4. **Given** a union endpoint over large collections, **when** it is composed, **then** the composition UI flags
   it and states that `cacheTtl` is the practical mitigation (CU-2 criterion 5)
   ([adapter-engine.md](../architecture/adapter-engine.md) *Aggregation strategies*).
5. **Given** the ceiling fires, **when** telemetry is emitted, **then** it is visible as its own signal (not
   folded into generic upstream errors), so an operator can see the endpoint outgrew its configuration
   ([observability.md](../architecture/observability.md) *Metrics*).

### Out of scope

- Cursor-based streaming/incremental union — not in the concept; the documented trade is full materialization
  plus caching.

### Dependencies

Blocked by AG-4. Precedes CU-2.

---

## AG-6 — `fanout-first-success`: ordered fallback

**As a** consumer-app developer, **I** get an answer from the first backend that can serve it, **so that** a
degraded landscape still answers reads.

### Acceptance criteria

1. **Given** a `fanout-first-success` endpoint, **when** it executes, **then** the `primary` is tried first and
   `fallback` bindings follow in `executionOrder`; **no** `supplement` role participates
   ([adapter-engine.md](../architecture/adapter-engine.md) *Role validity per aggregation strategy*).
2. **Given** the first binding succeeds, **when** the aggregator runs, **then** later bindings are **not
   called** at all, and the response is that binding's payload.
3. **Given** a binding fails **or** is eliminated by a planner cause (`mapping-stale`, `mapping-suspended`,
   `backend-disabled`), **when** the chain continues, **then** it is **skipped exactly like a failure** and the
   next binding in order is tried ([adapter-engine.md](../architecture/adapter-engine.md) *Stale bindings at
   request time*).
4. **Given** the whole chain is exhausted, **when** the request is answered, **then** it fails with a cause that
   preserves the **specific** reasons — e.g. a chain exhausted by staleness reports `mapping-stale`, not a
   generic upstream error ([adapter-engine.md](../architecture/adapter-engine.md) *Stale bindings at request
   time*).
5. **Given** `executionOrder` is a **strict total order** here, **when** two bindings share an order, **then**
   the configuration is invalid (rejected at composition, CO-2 criterion 4) and execution never runs "both in
   parallel, take the first" ([adapter-engine.md](../architecture/adapter-engine.md) order validity rules).
6. **Given** this strategy, **when** the endpoint's consumer operation is a **write**, **then** it is not
   permitted (WR-1) — a timed-out primary may have succeeded
   ([adapter-engine.md](../architecture/adapter-engine.md) *Write operations*).

### Out of scope

- Retry policy within a single binding's call — TE-2 criterion 6.

### Dependencies

Blocked by TE-5, RP-3. Precedes AG-7.

---

## AG-7 — Validate the aggregated response; `mediator-transform-error`

**As a** consumer-app developer, **I** never receive a body that violates the schema I coded against, **so
that** a mediator-side mapping or composition defect surfaces as an error I can report — not as corrupt data
in my app.

### Acceptance criteria

1. **Given** an aggregated response under **any** strategy, **when** it is about to be returned, **then** it is
   validated against the **consumer** operation's OpenAPI response schema
   ([adapter-engine.md](../architecture/adapter-engine.md) *Request pipeline* step 9).
2. **Given** validation fails, **when** the request is answered, **then** it fails with the distinct
   **`mediator-transform-error`** cause, and the invalid body is **not** returned — this is a mediator-side
   defect, not a backend failure ([adapter-engine.md](../architecture/adapter-engine.md) *Error and
   partial-failure semantics*; [glossary.md](../glossary.md) `mediator-transform-error`).
3. **Given** a **degraded** response (AG-2 criterion 3, AG-3 criterion 2), **when** it is validated, **then** it
   must still pass — degradation may only omit **optional** fields, and out-of-band headers are not part of the
   validated body ([adapter-engine.md](../architecture/adapter-engine.md) *Error and partial-failure
   semantics*).
4. **Given** a `mediator-transform-error` occurs, **when** it is recorded, **then** every occurrence is logged
   and alerted as a defect signal, and counted in metrics
   ([observability.md](../architecture/observability.md) *Alerting*, *Metrics*).
5. **Given** the aggregator → validator seam, **when** it is tested, **then** validation runs on the
   aggregator's output value alone (pure input → verdict), so a fixture aggregate with a missing required field
   deterministically produces `mediator-transform-error` with no backend involved.
6. **Given** a response that **fails** validation, **when** caching is considered, **then** it is **never
   cached** (CH-2 criterion 1) — a defect must not be served for `cacheTtl` seconds.

### Out of scope

- Fixing the defect (re-review, recomposition) — CO-6/CO-7 and Phase-6 re-review.

### Dependencies

Blocked by AG-1..AG-6. Completes RP-5's six-cause set.
