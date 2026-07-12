# Phase 4 — Outbound Call Executor (+ REST Protocol Client)

The **Outbound Call Executor** makes the authenticated call to a target app for a mapped operation, and is the
single choke point through which *all* outbound traffic — polling, backfill enumeration, sync writes, and
(Phase 5) adapter fan-out — passes. This file owns the REST Protocol Client, the **deterministic idempotency
key** (the risk-register item that must include prior reconciled state), per-app **load discipline**
(concurrency/rate ceilings, `429`/`Retry-After`), and the **retry / dead-letter (park)** policy. It is shared
with the Adapter Engine; Phase 4 stands it up for sync.

Every criterion is unit-testable against a fake REST client and a fake `SyncEvent` store; the load-discipline
and idempotency invariants are deterministic and do not need a running landscape.

**Actor:** system (Sync Engine's pipeline stage; reused by the Adapter Engine in Phase 5).

**Concept references (whole file):** [sync-engine.md](../architecture/sync-engine.md) *Idempotency*, *Write
failures: retry and dead-letter*, *Polling pull pipeline* (create-response native-id capture);
[overview.md](../architecture/overview.md) *Outbound load discipline*, *Key interfaces*
(`CredentialStore.withCredential`); [security.md](../architecture/security.md) *Least privilege*;
[data-model.md](../architecture/data-model.md) `SyncEvent / AuditLog` (`idempotencyKey`, `payloadHash`),
`ResourceBinding.nativeIdRef`, `OperationMapping.targetIdParamRef`; [observability.md](../architecture/observability.md)
*Metrics* (Sync Engine), *Alerting* (parked write); [glossary.md](../glossary.md) `Outbound Call Executor`,
`Idempotency key`, `Parked (dead-letter) event`, `Protocol Client/Server interface pair`.

> **The idempotency-key *inputs* and the load-discipline *guarantees* are authoritative; the HTTP-client
> library, hash algorithm, and backoff curve are the implementation choice.** The `Protocol Client` seam is
> named in the concept as the extensibility point a future non-REST protocol plugs into; Phase 4 ships the REST
> implementation only.

---

## OC-1 — REST Protocol Client: authenticated call for a mapped operation

**As the** Sync Engine, **I** issue an authenticated REST request for the operation an action selects, filling
its inputs, **so that** a transformed payload reaches the target app and (for a create) the target's new native
id is captured.

### Acceptance criteria

1. **Given** an `OperationMapping` selected by the change's action and a transformed payload (TX), **when** the
   executor calls the target, **then** it obtains the target app's credential via
   `CredentialStore.withCredential(targetAppId, fn)` and makes the REST call **inside** that scope — least
   privilege, secret never leaving the scope (CD-1; [overview.md](../architecture/overview.md) *Key interfaces*).
2. **Given** an `action = update | delete` call on a **peer-peer** rule, **when** the request is built, **then**
   the target operation's id parameter is filled from the `RecordLink`'s target-side native id via
   `OperationMapping.targetIdParamRef` ([data-model.md](../architecture/data-model.md)
   `OperationMapping.targetIdParamRef`; [sync-polling-pull.md](../flows/sync-polling-pull.md) step 3.6).
3. **Given** an `action = create` call, **when** the response returns, **then** the target's **newly assigned
   native id** is read from the response via the target resource's `ResourceBinding.nativeIdRef` and returned to
   the pipeline for the `RecordLink` write (RL-2) ([sync-engine.md](../architecture/sync-engine.md) *Polling
   pull pipeline*; [data-model.md](../architecture/data-model.md) `ResourceBinding.nativeIdRef`).
4. **Given** the REST Protocol Client sits behind the named `Protocol Client` seam, **when** it is implemented,
   **then** it implements that interface for REST — a future non-REST protocol would provide another
   implementation without changing the executor's callers ([glossary.md](../glossary.md) *Protocol Client/Server
   interface pair*).
5. **Given** any outbound call, **when** it is made, **then** **no** credential material and **no** live payload
   value is logged or sent to an LLM — only metadata/hashes reach the audit log and telemetry
   ([security.md](../architecture/security.md) *Audit logging*, *LLM data boundary*).

### Out of scope

- Choosing *which* `OperationMapping` (action match) — that classification is SP-3 / done at the pipeline; OC
  executes the chosen one.
- Adapter request/response serving — Phase 5.

### Dependencies

Blocked by CD-1, TX-1, SD-2. Precedes SP-*, RL-2, CF-*.

---

## OC-2 — Deterministic idempotency key including prior reconciled state

**As an** operator, **I** rely on every outbound write carrying a key that deduplicates true duplicate
deliveries but never a genuine value revert, **so that** re-runs and crash re-processing are safe while real
changes are never dropped as "repeats."

