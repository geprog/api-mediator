# Phase 5 — Adapter write operations

A consumer spec is not read-only: it can declare create/update/delete operations the consumer wants to perform
against the landscape. Phase 5 serves them under one deliberate restriction — **a write endpoint is always
`aggregationStrategy = single` with exactly one active binding** — plus idempotency backed by a bounded
write-outcome store, immediate cache invalidation, and strict failure semantics.

The subtlest rule here is the interplay with sync: an adapter write is a **genuine** change from the Sync
Engine's perspective and is deliberately **not** tagged in the loop-prevention cache, so the next poll picks it
up and propagates it like any other edit.

**Actor:** consumer-app developer (performs the write); system (executes); operator (observes).

**Concept references (whole file):** [adapter-engine.md](../architecture/adapter-engine.md) *Write operations*
(all five bullets), *Caching*, *Error and partial-failure semantics*;
[data-model.md](../architecture/data-model.md) `OperationMapping.action`, `AdapterEndpoint`, `AdapterBinding`;
[sync-engine.md](../architecture/sync-engine.md) *Loop prevention* (what tagging is for);
[security.md](../architecture/security.md) *Audit logging* (the Audit Log stays metadata-only);
[glossary.md](../glossary.md) `Idempotency key`, `action`. Reused:
[phase-4-outbound-executor.md](phase-4-outbound-executor.md) OC-2 (idempotency),
[phase-4-loop-prevention.md](phase-4-loop-prevention.md) EP-2 (the recently-written cache this must *not*
write to).

> **Authoritative:** writes never fan out; a deduplicated delivery is answered with the **recorded** outcome,
> never re-executed and never with a fabricated success; write responses are never cached and a successful
> write invalidates; an adapter write is **not** loop-tagged; any error fails the request. **Implementation
> choice:** key derivation details, storage of the outcome store, header names.

---

## WR-1 — A write endpoint is always `single`

**As a** landscape operator, **I** cannot compose a write across multiple backends, **so that** the mediator
never creates a distributed transaction it has no way to compensate.

### Acceptance criteria

1. **Given** a consumer operation whose `OperationMapping.action` is `create`, `update`, or `delete`, **when**
   its endpoint is composed, **then** `aggregationStrategy` must be `single` with exactly **one** `active`
   binding; any other strategy is rejected at composition validation
   ([adapter-engine.md](../architecture/adapter-engine.md) *Write operations*; CO-2).
2. **Given** an attempt to compose a write endpoint as `fanout-merge` or `collection-union`, **when** validated,
   **then** it is rejected with the reason "partial success leaves the landscape inconsistent" (copy is
   implementation-defined; the rejection is not)
   ([adapter-engine.md](../architecture/adapter-engine.md) *Write operations*).
3. **Given** an attempt to compose a write endpoint as `fanout-first-success`, **when** validated, **then** it
   is rejected because a timed-out primary may in fact have succeeded, so retrying against a fallback would
   duplicate the side effect ([adapter-engine.md](../architecture/adapter-engine.md) *Write operations*).
4. **Given** a second approved mapping attaches another binding to a **write** endpoint, **when** it attaches,
   **then** the endpoint goes `composition-required` as usual and the composer must choose **which single
   binding** is active — the others stay `proposed`/`disabled` rather than joining a fan-out
   ([adapter-endpoint-composition.md](../flows/adapter-endpoint-composition.md) step 3).
5. **Given** a consumer needing the same data in several backends, **when** the concept's answer is applied,
   **then** it is peer-peer sync **between those backends** — not a fanned-out adapter write; this is a
   documented limitation, not a gap ([adapter-engine.md](../architecture/adapter-engine.md) *Write
   operations*).

### Out of scope

- Classifying `action` — Phase-3 AS-4 (derive-then-correct at review); Phase 5 reads it.

### Dependencies

Blocked by AD-1, CO-2. Precedes WR-2.

---

## WR-2 — The write round trip

**As a** consumer-app developer, **I** can create/update/delete through my own API shape, **so that** the
mediator writes to the real backend and returns me the stored resource in my schema.

### Acceptance criteria

1. **Given** a write request, **when** the request phase runs, **then** the backend request body is produced by
   the mapping's `phase = request` `FieldMapping`s and its path/query inputs by the `OperationMapping`'s
   `ParameterMapping`s — identically to a read (TE-1)
   ([adapter-engine.md](../architecture/adapter-engine.md) *Write operations* — *Phases*).
2. **Given** the backend responds (typically with the stored resource), **when** the response phase runs,
   **then** it maps back via `phase = response` `FieldMapping`s, exactly like a read (TE-4).
3. **Given** the backend returns **no body** (e.g. `204`), **when** the response is produced, **then** the
   consumer response is derived without fabricating field values — if the consumer schema requires a body the
   mediator cannot produce, the request fails as `mediator-transform-error` rather than inventing one (AG-7).
   *Whether a follow-up read should be performed instead is README open question 12.*
4. **Given** the write executes, **when** the outbound call is made, **then** it uses the shared Outbound Call
   Executor with per-call credential access and the per-app ceilings (TE-2 criterion 3-4).
5. **Given** the aggregated (single-binding) write response, **when** it is returned, **then** it is validated
   against the consumer response schema like any other response (AG-7).

### Out of scope

- Multi-binding writes — WR-1 forbids them.

### Dependencies

Blocked by TE-1, TE-4, WR-1. Precedes WR-3.

---

## WR-3 — Idempotency and the write-outcome store

**As a** consumer-app developer, **I** can safely retry a write, **so that** a network hiccup does not create
the same record twice — and a deduplicated retry tells me what actually happened.

