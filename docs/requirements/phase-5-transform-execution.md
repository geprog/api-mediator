# Phase 5 — Request/response transform phases & backend execution

Steps 5-7 of the request pipeline: map the inbound request into **each backend's** expected shape, call the
backends grouped by `executionOrder` (parallel, sequential, or chained), and map each backend response back
into the **consumer's** shape. Both directions are **independent approved transform sets** — the response phase
is never an inversion of the request phase.

Everything here reuses Phase-4 machinery: the **Transformation Executor** (TX-*), the **Outbound Call
Executor** (OC-*) with its credential access, per-app ceilings and retry discipline, and the `expression`
sandbox. Phase 5 adds the consumer-provider specifics: `phase`-scoped `FieldMapping`s, `ParameterMapping`s, and
chained bindings.

**Actor:** system (executor); consumer-app developer (observes the result).

**Concept references (whole file):** [adapter-engine.md](../architecture/adapter-engine.md) intro (two
independent transform phases), *Binding: decided at composition time* (`executionOrder`/`dependsOnBindingId`/
`chainInputs`), *Request pipeline* steps 5-7; [adapter-request-resolution.md](../flows/adapter-request-resolution.md)
steps 5-7; [data-model.md](../architecture/data-model.md) `FieldMapping.phase`, `ParameterMapping`,
`OperationMapping`, `AdapterBinding.chainInputs`; [security.md](../architecture/security.md) *Least privilege*,
*Transformation expression sandboxing*; [overview.md](../architecture/overview.md) *Outbound load discipline*;
[glossary.md](../glossary.md) `phase`, `ParameterMapping`, `Transformation Executor`, `Outbound Call Executor`.
Reused: [phase-4-transformation-executor.md](phase-4-transformation-executor.md) TX-1..TX-5;
[phase-4-outbound-executor.md](phase-4-outbound-executor.md) OC-1..OC-5;
[phase-4-credential-decrypt.md](phase-4-credential-decrypt.md) CD-1..CD-3.

> **Authoritative:** a transform runs **only in its declared direction and phase**; a backend input is filled
> only from a reviewed `ParameterMapping`, a request-phase `FieldMapping`, or a composed `chainInput` — never
> guessed, never defaulted from an unrelated source; a chained binding reads its upstream's **consumer-shape**
> response, never the upstream backend's native schema. **Implementation choice:** concurrency primitives,
> HTTP client details, internal plan/result value shapes.

---

## TE-1 — Request phase: consumer request → backend request

**As a** consumer-app developer, **I** have my request mapped into each backend's shape exactly as reviewed,
**so that** the backend receives what the approved mapping says it should — and nothing invented.

### Acceptance criteria

1. **Given** a plan binding, **when** the request phase runs, **then** the backend **body** is produced by the
   mapping's `FieldMapping`s with `phase = request` only — `phase = response` rows are never applied here
   ([data-model.md](../architecture/data-model.md) `FieldMapping.phase`;
   [adapter-engine.md](../architecture/adapter-engine.md) intro).
2. **Given** the binding's `OperationMapping`, **when** the request phase runs, **then** the backend
   operation's **path/query/header parameters** are filled from its `ParameterMapping`s
   (`sourceParamRef` → `targetParamRef`, with the optional transform applied)
   ([data-model.md](../architecture/data-model.md) `ParameterMapping`).
3. **Given** a backend operation parameter with **no** `ParameterMapping` and **no** `chainInput`, **when** the
   request is composed, **then** the parameter is left unfilled and — if the backend operation **requires** it
   (a path parameter, or a required query parameter) — the call is **refused** rather than issued with an
   unsubstituted or invented value. Such a binding should have been rejected at composition (CO-2 criterion 6),
   so reaching this point is a defect signal ([data-model.md](../architecture/data-model.md) `ParameterMapping`;
   the same "never a fabricated URL" discipline as `scopePathBindings` in
   [scoped-resource-sync.md](scoped-resource-sync.md)).
4. **Given** a peer-peer operational binding (`scopePathBindings`, `ScopeLink`, `targetIdParamRef`), **when** an
   **adapter** request fills backend parameters, **then** those are **not** consulted — the adapter's mechanism
   is `ParameterMapping` (README open question 8 records the human decision on the fallback question)
   ([data-model.md](../architecture/data-model.md) `ParameterMapping`, `ResourceBinding.scopePathBindings`).
5. **Given** an `expression` transform in either phase, **when** it runs, **then** it executes in the Phase-4
   sandbox (no I/O, no network, bounded time/memory) — the same evaluator, not a second one
   ([security.md](../architecture/security.md) *Transformation expression sandboxing*; TX-4).
