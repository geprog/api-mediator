# Phase 2 — Proposal persistence

Turning validated stage outputs into durable review artifacts: a `MappingProposal` per directional
spec-pair analysis, its `MappingProposalItem`s (one per operation/field/parameter correspondence),
and the mechanically-enriched `shortlistResult`. Persistence is where the concept's "nothing
executes without approval" promise is set up: these rows are **reviewable proposals**, never
executable mappings — no `ApprovedMapping`, `SyncRule`, or `AdapterBinding` is created here.

All criteria are **FakeProvider-deterministic**: given a scripted `ResourceShortlist` /
`MappingSuggestionSet`, the persisted rows are fully determined.

**Actor:** system (Mapping Engine).

**Concept references (whole file):** [data-model.md](../architecture/data-model.md) `MappingProposal`,
`MappingProposalItem`; [mapping-engine.md](../architecture/mapping-engine.md) *Structured proposal
formats* (validation-before-persist, set-difference enrichment, `analysisFailed`);
[app-registration-and-mapping-detection.md](../flows/app-registration-and-mapping-detection.md)
step 6; [glossary.md](../glossary.md) `MappingProposal`, `MappingProposalItem`, `ResourceShortlist`,
`unmapped`, `phase`.

---

## PP-1 — Persist a `MappingProposal` per directional analysis

**As a** reviewer, **I** get one durable `MappingProposal` per directional spec-pair analysis, **so
that** each direction is reviewed and approved independently (which is what a bidirectional sync's two
one-way mappings require).

### Acceptance criteria

1. **Given** a completed directional analysis, **when** it is persisted, **then** a `MappingProposal`
   row is created with a generated `id`, its `sourceSpecId`, its `targetSpecId`, `generatedBy`
   (LP-4), `shortlistResult` (PP-3), `status`, and `createdAt`
   ([data-model.md](../architecture/data-model.md) `MappingProposal`).
2. **Given** a peer-peer unordered pair `{A, B}`, **when** persisted, **then** it yields **two**
   `MappingProposal`s — one `A → B` and one `B → A` — each its own row; a consumer-provider pair
   yields exactly **one** proposal (consumer as `sourceSpecId`).
3. **Given** a newly persisted proposal that produced reviewable items, **when** inspected, **then**
   its `status` is `pending` (not `partially_approved`/`approved`/`rejected`, which are Phase-3
   review outcomes).
4. **Given** a shortlist-stage failure (TD-4), **when** the proposal is persisted, **then** its
   `status` is `failed` and it has **no** `MappingProposalItem`s.
5. **Given** any proposal, **when** persisted, **then** it contains **no** credential material (it is
   derived from IR only), consistent with the Phase-1 no-secrets-in-derived-data invariant.

### Out of scope

- Transitioning `status` to `partially_approved`/`approved`/`rejected` — Phase 3 review.
- Yielding an `ApprovedMapping` on approval — Phase 3.

### Dependencies

Blocked by TD-2 (items) and TD-1/PP-3 (`shortlistResult`). Precedes DT-1.

---

## PP-2 — Persist each correspondence as a `MappingProposalItem`

**As a** reviewer, **I** get every operation/field/parameter correspondence persisted as a
first-class `MappingProposalItem`, **so that** I can accept/edit/reject each one individually in
Phase 3.

### Acceptance criteria

