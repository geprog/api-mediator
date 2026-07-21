# Phase 6 — Reconciliation sweep wired to real derivations

The concept's durability guarantee — **"Event Bus loss degrades timeliness, never correctness"** — is only
true because a periodic **reconciliation sweep** compares persisted state against what should have been
derived from it and re-triggers any missing reaction. Earlier phases built the sweep **framework**
(`ReconciliationSweep`) and registered concrete reconcilers for their own derivations (Phase-2 detection,
Phase-3 instantiation, Phase-4 sync-execution/backfill). Phase 6 closes the loop: it registers reconcilers
for the **Phase-6 derivations** (the graph projection, the `SpecDiff` reactions, successor adoption) and
turns the guarantee into a **tested** one across engines.

**What already exists vs. what Phase 6 adds** (checked against `packages/event-bus/src/reconciliation.ts`,
`packages/outbound/src/sync-execution-reconciler.ts`): the `ReconciliationSweep` registry (`register` /
`runSweep`, per-reconciler failure isolation, the `Reconciler` interface `{ name, reconcile() }`) is built;
the Phase-4 `SyncExecutionReconciler` (bounded scan, re-trigger crash-orphaned backfills) exists and notes
its "live wiring is the deferred SA slice"; the reconciliation sweep's own module documents that "concrete
reconcilers plug in later at their composition roots". Phase 6 **adds** the Phase-6 reconcilers, ensures
every Phase-6 derivation has one, and adds the bus-loss capstone. **No new framework** — every reconciler
is a `{ name, reconcile() }` registered on the existing sweep.

**Actor:** system (the sweep and its reconcilers). No human role — the sweep is an internal invariant
guardian, not an operator surface.

