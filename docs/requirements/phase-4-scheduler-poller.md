# Phase 4 — Scheduler + Poller

The **change-detection** slice: the Scheduler wakes each enabled `SyncRule` on its interval, and the Poller
pulls changes from the source app — delta query where the source supports it, full-fetch diffing otherwise —
classifies each change as create/update/delete, **durably enqueues** them, and only then advances the cursor
and snapshot. Polling is deliberately the mediator's **only** change-detection transport. This file owns the
poll pipeline up to enqueue; the shared per-record pipeline (Identity Resolution → Loop Prevention → Conflict
Detection → Transformation → Outbound Call) is RL/EP/CF/TX/OC.

The invariants here — **abort-on-partial** and **enqueue-then-advance** — are deterministic and unit-testable
against a fake source app (canned pages, injectable failures) and a fake queue/clock; a deterministic
**poll-trigger hook** makes a poll run invokable synchronously for e2e (SU-6).

**Actor:** system (Sync Engine — Scheduler + Poller).

**Concept references (whole file):** [sync-engine.md](../architecture/sync-engine.md) *Change detection:
polling pull*, *Polling pull pipeline*, *Change types: create, update, delete*, *Ordering and consistency*
(enqueue-then-advance); [sync-polling-pull.md](../flows/sync-polling-pull.md) steps 1-4;
[data-model.md](../architecture/data-model.md) `SyncRule` (`pollOperationRef`, `cursor`, `lastSnapshotRef`,
`lastRunAt`), `ResourceBinding` (`collectionReadRef`, `paginationRef`, `deltaCursorRef`, `deltaDeletionRef`,
`nativeIdRef`), `RegisteredApp.capabilities`; [observability.md](../architecture/observability.md) *Metrics*,
*Alerting* (stuck poller); [glossary.md](../glossary.md) `Scheduler`, `Poller`, `SyncRule`.

> **Scheduling mechanism and snapshot storage are the implementation choice; the pipeline *ordering* and the
> two crash-safety invariants are authoritative.** The `lastSnapshotRef` points at a per-record content-hash
> snapshot (native id → hash) whose storage form is an implementation detail; what is fixed is that it is
> written from a *complete* fetch and only after every change is enqueued.

---

## SP-1 — Scheduler wakes an eligible rule on its interval

**As the** Sync Engine, **I** wake each enabled `SyncRule` when its poll interval elapses, but only when it is
actually eligible to poll, **so that** freshness is bounded by the interval and no rule polls before it may.

### Acceptance criteria

1. **Given** a `SyncRule`, **when** the Scheduler evaluates it, **then** it wakes on
   `pollIntervalOverride` if set, else the source `RegisteredApp.defaultPollInterval`
   ([sync-polling-pull.md](../flows/sync-polling-pull.md) step 1; [data-model.md](../architecture/data-model.md)
   `SyncRule.pollIntervalOverride`).
2. **Given** a rule, **when** the Scheduler decides whether to poll it, **then** it polls **only** while the
   rule's `status = enabled`, its `backfillStatus` is `completed` or `skipped`, **and** its `ApprovedMapping`
   is `active` — an enabled rule with a **running** backfill polls nothing yet
   ([data-model.md](../architecture/data-model.md) `SyncRule.status`, `backfillStatus`;
   [sync-engine.md](../architecture/sync-engine.md) *Initial backfill*).
3. **Given** the rule's `ApprovedMapping` is `stale` or `suspended`, **when** the Scheduler evaluates it,
   **then** the rule is **paused without changing its `status`** — staleness/suspension lives on the mapping
   alone ([data-model.md](../architecture/data-model.md) `SyncRule.status`; [extensibility.md](../architecture/extensibility.md)).
   *(The transitions into `stale`/`suspended` are Phase 6; Phase 4 honors the pause gate.)*
4. **Given** a source app that declares `supportsPolling = false`, **when** a rule would use it as source,
   **then** it cannot poll — such an app cannot be a sync source (though it can be a target)
   ([data-model.md](../architecture/data-model.md) `RegisteredApp.capabilities`;
   [sync-engine.md](../architecture/sync-engine.md) *Change detection*). *(The enablement gate BE-1 prevents
   creating such a live rule; the Scheduler is the runtime backstop.)*
5. **Given** a rule that has not had a successful poll past N× its expected interval, **when** observability
   evaluates it, **then** poller lag (time since `lastRunAt` vs. expected interval) is emitted and the stuck-
   poller alert fires — the staleness bound is explicit and monitorable
   ([observability.md](../architecture/observability.md) *Metrics*, *Alerting*).

### Out of scope