### Acceptance criteria

1. **Given** the consumer operation **declares** an idempotency-key parameter, **when** a caller supplies it,
   **then** it is passed through as the write's key
   ([adapter-engine.md](../architecture/adapter-engine.md) *Write operations* — *Idempotency*).
2. **Given** the consumer operation declares **no** such parameter, **when** a write is executed, **then** a
   deterministic key is derived from the request via the shared Phase-4 idempotency treatment (OC-2), and this
   deliberately biases toward **at-most-once**: byte-identical writes inside the lookback window read as one
   delivery ([adapter-engine.md](../architecture/adapter-engine.md) *Write operations*).
3. **Given** a delivery is deduplicated, **when** it is answered, **then** it is answered with the **recorded
   outcome** (status and response) of the original execution from the write-outcome store — **never
   re-executed**, and **never** answered with a fabricated success
   ([adapter-engine.md](../architecture/adapter-engine.md) *Write operations*).
4. **Given** the original execution **failed**, **when** a deduplicated delivery arrives within the window,
   **then** it is answered with that recorded failure (AD-4 criterion 5) — a failure is not upgraded to a
   success by being repeated.
5. **Given** the outcome store is **bounded** to the dedup window, **when** an entry ages out, **then** a
   subsequent identical write is a genuinely new delivery and executes normally
   ([adapter-engine.md](../architecture/adapter-engine.md) *Write operations*).
6. **Given** the store holds response bodies, **when** the Audit Log is written for the same request, **then**
   the Audit Log remains **metadata-only** — the body lives only in the bounded store
   ([security.md](../architecture/security.md) *Audit logging*).
7. **Given** a consumer that genuinely needs to repeat identical writes, **when** it wants that, **then** the
   expressible answer is declaring an idempotency-key parameter in its consumer spec — the mediator does not
   offer a per-request "force" bypass ([adapter-engine.md](../architecture/adapter-engine.md) *Write
   operations*).

### Out of scope

- The key-derivation formula — reused verbatim from Phase-4 OC-2.

### Dependencies

Blocked by AD-4, Phase-4 OC-2, WR-2. Precedes WR-4.

---

## WR-4 — Not loop-tagged; invalidates cache

**As a** landscape operator, **I** have an adapter write behave like a real user edit for sync purposes and
immediately drop stale cached reads, **so that** the write propagates to sync peers and is not masked by the
mediator's own cache.

### Acceptance criteria

1. **Given** a successful adapter write to a backend that also participates in peer-peer sync, **when** it
   completes, **then** it is **not** tagged in the loop-prevention recently-written cache and creates no
   suppressing `SyncFieldState` baseline of its own — so the Sync Engine's next poll of that backend picks it
   up as a genuine change and propagates it
   ([adapter-engine.md](../architecture/adapter-engine.md) *Write operations* — *Interplay with sync*;
   [sync-engine.md](../architecture/sync-engine.md) *Loop prevention*; EP-2).
2. **Given** that write is later polled by the Sync Engine, **when** the poll runs, **then** it is **not**
   recorded `skipped-loop` — it propagates to the backend's sync peers like any other edit (an e2e-assertable
   contract between the two engines) ([adapter-engine.md](../architecture/adapter-engine.md) *Interplay with
   sync*).
3. **Given** a successful adapter write, **when** it completes, **then** cached entries of **every**
   `AdapterEndpoint` bound to the same backend resource are invalidated immediately — coarse, like all
   invalidation ([adapter-engine.md](../architecture/adapter-engine.md) *Write operations* — *Caching*,
   *Caching* section; CH-4).
4. **Given** a write response, **when** caching is considered, **then** it is **never cached**
   ([adapter-engine.md](../architecture/adapter-engine.md) *Write operations* — *Caching*).
5. **Given** a **failed** write, **when** invalidation is considered, **then** nothing is invalidated on the
   failure path alone (only a *successful* write invalidates) — while a partially-applied backend write remains
   covered by TTL and by sync-driven invalidation.

### Out of scope

- The cache mechanism itself — CH-*.

### Dependencies

Blocked by WR-3, CH-1. Cross-checked by the Phase-4 loop-prevention suite (EP-*).

---

## WR-5 — Strict failure semantics for writes

**As a** consumer-app developer, **I** always learn when my write did not happen, **so that** I never treat a
failed write as applied.

### Acceptance criteria

1. **Given** any error during a write — planner cause, backend failure, transform failure, response-validation
   failure — **when** the request is answered, **then** the request **fails** with the upstream/specific error
   surfaced; there is **no** partial or degraded response for a write
   ([adapter-engine.md](../architecture/adapter-engine.md) *Write operations* — *Failure semantics*).
2. **Given** a write binding is `stale`, `suspended`, or its backend `disabled`, **when** the write is
   attempted, **then** it fails with that specific cause and **no** call is made
   (RP-3; [adapter-engine.md](../architecture/adapter-engine.md) *Stale bindings at request time*).
3. **Given** a write that failed **after** the backend may have applied it (a timeout), **when** it is answered,
   **then** the failure is reported as such — the mediator never reports success it cannot confirm, and the
   idempotency key is what makes the caller's retry safe (WR-3).
4. **Given** every write outcome, **when** it is recorded, **then** an `adapter-request` audit row captures the
   endpoint, binding, idempotency key, and outcome (AD-5) — including deduplicated deliveries, which are
   distinguishable from fresh executions.

### Out of scope

- Retry/park semantics of sync writes — Phase-4 OC-4; an adapter write has a live caller and is never parked.

### Dependencies

Blocked by WR-2, RP-3, AG-7.
