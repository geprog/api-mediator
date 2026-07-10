# Phase 1 — Event Bus (`SpecIngested`)

Emitting `SpecIngested` when an `ApiSpec` version 1 is stored, and providing the durable,
at-least-once, **idempotent-consumer** delivery the concept's Event Bus promises. Phase 1 stands up
the bus and the emission; the *reaction* to `SpecIngested` (mapping detection) is Phase 2, so Phase
1 verifies the delivery/dedup contract with a scaffold consumer, not a real reaction.

**Actor:** system (producer: Spec Registry; consumers: internal).

**Concept references (whole file):** [overview.md](../architecture/overview.md) *Components*
(Event Bus: "Durable, at-least-once delivery with idempotent consumers (deduplicating by event id)
… every event is re-derivable from persisted state, and a periodic reconciliation sweep …");
[data-model.md](../architecture/data-model.md); [glossary.md](../glossary.md) `Event Bus`,
`SpecIngested`; [app-registration-and-mapping-detection.md](../flows/app-registration-and-mapping-detection.md)
step 3.

---

## EB-1 — Emit `SpecIngested` when an `ApiSpec` is stored

**As a** system, **I** emit a `SpecIngested` event once a new `ApiSpec` version is parsed and stored,
**so that** downstream services (Mapping Engine in Phase 2) can react without the Spec Registry
knowing about them.

### Acceptance criteria

1. **Given** an `ApiSpec` version 1 has been parsed and stored (SI-2), **when** storage completes,
   **then** the Spec Registry emits exactly one `SpecIngested` event onto the Event Bus for that
   spec.
2. **Given** a `SpecIngested` event, **when** inspected, **then** its payload carries at least the
   `specId`, `appId`, and `role` needed to identify the ingested spec, plus a unique event id used
   for deduplication.
3. **Given** a registration that stores multiple specs (AR-1 criterion 5), **when** processing
   completes, **then** one `SpecIngested` is emitted **per stored `ApiSpec`** (not one per app).
4. **Given** the atomic-registration rule (AR-1 criterion 7), **when** ingestion fails and no
   `ApiSpec` is stored, **then** no `SpecIngested` is emitted.
5. **Given** the bus is a durable outbox, **when** an event is emitted, **then** it is persisted
   durably such that it is deliverable at least once even across a supervised restart
   ([overview.md](../architecture/overview.md) *Components* / *Deployment model*).

### Security / invariant criteria

6. **Given** a `SpecIngested` payload, **when** inspected, **then** it contains no credential
   material (see CR-2 criterion 3).

### Out of scope

- Mapping-detection orchestration consuming `SpecIngested` (candidate enumeration, shortlist,
  detail) — Phase 2 ([mapping-engine.md](../architecture/mapping-engine.md);
  [app-registration-and-mapping-detection.md](../flows/app-registration-and-mapping-detection.md)
  steps 4-7).
- `MappingApproved` and other event types — later phases.

### Dependencies

Blocked by SI-2. Consumed contractually by EB-2.

---

## EB-2 — At-least-once delivery with idempotent consumption

**As a** system, **I** guarantee that a `SpecIngested` consumer processes each event effectively once
even under at-least-once (possibly duplicate) delivery, **so that** "bus loss degrades timeliness,
never correctness" holds from Phase 1 onward.

### Acceptance criteria

1. **Given** a subscribed consumer and a single emitted `SpecIngested`, **when** the bus delivers it,
   **then** the consumer's handler runs and records the event id as processed.
2. **Given** the same `SpecIngested` (same event id) is delivered twice, **when** the consumer
   handles the second delivery, **then** it is deduplicated by event id and the side effect runs
   **once**, not twice.
3. **Given** a consumer handler that fails mid-processing, **when** the event is redelivered, **then**
   the handler may run again (at-least-once) but the idempotent dedup ensures no duplicate committed
   side effect results.
4. **Given** Phase 1 has no real `SpecIngested` reaction yet, **when** these guarantees are tested,
   **then** they are verified with a scaffold/no-op consumer that records processed event ids —
   proving the delivery + dedup contract independently of Phase 2 behavior.

### Out of scope

- The **reconciliation sweep** that re-derives missing reactions from persisted state (e.g. an
  ingested spec with no analysis run) — its meaningful behavior is Phase 6
  ([overview.md](../architecture/overview.md) *Components*; the plan's "reconciliation sweep wired to
  real derivations"). Phase 1 may include only a stub; there is no real derivation to reconcile yet.
- Ordering guarantees / partitioned delivery — not required for `SpecIngested` in Phase 1.

### Dependencies

Blocked by EB-1.
