# Phase 3 — Approval Service (the core)

The heart of Phase 3: the **Approval Service** turns a `MappingProposal` into an `ApprovedMapping`
through per-item accept/edit/reject and **partial approval**, validating operator edits against the
target IR, confirming the **identity key** with its rename-only and shared-pairing locks, and emitting
`MappingApproved`. This file owns the *logic and persistence* of approval; the HTTP surface is
[phase-3-approval-api.md](phase-3-approval-api.md), the disabled-artifact reaction is
[phase-3-artifact-instantiation.md](phase-3-artifact-instantiation.md), and the screen is
[phase-3-review-ui.md](phase-3-review-ui.md).

Every criterion here is deterministic over a **replayed proposal fixture** — a persisted
`MappingProposal` + `MappingProposalItem`s (peer-peer or consumer-provider) — so the approval
invariants are unit-testable without an LLM.

**Actor:** operator (the mutations); the Approval Service executes them.

**Concept references (whole file):** [mapping-review-and-approval.md](../flows/mapping-review-and-approval.md)
steps 3-8; [data-model.md](../architecture/data-model.md) `ApprovedMapping`, `FieldMapping`,
`OperationMapping`, `ParameterMapping`, `MappingProposal.status`, `MappingProposalItem.reviewState`,
*Modeling notes*; [mapping-engine.md](../architecture/mapping-engine.md) *Structured proposal formats*
(identity key: value-preserving, human-confirmed); [sync-engine.md](../architecture/sync-engine.md)
*Identity correlation: RecordLink* (why a wrong identity key is the worst failure mode);
[security.md](../architecture/security.md) *Operator authentication & authorization* (`approvedBy`,
`mapping-decision` audit); [glossary.md](../glossary.md) `Approval Service`, `ApprovedMapping`,
`identity key`, `identityCandidate`, `counterpartMappingId`, `action`.

> **Core safety promise:** *nothing executes without approval*, and *the identity key is never
> auto-confirmed*. Both are hard invariants an e2e proves — not conveniences a fast path may skip.

---

## AS-1 — Per-item review decisions (accept / edit / reject), with permanent rejection

**As an** operator, **I can** accept, edit, or reject each `MappingProposalItem` individually, **so
that** I decide every correspondence on its own merits rather than all-or-nothing.

### Acceptance criteria

1. **Given** a `pending` `MappingProposalItem`, **when** the operator accepts it as-is, **then** its
   `reviewState` becomes `accepted` ([data-model.md](../architecture/data-model.md)
   `MappingProposalItem.reviewState`; [flow](../flows/mapping-review-and-approval.md) step 3).
2. **Given** a `pending` item, **when** the operator edits it — changing the `targetRef`
   (`targetPath`/`targetOperationId`/`targetParam`), changing the `transform`, or picking a different
   option from `ambiguousAlternatives` — **then** its `reviewState` becomes `edited` and the edit is
   captured against the item, subject to AS-3 validation ([flow](../flows/mapping-review-and-approval.md)
   step 3).
3. **Given** a `pending` item, **when** the operator rejects it, **then** its `reviewState` becomes
   `rejected`, and **that rejection is permanent**: a later incremental analysis of the same spec pair
   does **not** re-suggest it unless the underlying elements change
   ([flow](../flows/mapping-review-and-approval.md) note 2). *(The "unless the underlying elements
   change" re-suggestion trigger is Phase 6; Phase 3 persists the permanent `rejected` state it keys
   off.)*
4. **Given** an `unmapped` item, **when** the operator supplies a `targetRef` and `transform`, **then**
   it is treated as an `edited` mapped item (the "needs manual mapping" path) and is subject to AS-3
   validation; leaving it `unmapped` and accepting/rejecting it is equally valid.
5. **Given** any per-item decision, **when** it is recorded, **then** a `mapping-decision` audit entry
   captures the authenticated actor, the item, and the decision (see OA-3), so the incremental-approval
   history lives in the audit log rather than on the `ApprovedMapping`
   ([data-model.md](../architecture/data-model.md) `ApprovedMapping.approvedBy`;
   [security.md](../architecture/security.md) *Audit logging*).

### Out of scope

- The all-at-once **approve** action that assembles decided items into an `ApprovedMapping` — AS-2.
- Re-suggestion suppression logic on spec change — Phase 6.

### Dependencies

Blocked by Phase-2 PP-2 (persisted items), AM-1. Precedes AS-2.

---

## AS-2 — Partial approval assembles decided items into one `ApprovedMapping`