### Acceptance criteria

1. **Given** a write, **when** its `idempotencyKey` is computed, **then** it is a deterministic hash of the
   **mapping id**, the **source record's native id** (not the `RecordLink` — a create has no link until its
   response is captured), the **resulting payload**, **and the prior reconciled state the write was computed
   from** (the target-side `lastSyncedHash`es of the mapped fields at transform time, or a distinguished
   **`none`** marker for a first write that establishes state)
   ([sync-engine.md](../architecture/sync-engine.md) *Idempotency*; [glossary.md](../glossary.md) `Idempotency
   key`).
2. **Given** the A → X → Y → X revert sequence, **when** keys are computed, **then** the third write (starting
   from reconciled state Y) has a **different** key from the first (starting from the initial state) — a
   payload-only key would wrongly deduplicate the revert; including prior state distinguishes it
   ([sync-engine.md](../architecture/sync-engine.md) *Idempotency*).
3. **Given** a **true** duplicate delivery — an overlapping/re-run poll or crash re-processing of the same
   change — **when** its key is computed, **then** it has the **same** payload **and** the same prior state and
   therefore the **same** key, and is deduplicated ([sync-engine.md](../architecture/sync-engine.md)
   *Idempotency*).
4. **Given** a **delete** (no payload, no prior field state), **when** its key is computed, **then** it hashes
   the mapping id, the **source native id**, a distinguished **delete marker**, and the link's **target-side
   native id** — so duplicate deliveries of one deletion collide, while a later delete of a re-created record
   (fresh link, new native ids) keys differently ([sync-engine.md](../architecture/sync-engine.md)
   *Idempotency*).
5. **Given** a computed key, **when** the executor checks for a duplicate, **then** it consults `SyncEvent`
   history for that key within a **bounded lookback window** (last N per-record events or a configured retention
   period — **never** unbounded history), skipping the write on a hit
   ([sync-engine.md](../architecture/sync-engine.md) *Idempotency*).
6. **Given** the target API exposes its own idempotency-key mechanism, **when** the call is made, **then** the
   key is **also** passed through to it ([sync-engine.md](../architecture/sync-engine.md) *Idempotency*).

### Out of scope

- The recently-written cache / echo comparison — that is loop prevention (EP); idempotency dedup and echo
  suppression are distinct mechanisms.
- Per-record ordering — OQ; idempotency absorbs duplicates, ordering serializes them.

### Dependencies

Blocked by SD-4, TX-1. Precedes OC-4, SP-5.

---

## OC-3 — Per-app load discipline: concurrency + rate ceilings, `429`/`Retry-After`

**As an** operator, **I** have the mediator throttle its aggregate traffic to each app, **so that** a backfill
running while several rules poll and (later) an adapter fans out never overwhelms a landscape app.

### Acceptance criteria

1. **Given** the shared executor, **when** it dispatches calls to one app, **then** it enforces that app's
   **per-app concurrency ceiling** and **request-rate ceiling** across **all** outbound traffic to that app —
   polling, backfill enumeration, sync writes (and Phase-5 adapter fan-out) counted together
   ([overview.md](../architecture/overview.md) *Outbound load discipline*).
2. **Given** these ceilings, **when** they are configured, **then** they are **operational configuration on the
   app registration**, not per-rule review decisions ([overview.md](../architecture/overview.md) *Outbound load
   discipline*; the Phase-1 `RegisteredApp` schema was kept forward-compatible for exactly this — Phase-1 README
   open question 10).
3. **Given** a `429 Too Many Requests` (or a `Retry-After` header on any response), **when** the executor
   receives it, **then** it **honors `Retry-After`** and backs off before retrying, rather than immediately
   re-hammering the app ([overview.md](../architecture/overview.md) *Outbound load discipline*).
4. **Given** the poll interval bounds a single rule's steady-state read load, **when** aggregate load is
   considered, **then** the **per-app ceiling** — not the interval — is what protects an app from the mediator's
   combined traffic ([overview.md](../architecture/overview.md) *Outbound load discipline*).
5. **Given** load-discipline waits, **when** a call is delayed by a ceiling or `Retry-After`, **then** it does
   **not** hold its record's ordering queue open in a way that blocks *other* records — a slow app degrades its
   own throughput, not the whole engine (interacts with OQ-1 / OC-4).

### Out of scope

- Adapter fan-out load (the executor already counts it; the fan-out logic is Phase 5).
- Global cross-app rate limiting — the concept scopes ceilings per app.

### Dependencies

Blocked by OC-1. Precedes SP-*, BE-4/BE-5 (backfill enumeration obeys the same ceilings).