- The per-record pipeline that runs on each enqueued change — RL/EP/CF/TX/OC.
- Enabling a rule / triggering its backfill — BE.

### Dependencies

Blocked by SD-1, BE-3. Precedes SP-2.

---

## SP-2 — Poller: delta query vs. full-fetch diffing, paged to exhaustion

**As the** Poller, **I** pull the source's changes via its pinned poll operation — delta where supported, else
a complete paged full fetch diffed against the last snapshot — **so that** I detect what changed since the last
run using one uniform mechanism.

### Acceptance criteria

1. **Given** a rule whose source declares `supportsDeltaQuery` **and** the resource offers a delta operation,
   **when** the Poller runs, **then** it calls the delta operation pinned by `pollOperationRef`, passing the
   stored `cursor` via the resource's confirmed `ResourceBinding.deltaCursorRef`
   ([sync-polling-pull.md](../flows/sync-polling-pull.md) step 2; [data-model.md](../architecture/data-model.md)
   `SyncRule.pollOperationRef`, `ResourceBinding.deltaCursorRef`).
2. **Given** a rule without delta support (or whose resource offers no delta operation), **when** the Poller
   runs, **then** it calls the confirmed collection read (`ResourceBinding.collectionReadRef`) pinned by
   `pollOperationRef`, **paged to exhaustion** via `ResourceBinding.paginationRef`, and diffs the result against
   `lastSnapshotRef` by **content hash keyed by native id** (`ResourceBinding.nativeIdRef`)
   ([sync-polling-pull.md](../flows/sync-polling-pull.md) step 2).
3. **Given** a full fetch, **when** the snapshot diff runs, **then** a record whose content hash **changed**
   (or a delta record newly reported) is a change; a record **unchanged** since the snapshot is not re-processed
   ([sync-engine.md](../architecture/sync-engine.md) *Change types*).
4. **Given** the source obeys the shared executor's per-app ceilings, **when** the Poller pages, **then** its
   read load is subject to the same load discipline as writes (OC-3) — polling and diffing do not bypass the
   ceilings ([overview.md](../architecture/overview.md) *Outbound load discipline*).
5. **Given** a rule whose `pollOperationRef` is **unconfirmed**, **when** the Scheduler would poll it, **then**
   it does not — an unconfirmed ref is used nowhere (the enablement gate BE-1 prevents this state going live;
   the Poller is the backstop) ([data-model.md](../architecture/data-model.md) `ResourceBinding.confirmedBy`).

### Out of scope

- Classifying create/update/delete — SP-3.
- Establishing/resolving the `RecordLink` for a change — RL.

### Dependencies

Blocked by SP-1, OC-3, Phase-1 RB-* (confirmed refs). Precedes SP-3.

---

## SP-3 — Change classification: create, update, delete

**As the** Poller, **I** classify each detected change as create, update, or delete, **so that** the pipeline
calls the target operation whose `action` matches, and a deletion is only ever inferred safely.

### Acceptance criteria

1. **Given** a detected record **new** to the snapshot (or newly reported by a delta query) with **no**
   `RecordLink` and **no** identity match, **when** classified, **then** it is a **create**; a record whose
   content hash **changed**, or one with an existing link, is an **update**
   ([sync-engine.md](../architecture/sync-engine.md) *Change types*).
2. **Given** a delta-query source, **when** a deletion is reported, **then** it is detected **only** when the API
   explicitly reports deleted records, read via the resource's confirmed `ResourceBinding.deltaDeletionRef`
   (a per-record deletion-marker field or a separate deleted-ids list)
   ([sync-engine.md](../architecture/sync-engine.md) *Change types*; [data-model.md](../architecture/data-model.md)
   `ResourceBinding.deltaDeletionRef`).
3. **Given** a delta source whose `deltaDeletionRef` is **unconfirmed** (or the API reports no deletions),
   **when** classification runs, **then** it **cannot** drive delete detection at all — and `deletePropagation =
   propagate` cannot have been enabled on such a rule (BE-1) — so no deletion is fabricated
   ([sync-engine.md](../architecture/sync-engine.md) *Change types*).
4. **Given** a **full-fetch** source, **when** a record present in the last snapshot is **absent** from a
   **complete** fetch, **then** it is a **delete candidate** — valid **only** because the fetch completed
   (SP-4) ([sync-engine.md](../architecture/sync-engine.md) *Change types*).
5. **Given** a classified change, **when** it is enqueued, **then** its action is carried so the pipeline later
   selects the target operation whose `OperationMapping.action` matches (create/update/delete)
   ([sync-engine.md](../architecture/sync-engine.md) *Change types*).

### Out of scope