**As an** operator, **I can** approve a subset of a proposal's items, **so that** I can put the
correspondences I trust into production while leaving the rest for later — without an all-or-nothing
gate.

### Acceptance criteria

1. **Given** a proposal with some items `accepted`/`edited` and others still `pending`, **when** the
   operator approves the current selection, **then** the Approval Service assembles the
   `accepted`/`edited` items under a single `ApprovedMapping` for that directional proposal:
   `kind = field` → `FieldMapping` (keeping `phase` on a consumer-provider proposal),
   `kind = operation` → `OperationMapping`, and (consumer-provider only) `kind = parameter` →
   `ParameterMapping` under its operation pairing ([flow](../flows/mapping-review-and-approval.md)
   step 5; [data-model.md](../architecture/data-model.md) *Modeling notes*).
2. **Given** the approve action, **when** undecided (`pending`) items remain, **then** the proposal's
   `status` becomes `partially_approved` — not an all-or-nothing decision
   ([flow](../flows/mapping-review-and-approval.md) step 4).
3. **Given** a proposal in which **every** item is decided and **at least one** is `accepted`/`edited`,
   **when** it is approved, **then** its `status` becomes `approved`; **given** a proposal in which
   every item is `rejected`, **when** the review completes, **then** its `status` becomes `rejected`
   (no `ApprovedMapping` is created in that case). *(See README open question: the exact
   `partially_approved` vs. `approved` vs. `rejected` predicate is a concept gap; this is the
   recommended rule.)*
