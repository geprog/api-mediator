# Phase 4 — Sync HTTP API

The **HTTP** slice: the operator-API endpoints that drive the Sync Engine — configuring and enabling/disabling
a `SyncRule` (through the enablement gate), manually linking records, resolving parked conflicts, replaying
parked writes, and reading sync state. These handlers are **thin**: they authenticate/authorize (Phase-3
OA-1/OA-2), validate the request shape, and delegate every invariant to the engine services (BE/RL/CF/OC) —
they must not re-derive engine logic.

**Actor:** viewer (reads), operator (mutations).

**Concept references (whole file):** [sync-engine.md](../architecture/sync-engine.md) *Initial backfill*
(enable triggers backfill), *Identity correlation* (manual linking), *Conflict handling* (manual resolution,
parked replay), *Write failures* (parked replay re-runs the pipeline); [data-model.md](../architecture/data-model.md)
`SyncRule`, `RecordLink`, `SyncEvent / AuditLog`; [security.md](../architecture/security.md) *Operator
authentication & authorization* (enable/disable sync rules is an operator mutation); [observability.md](../architecture/observability.md)
*Metrics* (poller lag surfaced); [glossary.md](../glossary.md) `SyncRule`, `RecordLink`, `Parked (dead-letter)
event`, `Operator / Viewer`.

> **Routes and payloads are the implementation choice; the *contract* is authoritative.** The endpoint paths
> below are illustrative (consistent with Phase-1's `POST /apps` style); what is fixed is the read/mutate
> gating, the enablement-gate delegation, and the "resolution/replay re-runs the normal pipeline" rule.

---

## SA-1 — Configure and enable/disable a `SyncRule`

**As an** operator, **I can** set a rule's execution options and enable it (choosing a backfill mode) or disable
it, **so that** a reviewed-but-disabled rule can be turned into a live sync — but only once its gate is
satisfied.

### Acceptance criteria

1. **Given** an `operator` and a `disabled` rule, **when** they set its options — `pollIntervalOverride`,
   `pollOperationRef` (correcting the heuristic), `deletePropagation`, `targetDriftCheck`, and (per
   `FieldMapping`) `conflictPolicy` — **then** the endpoint persists them; these are the same derive-then-correct
   pattern as `ResourceBinding` refs ([data-model.md](../architecture/data-model.md) `SyncRule`).
2. **Given** an `operator` enabling a rule with a chosen `backfillMode` (`link-only`/`push`) or an **explicit
   skip**, **when** the gate (BE-1/BE-2) is satisfied, **then** the endpoint delegates to the enablement service:
   the rule goes `enabled`, the backfill is triggered (or recorded `skipped`), and polling starts only after
   backfill completes/skips ([sync-engine.md](../architecture/sync-engine.md) *Initial backfill*).
3. **Given** the gate is **not** satisfied, **when** enable is attempted, **then** the endpoint returns a 4xx
   with the **list of exactly which refs/decisions the rule still needs** (BE-1 criterion 5) and enables nothing.
4. **Given** an `operator` disabling an `enabled` rule, **when** they call disable, **then** polling stops; the
   rule's execution state (`cursor`/snapshot/links/field state) is retained, not reset (re-enabling does not
   re-backfill an already-backfilled rule).
5. **Given** a `viewer`, **when** they call any of these mutating endpoints, **then** it is rejected 403 (OA-2)
   and nothing changes ([security.md](../architecture/security.md)).
6. **Given** any enable/disable/config action, **when** it commits, **then** it is attributed to the
   authenticated identity in the audit log (OA-3).

### Out of scope

- The confirm/correct of a `ResourceBinding` ref itself — Phase-1 RB-2 (reused; the gate reads its state).
- Running the backfill / seeding — BE-3..BE-6.

### Dependencies

Blocked by BE-1, BE-2, BE-3, Phase-3 OA-1/OA-2.

---

## SA-2 — Read sync state: rules, backfill/poll status, poller lag, and events

**As a** viewer or operator, **I can** list `SyncRule`s with their status and read the sync audit log, **so that**
I can see what is enabled, what is backfilling, how stale each poller is, and what each execution did.

### Acceptance criteria

1. **Given** rules exist, **when** the rule-list endpoint is called, **then** it returns each `SyncRule` with
   `status`, `backfillStatus`, `lastRunAt`, `lastEventAt`, its resource pair, and the **gate's "still needs"
   list** for a not-yet-enable-able rule (BE-1) — no credential material
   ([data-model.md](../architecture/data-model.md) `SyncRule`).
2. **Given** a rule, **when** its status is read, **then** the response surfaces **poller lag** (time since
   `lastRunAt` vs. expected interval) so a stuck poller is visible in the UI as well as in Grafana
   ([observability.md](../architecture/observability.md) *Metrics*).
3. **Given** the `SyncEvent`/audit log, **when** it is queried (filtered by rule/record/status), **then** it
   returns `sync-execution`/`poll-run`/`backfill-run` rows with their `status`
   (`success`/`failure`/`skipped-loop`/`skipped-policy`/`conflict`), metadata, and `traceId`/`spanId` — never
   payload values ([data-model.md](../architecture/data-model.md) `SyncEvent / AuditLog`;
   [security.md](../architecture/security.md) *Audit logging*).
