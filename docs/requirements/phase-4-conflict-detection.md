# Phase 4 — Conflict Detection & resolution

A conflict is when **both sides** of a mapped field pairing have changed since the last successful sync. This
file owns detection over observed `SyncFieldState`, the resolution policies (last-write-wins by source
timestamp with an epsilon fallback to observation order, and the `manual-resolve` override), and — the
risk-register core — **partial withholding** (target-wins withholds and leaves baselines untouched), **PUT
read-carry** (clobber avoidance), **unobserved-target silent overwrite + `targetDriftCheck`**, and
**deletes-never-auto-resolve-against-drift**.

Every criterion is deterministic and unit-testable over hand-seeded `SyncFieldState` rows and fake target
operations (PATCH- vs PUT-shaped); no LLM and no running landscape are needed for the invariants.

**Actor:** system (Sync Engine — Conflict Detection stage); operator (resolving parked conflicts, SA-4/SU-3).

**Concept references (whole file):** [sync-engine.md](../architecture/sync-engine.md) *Conflict handling* (the
whole section — detection over observed state, LWW/epsilon/observation-order, `manual-resolve`, what resolution
does, deletes vs. edits, write granularity/PUT read-carry, `targetDriftCheck`), *Ordering and consistency*
(serialized against the counterpart), *Change types* (delete tombstoning);
[sync-polling-pull.md](../flows/sync-polling-pull.md) steps 3.3, 3.4; [data-model.md](../architecture/data-model.md)
`SyncFieldState`, `SyncRule.targetDriftCheck`, `FieldMapping.conflictPolicy`, `RegisteredApp.capabilities`
(`supportsChangeTimestamps`), `ResourceBinding.changeTimestampRef`; [observability.md](../architecture/observability.md)
*Metrics* (conflict rate); [glossary.md](../glossary.md) `SyncFieldState`, `deletePropagation`.

> **What resolution *does* is authoritative; the epsilon value and the configured retention are the
> implementation choice (config-defined).** Every auto-resolved conflict is still recorded `conflict` in the
> audit log — nothing is ever silently lost from the record, even when auto-resolved.

---

## CF-1 — Detect a conflict over observed state, serialized against the counterpart

**As the** Sync Engine, **I** detect drift by comparing a target field's observed hash against its own baseline
before writing, entirely over persisted observations, **so that** a target that changed since the last reconcile
is caught without an extra read and without a cross-direction race.

### Acceptance criteria

1. **Given** a write about to touch a target field, **when** Conflict Detection runs, **then** it compares that
   field's `SyncFieldState.observedHash` against **the same row's** `lastSyncedHash`; if the target has drifted
   (observed ≠ baseline) since the last reconcile, it is a **conflict**
   ([sync-engine.md](../architecture/sync-engine.md) *Conflict handling*; [sync-polling-pull.md](../flows/sync-polling-pull.md)
   step 3.4).
2. **Given** the check, **when** it runs, **then** it needs **no extra read of the target** — it runs entirely
   over observed state (`observedHash` is updated from every poll result and write response that touches the
   field) ([data-model.md](../architecture/data-model.md) `SyncFieldState.observedHash`).
3. **Given** a bidirectional pair, **when** both directions could check concurrently, **then** the check is
   **serialized against the counterpart direction on the record's queue** (OQ-2), so the two directions can
   **never both pass it concurrently** ([sync-engine.md](../architecture/sync-engine.md) *Conflict handling*,
   *Ordering and consistency*).
4. **Given** the honest limit, **when** a change on the other side hasn't been observed yet, **then** it is
   detected **late** — when it finally arrives it compares against the meanwhile-updated baseline and surfaces as
   a conflict *then* — **provided it survives to be observed** (the silent-overwrite window is CF-6)
   ([sync-engine.md](../architecture/sync-engine.md) *Conflict handling*).
5. **Given** conflicts, **when** they occur, **then** the conflict rate is emitted as a metric per `SyncRule`
   ([observability.md](../architecture/observability.md) *Metrics*).

### Out of scope

- The resolution policy that decides the winner — CF-2/CF-3.
- Delete conflicts — CF-7 (deletes are never auto-resolved).

### Dependencies

Blocked by SD-3, OQ-2, EP-1. Precedes CF-2..CF-7.

---

## CF-2 — Default auto-resolution: last-write-wins with epsilon fallback to observation order

