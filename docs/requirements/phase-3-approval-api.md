# Phase 3 — Review & Approval HTTP API

The **HTTP** slice: the operator-API endpoints that expose the Approval Service — reading proposals
confidence-sorted, recording per-item decisions, confirming the identity key, approving a subset, and
triggering the shortlist-miss escape hatch. These handlers are **thin**: they authenticate/authorize
(OA-1/OA-2), validate the request shape, and delegate every invariant to the Approval Service
([phase-3-approval-service.md](phase-3-approval-service.md)) — they must not re-derive approval logic.

**Actor:** viewer (reads), operator (mutations).

**Concept references (whole file):** [mapping-review-and-approval.md](../flows/mapping-review-and-approval.md)
steps 1-8; [mapping-engine.md](../architecture/mapping-engine.md) *Confidence & ambiguity*, *Escape
hatch*; [data-model.md](../architecture/data-model.md) `MappingProposal`, `MappingProposalItem`,
`ApprovedMapping`; [security.md](../architecture/security.md) *Operator authentication & authorization*;
[glossary.md](../glossary.md) `reviewRequired`, `ambiguousAlternatives`, `unmapped`,
`analysisExclusions`, `ResourceShortlist`.

> **Routes and payloads are the implementation choice; the *contract* is authoritative.** The endpoint
> paths below are illustrative (consistent with Phase-1's `POST /apps` style); what is fixed is the
> read/mutate gating, the confidence-sort contract, the delegation to the Approval Service, and the
> escape-hatch's exclusion rule.

---

## RA-1 — Read proposals, confidence-sorted, filtered by app pair

**As a** viewer or operator, **I can** list `MappingProposal`s by app pair and open one with its items
sorted riskiest-first, **so that** I review the correspondences most likely to be wrong before the
obvious ones.

### Acceptance criteria

1. **Given** proposals exist, **when** the proposal-list endpoint is called filtered by app pair,
   **then** it returns the matching `MappingProposal`s with `id`, `sourceSpecId`/`targetSpecId`,
   `status`, `generatedBy`, and `createdAt` ([flow](../flows/mapping-review-and-approval.md) step 1).
2. **Given** a proposal, **when** its detail endpoint is called, **then** it returns the
   `MappingProposalItem`s sorted by **ascending confidence / descending ambiguity** — items with
   `reviewRequired` (confidence below the configured threshold) first
   ([flow](../flows/mapping-review-and-approval.md) step 2;
   [mapping-engine.md](../architecture/mapping-engine.md) *Confidence & ambiguity*). `reviewRequired` is
   derived against the configured threshold (Phase-2 TD-5), not a stored column.
3. **Given** a proposal detail response, **when** inspected, **then** each item carries its `kind`,
   `sourceRef`, `targetRef` (absent when `unmapped`), `confidenceScore`, `ambiguousAlternatives[]`,
   `unmapped`, `rationale`, `reviewState`, and — on a peer-peer field item — its `identityCandidate`/
   `targetLookupParamRef` detection metadata.
4. **Given** a proposal detail response, **when** inspected, **then** it also returns the
   `shortlistResult`: the no-counterpart resources (surfaced like `unmapped`, RA-5/RU-3) and any
   `analysisFailed` candidate pairs, plus the spec's `analysisExclusions` listed **separately as
   excluded** ([flow](../flows/mapping-review-and-approval.md) step 2).
5. **Given** a `failed` proposal (Phase-2 TD-4), **when** its detail is read, **then** it is returned as
   needing attention with no items — surfacing the whole-spec-pair shortlist failure rather than an
   empty success.
6. **Given** the roles, **when** these read endpoints are called, **then** both `viewer` and `operator`
   are authorized (OA-2), and no response contains credential material.

### Out of scope

- The rendering of the sorted list / flags — the UI is RU-1..RU-3.
- Pagination of items — the shortlist bounds proposal size to plausible pairs
  ([mapping-engine.md](../architecture/mapping-engine.md)); no pagination at Phase-3 scale (see README
  open question).

### Dependencies

Blocked by Phase-2 PP-1/PP-2/PP-3, OA-1/OA-2.

---

## RA-2 — Record per-item review decisions (accept / edit / reject)

**As an** operator, **I can** POST an accept/edit/reject decision for one `MappingProposalItem`, **so
that** I decide each correspondence individually.

### Acceptance criteria

1. **Given** an `operator`, **when** they accept, edit, or reject a `pending` item, **then** the
   endpoint delegates to the Approval Service (AS-1) and the item's `reviewState` transitions to
   `accepted` / `edited` / `rejected` accordingly.
2. **Given** an edit request, **when** it changes `targetRef`, `transform`, or picks an
   `ambiguousAlternatives` option, **then** the change is captured on the item; **any** target-IR
   validation still happens atomically at approve time (AS-3), and the endpoint may additionally
   surface an early validation hint without persisting an invalid edit.
3. **Given** a `viewer`, **when** they call this mutating endpoint, **then** it is rejected 403 (OA-2)
   and nothing changes.
4. **Given** the decision commits, **when** it is recorded, **then** a `mapping-decision` audit entry
   attributes it to the authenticated identity (OA-3).
5. **Given** an item id that does not exist or does not belong to the addressed proposal, **when** the
   endpoint is called, **then** it returns 404 and nothing changes.

### Out of scope

- Assembling decided items into an `ApprovedMapping` — that is the approve action, RA-4.

### Dependencies

Blocked by RA-1, AS-1, OA-2.

---

## RA-3 — Confirm the identity key (peer-peer)

**As an** operator, **I can** confirm the identity key of a peer-peer resource pair, **so that** its
`SyncRule` becomes enable-able later — under the rename-only and shared-pairing locks the service
enforces.

### Acceptance criteria

1. **Given** an `operator` and a **peer-peer** proposal, **when** they confirm an identity `FieldMapping`
   for a resource pair, **then** the endpoint delegates to the Approval Service (AS-5), which sets
   `isIdentityKey = true` on exactly that one pairing and records its confirmed `targetLookupParamRef`
   when the target offers one.
2. **Given** a confirmation of a non-`rename` pairing, **when** submitted, **then** the endpoint returns
   a validation error (from AS-5) and nothing is confirmed — only a value-preserving pairing qualifies.
3. **Given** the counterpart direction already confirmed a different pairing, **when** a conflicting
   pairing is submitted, **then** the endpoint returns a shared-pairing-lock validation error (AS-5) and
   nothing is confirmed.
4. **Given** a **consumer-provider** proposal, **when** an identity-key confirmation is attempted,
   **then** the endpoint rejects it as not-applicable — the adapter never correlates records (AS-5).
5. **Given** a `viewer`, **when** they call this endpoint, **then** it is rejected 403 (OA-2).
6. **Given** a confirmation commits, **when** recorded, **then** it is audited as a `mapping-decision`
   attributed to the identity (OA-3).

### Out of scope

- Enabling the resulting `SyncRule` — Phase 4.

### Dependencies

Blocked by RA-1, AS-5, OA-2.

---

## RA-4 — Approve a selection (assemble `ApprovedMapping`, emit `MappingApproved`)

**As an** operator, **I can** approve the currently-decided selection of a proposal, **so that** the
accepted items become an `ApprovedMapping` and downstream disabled artifacts get instantiated.

### Acceptance criteria

1. **Given** an `operator` and a proposal with decided items, **when** they call the approve endpoint,
   **then** it delegates to the Approval Service (AS-2..AS-6): target-IR validation (AS-3), assembly
   into one `ApprovedMapping`, `action`/`targetIdParamRef` classification (AS-4), counterpart linking
   and `MappingApproved` emission (AS-6).
2. **Given** the approve leaves items `pending`, **when** it returns, **then** the response reflects
   `status = partially_approved`; **given** all items decided with ≥1 accepted, `status = approved`
   (AS-2).
3. **Given** an approve whose edited refs fail target-IR validation, **when** it is processed, **then**
   the endpoint returns a 4xx validation error naming the unresolvable ref and **no** `ApprovedMapping`
   is created/updated and **no** `MappingApproved` is emitted (AS-3 atomicity).
4. **Given** a successful approve, **when** it returns, **then** the response identifies the created/
   updated `ApprovedMapping` (id, `variant`, `status`) and contains no credential material.
5. **Given** a `viewer`, **when** they call the approve endpoint, **then** it is rejected 403 (OA-2) and
   nothing is created.
6. **Given** the approve commits, **when** recorded, **then** `approvedBy`/`approvedAt` and a
   `mapping-decision` audit entry attribute it to the authenticated identity (OA-3).

### Out of scope

- Instantiating the disabled artifacts — that is the AI-* reaction to the emitted `MappingApproved`, not
  a synchronous response of this endpoint.

### Dependencies

Blocked by RA-1, AS-2/AS-3/AS-4/AS-6, OA-2.

---

## RA-5 — Trigger the shortlist-miss escape hatch ("analyze this resource pair anyway")

**As an** operator, **I can** trigger a scoped detail analysis for a resource pair the stage-1 shortlist
missed, **so that** a recall gap does not permanently hide a real correspondence — while the operator's
declared analysis scope stays the single source of truth.

### Acceptance criteria

1. **Given** an `operator` and a resource in the proposal's **no-counterpart** set, **when** they
   trigger "analyze this resource pair anyway" for a chosen counterpart resource, **then** the endpoint
   runs a **scoped detail analysis** (reusing the Phase-2 stage-2 detail path, TD-2) for that one
   resource pair ([flow](../flows/mapping-review-and-approval.md) step 2;
   [mapping-engine.md](../architecture/mapping-engine.md) *Escape hatch*).
2. **Given** the scoped analysis produces correspondences, **when** it completes, **then** the resulting
   `MappingProposalItem`s are attached to the existing proposal for that resource pair and the analyzed
   resource is removed from the no-counterpart set. *(See README open question: attach-to-existing vs.
   new delta proposal — this is the recommended default.)*
3. **Given** a resource the operator **excluded** via `analysisExclusions`, **when** the escape hatch is
   consulted, **then** that resource has **no** "analyze anyway" action and the endpoint refuses to
   analyze it — analyzing it means removing its exclusion, a deliberate scope edit, not a review-screen
   override ([flow](../flows/mapping-review-and-approval.md) step 2;
   [mapping-engine.md](../architecture/mapping-engine.md) *Scoping down*).
4. **Given** a `viewer`, **when** they call this endpoint, **then** it is rejected 403 — it spends LLM
   budget and mutates the proposal, so it is an operator mutation (OA-2 criterion 5).
5. **Given** the scoped detail call fails its retry ceiling (Phase-2 TD-3/TD-4), **when** it resolves,
   **then** that pair is marked `analysisFailed` on the proposal's `shortlistResult` and surfaced as
   needing attention — the escape hatch does not silently swallow the failure.
6. **Given** escape-hatch usage, **when** it runs, **then** it is observable (OTel) as a manually-triggered
   detail analysis — the health signal for shortlist recall
   ([mapping-engine.md](../architecture/mapping-engine.md) *Escape hatch*;
   [observability.md](../architecture/observability.md)).

### Out of scope

- Removing an `analysisExclusion` and its scoped incremental re-analysis (the concept's re-inclusion
  path) — Phase 6 ([mapping-engine.md](../architecture/mapping-engine.md) *Scoping down*).
- Any `SpecDiff`-driven incremental analysis — Phase 6.

### Dependencies

Blocked by RA-1, Phase-2 TD-2/PP-2/PP-3, OA-2.
