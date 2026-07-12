# Phase 4 — Sync UI (+ the capstone sync-round e2e)

The **UI** slice: Vue 3 (`<script setup lang="ts">`, Composition API) screens that drive the Sync Engine
through the Phase-4 API — a rule-enablement panel (the gate checklist + backfill choice + one-way/degradation
warnings), a manual-linking screen, a conflict-resolution screen, and a parked/withheld replay screen — plus the
capstone e2e that runs a real sync round against a **running** `scenarios/` landscape. These stories are
deliberately **thin**: they render and call the API; every invariant is enforced server-side.

**Actor:** operator (mutations), viewer (read-only view).

**Concept references (whole file):** [sync-engine.md](../architecture/sync-engine.md) *Initial backfill* /
*Identity correlation* (enablement gate + degradation copy), *Conflict handling* (one-way source-of-truth
warning, resolution), *Write failures* (parked replay); [data-model.md](../architecture/data-model.md)
`SyncRule`, `RecordLink`, `ResourceBinding`; [security.md](../architecture/security.md) *Operator authentication
& authorization*; [glossary.md](../glossary.md) `SyncRule`, `RecordLink`, `Parked (dead-letter) event`. E2e
landscape: [scenarios/README.md](../../scenarios/README.md) (scenario 1, Gitea + Vikunja).

> **Copy and layout are the implementation choice; the surfaced *distinctions and warnings* are authoritative.**
> The enablement panel must make the gate's blockers, the identity-lookup degradation, and one-way source-of-
> truth semantics visible; it must never let a rule be enabled while the gate is unmet or an identity key is
> unconfirmed.

---

## SU-1 — Rule-enablement panel (gate checklist, backfill choice, warnings)

**As an** operator, **I** open a `SyncRule` and see exactly what it still needs to be enabled, choose its
backfill mode, and acknowledge its degradations, **so that** I never enable a rule that could silently merge
records or clobber a target.

### Acceptance criteria

1. **Given** a `disabled` rule, **when** the panel renders, **then** it shows the enablement gate as a
   **checklist** driven by the API's "still needs" list (BE-1/BE-2): confirmed identity key, confirmed
   `pollOperationRef`, approved target operations for what it propagates, and both sides' required
   `ResourceBinding` refs — with the enable action **disabled** until the checklist is satisfied
   ([sync-engine.md](../architecture/sync-engine.md) *Initial backfill*).
2. **Given** the panel, **when** the operator prepares to enable, **then** it offers a **backfill-mode** choice
   (`link-only` / `push`) and an **explicit skip** option (never a default), and — for `push` on a bidirectional
   pair — prevents choosing `push` on both directions (BE-5 criterion 3).
3. **Given** a resource pair with **neither** identity-lookup path (RL-3 criterion 5), **when** the panel
   renders, **then** it states the **degradation** (match-first unavailable, duplicate risk) and permits enable
   only with backfill explicitly skipped (BE-1 criterion 6)
   ([sync-engine.md](../architecture/sync-engine.md) *Identity correlation*).
4. **Given** a **one-way** rule (no counterpart), **when** the panel renders, **then** it states that one-way
   sync **means source-of-truth semantics** for the mapped fields, and offers `targetDriftCheck = read-before-
   write` as the opt-in that turns silent overwrites into conflicts (CF-6)
   ([sync-engine.md](../architecture/sync-engine.md) *Conflict handling*).
5. **Given** the operator enables the rule, **when** they confirm, **then** the UI calls SA-1 and reflects the
   resulting state (`enabled`, backfill `running`/`skipped`, then polling) — an enabled rule with a running
   backfill is shown as **not yet polling** (BE-3).
6. **Given** a `viewer`, **when** they open the panel, **then** it renders read-only — enable/disable/config
   controls are absent or disabled (OA-2).

### Out of scope

- The engine's gate/backfill logic — BE-*.
- Confirming a `ResourceBinding` ref inline — reuses the Phase-1 binding panel (SU-5 surfaces the blockers).