**As an** operator, **I** get conflicts auto-resolved by the more recent source change timestamp where that is
trustworthy, and by observation order otherwise, **so that** routine conflicts converge without a human while
clock skew never silently picks the wrong side.

### Acceptance criteria

1. **Given** a conflict where **both** apps declare `capabilities.supportsChangeTimestamps` **and** both
   resources have a confirmed `ResourceBinding.changeTimestampRef`, **when** it is auto-resolved, **then** the
   side with the more recent `SyncFieldState.observedChangeTimestamp` wins — compared entirely from persisted
   observations ([sync-engine.md](../architecture/sync-engine.md) *Conflict handling* — default policy;
   [data-model.md](../architecture/data-model.md) `SyncFieldState.observedChangeTimestamp`).
2. **Given** the two candidate timestamps are within a configurable **epsilon** of each other, **when**
   resolution runs, **then** timestamp comparison is treated as **inconclusive** and the mediator falls back to
   the order in which it **observed** the two changes (the rows' `observedAt` order) — not trusting sub-epsilon
   differences from two unrelated clocks ([sync-engine.md](../architecture/sync-engine.md) *Conflict handling*).
3. **Given** either app does **not** declare change timestamps (or its ref is unconfirmed), **when** a conflict
   is resolved, **then** timestamp comparison is **skipped entirely** and **observation order** is the policy
   ([sync-engine.md](../architecture/sync-engine.md) *Conflict handling*).
4. **Given** any auto-resolution outcome, **when** it is recorded, **then** the event is recorded with
   `SyncEvent.status = conflict` in the audit log — nothing is silently lost from the record even though it is
   auto-resolved ([sync-engine.md](../architecture/sync-engine.md) *Conflict handling*).

### Out of scope

- What "source wins" / "target wins" actually *does* to the write and baselines — CF-4.
- Forcing a conflict to the UI regardless — CF-3.

### Dependencies

Blocked by CF-1, SD-3. Precedes CF-4.

---

## CF-3 — `manual-resolve` override forces a conflict to surface

**As an** operator, **I** can mark a `FieldMapping` `conflictPolicy = manual-resolve` so its conflicts surface
in the UI instead of auto-resolving, **so that** fields where auto-resolution would be unacceptable always wait
for a human.

### Acceptance criteria

1. **Given** a **peer-peer** `FieldMapping` with `conflictPolicy = manual-resolve`, **when** its field
   conflicts, **then** the conflict is **surfaced in the UI** (SU-3) instead of auto-resolving — recorded
   `conflict`, the field parked for manual resolution ([data-model.md](../architecture/data-model.md)
   `FieldMapping.conflictPolicy`; [sync-engine.md](../architecture/sync-engine.md) *Conflict handling*).
2. **Given** `conflictPolicy` is a **sibling field** to `transformConfig` (not a value inside it), **when** it is
   read, **then** it is read as such ([sync-engine.md](../architecture/sync-engine.md) *Conflict handling*).
3. **Given** `conflictPolicy` lives on `FieldMapping`, **when** it appears on a **consumer-provider**
   `FieldMapping`, **then** it has **no effect** — the Adapter Engine never reconciles against a prior state
   ([sync-engine.md](../architecture/sync-engine.md) *Conflict handling*).
4. **Given** a parked (manual) conflict, **when** a human resolves it (SA-4), **then** the resolution flows
   through the **normal pipeline** (loop prevention + conflict detection against current state) — not a blind
   write ([sync-engine.md](../architecture/sync-engine.md) *Conflict handling* — write granularity).

### Out of scope

- Setting `conflictPolicy` at review — Phase 3 left it absent (AM-3 criterion 5); an operator may set it as a
  Phase-4 configuration action (SA-2 scope), but the *review-time* default remains absent.
- The resolution UI — SU-3.

### Dependencies

Blocked by CF-1, Phase-3 AM-3. Precedes CF-4, SA-4.

---

## CF-4 — What resolution does: source-wins re-baselines; target-wins withholds and leaves baselines untouched

**As an** operator, **I** rely on target-wins **withholding** the contested field and leaving baselines
untouched — never sneaking the winning value into reconciled state — **so that** convergence happens through the
counterpart's ordinary processing, deterministically.

### Acceptance criteria

1. **Given** **source wins** (CF-2), **when** the write proceeds, **then** both sides **re-baseline through the
   normal write path** — the winning value simply overwrites and its stored representation is captured (EP-3)
   ([sync-engine.md](../architecture/sync-engine.md) *Conflict handling* — what resolution does).
2. **Given** **target wins**, **when** resolution runs, **then** the contested field is **withheld from the
   write** exactly as under a manual park, **and the baselines stay untouched** — the winning value is **never**
   sneaked into reconciled state ([sync-engine.md](../architecture/sync-engine.md) *Conflict handling*).
3. **Given** a **bidirectional** pair and a target-wins outcome, **when** convergence is considered, **then** it
   happens through the **counterpart direction's own processing** of the winning change (already queued, or
   arriving with its next poll): it re-runs the same comparison over the same persisted observations,
   deterministically picks the **same** winner, and writes it to the losing side — ordinary convergence, no
   special path ([sync-engine.md](../architecture/sync-engine.md) *Conflict handling*).