---

## OC-4 — Retry with backoff, then park (dead-letter); supersession keeps a park from blocking

**As an** operator, **I** have a transiently-failing write retried and a permanently-failing one parked and
alerted, **so that** one bad record never blocks its queue and a later successful sync supersedes the failure.

### Acceptance criteria

1. **Given** an outbound write fails transiently (5xx, timeout, network error), **when** it is retried, **then**
   it retries with **exponential backoff inside its per-record ordering queue**, up to a bounded attempt ceiling
   ([sync-engine.md](../architecture/sync-engine.md) *Write failures*).
2. **Given** the attempt ceiling is reached, **when** the write still fails, **then** the event is **parked**:
   recorded as `SyncEvent.status = failure` with a **dead-letter marker**, surfaced in the UI (SU-4), and
   alerted — and the queue **moves on** to the record's next change and to other records
   ([sync-engine.md](../architecture/sync-engine.md) *Write failures*; [observability.md](../architecture/observability.md)
   *Alerting* — parked write).
3. **Given** sync is **state-convergent, not event-sourced**, **when** a later change to the same record
   succeeds, **then** it **supersedes** the parked failure entirely — no manual action needed for that record
   ([sync-engine.md](../architecture/sync-engine.md) *Write failures*).
4. **Given** a parked event with **no** later change, **when** an operator manually replays it (SA-5), **then**
   the replay **re-runs the standard pipeline** (loop prevention + conflict detection against *current* state) —
   never a blind re-issue of the stale payload ([sync-engine.md](../architecture/sync-engine.md) *Write
   failures*).
5. **Given** a permanently failing record, **when** it is parked, **then** it blocks **neither** other records
   **nor** later changes to the same record — "a permanently failing record must not block other records, nor
   later changes to the same record" ([sync-engine.md](../architecture/sync-engine.md) *Write failures*).
6. **Given** a transform error (TX-5) or a credential-refresh failure (CD-2 criterion 4), **when** it prevents a
   write, **then** it is handled through this same failure path (recorded, retried where retryable, parked where
   not) — never a silent success.

### Out of scope

- The manual replay endpoint/UI — SA-5 / SU-4 (this story specifies what replay re-runs).
- Conflict "parks" (a withheld field awaiting manual resolution) — those are `conflict` events, not
  `failure`/dead-letter; CF-3/CF-4 own them, kept distinct from a write failure.

### Dependencies

Blocked by OC-1, OC-2, SD-4. Precedes SA-5, RS-2.

---

## OC-5 — Record a `SyncEvent` per call and update observed/written state

**As an** operator, **I** have every outbound call leave a durable per-record audit row and update the
mediator's observed state, **so that** loop prevention, conflict detection, and idempotency all read a consistent
record of what the mediator did.

### Acceptance criteria

1. **Given** an outbound call resolves (success or failure), **when** it completes, **then** exactly one
   `sync-execution` `SyncEvent` is recorded with its `status`, `idempotencyKey`, `payloadHash`, `relatedRuleId`,
   `recordLinkId`/`sourceNativeId`, and `traceId`/`spanId` (SD-4)
   ([sync-polling-pull.md](../flows/sync-polling-pull.md) step 3.7).
2. **Given** a successful **write**, **when** it commits, **then** the written side's `SyncFieldState` is
   re-baselined from the target's **stored representation** (write response body, or a follow-up read when the
   API doesn't return it) and the **recently-written cache** for the target's resource is updated — the bridge
   to loop prevention (EP-2, EP-3) so the target's own next poll doesn't bounce the change back
   ([sync-polling-pull.md](../flows/sync-polling-pull.md) step 3.7;
   [sync-engine.md](../architecture/sync-engine.md) *Loop prevention*).
3. **Given** a successful **create**, **when** it commits, **then** the target's new native id (OC-1 criterion 3)
   is persisted on the `RecordLink` in the same step (RL-2)
   ([sync-engine.md](../architecture/sync-engine.md) *Polling pull pipeline*).
4. **Given** every call, **when** it is emitted as an OTel trace, **then** the trace is correlated to its
   `SyncEvent` via `traceId`/`spanId`, and the sync success/failure/`skipped-*`/`conflict` rates are the metrics
   the observability layer derives ([observability.md](../architecture/observability.md) *Metrics* — Sync
   Engine).

### Out of scope

- The echo comparison logic and the cache TTL — EP; this story only *updates* the cache/baselines a write
  produces.
- Seeding baselines at backfill — BE-4/BE-5.

### Dependencies

Blocked by OC-1, SD-3, SD-4. Precedes EP-*, CF-*.