- Applying `deletePropagation` policy / the delete drift check / tombstoning — CF-7, RL-5.
- The create's match-first downgrade-to-update — RL-1 (Identity Resolution owns it).

### Dependencies

Blocked by SP-2. Precedes RL-1, CF-7.

---

## SP-4 — Abort-on-partial: deletions only from a complete fetch

**As an** operator, **I** rely on the Poller never misreading a truncated fetch as mass deletion, **so that** a
transient paging failure can never destroy real records on the target.

### Acceptance criteria

1. **Given** a full fetch where **any page fails** (error, timeout, truncation), **when** the run reaches the
   diff, **then** the run **aborts** rather than treating missing records as deletions
   ([sync-engine.md](../architecture/sync-engine.md) *Change types*; [sync-polling-pull.md](../flows/sync-polling-pull.md)
   step 2).
2. **Given** an aborted run, **when** it ends, **then** the `cursor`, `lastSnapshotRef`, and `lastRunAt` are
   **not advanced** — the next poll re-attempts from the same position, so no change is lost and no false
   deletion is emitted ([sync-engine.md](../architecture/sync-engine.md) *Polling pull pipeline*).
3. **Given** a **delete via full-fetch diff**, **when** it is emitted, **then** it is emitted **only** when every
   page of the fetch succeeded — the completeness precondition is checked before any absence is interpreted as a
   delete ([sync-engine.md](../architecture/sync-engine.md) *Change types*).
4. **Given** an aborted run, **when** observability reports it, **then** poller lag continues to grow (no
   successful `lastRunAt`), so a persistently failing source surfaces as a stuck poller rather than as silent
   inactivity ([observability.md](../architecture/observability.md) *Alerting*).

### Out of scope

- Delta-query deletion (which does not diff for absence) — SP-3 criterion 2.

### Dependencies

Blocked by SP-2, SP-3. Precedes SP-5.

---

## SP-5 — Enqueue-then-advance: durable enqueue before cursor/snapshot advance, closing the crash windows

**As an** operator, **I** rely on a poll run enqueuing every detected change durably **before** it advances the
cursor and snapshot, **so that** a crash at any point loses no change and never strands a detected-but-
unprocessed one.

### Acceptance criteria

1. **Given** a poll run detected N changes, **when** it processes the run, **then** it **durably enqueues** each
   change onto its cross-direction ordering queue (key resolved before enqueue — OQ-3) and **only after all N
   are enqueued** advances `SyncRule.cursor`, replaces `lastSnapshotRef`, and sets `lastRunAt` — **atomically,
   and only then** ([sync-engine.md](../architecture/sync-engine.md) *Polling pull pipeline*;
   [sync-polling-pull.md](../flows/sync-polling-pull.md) step 4).
2. **Given** a **crash before the advance**, **when** the next poll runs, **then** it **re-detects and
   re-enqueues** the same changes — and echo checks (EP) and idempotency keys (OC-2) absorb the duplicates — so
   nothing is lost ([sync-engine.md](../architecture/sync-engine.md) *Polling pull pipeline*).
3. **Given** a **crash after the advance**, **when** the engine restarts, **then** nothing is lost because the
   enqueued changes are **durable** and are processed from the queue independently of the poll run
   ([sync-engine.md](../architecture/sync-engine.md) *Polling pull pipeline*).
4. **Given** a record sitting in **retry backoff** or **parked**, **when** the poll run considers advancement,
   **then** *processing* **never gates advancement** — the change is already queued, so the cursor is never held
   open by a slow/failed/parked record ([sync-engine.md](../architecture/sync-engine.md) *Polling pull
   pipeline*).
5. **Given** a `SyncEvent` per changed record is recorded **as it is processed** (not at enqueue), **when** the
   run advances, **then** `lastRunAt` advances **with** the cursor while per-record `sync-execution` events are
   written downstream by the pipeline (SD-4, OC-5) ([sync-polling-pull.md](../flows/sync-polling-pull.md)
   step 4).
6. **Given** a deterministic **poll-trigger hook** exists for tests, **when** it is invoked, **then** it runs
   exactly one poll cycle for a named rule synchronously (detect → enqueue → advance), so an e2e can drive a
   sync round deterministically instead of waiting on the Scheduler's wall-clock interval (used by SU-6).

### Out of scope

- The queue's key resolution and continuation handoff — OQ-3/OQ-4 (this story requires the enqueue to be durable
  and to precede the advance; OQ owns *how* the key is computed).
- Processing the enqueued change — the shared pipeline (RL/EP/CF/TX/OC).

### Dependencies

Blocked by SP-3, SP-4, OC-2, OQ-3. Precedes OQ-4, RS-2.