4. **Given** a proposal already yielding an `ApprovedMapping` from an earlier partial approval, **when**
   a later approve adds more items, **then** the **same** `ApprovedMapping` is updated in place (new
   `FieldMapping`/`OperationMapping`/`ParameterMapping` rows added, `approvedBy`/`approvedAt` set to the
   most recent action) — one `ApprovedMapping` per directional proposal, not a new row per approve
   ([data-model.md](../architecture/data-model.md) `ApprovedMapping.approvedBy` "the *most recent*
   approval action"). *(See README open question confirming update-in-place.)*
5. **Given** a `MappingProposal` is always one-directional, **when** it is approved, **then** the
   resulting `ApprovedMapping` is one-directional too — there is **no** "approve as bidirectional"
   action ([flow](../flows/mapping-review-and-approval.md) step 5).
6. **Given** the assembled `ApprovedMapping` is created, **when** persisted, **then** its `status` is
   `active` (the only creation value the concept's enum offers — see AS-6 criterion 3) and **no**
   `SyncRule`/`AdapterBinding` exists yet — those are the AI-* reaction to the emitted event, never a
   synchronous side effect of assembly.

### Out of scope

- Validating the edited target paths (AS-3), confirming the identity key (AS-5), linking the counterpart
  and emitting `MappingApproved` (AS-6) — separate stories invoked by the same approve action.
- Instantiating disabled artifacts — AI-1..AI-3.

### Dependencies

Blocked by AS-1, AM-2, AM-3, AM-4. Precedes AS-3, AS-6.

---

## AS-3 — Edit-path validation against the target IR before acceptance

**As an** operator, **I** have my edits validated against the target spec's IR before they become part
of an `ApprovedMapping`, **so that** I can never approve a mapping that points at a target element that
does not exist.

### Acceptance criteria

1. **Given** an approve action over `accepted`/`edited` items, **when** the Approval Service runs,
   **then** it validates every item's effective `targetRef` against the **target spec's IR** before
   assembling the `ApprovedMapping` ([flow](../flows/mapping-review-and-approval.md) step 5: "validates
   the edited paths against the target spec's IR").
2. **Given** an edited `targetPath` (field) that resolves to a field of the target resource's IR,
   **when** validated, **then** it passes; **given** one that resolves to **no** field, **when**
   validated, **then** the approve is **rejected** with an error naming the unresolvable ref, and **no**
   `ApprovedMapping` row (or update) is committed.
3. **Given** an edited `targetOperationId`, **when** validated, **then** it must resolve to an operation
   in the target spec's IR — an unresolvable operation ref rejects the approve, same as criterion 2.
4. **Given** a **consumer-provider** proposal with an edited `targetParam`, **when** validated, **then**
   the parameter must exist on the referenced target operation's IR; an unresolvable parameter ref
   rejects the approve.
5. **Given** an approve action containing at least one invalid edited ref, **when** it is rejected,
   **then** the rejection is atomic: none of that action's items are committed (validation is a
   precondition of assembly, not a per-item best-effort).
6. **Given** an item `accepted` as-is (unedited), **when** validated, **then** it is validated the same
   way — an item the Mapping Engine produced against a since-unchanged version-1 spec still resolves, so
   this is a defense-in-depth check, not only an edit check.

### Out of scope

- Validating *source* refs — Phase 3 operates on version-1 specs the proposal was generated against, so
  source refs resolve by construction; source-side re-validation on spec change is Phase 6.
- Semantic validation of a `transform`'s config beyond ref resolution (e.g. sandbox checks) — Phase 4/5.

### Dependencies

Blocked by AS-2, Phase-1 SI-1 (IR to validate against). Precedes AS-6.

---

## AS-4 — Operation `action` classification and `targetIdParamRef` derivation, reviewer-correctable

**As an** operator, **I** get each approved operation classified `create`/`read`/`update`/`delete` from
the target IR — and, for peer-peer writes, its target-id parameter derived — with the ability to
correct a wrong heuristic, **so that** the executing engines call the right operation with the right
inputs.

### Acceptance criteria

1. **Given** a `kind = operation` item being approved into an `OperationMapping`, **when** the Approval
   Service classifies it, **then** it derives `action` (`create` | `read` | `update` | `delete`)
   mechanically from the target operation's IR (HTTP method + path shape)
   ([data-model.md](../architecture/data-model.md) `OperationMapping.action`;
   [flow](../flows/mapping-review-and-approval.md) step 5).
2. **Given** a derived `action`, **when** the operator disagrees, **then** they may override it to any
   of the four values, and the override is what persists — the same derive-then-correct pattern as
   `ResourceBinding` refs.
3. **Given** a **peer-peer** `OperationMapping` classified `action = update | delete`, **when** it is
   assembled, **then** the Approval Service derives `targetIdParamRef` from the target operation's IR
   (unambiguous when the operation has exactly one path parameter), reviewer-correctable
   ([data-model.md](../architecture/data-model.md) `OperationMapping.targetIdParamRef`).
4. **Given** a **peer-peer** `OperationMapping` classified `action = create | read`, **when** assembled,
   **then** `targetIdParamRef` is **absent** (a create has no linked target id yet; a read is served by
   the poll operation, not a per-record write).
5. **Given** a **consumer-provider** `OperationMapping`, **when** assembled, **then** it carries **no**
   `targetIdParamRef` — consumer-provider mappings fill inputs via `ParameterMapping`s (AM-4).
6. **Given** the concept's four-value `action` vocabulary, **when** classification runs, **then** it
   never emits a `list` action — a collection read is classified `read` (see README open question on the
   plan's `list`).

### Out of scope

- Selecting the operation by `action` at sync time / choosing `backendOperationId` at request time —
  Phase 4/5.

### Dependencies

Blocked by AS-2, AM-4. Precedes AS-6.

---

## AS-5 — Identity-key confirmation: rename-only lock, one-per-pair, shared-pairing lock

**As an** operator, **I** explicitly confirm the identity key of a peer-peer resource pair — never
having it auto-confirmed — under the rename-only and shared-pairing invariants, **so that** the Sync
Engine can correlate records without ever silently merging unrelated ones.

### Acceptance criteria

1. **Given** a **peer-peer** proposal, **when** the review UI opens, **then** the LLM's
   `identityCandidate` (and its suggested `targetLookupParamRef`) **pre-selects** the identity field
   pairing but sets nothing — `FieldMapping.isIdentityKey` is set **only** by an explicit operator
   confirmation ([mapping-engine.md](../architecture/mapping-engine.md) *Structured proposal formats*;
   [flow](../flows/mapping-review-and-approval.md) step 6).
2. **Given** the operator confirms an identity key, **when** the Approval Service records it, **then**
   **exactly one** `FieldMapping` per mapped resource pair has `isIdentityKey = true`; confirming a
   second identity key for the same resource pair is a validation error
   ([data-model.md](../architecture/data-model.md) `FieldMapping.isIdentityKey`).
3. **Given** an identity-key confirmation, **when** the chosen `FieldMapping`'s `transform` is anything
   other than `rename`, **then** the confirmation is **rejected** — only a value-preserving pairing may
   be an identity key ([data-model.md](../architecture/data-model.md);
   [sync-engine.md](../architecture/sync-engine.md) *Identity correlation*).
4. **Given** the counterpart-direction `ApprovedMapping` for the same resource pair already has a
   confirmed identity key, **when** the operator confirms this direction's identity key, **then** the
   **same** field pairing is pre-locked and confirming a **different** pairing is a validation error —
   the shared-pairing lock ([flow](../flows/mapping-review-and-approval.md) step 6;
   [sync-engine.md](../architecture/sync-engine.md) *One identity pairing per resource pair*).
5. **Given** an identity key is confirmed and the target's collection read offers a lookup parameter,
   **when** recorded, **then** the reviewer-confirmed `targetLookupParamRef` is stored on the identity
   `FieldMapping`; **when** the target offers no such parameter, **then** it is absent and matching later
   falls back to fetch-and-match (Phase 4) — the absence is recorded, not invented.
6. **Given** approval, **when** the operator does **not** confirm an identity key, **then** approval
   still completes and the `ApprovedMapping` is created — but its resource pair's `SyncRule` cannot be
   *enabled* until an identity key exists ([flow](../flows/mapping-review-and-approval.md) step 6; the
   enablement gate is Phase 4). The unconfirmed state must not silently self-confirm from
   `identityCandidate`.
7. **Given** a **consumer-provider** proposal, **when** reviewed, **then** there is **no** identity-key
   step at all — the adapter never correlates records across apps
   ([data-model.md](../architecture/data-model.md) `FieldMapping.isIdentityKey`).

### Out of scope

- *Enabling* a `SyncRule` (which requires the confirmed identity key) and executing identity-match
  lookups — Phase 4 ([sync-engine.md](../architecture/sync-engine.md) *Identity correlation*).

### Dependencies

Blocked by AS-2, AM-3, Phase-2 PP-2 (persisted `identityCandidate`/`targetLookupParamRef` metadata).
Precedes AS-6.

---

## AS-6 — Emit `MappingApproved`, link the counterpart, and keep nothing executing

**As an** operator, **I** have an approval announce itself on the Event Bus and opportunistically link
its reverse direction, **while** nothing runs until a later phase enables it, **so that** the approval
is the single trigger for downstream instantiation and the core safety promise holds.

### Acceptance criteria

1. **Given** a successful approve (AS-2 + AS-3 pass), **when** the `ApprovedMapping` is created/updated,
   **then** the Approval Service emits **one** `MappingApproved(approvedMappingId)` on the Event Bus
   ([flow](../flows/mapping-review-and-approval.md) step 8; [glossary.md](../glossary.md)
   `MappingApproved`).
2. **Given** a **peer-peer** approval whose reverse-direction `MappingProposal` for the same spec
   lineages has **also** been approved, **when** the approve completes, **then** the Approval Service
   sets `counterpartMappingId` on both `ApprovedMapping`s to point at each other
   ([flow](../flows/mapping-review-and-approval.md) step 7); **given** the reverse direction has **not**
   been approved, **then** no link is set and the one-way mapping is a valid, common end state.
3. **Given** the `ApprovedMapping` is created, **when** its `status` is set, **then** it is `active` —
   the concept's `ApprovedMapping.status` enum has **no** "disabled"/"pending" value
   ([data-model.md](../architecture/data-model.md) `ApprovedMapping.status`). Non-execution does **not**
   come from the mapping status: it comes from the AI-* consumer instantiating the `SyncRule`(s)
   **disabled** / `AdapterBinding`(s) **proposed** and from no Sync/Adapter engine running in Phase 3.
   An `active` mapping whose rules are all `disabled` executes nothing ("a rule only executes while its
   `ApprovedMapping` is `active`" is necessary, not sufficient — the rule must also be enabled, Phase 4).
   Implementers must **not** invent a non-concept `ApprovedMapping` status to express "not running."
4. **Given** the whole approval path, **when** an e2e replays a proposal fixture and approves it, **then**
   it proves **nothing executed before approval**: no outbound call to any registered app, no
   `SyncRule` polling, and no adapter serving occurred at any point up to and including the emit
   ([security.md](../architecture/security.md): the mediator makes calls only from the Sync/Adapter
   engines, which Phase 3 does not run).
5. **Given** the emit fails or the transaction rolls back, **when** the approve is retried, **then** the
   `ApprovedMapping` and its `MappingApproved` are produced consistently (the emit rides the same
   transactional-outbox discipline as `SpecIngested`, so a committed approval always eventually emits
   exactly one deliverable event) ([overview.md](../architecture/overview.md) *Components*; Phase-1
   EB-1).

### Out of scope

- The consumer that reacts to `MappingApproved` — AI-1..AI-3.
- `suspend`/re-review/`stale`/re-pin transitions and the reverse-direction re-pinning of
  `counterpartMappingId` across spec versions — Phase 6.

### Dependencies

Blocked by AS-2, AS-3, AS-4, AS-5, AM-5, Phase-1 EB-1. Precedes AI-1.