4. **Given** a **one-way** rule and a target-wins outcome, **when** it resolves, **then** this write is
   **skipped** and the sides stay divergent until a later source change wins — drift protection **protects** the
   target and never back-propagates (the mediator does not write a one-way rule's source)
   ([sync-engine.md](../architecture/sync-engine.md) *Conflict handling*).
5. **Given** **every** mapped field of a write ends up withheld, **when** the execution completes, **then**
   **no call is made** and it records its `conflict` event alone
   ([sync-engine.md](../architecture/sync-engine.md) *Conflict handling*).
6. **Given** target-wins-withhold is a hard invariant, **when** it is tested, **then** a unit test asserts a
   target-wins outcome makes **no** write for the contested field **and** leaves both sides' `lastSyncedHash`
   **unchanged** — no forged reconciliation.

### Out of scope

- *How* a field is withheld against a full-replace operation (PUT read-carry) — CF-5.
- The unobserved-target case — CF-6.

### Dependencies

Blocked by CF-2, CF-3, EP-3. Precedes CF-5.

---

## CF-5 — Write granularity under partial conflict: PUT read-carry (clobber avoidance)

**As an** operator, **I** rely on a withheld field being **preserved** even against a full-replace (PUT)
operation, **so that** the rest of the record still syncs while the contested field is never clobbered with the
losing source value.

### Acceptance criteria

1. **Given** one field of a record is parked/withheld while others are fine, **when** the write proceeds, **then**
   the record **still syncs** with the conflicted field withheld — the rest of the record is not held hostage to
   one field ([sync-engine.md](../architecture/sync-engine.md) *Conflict handling* — write granularity).
2. **Given** a **PATCH-shaped** (partial-payload) target `update` operation, **when** a field is withheld, **then**
   withholding is trivial — the field is simply omitted from the partial payload
   ([sync-engine.md](../architecture/sync-engine.md) *Conflict handling*).
3. **Given** a **PUT-shaped** (full-replace) target operation, **when** a field is withheld, **then** the executor
   **first reads the target record** and **carries the target's current value through** for the withheld field —
   **preserving** it rather than overwriting it with the contested source value
   ([sync-engine.md](../architecture/sync-engine.md) *Conflict handling*).
4. **Given** the PUT-clobber guard is a hard invariant, **when** it is tested, **then** a unit test over a
   full-replace operation asserts the withheld field in the sent payload equals the **target's current** value,
   not the source's contested value — proving no clobber.
5. **Given** a parked field stays flagged until a human resolves it, **when** the human resolves it (SA-4),
   **then** the resolution flows through the normal pipeline (CF-3 criterion 4)
   ([sync-engine.md](../architecture/sync-engine.md) *Conflict handling*).

### Out of scope

- Detecting the operation is PUT- vs PATCH-shaped — read from the target operation's IR (Phase-1); this story
  requires the read-carry behavior.

### Dependencies

Blocked by CF-4, OC-1. Precedes SA-4.

---

## CF-6 — Unobserved-target silent overwrite and `targetDriftCheck = read-before-write`

**As an** operator, **I** can opt a rule into reading the target immediately before writing, **so that** a
target-side edit made too recently to have been observed becomes a normal conflict instead of a silent
overwrite.

### Acceptance criteria

1. **Given** the honest limit of observed-only detection, **when** a target change is made within the current
   interval and this direction's write lands **before** any poll observes it, **then** without protection the
   change is **overwritten in the app itself** — gone before any poll could see it, silently, with only the
   overwriting write's audit trail ([sync-engine.md](../architecture/sync-engine.md) *Conflict handling*).
2. **Given** this is **sharpest for a one-way rule with no counterpart** (nothing routinely observes the target),
   **when** such a rule writes, **then** one-way sync **means** source-of-truth semantics for the mapped fields —
   and the enablement UI says so explicitly (SU-1)
   ([sync-engine.md](../architecture/sync-engine.md) *Conflict handling*).
3. **Given** `SyncRule.targetDriftCheck = read-before-write`, **when** the rule writes, **then** it **reads the
   target record immediately before writing** and compares mapped fields against their target-side
   `lastSyncedHash`; drift is handled as a **conflict** (CF-2/CF-3), not silently overwritten
   ([sync-engine.md](../architecture/sync-engine.md) *Conflict handling*; [data-model.md](../architecture/data-model.md)
   `SyncRule.targetDriftCheck`).
4. **Given** `read-before-write` is available on **any** rule (not only one-way ones), **when** an operator wants
   drift caught for fields where losing even an intra-interval edit is unacceptable, **then** it can be set on a
   bidirectional rule too — at one extra read per write
   ([data-model.md](../architecture/data-model.md) `SyncRule.targetDriftCheck`).
5. **Given** `targetDriftCheck = none` (default), **when** the rule writes, **then** no pre-read occurs — only
   **observed** state is compared (CF-1), and the intra-interval window described above exists by design
   ([sync-engine.md](../architecture/sync-engine.md) *Conflict handling*).

### Out of scope

- The delete-specific drift check — CF-7 (deletes get read-before-write's benefit but are never auto-resolved).

### Dependencies

Blocked by CF-1, CF-2, OC-1. Precedes CF-7.

---

## CF-7 — Deletes are never auto-resolved against a drifted target

**As an** operator, **I** rely on a propagated delete **never** auto-resolving against a target that has drifted,
**so that** deleting a record that was edited since the last reconcile can never silently destroy that edit.

### Acceptance criteria

1. **Given** a source deletion with `deletePropagation = propagate`, **when** the pipeline is about to call the
   `action = delete` operation, **then** it first compares the target side's observed state against its baselines
   exactly as an update would (and under `targetDriftCheck = read-before-write`, **reads the target first**,
   catching unobserved edits too) ([sync-engine.md](../architecture/sync-engine.md) *Conflict handling* —
   deletes vs. edits; [sync-polling-pull.md](../flows/sync-polling-pull.md) step 3.3).
2. **Given** the target has **drifted**, **when** the delete is evaluated, **then** it is **parked as a manual
   conflict** — recorded `conflict`, the link left **`active`**, **nothing deleted** — for the operator to
   resolve (propagate the deletion after all, or keep the survivor and sever the pair)
   ([sync-engine.md](../architecture/sync-engine.md) *Conflict handling*).
3. **Given** deletes are **never auto-resolved** against a drifted target — **not even under last-write-wins** —
   **when** a drifted-target delete is evaluated, **then** the LWW policy does **not** apply to it: destruction is
   irreversible, so it always parks ([sync-engine.md](../architecture/sync-engine.md) *Conflict handling*).
4. **Given** an **undrifted** target, **when** a propagated delete runs, **then** it deletes **normally**, the
   `RecordLink` is tombstoned `propagated-delete` (RL-5), and the delete idempotency key (OC-2 criterion 4)
   applies ([sync-engine.md](../architecture/sync-engine.md) *Conflict handling*, *Change types*).
5. **Given** `deletePropagation = ignore` (default), **when** a source deletion is observed, **then** it is
   recorded `skipped-policy`, the link tombstoned `observed-delete`, and processing stops — never silently
   dropped, and the drift check is moot because nothing is deleted
   ([sync-engine.md](../architecture/sync-engine.md) *Change types*; [data-model.md](../architecture/data-model.md)
   `SyncRule.deletePropagation`).
6. **Given** deletes-never-auto-resolve is a hard invariant, **when** it is tested, **then** a unit test asserts a
   `propagate` delete against a **drifted** target produces a `conflict` event, leaves the link `active`, and
   makes **no** delete call.

### Out of scope

- Resolving the parked delete conflict (propagate vs. sever) — SA-4/SU-3.
- The tombstone lifecycle mechanics — RL-5.

### Dependencies

Blocked by CF-1, CF-6, RL-5, OC-2. Precedes SA-4.
