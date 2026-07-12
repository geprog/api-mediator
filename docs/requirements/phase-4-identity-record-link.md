# Phase 4 — Identity Resolution + `RecordLink` lifecycle

The pipeline's **first** stage: resolve (or establish) the `RecordLink` for each detected change, because
everything downstream — the echo check, conflict detection, delete propagation — operates on the link. This
file owns link establishment (create-propagation, identity-key match, manual), the **ambiguous-match → manual
only** guard (a wrong identity key silently merges unrelated records — the worst failure the engine has), and
the tombstone lifecycle.

Every criterion is unit-testable with fake source/target apps and a fake link store; the ambiguous-match and
value-preserving-lookup invariants are deterministic and do not need a running landscape.

**Actor:** system (Sync Engine — Identity Resolution stage); operator (manual linking, SA-3/SU-2).

**Concept references (whole file):** [sync-engine.md](../architecture/sync-engine.md) *Identity correlation:
RecordLink* (the three establishment paths, filtered read vs. fetch-and-match, ambiguous → manual, value-
preserving pairing), *Change types* (create match-first, tombstoning), *Loop prevention* (create/delete
echoes); [sync-polling-pull.md](../flows/sync-polling-pull.md) steps 3, 3.1;
[data-model.md](../architecture/data-model.md) `RecordLink`, `FieldMapping.isIdentityKey`/`targetLookupParamRef`,
`ResourceBinding.collectionReadRef`; [observability.md](../architecture/observability.md) *Metrics* (identity-
resolution failure rate — no-match / ambiguous-match); [glossary.md](../glossary.md) `Identity Resolution`,
`RecordLink`, `identity key`, `Tombstone`.

> **The three establishment paths and the ambiguous-match guard are authoritative; the lookup query encoding is
> the implementation choice.** The identity value is always used **as-is** (no transform is ever applied to an
> identity value), because the identity `FieldMapping` is restricted to `rename` at review (AS-5).

---

## RL-1 — Identity Resolution: resolve the `RecordLink` first, establishing one by identity match

**As the** Sync Engine, **I** resolve each detected change's `RecordLink` before any downstream stage,
establishing one by identity-key match for a record I have never seen, **so that** loop prevention and conflict
detection have the link they are keyed by.

### Acceptance criteria

1. **Given** a detected change, **when** the pipeline runs, **then** **Identity Resolution runs first** and
   resolves the record's `RecordLink`; only the short-TTL recently-written cache fast path (EP-2) may
   short-circuit *ahead* of it ([sync-engine.md](../architecture/sync-engine.md) *Change detection*, *Loop
   prevention*; [sync-polling-pull.md](../flows/sync-polling-pull.md) step 3.1).
2. **Given** a change with an **existing active** `RecordLink` (by app + native id), **when** resolved, **then**
   that link is used and no new link is established ([data-model.md](../architecture/data-model.md) `RecordLink`).
3. **Given** a change for a record the mediator has **never seen** (no link), **when** resolved, **then**
   Identity Resolution attempts an **identity-key match** to establish one before treating it as a create
   ([sync-engine.md](../architecture/sync-engine.md) *Identity correlation*, *Change types*).
4. **Given** the resolution outcome, **when** it completes, **then** the change carries its resolved (or newly
   established) link into Loop Prevention and Conflict Detection — the stages that are keyed by `RecordLink`
   ([sync-engine.md](../architecture/sync-engine.md) *Loop prevention*, *Conflict handling*).
5. **Given** identity resolution runs, **when** its outcomes are counted, **then** no-match and ambiguous-match
   rates are emitted as metrics ([observability.md](../architecture/observability.md) *Metrics*).

### Out of scope

- The echo check / conflict check themselves — EP / CF.
- The ordering-queue key derived from the link vs. the identity value — OQ.

### Dependencies

Blocked by SD-2, SP-3. Precedes EP-1, CF-1, RL-2..RL-5.

---

## RL-2 — Create-propagation: capture the target's new native id, write the link in the same step

**As the** Sync Engine, **I** write the `RecordLink` at the moment I create a record in the target, capturing
the target's newly assigned native id, **so that** the link exists for routing and the target's own "new record"
poll hit is recognizable as the mediator's echo.

### Acceptance criteria