1. **Given** a validated `MappingSuggestionSet`, **when** persisted, **then** each `operationMappings`
   entry becomes a `MappingProposalItem` with `kind = operation`, each `fieldMappings` entry a
   `kind = field` item, and (consumer-provider only) each `parameterMappings` entry a
   `kind = parameter` item ([data-model.md](../architecture/data-model.md) `MappingProposalItem`;
   [mapping-engine.md](../architecture/mapping-engine.md): "All three map onto the single
   `MappingProposalItem` entity regardless of `kind`").
2. **Given** any persisted item, **when** inspected, **then** it carries `id`, `proposalId`, `kind`,
   `sourceRef`, `targetRef` (nullable — absent when `unmapped = true`), `confidenceScore`,
   `ambiguousAlternatives[]`, `unmapped`, `rationale`, and `reviewState = pending`.
3. **Given** a `kind = field` item on a **consumer-provider** proposal, **when** persisted, **then**
   it carries a `phase` (`request` | `response`); on a **peer-peer** proposal a `field` item carries
   **no** `phase`; a `kind = parameter` item carries **no** `phase` (it is inherently request-phase),
   and `kind = parameter` items exist **only** on consumer-provider proposals.
4. **Given** a `kind = field` or `kind = parameter` item, **when** persisted, **then**
   `transformSuggestion` is populated from the suggestion's transform; a `kind = operation` item has
   `transformSuggestion = null`.
5. **Given** an `unmapped = true` item, **when** persisted, **then** `targetRef` and
   `transformSuggestion` are absent.
6. **Given** the validation-before-persist rule (TD-3), **when** items are persisted, **then** they
   originate **only** from a validated `MappingSuggestionSet` — no item is ever persisted from
   unvalidated free-text output.
7. **Given** a **peer-peer** `kind = field` item, **when** persisted, **then** the LLM's
   `identityCandidate` suggestion (and the suggested `targetLookupParamRef`, when present) is stored
   on the item as review-time detection metadata, so Phase-3 can pre-select the identity key without
   re-running the LLM ([data-model.md](../architecture/data-model.md) `MappingProposalItem`;
   [mapping-engine.md](../architecture/mapping-engine.md); [mapping-review-and-approval.md](../flows/mapping-review-and-approval.md)
   step 6); it is **absent** on `operation`/`parameter` items and on consumer-provider (phased) field
   items.

### Out of scope

- Turning accepted items into `FieldMapping`/`OperationMapping`/`ParameterMapping` — Phase 3.
- `reviewState` transitions beyond the initial `pending` — Phase 3.

### Dependencies

Blocked by TD-2. Precedes DT-1.

---

## PP-3 — Persist and mechanically enrich `shortlistResult`

**As a** reviewer, **I** get the stage-1 shortlist persisted **and enriched** with the resources that
found no counterpart and any failed detail pairs, **so that** the review UI can surface shortlist
misses (the escape hatch) and detail failures transparently — the shortlist is reviewable, not
silent.

### Acceptance criteria

1. **Given** a validated stage-1 `ResourceShortlist`, **when** persisted, **then** it is stored on the
   proposal's `shortlistResult`, carrying the candidate resource pairs (with confidence + rationale)
   the run was scoped by ([data-model.md](../architecture/data-model.md)
   `MappingProposal.shortlistResult`).
2. **Given** the in-scope resources on each side (CE-4) and the shortlisted candidate pairs, **when**
   `shortlistResult` is enriched, **then** the engine adds the in-scope resources that appear in **no**
   candidate pair as the **no-counterpart** set, computed by **set difference** — computed by the
   engine, **not trusted from the LLM** ([mapping-engine.md](../architecture/mapping-engine.md):
   "computed by set difference rather than trusted from the LLM").
3. **Given** a resource excluded via `analysisExclusions` (CE-4), **when** `shortlistResult` is
   enriched, **then** that resource is **not** in the no-counterpart set — excluded is distinct from
   no-counterpart (the review UI lists it as excluded, with no "analyze anyway" action; Phase 3).
4. **Given** a stage-2 detail failure for a candidate pair (TD-4), **when** the proposal is persisted,
   **then** that pair is marked `analysisFailed` inside this proposal's `shortlistResult`.
5. **Given** a **peer-peer** unordered pair's two directional proposals, **when** both are persisted,
   **then** the shared, direction-agnostic parts of `shortlistResult` (candidate pairs +
   no-counterpart set) are **identical** across the two, since stage 1 ran once for the pair; the
   per-direction `analysisFailed` markers may differ (each direction runs its own detail calls).

### Out of scope

- The review-UI escape hatch that lets a reviewer trigger a detail analysis for a no-counterpart pair
  — Phase 3 UI action ([mapping-review-and-approval.md](../flows/mapping-review-and-approval.md)).
  Phase 2 persists the `shortlistResult` that **enables** it.

### Dependencies

Blocked by TD-1 (shortlist), TD-4 (`analysisFailed`), CE-4 (in-scope set). Realized with PP-1.