### Dependencies

Blocked by SA-1, SA-2, Phase-3 OA-2.

---

## SU-2 — Manual-linking screen

**As an** operator, **I** see records the engine refused to link (ambiguous matches, key-less pairs) and link or
unlink them, **so that** the worst-failure guard (ambiguous → manual) has a resolution path.

### Acceptance criteria

1. **Given** the ambiguous-match queue (RL-4 / SA-3), **when** the screen renders, **then** it lists each
   unresolved source record with its **candidate target ids**, so the operator can pick the correct one.
2. **Given** the operator picks a target, **when** they confirm the link, **then** the UI calls SA-3 and reflects
   the new `RecordLink` (`establishedBy = manual`); the record leaves the ambiguous queue.
3. **Given** an existing link, **when** the operator unlinks it, **then** the UI calls SA-3 and reflects the
   severed link.
4. **Given** a `viewer`, **when** they open the screen, **then** link/unlink controls are absent or disabled
   (OA-2).
5. **Given** the screen renders, **when** it loads, **then** it uses SA-3's read endpoints and shows no
   credential material and no live payload values beyond the identifying fields needed to link.

### Out of scope

- The engine's ambiguous-match guard and link lifecycle — RL-4/RL-5.

### Dependencies

Blocked by SA-3, Phase-3 OA-2.

---

## SU-3 — Conflict-resolution screen

**As an** operator, **I** see parked conflicts and resolve them, **so that** `manual-resolve` fields, withheld
fields, and drifted deletes get a human decision that then flows through the normal pipeline.

### Acceptance criteria

1. **Given** the parked-conflict queue (SA-4), **when** the screen renders, **then** it lists `manual-resolve`
   field conflicts, withheld fields under partial conflict, and **drifted deletes** (link still `active`) — each
   visibly distinct ([sync-engine.md](../architecture/sync-engine.md) *Conflict handling*).
2. **Given** a **field** conflict, **when** the operator chooses a side, **then** the UI calls SA-4 and reflects
   that the resolution re-ran through the pipeline (not a blind write).
3. **Given** a **drifted delete**, **when** the operator decides, **then** the UI offers exactly the two CF-7
   outcomes — **propagate the deletion** or **keep the survivor and sever the pair** — and calls SA-4.
4. **Given** a `viewer`, **when** they open the screen, **then** resolution controls are absent or disabled
   (OA-2).
5. **Given** a resolved conflict, **when** it settles, **then** the screen reflects the resulting `SyncEvent` and
   removes the item from the queue.

### Out of scope

- The detection/parking and the resolution pipeline — CF-*/SA-4.

### Dependencies

Blocked by SA-4, Phase-3 OA-2.

---

## SU-4 — Parked / withheld replay screen

**As an** operator, **I** see dead-letter writes and replay them, **so that** a record with no later change still
syncs — re-run through the pipeline.

### Acceptance criteria

1. **Given** the dead-letter queue (SA-5), **when** the screen renders, **then** it lists parked writes
   (`failure` at the retry ceiling) with their record/rule context and whether a later change **superseded**
   them ([sync-engine.md](../architecture/sync-engine.md) *Write failures*).
2. **Given** the operator replays a parked write, **when** they trigger it, **then** the UI calls SA-5 and
   communicates that the replay re-runs the standard pipeline against **current** state (not a stale re-issue).
3. **Given** a superseded parked event, **when** it is shown, **then** it is marked as needing no action.
4. **Given** a `viewer`, **when** they open the screen, **then** the replay control is absent or disabled (OA-2).

### Out of scope

- The retry/park/supersession mechanics — OC-4.

### Dependencies

Blocked by SA-5, Phase-3 OA-2.

---

## SU-5 — Surface `ResourceBinding` confirmation as an enablement blocker