**Concept references (whole file):** [overview.md](../architecture/overview.md) *Components* (Event Bus not
a source of truth; the reconciliation sweep re-triggers "an ingested spec with no analysis run, an approved
mapping with no rules/bindings/edge"), *Deployment model* (self-heal across downtime);
[graph-overview.md](../flows/graph-overview.md) *Materialized projection* (the projection is *recoverable* —
rebuilt wholesale from persisted state); [extensibility.md](../architecture/extensibility.md) *Spec update
lifecycle*, *Successor adoption* (the reactions a lost event must recover). Reused seams:
[phase-4-reconciliation-sweep.md](phase-4-reconciliation-sweep.md) RS-1/RS-2 (`SyncExecutionReconciler`);
[phase-2-detection-trigger.md](phase-2-detection-trigger.md) DT-2, [phase-3-artifact-instantiation.md](phase-3-artifact-instantiation.md)
AI-3 (existing reconcilers); [phase-6-graph.md](phase-6-graph.md) GR-4 (rebuild-from-state),
[phase-6-spec-update-lifecycle.md](phase-6-spec-update-lifecycle.md) SL-1 … SL-8.

> **Authoritative:** the sweep — not the bus's delivery guarantee alone — is what makes bus loss degrade
> timeliness, never correctness; every event is **re-derivable from persisted state**; a reconciler
> **re-triggers a missing reaction**, it does not replay bus history; the graph projection is rebuildable
> wholesale from persisted state. **Implementation choice:** sweep interval, per-reconciler bound/`limit`,
> the exact "missing reaction" predicate per derivation.

---

## RC-1 — Register the Phase-6 reconcilers live on the sweep

**As the** mediator, **I** run every Phase-6 derivation's reconciler on the shared sweep, **so that** a
dropped `MappingApproved`/`SpecIngested`/adoption event is eventually recovered from persisted state.

### Acceptance criteria

1. **Given** the existing `ReconciliationSweep`, **when** the composition root wires Phase 6, **then** it
   **registers** the Phase-6 reconcilers (RC-2 graph, RC-3 spec-lifecycle/adoption) via
   `ReconciliationSweep.register`, each with a unique `name`, alongside the Phase-2/3/4 reconcilers —
   reusing the framework, not replacing it (`packages/event-bus/src/reconciliation.ts`).
2. **Given** a reconciler throws, **when** the sweep runs, **then** the failure is isolated as an `error`
   outcome and the other reconcilers still run — one broken derivation cannot block the rest
   (`ReconciliationSweep.runSweep` failure isolation).
3. **Given** each reconciler, **when** it runs, **then** it re-derives its work **purely from persisted
   state** (a bounded scan) and closes over its own repositories — it **never replays** bus history
   ([overview.md](../architecture/overview.md) *Components*; Reconciler contract).
4. **Given** the sweep runs on a schedule, **when** it is wired, **then** the interval is config-defined and
   the sweep is idempotent — a pass that finds nothing missing re-triggers nothing (Phase-4 RS-1.5).
5. **Given** the Phase-4 `SyncExecutionReconciler` noted its live wiring as "the deferred SA slice",
   **when** Phase 6 wires the composition root, **then** any still-inert earlier reconciler is confirmed
   registered too — the sweep is not partially wired (a test asserts the full registered set).

### Out of scope

- The per-derivation predicates — RC-2/RC-3. The framework — already built.

### Dependencies

Blocked by Phase-1 (sweep framework), Phase-4 RS-* (existing sync reconciler). Precedes RC-2 … RC-4.

---

## RC-2 — Graph-projection reconciler (recoverable projection)

**As the** Graph/Overview Service, **I** rebuild an edge that a lost event left missing or wrong, **so
that** the materialized `GraphEdge` projection is recoverable and a dropped `MappingApproved`/status change
never leaves the overview permanently inconsistent.

### Acceptance criteria

1. **Given** an `ApprovedMapping` with instantiated `SyncRule`s/`AdapterBinding`s but **no** matching
   `GraphEdge` (a lost `MappingApproved` reaction), **when** the reconciler runs, **then** it **re-derives**
   the missing edge from persisted state — exactly the "approved mapping with no … edge" case the concept
   names ([overview.md](../architecture/overview.md) *Components*;
   [graph-overview.md](../flows/graph-overview.md) *Materialized projection*).
2. **Given** an edge whose persisted `status` **diverges** from the current aggregate of its underlying
   rules/bindings (a lost status-change event), **when** the reconciler runs, **then** it **recomputes and
   corrects** the edge (via the GR-1 update) — the projection converges to what persisted state implies.
3. **Given** an edge whose underlying rules/bindings are **all gone** (a lost deregister/removal), **when**
   the reconciler runs, **then** it **removes** the orphaned edge (GR-1 remove).
4. **Given** a suspect or lost projection, **when** a wholesale rebuild is requested, **then** the entire
   `GraphEdge` set is **rebuilt from persisted `ApprovedMapping`/`SyncRule`/`AdapterBinding` state + audit
   summaries** — events keep it incremental, persisted state keeps it recoverable
   ([graph-overview.md](../flows/graph-overview.md) *Materialized projection*).
5. **Given** the scan, **when** it runs, **then** it is **bounded** per pass and **idempotent** — a pass
   after convergence re-derives/removes nothing (Phase-4 RS-1.4/1.5).

### Out of scope

- The incremental updaters — GR-2/GR-3 (this reconciler is the recovery path when an incremental update was
  lost). Rendering — GR-6.

### Dependencies

Blocked by RC-1, GR-1 … GR-4. Registered by RC-1.

---

## RC-3 — Spec-lifecycle and successor-adoption reconciler

**As the** mediator, **I** re-trigger a `SpecDiff` reaction or a successor adoption that a lost event
skipped, **so that** a re-pin, stale-marking, scoped analysis, or adoption is never permanently dropped by
bus loss.

### Acceptance criteria

1. **Given** an ingested `ApiSpec` version with **no** `SpecDiff` reaction applied (no re-pin, no
   stale-marking, no scoped analysis) — a lost `SpecIngested` reaction — **when** the reconciler runs,
   **then** it re-derives and re-triggers the missing reaction from the persisted old/new versions
   ([overview.md](../architecture/overview.md) *Components* — "an ingested spec with no analysis run";
   [extensibility.md](../architecture/extensibility.md) *Spec update lifecycle*).
2. **Given** a breaking diff that marked mappings `stale` but whose **scoped re-analysis proposal** (SL-6)
   was never produced, **when** the reconciler runs, **then** it re-triggers the scoped re-analysis — a
   stale mapping never sits without its re-review proposal being (re)requested
   ([mapping-engine.md](../architecture/mapping-engine.md) *Re-mapping on spec change*).
3. **Given** a **successor** `ApprovedMapping` that was approved but whose **adoption** (SL-7/SL-8) did not
   run or half-ran — a lost/half-applied `MappingApproved` for the successor — **when** the reconciler runs,
   **then** it re-triggers adoption: re-pointing, counterpart transfer, supersession, field-state
   reconciliation, and the CO-7 adapter re-validation converge idempotently
   ([extensibility.md](../architecture/extensibility.md) *Successor adoption*; SL-7/SL-8).
4. **Given** an `analysisExclusions` re-inclusion (SL-9) whose scoped analysis was lost, **when** the
   reconciler runs, **then** it re-triggers that scoped analysis — treated identically to an additively-added
   resource with no analysis run ([mapping-engine.md](../architecture/mapping-engine.md) *Scoping down*).
5. **Given** each re-trigger, **when** it runs, **then** it is **idempotent**: re-running an already-applied
   re-pin/stale-marking/adoption is a no-op, so the reconciler never double-adopts or double-marks, and a
   `failed`-recorded scoped analysis counts as "reacted" (not re-looped) — the Phase-2 DT-2 "analyzed
   includes failed" discipline.
6. **Given** the scan, **when** it runs, **then** it is **bounded** per pass and re-derives purely from
   persisted `ApiSpec`/`ApprovedMapping` state — never from bus history (Reconciler contract).

### Out of scope

- The lifecycle reactions themselves — SL-1 … SL-9 (this reconciler only re-triggers a *missing* one).

### Dependencies

Blocked by RC-1, SL-1 … SL-9. Registered by RC-1.

---

## RC-4 — Capstone: "bus loss degrades timeliness, never correctness" is a tested guarantee

**As the** mediator, **I** prove that dropping bus deliveries still converges every Phase-6 derivation via
the sweep, **so that** the concept's durability guarantee is a regression-tested fact, not a claim.

### Acceptance criteria

1. **Given** a test harness that **suppresses** Event-Bus delivery for a chosen reaction, **when** a
   `MappingApproved` for a peer-peer mapping is approved with delivery dropped, **then** immediately
   afterward the `SyncRule`/`GraphEdge` are missing, and **after one sweep** they exist and are correct —
   timeliness degraded, correctness intact (RC-1/RC-2; [overview.md](../architecture/overview.md)
   *Components*).
2. **Given** a **breaking** `SpecDiff` with its reaction delivery dropped, **when** the sweep runs, **then**
   the affected mappings are `stale`, the affected rules paused, and the scoped re-analysis (re)requested —
   recovered from persisted spec state (RC-3; SL-4/SL-6).
3. **Given** an approved **successor** whose adoption delivery is dropped, **when** the sweep runs, **then**
   adoption converges (re-point + supersede + field-state reconciliation + CO-7 re-validation) exactly once
   (RC-3; SL-7/SL-8).
4. **Given** a dropped `sync-execution` outbox delivery (XI-1), **when** it is never delivered, **then** the
   worst outcome is a cached adapter response living out its `cacheTtl` — asserted as **bounded staleness,
   never a correctness break** (this reaction is deliberately *not* reconciled, because it is already
   correctness-safe; CH-3.4) ([phase-6-cross-engine-invalidation.md](phase-6-cross-engine-invalidation.md)
   XI-1).
5. **Given** the sweep runs twice in a row after convergence, **when** the second pass runs, **then** it
   re-triggers nothing — the guarantee holds without churn (idempotency, RC-1.4/RC-2.5/RC-3.5).

### Out of scope

- High availability / multi-instance failover — deliberately out of scope
  ([overview.md](../architecture/overview.md) *Deployment model*); the sweep is a single-instance
  self-heal, not an HA mechanism.

### Dependencies

Blocked by RC-1, RC-2, RC-3, and the derivations they recover (GR-*, SL-*, XI-1). The phase's durability
capstone.
