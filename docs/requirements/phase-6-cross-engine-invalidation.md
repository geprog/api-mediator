# Phase 6 — Cross-engine cache invalidation wiring (Phase-5 deferred seams)

Phase 5 built two cache-invalidation **seams** deliberately left inert, because the signals that drive
them are lifecycle transitions this phase owns. Called out here as explicit stories so they are **not
lost** in the larger lifecycle work:

- **CH-3 activation** — the `sync-execution` `SyncEvent` cache invalidator exists and is registered
  (`apps/backend/src/http/adapter-runtime/cache-invalidation.ts`, consumer
  `adapter-cache-invalidation`), but **nothing emits `sync-execution` `SyncEvent`s onto the
  `event_outbox`**, so it never fires. This phase supplies the **producer**.
- **CH-5.3 transitions** — the by-endpoint invalidation seam
  (`CacheInvalidator.invalidateEndpoint(endpointId)`,
  `apps/backend/src/http/adapter-runtime/serve/cache-invalidator.ts`) is wired for CO-6 config changes,
  but the **mapping-lifecycle and app-lifecycle transitions** that CH-5.3 named — a mapping going
  `stale`/`suspended`/`superseded`, a backend app disabled/deregistered — are **produced by Phase 6**
  (SL-4/SL-7/SL-10, AL-1/AL-2). This phase drives the existing seam from those transitions.

Both are pure **wiring**: the invalidation mechanism, the seam interface, and the CH-3 consumer are built.
Nothing here rebuilds them.

**What already exists vs. what Phase 6 adds** (checked against the paths above +
`packages/outbound/src/sync-event-store.ts`, `packages/outbound/src/executor.ts`): the Outbound Call
Executor already **records** each `sync-execution` `SyncEvent` via `DbSyncEventStore.record` →
`AuditLogRepository.insert` (the durable Audit/Event Log), stamping `originAppId = targetAppId`,
`relatedRuleId`, and `status`; the CH-3 consumer reads exactly those fields off a **delivered** event.
The gap is that the recorded event is written only to the audit table, **not enqueued on the
`event_outbox`**, so the `OutboxDispatcher` never delivers it to the consumer. Phase 6 **adds** the outbox
enqueue (the producer) and the CH-5.3 transition triggers; it does not touch the consumer, the seam, or the
cache.

**Actor:** system (the Sync Engine as producer; the lifecycle transitions as invalidation triggers).

**Concept references (whole file):** [adapter-engine.md](../architecture/adapter-engine.md) *Caching*
(coarse invalidation by backend resource; config/health invalidation);
[overview.md](../architecture/overview.md) *Components* (Event Bus feeds cache invalidation; not a source
of truth); [extensibility.md](../architecture/extensibility.md) *Spec update lifecycle*, *App lifecycle*
(the transitions); [data-model.md](../architecture/data-model.md) `SyncEvent / AuditLog`, `event_outbox`;
[observability.md](../architecture/observability.md) *Relationship to the Audit/Event Log*. Reused seams:
[phase-5-caching.md](phase-5-caching.md) CH-3 (`SyncEventCacheInvalidationConsumer`), CH-4 (write
invalidation), CH-5 (`invalidateEndpoint` by-endpoint seam), CH-5.6 (one mechanism, two key kinds);
[phase-4-outbound-executor.md](phase-4-outbound-executor.md) OC-5 (`SyncEvent` write);
[phase-6-spec-update-lifecycle.md](phase-6-spec-update-lifecycle.md) SL-4/SL-7/SL-10,
[phase-6-app-lifecycle.md](phase-6-app-lifecycle.md) AL-1/AL-2 (the transitions).

> **Authoritative:** invalidation is **coarse** and **always correctness-safe** — the worst outcome is a
> spurious miss → re-fetch; `SyncEvent`-driven invalidation reuses the Sync Engine's own change signal
> rather than a second one; a mapping/health change must not let a cached response **outlive** the
> configuration that produced it; **bus loss degrades timeliness (staleness bounded by `cacheTtl`), never
> correctness**. **Implementation choice:** whether the producer enqueues onto the `event_outbox` in the
> executor's write transaction or a subsequent step (open question 6), the transition→drop dispatch shape.

---

## XI-1 — Emit `sync-execution` `SyncEvent`s onto the `event_outbox` (activate CH-3)

**As a** consumer-app developer, **I** see sync-driven backend changes drop the adapter's cached responses
for the changed resource, **so that** the adapter reuses the mediator's own change-detection signal instead
of serving data the sync engine already knows is stale.

### Acceptance criteria

1. **Given** the Outbound Call Executor completes a sync write, **when** it records the `sync-execution`
   `SyncEvent` (OC-5), **then** it **also enqueues that event onto the `event_outbox`** so the
   `OutboxDispatcher` delivers it — the missing producer that leaves the registered CH-3 consumer inert
   today (`apps/backend/src/http/adapter-runtime/cache-invalidation.ts`;
   `packages/outbound/src/sync-event-store.ts`).
