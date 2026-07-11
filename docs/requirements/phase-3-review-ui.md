# Phase 3 — Review UI

The **UI** slice: a Vue 3 (`<script setup lang="ts">`, Composition API) review screen driven entirely
by the Approval Service contract ([phase-3-approval-api.md](phase-3-approval-api.md)). It surfaces
proposals confidence-sorted, exposes per-item accept/edit/reject, renders `ambiguousAlternatives`,
`unmapped` items, the no-counterpart escape hatch and the excluded-resource listing, and carries the
identity-key confirmation panel with its rename-only and shared-pairing locks. These stories are
deliberately **thin** — they render and call the API; every invariant is enforced server-side.

**Actor:** operator (mutations), viewer (read-only view).

**Concept references (whole file):** [mapping-review-and-approval.md](../flows/mapping-review-and-approval.md)
steps 1-8; [mapping-engine.md](../architecture/mapping-engine.md) *Confidence & ambiguity*, *Escape
hatch*, *Scoping down*; [data-model.md](../architecture/data-model.md) `MappingProposalItem`,
`FieldMapping.isIdentityKey`; [glossary.md](../glossary.md) `reviewRequired`, `ambiguousAlternatives`,
`unmapped`, `identityCandidate`, `analysisExclusions`.

> **Copy and layout are the implementation choice; the surfaced *distinctions* are authoritative.** The
> UI must keep `unmapped`, no-counterpart (with escape hatch), and *excluded* (no escape hatch) visibly
> distinct, and must never auto-confirm an identity key. Exact wording, ordering within equal-confidence
> ties, and visual treatment are open (see README open questions on UI copy).

---

## RU-1 — Confidence-sorted proposal review screen

**As a** reviewer, **I** open a proposal and see its items sorted riskiest-first, **so that** I spend my
attention where the Mapping Engine is least certain.

### Acceptance criteria

1. **Given** a proposal, **when** the review screen renders, **then** it lists the
   `MappingProposalItem`s in the API's confidence order (ascending confidence / descending ambiguity),
   with `reviewRequired` items visually flagged first
   ([flow](../flows/mapping-review-and-approval.md) step 2).
2. **Given** an item, **when** rendered, **then** it shows its `kind`, `sourceRef`, `targetRef` (or an
   `unmapped` treatment), `confidenceScore`, and `rationale`.
3. **Given** a `failed` proposal (Phase-2 TD-4), **when** the screen renders it, **then** it is shown as
   needing attention (whole-spec-pair shortlist failure) rather than as an empty proposal.
4. **Given** a `viewer`, **when** they open the screen, **then** it renders read-only — the accept/edit/
   reject/approve controls are absent or disabled (mutations require `operator`, OA-2).
5. **Given** the screen filters by app pair, **when** it loads, **then** it uses RA-1's list + detail
   endpoints and renders no credential material.

### Out of scope

- The read/mutate API contract itself — RA-1.

### Dependencies

Blocked by RA-1.

---

## RU-2 — Per-item accept / edit / reject controls

**As an** operator, **I** accept, edit, or reject each item inline, **so that** I decide every
correspondence without leaving the screen.

### Acceptance criteria

1. **Given** a `pending` item, **when** the operator accepts it, **then** the UI calls RA-2 and reflects
   `reviewState = accepted`.
2. **Given** an item with `ambiguousAlternatives`, **when** the operator opens the edit control, **then**
   the alternatives are presented as a **choice** (not a silent best guess), and picking one records an
   `edited` decision via RA-2 ([mapping-engine.md](../architecture/mapping-engine.md) *Confidence &
   ambiguity*: "surfaced in the review UI as a choice").
3. **Given** the edit control, **when** the operator changes the `targetPath` or `transform`, **then**
   the UI submits the edit via RA-2; a server-side target-IR validation error (AS-3, surfaced at approve
   or as an early hint) is shown against the field without losing entered input.
4. **Given** a `pending` item, **when** the operator rejects it, **then** the UI calls RA-2 and reflects
   `reviewState = rejected`, communicating that rejection is permanent (won't be re-suggested).
5. **Given** an `unmapped` item, **when** rendered, **then** it is shown as "needs manual mapping or
   intentionally unmapped," offering either supplying a target (an `edited` mapping) or accepting the
   unmapped state ([data-model.md](../architecture/data-model.md) `MappingProposalItem.unmapped`).

### Out of scope

- The approve action — RU-4.

### Dependencies

Blocked by RU-1, RA-2.

---

## RU-3 — Surface no-counterpart resources (escape hatch) vs. excluded resources (no action)

**As a** reviewer, **I** see the resources stage 1 shortlisted no counterpart for — each with an
"analyze anyway" action — kept visibly distinct from resources the operator excluded from analysis, **so
that** a shortlist miss is correctable while my declared scope stays authoritative.

### Acceptance criteria

1. **Given** a proposal's `shortlistResult`, **when** the screen renders, **then** it lists the
   **no-counterpart** resources the same way `unmapped` items are surfaced, each carrying an "analyze
   this resource pair anyway" action ([flow](../flows/mapping-review-and-approval.md) step 2;
   [mapping-engine.md](../architecture/mapping-engine.md) *Escape hatch*).
