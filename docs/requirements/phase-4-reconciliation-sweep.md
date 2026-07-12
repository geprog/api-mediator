# Phase 4 — Reconciliation sweep (sync)

The invariant guardian: the periodic **reconciliation sweep** compares persisted state against what should have
been derived from it and re-triggers any missing reaction — so that **bus loss degrades timeliness, never
correctness**. Phase 2 wired the sweep to detection, Phase 3 (AI-3) to disabled-artifact instantiation; Phase 4
wires it to **sync execution** and pairs it with the polling loop's own cursor/snapshot self-healing across
restarts. This file extends the existing sweep ([`event-bus/src/reconciliation.ts`](../../packages/event-bus/src/reconciliation.ts)),
it does not replace it.

Every criterion is deterministic and unit-testable by dropping a reaction / simulating a restart and asserting
eventual convergence; it does not need a running landscape (though SU-6's e2e demonstrates it end to end).

**Actor:** system (the reconciliation sweep + the Scheduler/Poller).

**Concept references (whole file):** [overview.md](../architecture/overview.md) *Components* (the sweep;
"bus loss degrades timeliness, never correctness"), *Deployment model* ("Sync self-heals across downtime —
polling resumes from cursors/snapshots, and state-convergent sync catches up on the next poll after restart");
[sync-engine.md](../architecture/sync-engine.md) *Polling pull pipeline* (enqueue-then-advance), *Write failures*
(state-convergent); [glossary.md](../glossary.md) `Event Bus`. Builds on Phase-3
[phase-3-artifact-instantiation.md](phase-3-artifact-instantiation.md) (AI-3).

> **Concept-coverage flag (see README open question):** the concept specifies the sweep's *sync-specific*
> derivations more thinly than the plan implies — its named examples are detection and instantiation, and it
> leans on cursor/snapshot self-healing for the polling loop itself. The derivations below are the
> product-owner's reading of "wired to real derivations"; a human should confirm the exact set.

---

## RS-1 — The sweep re-derives missing sync enablement/backfill reactions

**As an** operator, **I** rely on a periodic sweep detecting and re-triggering a sync reaction that was lost,
**so that** a dropped or crashed event never leaves an enabled rule permanently stuck.

### Acceptance criteria

1. **Given** the Phase-3 sweep already re-triggers "an approved mapping with no rules/bindings/edge" (AI-3),
   **when** Phase 4 extends it, **then** it additionally re-derives sync-execution readiness from persisted
   `SyncRule` state — the sweep stays a comparison of persisted state against what should have been derived from
   it ([overview.md](../architecture/overview.md) *Components*).
2. **Given** a rule enabled with `backfillStatus = running` whose backfill did **not** finish (a crash mid-run),
   **when** the sweep evaluates it, **then** it re-triggers the backfill — the reaction is **re-derivable** from
   the persisted rule + binding + mapping state, and re-running is safe because backfill goes through the normal
   idempotent pipeline (echo checks + idempotency keys absorb re-processing)
   ([sync-engine.md](../architecture/sync-engine.md) *Initial backfill*, *Idempotency*).
3. **Given** a rule enabled with `backfillStatus = completed`/`skipped` that is **not** being scheduled, **when**
   the sweep evaluates it, **then** it ensures the rule is scheduled — an enabled, backfilled rule that somehow
   isn't polling is a missing reaction the sweep repairs ([overview.md](../architecture/overview.md) *Components*).
4. **Given** the sweep's work, **when** it runs, **then** it is **bounded** — it re-derives a small set of
   reactions per pass, never replays unbounded history (matching AI-3's bounded-reconciliation shape).
5. **Given** a reaction is re-triggered, **when** it completes, **then** it produces the **same** committed side
   effect as the original (idempotent) — re-triggering never double-enables or double-backfills a rule.

### Out of scope

- The bus's at-least-once delivery + idempotent-consumer mechanics — Phase-1 EB-2 (the sweep complements them).
- Re-deriving detection / instantiation reactions — Phase 2 / Phase-3 AI-3 (already wired).

### Dependencies

Blocked by Phase-3 AI-3, BE-3, SD-1. Precedes RS-2.

---

## RS-2 — Bus loss and restart degrade timeliness, never correctness

**As an** operator, **I** rely on the combination of the sweep and cursor/snapshot durability making dropped
events and restarts cost only **timeliness**, **so that** sync always eventually converges to the correct state.

### Acceptance criteria

1. **Given** a `MappingApproved`/enablement reaction is **dropped**, **when** the sweep next runs, **then** the
   missing rules/backfill/schedule are re-derived and sync eventually converges — the sweep, **not** the bus's
   delivery guarantee alone, is what makes "bus loss degrades timeliness, never correctness" true
   ([overview.md](../architecture/overview.md) *Components*).
2. **Given** the mediator **restarts** mid-run, **when** it comes back, **then** **polling resumes from the
   persisted `cursor`/`lastSnapshotRef`** and **state-convergent** sync catches up on the next poll — durable
   queue entries (OQ-1) and enqueue-then-advance (SP-5) mean no detected change is stranded
   ([overview.md](../architecture/overview.md) *Deployment model*;
   [sync-engine.md](../architecture/sync-engine.md) *Polling pull pipeline*).
3. **Given** a parked write with no later change, **when** correctness is considered, **then** it is the **one**
   case needing manual attention (SA-5) — everything else converges automatically because each execution carries
   current state and any later successful sync supersedes a failure (OC-4)
   ([sync-engine.md](../architecture/sync-engine.md) *Write failures*).
4. **Given** the invariant is testable, **when** it is tested, **then** an integration test drops the enablement
   reaction (or restarts mid-run) and asserts the sweep + cursor/snapshot recovery **eventually** produce the
   correct target state — timeliness delayed, correctness intact.
5. **Given** single-instance deployment with supervised restart, **when** the mediator is down, **then** sync
   self-heals across the downtime (no HA required for correctness) — consistent with the availability model
   ([overview.md](../architecture/overview.md) *Deployment model*).

### Out of scope

- High availability / active-passive standby — deliberately out of scope for the initial version
  ([overview.md](../architecture/overview.md) *Deployment model*).
- Adapter-caller unavailability during downtime — that is an Adapter Engine concern (Phase 5).

### Dependencies

Blocked by RS-1, SP-5, OQ-1, OC-4. The correctness capstone the SU-6 e2e demonstrates.