2. **Given** the enqueued event, **when** it is delivered to the CH-3 consumer
   (`adapter-cache-invalidation`), **then** the consumer resolves `(originAppId, resourceRef)` from
   `originAppId` + `relatedRuleId`'s `resourcePairRef` and drops **all** cached responses of **every**
   `AdapterEndpoint` bound to that backend resource — **unchanged** CH-3 behavior, now actually triggered
   ([adapter-engine.md](../architecture/adapter-engine.md) *Caching*; CH-3.1/CH-3.3).
3. **Given** the CH-3 selectivity, **when** the producer emits, **then** only an **applied change**
   (`status = success`) needs to invalidate; a `failure`/`skipped-*`/`conflict` event changed no target
   data, so the consumer's existing `isAppliedChange` guard drops nothing — the producer must carry
   `status` faithfully so that guard works (CH-3 `syncExecutionSignalSchema`).
4. **Given** the enqueue is on the sync **write** path (not a request's critical path), **when** it runs,
   **then** it never blocks or fails the sync write itself — an outbox enqueue failure degrades cache
   freshness (bounded by `cacheTtl`), never sync correctness
   ([overview.md](../architecture/overview.md) *Components*; CH-3.4).
5. **Given** the Event Bus loses the delivery, **when** the reconciliation principle applies, **then** the
   cached entry the drop would have removed simply lives out its `cacheTtl` and expires on read — staleness
   bounded, never an unbounded-stale entry (CH-3.4). The `sync-execution` event is **already durably
   recorded** in the Audit Log regardless, so the business record is never lost even if the outbox delivery
   is.
6. **Given** a redelivered event, **when** the consumer re-runs, **then** the drop is idempotent (a re-drop
   of already-absent entries is a no-op) and the dispatcher dedups by event id besides — the producer needs
   no exactly-once guarantee (CH-3 consumer idempotency).

### Out of scope

- Building the CH-3 consumer or the invalidation seam — already exist (Phase 5). Adapter-write invalidation
  (CH-4) — already active on the write path.

### Dependencies

Blocked by Phase-4 OC-5 (`SyncEvent` record), Phase-1 EB-* (`event_outbox` + dispatcher), Phase-5 CH-3
(consumer). **Activates the inert CH-3 seam.** Coupled to RC-4 (bus-loss capstone).

---

## XI-2 — Drive `invalidateEndpoint` from mapping- and app-lifecycle transitions (CH-5.3)

**As a** landscape operator, **I** have a mapping going stale/suspended/superseded or a backend going away
drop the cached responses those bindings produced, **so that** a cached response never outlives the health
of the bindings behind it.

### Acceptance criteria

1. **Given** a binding's `ApprovedMapping` transitions to **`stale`** (SL-4), **`suspended`** (SL-10), or
   **`superseded`** (SL-7 adoption), **when** the transition commits, **then** **every** endpoint with that
   binding has its cached entries dropped via the existing `CacheInvalidator.invalidateEndpoint(endpointId)`
   seam ([extensibility.md](../architecture/extensibility.md) *Spec update lifecycle*;
   [phase-5-caching.md](phase-5-caching.md) CH-5.3;
   `apps/backend/src/http/adapter-runtime/serve/cache-invalidator.ts`).
2. **Given** a binding's **backend app** is **disabled** (AL-1) or **deregistered** (AL-2), **when** the
   transition commits, **then** the same by-endpoint drop runs — a `backend-disabled`/gone binding must not
   keep serving a response cached while it was healthy
   ([extensibility.md](../architecture/extensibility.md) *App lifecycle*; CH-5.3).
3. **Given** successor **adoption** (SL-7/CO-7), **when** it commits, **then** the affected endpoints'
   cached entries are dropped because the correspondence content that produced them changed — the exact
   drop CH-5 criterion 4 specified against a *simulated* succession, now driven by the **live** trigger
   ([extensibility.md](../architecture/extensibility.md) *Successor adoption*; CH-5.4).
4. **Given** all of these route through the **same** `invalidateEndpoint` seam as CO-6 recomposition,
   **when** they are implemented, **then** they add **no** parallel mechanism — one seam, keyed by endpoint
   id, is the single by-endpoint invalidation contract (CH-5.6: one mechanism, two key kinds).
5. **Given** the drop is coarse and correctness-safe, **when** it runs, **then** it needs no transaction and
   never fails the triggering transition — a missed drop only costs a spurious hit until `cacheTtl`, which
   the transition's own alerting (OB-5) and the runtime `mapping-stale`/`mapping-suspended`/`backend-disabled`
   guards (RP-3) already make loud regardless.
6. **Given** an endpoint with **no** `cacheTtl` (nothing cached), **when** any of these transitions fires
   for it, **then** the drop is a harmless no-op (the seam already no-ops an endpoint with nothing cached).

### Out of scope

- Producing the transitions — SL-4/SL-7/SL-10, AL-1/AL-2. Building the seam — Phase-5 CH-5. Fine-grained
  "only the affected parameter sets" — the concept's answer is coarse invalidation (CH-5 *Out of scope*).

### Dependencies

Blocked by Phase-5 CH-5 (`invalidateEndpoint`), SL-4/SL-7/SL-10, AL-1/AL-2. **Drives the CH-5.3 seam from
its live triggers.** Coupled to GR-2/GR-3 (the same transitions recompute graph edges) and OB-5 (alerts).