1. **Given** a create that found **no** identity match, **when** the `action = create` target operation returns,
   **then** the target's new native id is captured (OC-1) and a `RecordLink` with `establishedBy =
   create-propagation` is written **in the same step** ([sync-engine.md](../architecture/sync-engine.md)
   *Identity correlation* (1), *Polling pull pipeline*; [sync-polling-pull.md](../flows/sync-polling-pull.md)
   step 3.6).
2. **Given** the rule's mapping has **no** approved `action = create` `OperationMapping`, **when** a create is
   observed, **then** it is recorded `skipped-policy` — visible, never silent — and **no** create is made and
   **no** link written ([sync-engine.md](../architecture/sync-engine.md) *Change types* — create;
   [data-model.md](../architecture/data-model.md) `SyncEvent / AuditLog`).
3. **Given** the create-propagation link is written, **when** the target's subsequent "new record" poll fires,
   **then** that link is what identifies the hit as the mediator's own create (a create echo), not a genuine new
   record — the RecordLink-state half of loop prevention (EP-4)
   ([sync-engine.md](../architecture/sync-engine.md) *Loop prevention* — create echoes).
4. **Given** the create's establishing execution ran on the pre-link ordering queue, **when** the link is
   written, **then** it **retains that pre-link queue key** so the link-keyed queue opens strictly as a
   continuation of it (OQ-4) ([data-model.md](../architecture/data-model.md) `RecordLink.establishedBy`;
   [sync-engine.md](../architecture/sync-engine.md) *Ordering and consistency*).

### Out of scope

- The create's match-first attempt (that is RL-3; only a **no-match** create reaches this story).
- The echo recognition itself — EP-4.

### Dependencies

Blocked by RL-1, OC-1. Precedes EP-4, OQ-4.

---

## RL-3 — Identity-key match execution: filtered read preferred, fetch-and-match fallback

**As the** Sync Engine, **I** look the target up by the confirmed identity key — via a filtered read where the
target offers one, else a complete fetch-and-match — using the observed value as-is, **so that** a create can be
downgraded to an update when the record already exists on the target.

### Acceptance criteria

1. **Given** a change for an unlinked record, **when** Identity Resolution matches, **then** it prefers a
   **filtered read** — the confirmed filter parameter on the target's collection read
   (`FieldMapping.targetLookupParamRef`) queried with the identity field's value
   ([sync-engine.md](../architecture/sync-engine.md) *Identity correlation* — "How an identity-key lookup
   executes"; [data-model.md](../architecture/data-model.md) `FieldMapping.targetLookupParamRef`).
2. **Given** no confirmed `targetLookupParamRef` but a confirmed `ResourceBinding.collectionReadRef` on the
   target, **when** matching, **then** it falls back to **fetch-and-match** — a complete fetch of the target
   resource (paged to exhaustion, subject to abort-on-partial semantics) with **in-memory comparison**
   ([sync-engine.md](../architecture/sync-engine.md) *Identity correlation*).
3. **Given** the identity value, **when** any lookup executes, **then** the value is used **as-is** — **no
   transform is ever applied to an identity value** (guaranteed by the review-time `rename`-only restriction,
   AS-5) ([sync-engine.md](../architecture/sync-engine.md) *One identity pairing per resource pair*).
4. **Given** a **single** match, **when** it is found, **then** the records are linked
   (`establishedBy = identity-match`), the new link's `SyncFieldState` is **seeded** from the matched target
   record and the source record as observed (agree/disagree per BE-4), and the change is **downgraded to an
   update** — so the conflict check running next in the same execution is well-defined
   ([sync-engine.md](../architecture/sync-engine.md) *Change types* — create).
5. **Given** a resource pair with **neither** lookup path (no `targetLookupParamRef` **and** no target
   `collectionReadRef`), **when** matching is attempted, **then** match-first is **unavailable**: a create goes
   straight to create (risking duplicates for pre-existing data), links form only via create-propagation or
   manual linking, and the enablement UI states exactly this degradation before the rule can be turned on
   (SU-1) ([sync-engine.md](../architecture/sync-engine.md) *Identity correlation*).

### Out of scope

- The **ambiguous** (multi-match) case — RL-4 (a hard, separate guard).
- Seeding baselines in detail — BE-4 (this story invokes the same agree/disagree seeding).

### Dependencies

Blocked by RL-1, SD-3, OC-3. Precedes RL-4, CF-1.

---

## RL-4 — Ambiguous identity match → manual only (the worst failure mode, guarded hard)

**As an** operator, **I** rely on the engine **never** silently picking one target when an identity lookup
matches more than one record, **so that** a wrong or non-unique identity key can never silently merge unrelated
records — the Sync Engine's worst possible failure.

### Acceptance criteria

1. **Given** an identity-key lookup that matches **more than one** target record, **when** Identity Resolution
   evaluates it, **then** it **never** picks one silently: the event is recorded as `SyncEvent.status = failure`
   with the **candidate ids** in `details`, and the record is surfaced for **manual linking** (SU-2)
   ([sync-engine.md](../architecture/sync-engine.md) *Identity correlation* (2)).
2. **Given** an ambiguous match, **when** it is recorded, **then** **no** `RecordLink` is established, **no**
   create is made, and **no** target write happens for that record — the change is held for a human, not
   guessed ([sync-engine.md](../architecture/sync-engine.md) *Identity correlation*).
3. **Given** an ambiguous match, **when** it is surfaced, **then** the ambiguous-match rate is emitted as a
   metric distinct from the no-match rate ([observability.md](../architecture/observability.md) *Metrics*).
4. **Given** the record remains unresolved, **when** later changes to the same source record arrive, **then**
   they do not silently self-resolve into a link — the ambiguity persists until a human links it (RL-5) or the
   duplicate is removed on the target and a subsequent lookup matches exactly one.
5. **Given** this is a hard invariant, **when** it is tested, **then** an explicit unit test asserts that a
   two-candidate lookup produces a `failure` event and **zero** `RecordLink`/write side effects — no fast path
   or heuristic may bypass it.

### Out of scope

- Resolving the ambiguity — the operator does that via manual linking (RL-5, SA-3, SU-2).

### Dependencies

Blocked by RL-3, SD-4. Precedes RL-5.

---

## RL-5 — Manual linking/unlinking and the tombstone lifecycle

**As an** operator, **I** can explicitly link or unlink records an identity key cannot disambiguate, and rely on
a deleted record's link being **tombstoned** (not deleted), **so that** every stateful sync behavior has an
explicit id pairing and delete echoes / resurrection stay detectable.

### Acceptance criteria

1. **Given** two records an identity key cannot disambiguate (RL-4) or that have no natural key, **when** the
   operator links them, **then** a `RecordLink` with `establishedBy = manual` is created; **when** they unlink,
   **then** the link is removed/severed — both via the UI (SA-3/SU-2)
   ([sync-engine.md](../architecture/sync-engine.md) *Identity correlation* (3);
   [data-model.md](../architecture/data-model.md) `RecordLink.establishedBy`).
2. **Given** a **manual** link (which has no establishing execution), **when** it is created, **then** it records
   the pair's identity-key value as its queue key, or — absent a confirmed identity key — carries a marker that
   the link-keyed queue opens only after **both** sides' native-id-keyed queues drain (OQ-4)
   ([data-model.md](../architecture/data-model.md) `RecordLink.establishedBy`).
3. **Given** a record deletion is processed, **when** the link is updated, **then** it is **tombstoned, not
   deleted**, with `tombstoneReason = propagated-delete` (the mediator propagated the deletion) or
   `observed-delete` (a source deletion observed but not propagated under `deletePropagation = ignore`) — the
   pair is severed either way ([sync-engine.md](../architecture/sync-engine.md) *Change types* — delete;
   [data-model.md](../architecture/data-model.md) `RecordLink.tombstoneReason`; [glossary.md](../glossary.md)
   `Tombstone`).
4. **Given** a link tombstoned `observed-delete`, **when** later changes to the surviving record arrive, **then**
   they are recorded `skipped-policy` (counterpart deleted) and surfaced — the survivor is **unmanaged** until
   re-linked manually or matched afresh by a genuine re-create on the deleted side (which arrives with a new
   native id and a fresh link through the normal create path)
   ([sync-engine.md](../architecture/sync-engine.md) *Change types* — delete).
5. **Given** either tombstone kind, **when** a slower poll cycle still sees the record in an old snapshot diff,
   **then** the tombstone **prevents resurrection** — the mediator must not re-create what was just deleted
   ([sync-engine.md](../architecture/sync-engine.md) *Loop prevention* — delete echoes).

### Out of scope

- The delete drift check that decides whether a propagated delete parks — CF-7.
- `archived` links on app deregistration — Phase 6 ([extensibility.md](../architecture/extensibility.md)).

### Dependencies

Blocked by RL-4, SD-2, SP-3. Precedes CF-7, SA-3, SU-2.
