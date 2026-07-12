# Phase 4 — `SyncRule` enablement gate + initial backfill

This is where a **disabled** Phase-3 `SyncRule` first becomes live. Enabling a rule is gated on hard
preconditions (a confirmed identity key, a confirmed `pollOperationRef`, the approved target operations for what
it propagates, and both sides' confirmed `ResourceBinding` refs); the **enable action itself triggers** the
one-time initial backfill; and the transition to live polling seeds the cursor and snapshot — deliberately
early, so nothing made during backfill is missed. This file owns the gate, the two backfill modes (`link-only`
vs. `push`), and the enablement seeding.

Every criterion is unit-testable with fake registry/binding/mapping state and fake source/target apps; the
early-cursor-seeding invariant is deterministic against a fake clock.

**Actor:** operator (enabling a rule, choosing backfill mode, SA-1/SU-1); system (running the backfill,
seeding).

**Concept references (whole file):** [sync-engine.md](../architecture/sync-engine.md) *Initial backfill* (the
whole section, including *What enablement seeds*), *Identity correlation* (lookup-path degradation);
[sync-polling-pull.md](../flows/sync-polling-pull.md) *Notes*; [data-model.md](../architecture/data-model.md)
`SyncRule` (enablement preconditions, `backfillMode`/`backfillStatus`, `cursor`/`lastSnapshotRef`),
`ResourceBinding` (which refs each use requires), `FieldMapping.isIdentityKey`, `OperationMapping.action`;
[observability.md](../architecture/observability.md) *Metrics* (backfill progress/duration);
[glossary.md](../glossary.md) `Initial backfill`, `SyncRule`, `identity key`, `ResourceBinding`.

> **The gate preconditions and the early-cursor rule are authoritative; the UI presentation of the checklist is
> the implementation choice.** Skipping backfill is an **explicit** operator choice, **never** a default.

---

## BE-1 — The enablement gate: a rule can only be enabled when its preconditions hold

**As an** operator, **I** can only enable a `SyncRule` once every precondition holds, **so that** a rule never
goes live able to silently merge records, poll an unconfirmed operation, or propagate something it has no
approved operation for.

### Acceptance criteria

1. **Given** a `SyncRule`, **when** enable is attempted, **then** it is **rejected unless** its resource pair has
   **exactly one confirmed identity `FieldMapping`** (`isIdentityKey = true`) — a wrong/absent identity key is the
   worst failure mode, so this is a hard gate ([sync-engine.md](../architecture/sync-engine.md) *Identity
   correlation*; [data-model.md](../architecture/data-model.md) `SyncRule`, `FieldMapping.isIdentityKey`).
2. **Given** enable, **when** attempted, **then** it is rejected unless `pollOperationRef` is **confirmed**
   ([data-model.md](../architecture/data-model.md) `SyncRule.pollOperationRef`).
3. **Given** enable, **when** attempted, **then** the target side must have the approved `OperationMapping`s for
   **what the rule propagates**: `update` (with its `targetIdParamRef`) in the normal case; a rule with **no**
   approved `update` may enable **create-only** (the natural mode for append-only resources, recording observed
   updates as `skipped-policy`); a rule with **no** approved `create` records observed creates `skipped-policy`;
   a rule with **neither** `create` **nor** `update` has nothing to propagate and **cannot** enable
   ([data-model.md](../architecture/data-model.md) `SyncRule`; [sync-engine.md](../architecture/sync-engine.md)
   *Change types*).
4. **Given** `deletePropagation = propagate`, **when** enable is attempted, **then** the target must have an
   approved `action = delete` `OperationMapping`, **and** on a **delta-polling** rule the source's
   `deltaDeletionRef` must be confirmed — else `propagate` cannot be enabled
   ([data-model.md](../architecture/data-model.md) `SyncRule.deletePropagation`, `ResourceBinding.deltaDeletionRef`).
5. **Given** any unmet precondition, **when** enable is attempted, **then** the response **lists exactly which
   refs/decisions the rule still needs** — the enablement UI is driven by this list (SU-1)
   ([data-model.md](../architecture/data-model.md) `ResourceBinding.confirmedBy` — "the rule-enablement UI lists
   exactly which refs a rule still needs").
6. **Given** a resource pair with **neither** identity-lookup path (RL-3 criterion 5), **when** enable is
   attempted, **then** enable is permitted **only** with backfill **explicitly skipped** and the UI states the
   degradation (match-first unavailable, duplicate risk) before the rule turns on
   ([sync-engine.md](../architecture/sync-engine.md) *Identity correlation*, *Initial backfill*).

### Out of scope

- Running the backfill / seeding — BE-3..BE-6.
- The Phase-1 `ResourceBinding` confirm/correct action itself (RB-2) — reused; BE-2 reads its state.

### Dependencies

Blocked by SD-1, Phase-3 AS-5 (confirmed identity key), Phase-1 RB-2 (confirmed refs). Precedes BE-2, BE-3, SA-1.

---

## BE-2 — `ResourceBinding` confirmation gating

**As an** operator, **I** can only enable a rule once both sides' **required** `ResourceBinding` refs are
confirmed, **so that** an unconfirmed convention (native id, collection read, pagination, delta cursor/deletion,
change timestamp) is never used to poll, enumerate, or route.

### Acceptance criteria

1. **Given** enable, **when** the gate checks bindings, **then** **`nativeIdRef`** must be confirmed on **both**
   the source and target resources — everything record-identity-shaped depends on it
   ([data-model.md](../architecture/data-model.md) `ResourceBinding.nativeIdRef`).
2. **Given** a full-fetch rule, or any use of enumeration/fetch-and-match, **when** the gate checks bindings,
   **then** the relevant **`collectionReadRef`** (and its **`paginationRef`** where paging applies) must be
   confirmed wherever that use applies — polling source, backfill source, and/or fetch-and-match target
   ([data-model.md](../architecture/data-model.md) `ResourceBinding.collectionReadRef`, `paginationRef`).
3. **Given** a **delta-polling** rule, **when** the gate checks bindings, **then** the source's **`deltaCursorRef`**
   must be confirmed (and **`deltaDeletionRef`** additionally when `deletePropagation = propagate`, BE-1
   criterion 4) ([data-model.md](../architecture/data-model.md) `ResourceBinding.deltaCursorRef`, `deltaDeletionRef`).
4. **Given** the LWW conflict policy is desired, **when** the gate evaluates it, **then** `changeTimestampRef` is
   **not** a hard enablement precondition — while unconfirmed, conflict resolution simply falls back to
   observation order (CF-2), so its absence degrades conflict policy rather than blocking enablement
   ([data-model.md](../architecture/data-model.md) `ResourceBinding.changeTimestampRef`).
5. **Given** a required ref is **unconfirmed**, **when** enable is attempted, **then** it is blocked and the ref
   appears in the "still needs" list (BE-1 criterion 5) — an unconfirmed ref is used nowhere
   ([data-model.md](../architecture/data-model.md) `ResourceBinding.confirmedBy`).

### Out of scope

- The confirm/correct UI and API for a binding ref — Phase-1 RB-2/RB-3 (reused); this story reads confirmation
  state.

### Dependencies

Blocked by BE-1, Phase-1 RB-1/RB-2. Precedes BE-3, SA-1, SU-5.

---

## BE-3 — Enable triggers the one-time backfill; polling starts only after it completes or is skipped

**As an** operator, **I** have the enable action itself start the backfill, with polling held until the backfill
finishes, **so that** the records that exist *now* are reconciled before steady-state detection races them.

### Acceptance criteria

1. **Given** all preconditions hold (BE-1/BE-2), **when** the operator enables a rule, **then** the enable action
   **starts the one-time initial backfill** (`backfillStatus: pending → running`) or records the **explicit
   choice to skip it** (`skipped`) — skipping is an explicit choice, never a default
   ([sync-engine.md](../architecture/sync-engine.md) *Initial backfill*; [data-model.md](../architecture/data-model.md)
   `SyncRule.backfillStatus`).
2. **Given** a rule is enabled with a **running** backfill, **when** the Scheduler evaluates it, **then** it
   **polls nothing yet** — polling begins **only** once `backfillStatus` is `completed` or `skipped` (SP-1
   criterion 2) ([sync-engine.md](../architecture/sync-engine.md) *Initial backfill*).
3. **Given** the ordering is deliberate, **when** the backfill runs, **then** it runs at **enable** time (not at
   rule *creation* / approval time) because backfill matching needs the confirmed identity key, which only exists
   after review ([sync-engine.md](../architecture/sync-engine.md) *Initial backfill*).
4. **Given** the backfill runs, **when** it executes, **then** its executions are ordinary `SyncEvent`s
   (`type = backfill-run`) and its progress/duration is emitted as a metric
   ([sync-engine.md](../architecture/sync-engine.md) *Initial backfill*;
   [observability.md](../architecture/observability.md) *Metrics*).

### Out of scope

- The two backfill modes' behavior — BE-4/BE-5.
- Cursor/snapshot seeding — BE-6.

### Dependencies

Blocked by BE-1, BE-2. Precedes BE-4, BE-5, BE-6, SP-1.

---

## BE-4 — `link-only` backfill (default): link and seed baselines, write nothing

**As an** operator, **I** have the default backfill link overlapping records and seed reconciled baselines
without writing to either app, **so that** steady-state sync starts from a known-agreed state and true
divergences surface as conflicts rather than being silently overwritten.

### Acceptance criteria

1. **Given** `backfillMode = link-only`, **when** the backfill runs, **then** it does a **complete fetch** of the
   source's mapped resource via `collectionReadRef` (paged to exhaustion via `paginationRef`) — **not** the delta
   operation, even for a delta-polling rule: backfill always **enumerates**
   ([sync-engine.md](../architecture/sync-engine.md) *Initial backfill* (1)).
2. **Given** each fetched record, **when** it is processed, **then** it is resolved against existing
   `RecordLink`s, then by **identity-key match**; matches produce links, and the ambiguous-match guard (RL-4)
   still applies ([sync-engine.md](../architecture/sync-engine.md) *Initial backfill* (2)).
3. **Given** a matched pair, **when** baselines are seeded, **then** **one `SyncFieldState` row per side-field**
   is seeded from **each side's own current stored value**, and **nothing is written to either app**
   ([sync-engine.md](../architecture/sync-engine.md) *Initial backfill* (3) — link-only).
4. **Given** a field pairing, **when** its two sides are compared, **then** they **agree** iff applying the rule's
   transform to the source value reproduces the target's stored value (agreement is defined **in the target's
   representation**); an **agreeing** pair gets a baseline, a **disagreeing** pair gets **no baseline** (reported
   in the backfill summary) — so the first subsequent change to it is a conflict by construction
   ([sync-engine.md](../architecture/sync-engine.md) *Initial backfill*).
5. **Given** the two directions of a bidirectional pair share links and field state, **when** the second
   direction backfills, **then** it finds the overlap already linked and its seeding is **monotone** — a baseline
   the first run seeded is **never erased** because the second direction's own pairing disagrees; disagreement
   only **withholds** baselines from rows that have none ([sync-engine.md](../architecture/sync-engine.md)
   *Initial backfill* — bidirectional seeding).
6. **Given** a source with **no** `collectionReadRef` (a delta-query-only API), **when** enablement is attempted,
   **then** backfill can only be **explicitly skipped**, and pre-existing overlap links up gradually via
   steady-state identity matches or manual linking
   ([sync-engine.md](../architecture/sync-engine.md) *Initial backfill* (1)).

### Out of scope

- Writing anything to an app — that is `push` (BE-5); link-only never writes.
- The steady-state identity match reusing this seeding — RL-3 (same agree/disagree logic).

### Dependencies

Blocked by BE-3, RL-3, SD-3, OC-3. Precedes BE-6.

---

## BE-5 — `push` backfill: source is the initial source of truth

**As an** operator, **I** can declare the source the initial source of truth for a direction, pushing its values
to matched targets and creating unmatched source records, **so that** an authoritative side can seed a fresh or
empty target in one deliberate run.

### Acceptance criteria

1. **Given** `backfillMode = push`, **when** the backfill runs, **then** mapped field values are **pushed to
   matched target records** and **unmatched source records are created in the target** — all through the **normal
   pipeline** (loop-prevention tagging, idempotency keys, audit)
   ([sync-engine.md](../architecture/sync-engine.md) *Initial backfill* (3) — push).
2. **Given** push runs **before any baselines exist**, **when** a matched target's values differ, **then**
   declaring the source the initial source of truth **is** the conflict decision — made once for the whole run:
   the differing values are **overwritten** (each listed in the backfill summary), and baselines are captured
   from the write responses exactly as for any write (EP-3)
   ([sync-engine.md](../architecture/sync-engine.md) *Initial backfill*).
3. **Given** a **bidirectional** pair, **when** backfill modes are chosen, **then** **at most one** of the two
   rules may use `push` — pushing both directions is a contradiction and is rejected
   ([sync-engine.md](../architecture/sync-engine.md) *Initial backfill*).
4. **Given** push writes to the target, **when** each write commits, **then** baselines are captured from the
   write responses (canonical-form capture, EP-3) so subsequent echoes are recognized
   ([sync-engine.md](../architecture/sync-engine.md) *Initial backfill*, *Loop prevention*).

### Out of scope

- Choosing which direction pushes — an operator decision at enable (SA-1/SU-1); this story enforces the
  at-most-one rule.

### Dependencies

Blocked by BE-3, RL-3, OC-1, EP-3. Precedes BE-6.

---

## BE-6 — What enablement seeds: snapshot and (deliberately early) delta cursor

**As an** operator, **I** rely on the transition to live polling seeding the snapshot and cursor **early**, **so
that** changes made while backfill ran are re-observed rather than missed, and the first poll doesn't treat the
whole collection as new.

### Acceptance criteria

1. **Given** a **full-fetch** rule, **when** it transitions to live polling, **then** `lastSnapshotRef` is
   written from the **backfill's complete enumeration** (the backfill fetch doubles as the first snapshot), so
   the first steady-state poll **diffs against it** instead of treating the whole collection as new
   ([sync-engine.md](../architecture/sync-engine.md) *What enablement seeds*).
2. **Given** backfill was **explicitly skipped**, **when** the first poll runs, **then** the first poll's own
   complete fetch initializes the snapshot, and **every record it returns takes the normal pipeline**
   (match-first absorbs pre-existing records — correct, at one identity lookup per record)
   ([sync-engine.md](../architecture/sync-engine.md) *What enablement seeds*).
3. **Given** a **delta-polling** rule against a **cursor-returning** delta API, **when** it transitions, **then**
   an **initialization call** establishes the current position (read from where `deltaCursorRef` says the next
   cursor lives) ([sync-engine.md](../architecture/sync-engine.md) *What enablement seeds*).
4. **Given** a **delta-polling** rule against a **changed-since** API, **when** it transitions, **then** the
   `cursor` starts at a timestamp captured **before** the backfill enumeration began (or before the
   initialization call, when backfill was skipped) — **deliberately early**, so changes made while backfill ran
   are **re-observed** rather than missed; echo checks and idempotency keys absorb the overlap
   ([sync-engine.md](../architecture/sync-engine.md) *What enablement seeds*).
5. **Given** the early-cursor rule is a hard invariant, **when** it is tested, **then** a unit test asserts the
   seeded cursor timestamp is **≤** the moment backfill enumeration began — proving no change made during
   backfill can fall outside the first poll's window.
6. **Given** re-confirming `pollOperationRef` onto a **different** operation (Phase 6), **when** it happens,
   **then** cursor and snapshot are **re-seeded the same way** — noted here as the shared seeding rule, though
   the re-pinning trigger itself is Phase 6 ([data-model.md](../architecture/data-model.md) `SyncRule.pollOperationRef`;
   [extensibility.md](../architecture/extensibility.md)).

### Out of scope

- Advancing the cursor during steady-state polling — SP-5.
- The Phase-6 re-pinning trigger that re-seeds — Phase 6.

### Dependencies

Blocked by BE-4, BE-5, SP-2. Precedes SP-1.