2. **Given** the operator triggers "analyze anyway" for a chosen counterpart, **when** invoked, **then**
   the UI calls RA-5 and, on completion, renders the newly produced items and removes the resource from
   the no-counterpart list.
3. **Given** the spec's `analysisExclusions`, **when** the screen renders, **then** excluded resources
   are listed **separately, as excluded**, with **no** "analyze anyway" action — distinct from a
   shortlist miss ([flow](../flows/mapping-review-and-approval.md) step 2;
   [mapping-engine.md](../architecture/mapping-engine.md) *Scoping down*).
4. **Given** a candidate pair marked `analysisFailed` (a detail-call ceiling, or an escape-hatch failure,
   Phase-2 TD-4 / RA-5), **when** rendered, **then** it is shown as needing attention rather than
   silently omitted.
5. **Given** a `viewer`, **when** the screen renders, **then** the escape-hatch action is absent/disabled
   (it is an `operator` mutation, OA-2 / RA-5 criterion 4).

### Out of scope

- Editing `analysisExclusions` from the review screen — that is a deliberate scope edit elsewhere, and
  its re-inclusion re-analysis is Phase 6.

### Dependencies

Blocked by RU-1, RA-5.

---

## RU-4 — Identity-key confirmation panel and partial-approval action (peer-peer)

**As an** operator, **I** confirm the identity key from a panel that pre-selects the suggestion but never
auto-confirms, then approve a subset, **so that** I put trusted correspondences into production with the
identity key set only by my explicit choice.

### Acceptance criteria

1. **Given** a **peer-peer** proposal, **when** the identity-key panel renders, **then** the field
   pairing suggested by `identityCandidate` (and its `targetLookupParamRef`) is **pre-selected** but not
   confirmed — confirmation requires an explicit operator action
   ([flow](../flows/mapping-review-and-approval.md) step 6;
   [mapping-engine.md](../architecture/mapping-engine.md)).
2. **Given** the panel, **when** the operator tries to confirm a non-`rename` pairing, **then** the UI
   surfaces the rename-only rejection from RA-3/AS-5 and does not confirm.
3. **Given** the counterpart direction already confirmed a pairing, **when** the panel renders, **then**
   it pre-locks the same pairing and surfaces the shared-pairing-lock error if a different one is
   attempted (RA-3/AS-5).
4. **Given** a **consumer-provider** proposal, **when** the screen renders, **then** **no** identity-key
   panel appears — the adapter never correlates records (AS-5 criterion 7).
5. **Given** the operator has decided a subset of items, **when** they click approve, **then** the UI
   calls RA-4 and reflects the resulting status (`partially_approved` when items remain `pending`,
   `approved` when all decided) — undecided items stay reviewable
   ([flow](../flows/mapping-review-and-approval.md) step 4).
6. **Given** approval completes **without** a confirmed identity key, **when** the UI reflects the state,
   **then** it communicates that the mapping is approved but its `SyncRule` cannot be *enabled* until an
   identity key is confirmed (the enablement gate is Phase 4) — it must not imply the mapping is running.

### Out of scope

- Enabling a `SyncRule` / composing an `AdapterEndpoint` — Phase 4/5; the UI shows the approved-but-not-
  running state only.

### Dependencies

Blocked by RU-1, RU-2, RA-3, RA-4.

---

## RU-5 — E2e review journey proving nothing executes before approval

**As a** product owner, **I** have an end-to-end review journey over a replayed proposal fixture that
proves the core safety promise, **so that** "nothing executes without approval" is a tested guarantee,
not a claim.

### Acceptance criteria

1. **Given** a **replayed proposal fixture** — a persisted peer-peer `MappingProposal` + items seeded
   without invoking an LLM — **when** an operator drives the full journey (open → review items → confirm
   identity key → partial approve), **then** each step calls the real RA-* endpoints and the journey
   completes to an `ApprovedMapping`.
2. **Given** the journey up to and including approval, **when** the system is observed, **then** **no**
   outbound call to any registered app occurred, **no** `SyncRule` polled, and **no** adapter served a
   request — nothing executed before approval (AS-6 criterion 4).
3. **Given** the approval emits `MappingApproved`, **when** the reaction settles, **then** the
   instantiated `SyncRule`(s) are **disabled** (or the `AdapterBinding`(s) **proposed**) and still
   execute nothing — approval instantiates, it does not enable (AI-1/AI-2).
4. **Given** a `viewer` drives the same journey, **when** they reach any mutation, **then** the UI/API
   blocks it (OA-2) — the e2e also proves the read/mutate split.
5. **Given** an approve with an intentionally-invalid edited target ref in the fixture, **when** the
   operator approves, **then** the journey surfaces the target-IR validation error and produces **no**
   `ApprovedMapping` (AS-3), proving invalid edits never reach production.

### Out of scope

- Enabling/backfilling a rule or serving an adapter within the journey — Phase 4/5; the journey stops at
  the instantiated-disabled state.

### Dependencies

Blocked by RU-1..RU-4, AI-1/AI-2, OA-2. The capstone e2e for Phase 3.