4. **Given** the roles, **when** these read endpoints are called, **then** both `viewer` and `operator` are
   authorized (OA-2), and no response contains credential material.

### Out of scope

- Rendering — SU-*.
- The Grafana dashboards themselves — [observability.md](../architecture/observability.md) (provisioned
  separately).

### Dependencies

Blocked by SD-1, SD-4, Phase-3 OA-1/OA-2.

---

## SA-3 — Manually link and unlink records

**As an** operator, **I can** explicitly link or unlink two records, **so that** an ambiguous or key-less pairing
that the engine refused to guess (RL-4) is resolved by a human.

### Acceptance criteria

1. **Given** an `operator`, **when** they submit a manual link between a source record and a chosen target
   record, **then** the endpoint delegates to the engine (RL-5), which creates a `RecordLink` with
   `establishedBy = manual` and records its queue key per RL-5 criterion 2
   ([sync-engine.md](../architecture/sync-engine.md) *Identity correlation* (3)).
2. **Given** an `operator`, **when** they unlink a `RecordLink`, **then** it is severed via the engine (RL-5).
3. **Given** the ambiguous-match queue (records where a lookup matched >1 target, RL-4), **when** it is read,
   **then** the endpoint lists the unresolved records with their candidate target ids from the `failure` event's
   `details` — the input to a manual-linking decision.
4. **Given** a `viewer`, **when** they call the link/unlink endpoints, **then** they are rejected 403 (OA-2).
5. **Given** a manual link/unlink commits, **when** recorded, **then** it is attributed to the authenticated
   identity (OA-3).

### Out of scope

- The engine's link lifecycle mechanics — RL-5.
- The linking screen — SU-2.

### Dependencies

Blocked by RL-4, RL-5, Phase-3 OA-2.

---

## SA-4 — Resolve a parked conflict

**As an** operator, **I can** resolve a conflict the engine parked — a `manual-resolve` field, a withheld field,
or a drifted delete — **so that** a decision only a human should make gets made and then flows through the
normal pipeline.

### Acceptance criteria

1. **Given** the parked-conflict queue, **when** it is read, **then** it lists conflicts recorded `conflict`:
   `manual-resolve` field conflicts (CF-3), withheld fields under partial conflict (CF-4/CF-5), and **drifted
   deletes** parked with the link left `active` (CF-7) — each with the context needed to decide.
2. **Given** an `operator` resolves a **field** conflict by choosing a side, **when** they submit it, **then**
   the resolution **flows through the normal pipeline** (loop prevention + conflict detection against current
   state), never a blind write ([sync-engine.md](../architecture/sync-engine.md) *Conflict handling* — write
   granularity).
3. **Given** an `operator` resolves a **drifted delete**, **when** they choose an outcome, **then** they may
   either **propagate the deletion after all** (delete + tombstone `propagated-delete`) or **keep the survivor
   and sever the pair** (tombstone `observed-delete`) — the two outcomes CF-7 defines
   ([sync-engine.md](../architecture/sync-engine.md) *Conflict handling* — deletes vs. edits).
4. **Given** a resolution commits, **when** it runs, **then** it is recorded as a `SyncEvent` and attributed to
   the authenticated identity (OA-3); nothing is written outside the pipeline.
5. **Given** a `viewer`, **when** they call the resolution endpoint, **then** it is rejected 403 (OA-2).

### Out of scope

- The detection/parking of the conflict — CF-*.
- The resolution screen — SU-3.

### Dependencies

Blocked by CF-3, CF-4, CF-5, CF-7, Phase-3 OA-2.

---

## SA-5 — Replay a parked (dead-letter) write

**As an** operator, **I can** replay a write that exhausted its retry ceiling, **so that** a record with no later
change still eventually syncs — re-run through the pipeline, not blindly re-issued.

### Acceptance criteria

1. **Given** the dead-letter queue (writes parked `failure` at the retry ceiling, OC-4), **when** it is read,
   **then** it lists the parked events with their record/rule context ([observability.md](../architecture/observability.md)
   *Alerting* — parked write).
2. **Given** an `operator` replays a parked event, **when** they trigger it, **then** the replay **re-runs the
   standard pipeline** — loop prevention and conflict detection **against current state** — rather than
   re-issuing the stale payload ([sync-engine.md](../architecture/sync-engine.md) *Write failures*).
3. **Given** a parked event that a **later change already superseded**, **when** the queue is read, **then** it is
   shown as superseded (no manual action needed) — replay is only for records with no later change
   ([sync-engine.md](../architecture/sync-engine.md) *Write failures*).
4. **Given** a `viewer`, **when** they call the replay endpoint, **then** it is rejected 403 (OA-2).
5. **Given** a replay commits, **when** recorded, **then** its new `SyncEvent` is attributed to the authenticated
   identity (OA-3).

### Out of scope

- The retry/park mechanics — OC-4.
- The replay screen — SU-4.

### Dependencies

Blocked by OC-4, Phase-3 OA-2.