6. **Given** live payload data flows through this stage, **when** it is processed, **then** none of it is sent
   to any LLM provider ([security.md](../architecture/security.md) *LLM data boundary*).

### Out of scope

- Deciding *which* backend operation to call — it is `AdapterBinding.backendOperationId`, chosen at composition
  from the approved `OperationMapping`s (CO-1).

### Dependencies

Blocked by RP-4, Phase-4 TX-1..TX-5. Precedes TE-2.

---

## TE-2 — Execute backends grouped by `executionOrder`

**As a** landscape operator, **I** have the mediator call the composed backends in the composed order —
parallel where they are independent — **so that** fan-out is fast without becoming unpredictable or abusive to
the backends.

### Acceptance criteria

1. **Given** a plan whose bindings share an `executionOrder`, **when** it executes under `fanout-merge` or
   `collection-union`, **then** those calls run **in parallel**
   ([adapter-engine.md](../architecture/adapter-engine.md) *Binding: decided at composition time*).
2. **Given** bindings with different `executionOrder` values, **when** they execute, **then** lower orders run
   before higher ones; under `fanout-first-success` the order is a **strict total order** over the fallback
   chain and the next binding is tried only after the previous one fails
   ([adapter-engine.md](../architecture/adapter-engine.md) role/order validity rules).
3. **Given** each backend call, **when** it is issued, **then** it goes through the **shared Outbound Call
   Executor**: credentials via `withCredential` scoped to that one call and that one app, per-app concurrency
   and rate ceilings honored, `429`/`Retry-After` respected
   ([security.md](../architecture/security.md) *Least privilege*;
   [overview.md](../architecture/overview.md) *Outbound load discipline*; OC-3).
4. **Given** an adapter fan-out competing with sync polling/backfill for the same backend app, **when** calls
   are issued, **then** they share **one** per-app ceiling — adapter traffic is not exempt
   ([overview.md](../architecture/overview.md) *Outbound load discipline*).
5. **Given** a backend call fails (timeout, 5xx, connection error), **when** the result is recorded, **then** it
   is a **per-binding failure** carrying which backend failed, and it does not abort sibling calls in the same
   parallel group — the aggregator decides the request's fate per strategy and role (AG-*)
   ([adapter-engine.md](../architecture/adapter-engine.md) *Error and partial-failure semantics*).
6. **Given** a read request, **when** the outbound retry policy applies, **then** a live inbound request is not
   retried indefinitely — it is bounded so the consumer gets an answer (bound is config-defined; README open
   question 9); the Phase-4 park/dead-letter path does **not** apply to adapter reads, which have a live caller
   ([adapter-engine.md](../architecture/adapter-engine.md); contrast *Write failures* in
   [sync-engine.md](../architecture/sync-engine.md)).

### Out of scope

- Idempotency treatment of **writes** — WR-3.
- Aggregating results — AG-*.

### Dependencies

Blocked by TE-1, Phase-4 OC-1..OC-5, CD-1..CD-3. Precedes TE-3, TE-4.

---

## TE-3 — Chained bindings: `dependsOnBindingId` + `chainInputs`

**As an** operator composing an endpoint, **I** can feed one backend's output into another backend's input,
**so that** "get the id from A, then fetch from B" is expressible without coupling the two backends' native
schemas.

### Acceptance criteria

1. **Given** a binding with `dependsOnBindingId` set, **when** the plan executes, **then** it runs **only
   after** the upstream binding's response is available, regardless of `executionOrder` values
   ([adapter-engine.md](../architecture/adapter-engine.md) *Binding: decided at composition time*).
2. **Given** the upstream binding's response arrives, **when** the dependent is dispatched, **then** the
   upstream's **response-phase transform has already run** and the `chainInputs` read from its
   **consumer-shape** response — never from the upstream backend's native payload
   ([adapter-engine.md](../architecture/adapter-engine.md) *Request pipeline* step 6;
   [data-model.md](../architecture/data-model.md) `AdapterBinding.chainInputs`).
3. **Given** a `chainInput` entry, **when** it is applied, **then** it fills exactly the named
   `targetParamRef` of the dependent binding's backend operation, applying its optional transform in the
   sandbox ([data-model.md](../architecture/data-model.md) `AdapterBinding.chainInputs`).
4. **Given** the upstream response does **not** contain the `upstreamFieldPath` value (absent/null), **when**
   the dependent is dispatched, **then** the dependent binding **fails as a binding failure** with a cause
   naming the missing chain input — it is never dispatched with the parameter unfilled or with a guessed value
   (the same discipline as TE-1 criterion 3).
5. **Given** the upstream binding **failed**, **when** the plan continues, **then** the dependent binding is not
   called at all and is recorded as a dependent failure; the request's fate follows the roles/strictness of both
   (AG-2) ([adapter-engine.md](../architecture/adapter-engine.md) *Error and partial-failure semantics*).
