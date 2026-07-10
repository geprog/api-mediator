# Phase 2 — Detection trigger (`SpecIngested` → detection)

Wiring detection to the Event Bus: a `SpecIngested` consumer that enumerates the new spec's candidate
pairs (CE), runs the two-stage detection (TD), and persists proposals (PP) — **auto-running on every
ingestion** as the flow specifies, while keeping the slow LLM/network work **out of the event-bus
dispatcher transaction**, staying idempotent under at-least-once delivery, and being re-derivable by
the reconciliation sweep.

This is the seam Phase 1 left dangling: Phase-1 EB-1 emits `SpecIngested` and EB-2 proves the
delivery/dedup contract with a scaffold consumer; Phase 2 replaces the scaffold with the real
reaction.

**Actor:** system (Mapping Engine orchestrator as an Event Bus consumer).

**Concept references (whole file):** [app-registration-and-mapping-detection.md](../flows/app-registration-and-mapping-detection.md)
steps 4-7; [overview.md](../architecture/overview.md) *Components* (Event Bus: at-least-once,
idempotent consumers, reconciliation sweep — "an ingested spec with no analysis run … re-triggers the
missing reaction"); [mapping-engine.md](../architecture/mapping-engine.md) *Candidate pair
selection*; [glossary.md](../glossary.md) `SpecIngested`, `Event Bus`, `Mapping Engine`. Builds on
Phase-1 [phase-1-event-bus.md](phase-1-event-bus.md) (EB-1, EB-2).

> **"Offload outside the dispatcher transaction" is a stated constraint, its mechanism is
> implementation-defined.** A full landscape pass is ~1,000 LLM calls
> ([overview.md](../architecture/overview.md) *Scale assumption*); holding a bus-dispatch transaction
> open across that is unacceptable. Whether the handler hands off to a job queue, a worker, or an
> async task is an implementation choice — the testable requirement is that the dispatcher
> transaction does not span the LLM/network work.

---

## DT-1 — Consume `SpecIngested` and run detection for the new spec's candidates

**As the** Mapping Engine, **I** react to each `SpecIngested` by analyzing exactly the candidate pairs
that new spec introduces, **so that** newly registered apps get proposals without any operator having
to trigger detection by hand.

### Acceptance criteria

1. **Given** a `SpecIngested` event for spec `S`, **when** the Mapping Engine consumes it, **then** it
   enumerates the candidate spec pairs **involving `S`** (CE-1..3), runs two-stage detection (TD) for
   each, and persists the resulting `MappingProposal`s (PP) — auto-run, no operator action required
   ([flow](../flows/app-registration-and-mapping-detection.md) step 4: "A mapping orchestrator …
   picks up `SpecIngested` and enumerates the candidate spec pairs").
2. **Given** a landscape with other active specs, **when** detection completes for `S`, **then** one
   analysis ran per enumerated candidate (peer-peer: two proposals per unordered pair;
   consumer-provider: one) and no pair **not** involving `S` was analyzed.
3. **Given** the first spec ever ingested (no other active specs), **when** detection runs, **then**
   it enumerates zero candidates and persists zero proposals — successfully, not as an error.
4. **Given** detection completes, **when** proposals exist, **then** the API/UI Layer is notified that
   new proposals are ready for review (the handoff to the Phase-3 review flow)
   ([flow](../flows/app-registration-and-mapping-detection.md) step 7).
5. **Given** the escape hatch and re-mapping are **not** Phase 2, **when** detection is triggered,
   **then** the only trigger wired here is `SpecIngested` — there is no operator "re-run detection"
   action and no `SpecDiff`-driven incremental trigger in Phase 2.

### Out of scope

- The manual "analyze this resource pair anyway" trigger (escape hatch) — Phase 3 UI action.
- `SpecDiff`-scoped incremental analysis on a new spec version, and `analysisExclusions` re-inclusion
  triggers — Phase 6 ([extensibility.md](../architecture/extensibility.md);
  [mapping-engine.md](../architecture/mapping-engine.md) *Scoping down*).

### Dependencies

Blocked by Phase-1 EB-1/EB-2, and by CE-*, TD-*, PP-*.

---

## DT-2 — Offload the LLM work off the dispatcher transaction; idempotent + reconcilable

**As an** operator, **I** rely on detection not blocking the Event Bus and not double-producing
proposals on redelivery, **so that** "bus loss degrades timeliness, never correctness" holds for
detection just as the Phase-1 bus contract promised.

### Acceptance criteria

1. **Given** a `SpecIngested` delivery, **when** the consumer handles it, **then** the LLM/network
   work (shortlist + detail calls) runs **outside** the event-bus dispatcher transaction — the
   dispatch/ack transaction commits without waiting on the ~1,000-call analysis
   ([overview.md](../architecture/overview.md); Phase-2 scope note).
2. **Given** the **same** `SpecIngested` (same event id) is delivered twice (at-least-once), **when**
   the consumer handles the redelivery, **then** detection's committed side effect — the set of
   persisted `MappingProposal`s for that spec — is produced **once**, not duplicated (idempotent
   consumption, per Phase-1 EB-2).
3. **Given** a detection run that fails partway (e.g. some detail calls incomplete) and the event is
   redelivered, **when** it is reprocessed, **then** reprocessing does not create duplicate proposals
   for pairs already completed (the dedup/idempotency key discipline of EB-2 extends to detection's
   persisted output).
4. **Given** an ingested spec that ended up with **no** analysis run (e.g. the reaction was lost),
   **when** the reconciliation sweep runs, **then** it detects the missing analysis and re-triggers
   detection — detection is a re-derivable reaction, matching the concept's named example ("an
   ingested spec with no analysis run") ([overview.md](../architecture/overview.md) *Components*).
5. **Given** a proposal already marked `failed` by a shortlist-stage ceiling (TD-4), **when**
   reconciliation runs, **then** it does **not** treat that spec pair as "missing analysis" and loop
   — a recorded `failed` outcome is an analysis result, not an absence. *(See README open question on
   reconciliation's definition of "analyzed".)*

### Out of scope

- The full reconciliation-sweep implementation beyond detection's slice — its broader wiring (missing
  rules/bindings/edges) is Phase 4-6 ([overview.md](../architecture/overview.md)). Phase-1 EB-2 left
  it a stub; DT-2 wires **the detection derivation** into it.
- Ordering/partitioned delivery of `SpecIngested` — not required (each event is independently
  processable).

### Dependencies

Blocked by DT-1 and Phase-1 EB-2.