**As an** operator, **I** see which `ResourceBinding` refs a rule still needs confirmed, **so that** I can go
confirm them and unblock enablement — reusing the Phase-1 binding panel, not a new flow.

### Acceptance criteria

1. **Given** a rule blocked on unconfirmed refs (BE-2), **when** the enablement panel renders, **then** each
   unconfirmed **required** ref (`nativeIdRef`, `collectionReadRef`/`paginationRef`, `deltaCursorRef`/
   `deltaDeletionRef` as applicable) is listed as a blocker with a link to the Phase-1 binding-confirmation panel
   (RB-3) ([data-model.md](../architecture/data-model.md) `ResourceBinding.confirmedBy`).
2. **Given** `changeTimestampRef` is unconfirmed, **when** the panel renders, **then** it is shown as a
   **degradation** (conflict resolution falls back to observation order, CF-2), **not** an enablement blocker
   (BE-2 criterion 4).
3. **Given** the operator confirms a ref via the Phase-1 panel, **when** they return, **then** the enablement
   checklist reflects the now-satisfied item.
4. **Given** a `viewer`, **when** they view the panel, **then** it renders read-only.

### Out of scope

- The confirm/correct action itself — Phase-1 RB-2/RB-3 (reused).

### Dependencies

Blocked by SU-1, BE-2, Phase-1 RB-3.

---

## SU-6 — Capstone e2e: a real sync round with no echo, against a running scenario

**As a** product owner, **I** have an end-to-end sync round against a **running** `scenarios/` landscape that
proves a change propagates once and does **not** echo back, **so that** the Sync Engine's core promises are a
tested guarantee, not a claim.

### Acceptance criteria

1. **Given** a running **scenario-1** landscape (Gitea + Vikunja, [scenarios/README.md](../../scenarios/README.md))
   with an approved peer-peer mapping for issues↔tasks and its **counterpart** approved (bidirectional), **when**
   the operator confirms the identity key + required `ResourceBinding` refs and enables **both** rules through the
   gate (SU-1), **then** each rule backfills and begins polling.
2. **Given** a **Gitea issue is created/updated**, **when** the deterministic **poll-trigger hook** (SP-5) runs
   the Gitea→Vikunja rule's poll cycle, **then** a corresponding **Vikunja task** is created/updated via the real
   API — a real sync round end to end.
3. **Given** that write landed in Vikunja, **when** the poll-trigger hook then runs the **Vikunja→Gitea** rule's
   poll cycle, **then** the mediator's own write is recognized as an **echo** and recorded `skipped-loop` — **no
   write is made back to Gitea** ([sync-engine.md](../architecture/sync-engine.md) *Loop prevention*).
4. **Given** the same poll cycle is triggered **again** with no new change, **when** it runs, **then** **no
   duplicate** Vikunja task is created — idempotency + snapshot diffing absorb the re-run (OC-2, SP-2).
5. **Given** an **identity-less** pair (scenario-1's issue-comments↔task-comments, which have **no natural
   business key** — see `ground-truth.yaml`), **when** the operator attempts to enable its rule **without** a
   confirmed identity key, **then** enablement is **blocked** with the gate's "still needs identity key" reason
   (BE-1) — the enablement gate demonstrated against a real key-less resource.
6. **Given** a `viewer` drives the enablement journey, **when** they reach any mutation, **then** the UI/API
   blocks it (OA-2) — the e2e also proves the read/mutate split extends to sync operations.

### Out of scope

- Adapter serving in the same journey — Phase 5; this e2e stops at a verified sync round.
- Exhaustive per-scenario coverage — this capstone exercises scenario 1; the invariant unit tests
  (dedup/no-echo, enqueue-then-advance, ambiguous→manual, target-wins-withhold, PUT read-carry, cross-direction
  ordering, deletes) carry the rest deterministically.

### Dependencies

Blocked by SU-1..SU-4, BE-*, SP-5, EP-*, OC-*, RL-*, and a running scenario-1 landscape. The capstone e2e for
Phase 4.