6. **Given** `dependsOnBindingId` is valid **only** under `fanout-merge`, **when** a plan contains it under any
   other strategy, **then** execution fails loudly (composition validation CO-2 should have prevented it)
   ([adapter-engine.md](../architecture/adapter-engine.md) order/chaining validity rules).

### Out of scope

- Validating that `upstreamFieldPath` exists in the upstream's consumer-shape response — CO-2 (composition
  validation) and CO-7 (re-validation at successor adoption).

### Dependencies

Blocked by TE-2, AD-2. Precedes AG-2.

---

## TE-4 — Response phase: backend response → consumer shape

**As a** consumer-app developer, **I** receive fields shaped by the reviewed response-phase transforms, **so
that** the body matches the schema I coded against rather than a backend's native shape.

### Acceptance criteria

1. **Given** a backend response, **when** the response phase runs, **then** it applies **only** the mapping's
   `FieldMapping`s with `phase = response`, and **never** an inversion of the request phase
   ([adapter-engine.md](../architecture/adapter-engine.md) intro, *Request pipeline* step 7;
   [glossary.md](../glossary.md) `phase`).
2. **Given** each binding's response, **when** it arrives, **then** its response phase runs **immediately** —
   not after all backends have returned — so a chained dependent has consumer-shape input available as early as
   possible ([adapter-engine.md](../architecture/adapter-engine.md) *Request pipeline* step 6).
3. **Given** a **collection** response, **when** the response phase runs, **then** it is applied per row, and
   each row's **backend-native id** is captured from the pre-transform payload via that resource's confirmed
   `ResourceBinding.nativeIdRef` and carried as **row provenance** alongside the transformed row
   ([adapter-engine.md](../architecture/adapter-engine.md) *Aggregation strategies*, dedup paragraph).
4. **Given** the captured provenance, **when** it is carried, **then** it travels **out of band** (as executor
   metadata), never injected into the consumer-shape row body, which must stay consumer-schema-valid
   ([adapter-engine.md](../architecture/adapter-engine.md) *Aggregation strategies*).
5. **Given** a backend resource whose `nativeIdRef` is **not confirmed**, **when** rows are transformed,
   **then** provenance ids are simply absent — and link-based dedup is consequently unavailable for that
   contributor (CO-3 criterion 2), rather than being approximated from some other field
   ([adapter-engine.md](../architecture/adapter-engine.md) *Aggregation strategies*;
   [data-model.md](../architecture/data-model.md) `ResourceBinding.nativeIdRef`).

### Out of scope

- Merging/deduplicating rows — AG-3. Validating the aggregated response — AG-7.

### Dependencies

Blocked by TE-2, Phase-1 RB-1/RB-2 (`nativeIdRef` confirmation). Precedes AG-*.

---

## TE-5 — The executor → aggregator contract is an explicit per-binding result

**As an** implementer, **I** have every backend call produce one uniform result envelope, **so that** the
aggregator is a pure function of those envelopes and the seam is unit-testable without any HTTP.

### Acceptance criteria

1. **Given** any binding in the plan, **when** execution finishes, **then** it yields exactly one **result
   envelope** carrying: the binding id, its `role`, its `executionOrder`, the outcome
   (success | failure | not-called), the **consumer-shape** payload on success, the **cause** on failure
   (upstream error / `mapping-stale` / `mapping-suspended` / `backend-disabled` / missing chain input), and row
   provenance for collection payloads ([adapter-engine.md](../architecture/adapter-engine.md) *Request pipeline*
   steps 6-8).
2. **Given** the set of envelopes, **when** the aggregator runs, **then** it is a **pure function** of
   (plan + envelopes) — no I/O — so every strategy is testable over hand-built envelopes (AG-*).
3. **Given** a binding eliminated by the planner (RP-3), **when** envelopes are assembled, **then** it appears
   as a not-called envelope with its planner-assigned cause, so the aggregator never has to distinguish "never
   ran" from "ran and returned nothing".
4. **Given** an envelope's payload, **when** it is produced, **then** it is already in consumer shape — the
   aggregator applies **no** field transforms of its own
   ([adapter-engine.md](../architecture/adapter-engine.md) *Request pipeline* steps 7-8).
5. **Given** the same request executed twice with identical backend responses, **when** envelopes are produced,
   **then** they are identical apart from timing metadata — determinism the aggregator's tiebreak rules depend
   on (AG-4 criterion 5).

### Out of scope

- The aggregation itself — AG-*.

### Dependencies

Blocked by TE-2, TE-4. Precedes AG-1..AG-7.
