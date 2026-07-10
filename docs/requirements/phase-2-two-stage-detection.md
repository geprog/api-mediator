# Phase 2 — Two-stage detection (shortlist → detail)

The heart of the "core bet": for each enumerated spec pair, a cheap summary-level **shortlist** call
picks the plausibly-corresponding resource pairs, then a full **detail** call runs only on those —
turning a ~38,000-detail-call cross-product into ~1,000 landscape-wide calls (see
[overview.md](../architecture/overview.md) *Scale assumption*). Every LLM output is validated against
a fixed JSON schema before anything downstream trusts it, malformed output triggers a capped
corrective retry, and the two stages fail with deliberately different blast radii.

The **mechanical** behaviors here (call counts, validation-before-trust, retry cap, the two blast
radii, the confidence threshold, the peer-peer vs. consumer-provider output shapes) are all
**FakeProvider-deterministic**. Whether a *real* model actually finds the right pairs is **accuracy**,
scored — not asserted — by the eval harness (see [phase-2-eval-harness.md](phase-2-eval-harness.md)).

**Actor:** system (Mapping Engine core + active `LLMMappingProvider`).

**Concept references (whole file):** [mapping-engine.md](../architecture/mapping-engine.md)
*Matching approach: two-stage*, *Structured proposal formats*, *Confidence & ambiguity*;
[data-model.md](../architecture/data-model.md) `MappingProposal` (`status`, `shortlistResult`),
`MappingProposalItem`; [app-registration-and-mapping-detection.md](../flows/app-registration-and-mapping-detection.md)
step 5; [glossary.md](../glossary.md) `Shortlist pass (stage 1)`, `Detail pass (stage 2)`,
`ResourceShortlist`, `confidenceScore`, `ambiguousAlternatives`, `unmapped`, `reviewRequired`,
`identityCandidate`, `phase`.

> **The structured output shapes are authoritative; their JSON layout is implementation-defined.**
> `ResourceShortlist` and `MappingSuggestionSet` fields are fixed by
> [mapping-engine.md](../architecture/mapping-engine.md) *Structured proposal formats*; the concrete
> schema encoding is an implementation choice as long as every field is present and validated.

---

## TD-1 — Stage 1: shortlist plausible resource pairs, once per unordered spec pair

**As the** Mapping Engine, **I** run one recall-biased shortlist call per unordered spec pair over
resource *summaries*, **so that** only plausibly-corresponding resource pairs reach the expensive
detail stage — and both directions of a peer pair reuse the one shortlist.

### Acceptance criteria

1. **Given** an unordered spec pair with in-scope resources on both sides (CE-4), **when** stage 1
   runs, **then** the core calls `shortlistResourcePairs` **exactly once** for that unordered pair,
   passing only resource-level summaries (name, description, operation summaries, top-level field
   list) — not full operations/schemas ([mapping-engine.md](../architecture/mapping-engine.md)
   *Stage 1*).
2. **Given** a peer-peer unordered pair `{A, B}` with two directional analyses, **when** stage 1
   completes, **then** the single `ResourceShortlist` is **reused** by both the A→B and B→A detail
   passes — stage 1 does **not** run twice ([mapping-engine.md](../architecture/mapping-engine.md):
   "computed once per unordered spec pair and shared by both directional analyses").
3. **Given** a returned `ResourceShortlist`, **when** validated, **then** it has `candidatePairs`,
   each an object with `sourceResource`, `targetResource`, `confidence`, and `rationale`.
4. **Given** the concept's recall bias, **when** the shortlist prompt is templated, **then** it
   instructs the model to include a pair when in doubt (a false positive costs one wasted detail
   call; a false negative loses a real mapping) — a behavioral prompt property, verifiable that the
   template encodes recall bias, not that a real model achieves any recall number (that is EH).
5. **Given** an unordered spec pair where **no** resource summaries plausibly correspond, **when**
   stage 1 returns an empty `candidatePairs`, **then** stage 2 runs zero detail calls and the
   proposal is still created (with every in-scope resource recorded as no-counterpart — see PP-3).

### Out of scope

- Mechanically enriching `shortlistResult` with the no-counterpart set difference — PP-3.
- The manual "analyze this pair anyway" escape hatch that a low-recall shortlist needs — Phase 3 UI
  action; the persisted `shortlistResult` that *enables* it is Phase 2 (PP-3).

### Dependencies

Blocked by LP-1, CE-4. Precedes TD-2, PP-3.

---

## TD-2 — Stage 2: detail-analyze each shortlisted resource pair into a `MappingSuggestionSet`

**As the** Mapping Engine, **I** run one detail call per shortlisted resource pair to produce
operation-, field-, and (for adapters) parameter-level correspondences, **so that** reviewers get a
concrete, structured proposal to accept/edit/reject.

### Acceptance criteria

1. **Given** a shortlisted resource pair, **when** stage 2 runs, **then** the core calls
   `generateMappingProposal` **exactly once** for it, passing both resources' **full** operations and
   schemas, and validates the returned `MappingSuggestionSet`
   ([mapping-engine.md](../architecture/mapping-engine.md) *Stage 2*).
2. **Given** a validated `MappingSuggestionSet`, **when** inspected, **then** each `operationMappings`
   entry has `sourceOperationId`, `targetOperationId`, `confidence`, `rationale`,
   `ambiguousAlternatives[]` (each `{ targetOperationId, confidence }`), and `unmapped`.
3. **Given** a validated `MappingSuggestionSet`, **when** inspected, **then** each `fieldMappings`
   entry has `sourceField`, `targetField`, `transform` (one of `rename` | `coerce` | `aggregate` |
   `expression`), `transformDetail`, `confidence`, `rationale`, `ambiguousAlternatives[]`, and
   `unmapped`.
4. **Given** a **peer-peer** shortlisted pair, **when** stage 2 returns, **then** its `fieldMappings`
   carry `identityCandidate` (with **at most one** `true` per resource pair, only on a value-preserving
   — `rename`-or-none — pairing, optionally naming a `targetLookupParamRef`) and carry **no** `phase`
   and **no** `parameterMappings` ([mapping-engine.md](../architecture/mapping-engine.md) *Structured
   proposal formats*).
5. **Given** a **consumer-provider** shortlisted pair, **when** stage 2 returns, **then** every
   `fieldMappings` entry carries a `phase` (`request` | `response`), `parameterMappings` are present
   (each `{ sourceOperationId, targetOperationId, sourceParam, targetParam, transform?,
   transformDetail?, confidence, rationale, unmapped }`), and **no** `identityCandidate` appears —
   and **both** phases plus the parameter mappings come out of the **same single** detail call, not
   extra calls.
6. **Given** scenario-1's shortlisted Gitea `issues` ↔ Vikunja `tasks` pair analyzed with a
   FakeProvider scripted to the ground-truth-shaped result, **when** stage 2 runs, **then** its
   `operationMappings` and `fieldMappings` are produced in the peer-peer shape (identityCandidate on
   the `title`↔`title` pairing, no `phase`), demonstrating the shape end to end deterministically.

### Out of scope

- Persisting the set as `MappingProposalItem`s — PP-2.
- Confirming `identityCandidate` into `FieldMapping.isIdentityKey`, or an operation's `action` into
  `OperationMapping` — Phase 3 review/approval.

### Dependencies

Blocked by TD-1. Precedes PP-2, TD-5.

---

## TD-3 — Validate every LLM output against a fixed schema, with capped corrective retry

**As the** Mapping Engine, **I** never trust free-text LLM output — I validate each stage's output
against a fixed JSON schema and, on malformed output, re-prompt with the validation error up to a
capped number of attempts, **so that** only validated structured output is ever persisted.

### Acceptance criteria

1. **Given** either stage's raw output, **when** it is received, **then** it is validated against that
   stage's fixed JSON schema **before** anything is persisted — free-text output is never persisted
   or acted on directly ([mapping-engine.md](../architecture/mapping-engine.md) *Structured proposal
   formats*).
2. **Given** malformed output, **when** validation fails, **then** the core issues a **corrective
   retry**: it re-invokes the same stage's provider method for another attempt, incorporating the
   validation error into the corrective prompt (how the error reaches the provider is
   implementation-defined; that a further attempt occurs is the testable behavior).
3. **Given** repeated malformed output, **when** attempts reach a **configurable cap** (default
   implementation-/config-defined, e.g. 3 per call), **then** the core stops retrying that call and
   applies the stage's failure handling (TD-4) — it does **not** loop indefinitely consuming budget.
4. **Given** a FakeProvider scripted malformed-then-valid, **when** the core runs the stage, **then**
   the valid output on the later attempt is what gets validated and used, and exactly one persisted
   result reflects that valid output (retry produced no duplicate).
5. **Given** any attempt, **when** the LLM call and its validation outcome complete, **then** the
   attempt count and success/failure are observable (OTel), so the retry-ceiling alert
   ([observability.md](../architecture/observability.md) *Alerting*) has a signal.

### Out of scope

- The **shapes** being validated (that is TD-2's field list); this story owns the validate-then-retry
  *mechanism* only.

### Dependencies

Blocked by TD-1, TD-2. Precedes TD-4.

---

## TD-4 — Two failure blast radii: per-pair `analysisFailed` vs. whole-proposal `failed`

**As an** operator, **I** get a shortlist failure surfaced far more loudly than a detail failure,
**so that** the blast radius of each is honest: a detail failure loses one resource pair, a shortlist
failure loses the whole spec pair.

### Acceptance criteria

1. **Given** a **stage-2 detail** call that exhausts its retry cap for one shortlisted resource pair,
   **when** the run continues, **then** that one candidate pair is marked `analysisFailed` inside the
   proposal's persisted `shortlistResult`, and **every other** resource pair in the proposal is still
   analyzed and reviewable ([mapping-engine.md](../architecture/mapping-engine.md) *Structured
   proposal formats*, final paragraph; [data-model.md](../architecture/data-model.md)
   `MappingProposal.status`).
2. **Given** a detail failure, **when** the proposal is persisted, **then** the proposal's `status` is
   **not** `failed` — it remains a normal reviewable proposal (`pending`) whose `shortlistResult`
   flags the one failed pair.
3. **Given** a **stage-1 shortlist** call that exhausts its retry cap for a spec pair, **when** the
   run resolves, **then** there is **nothing reviewable for the entire spec pair**: the spec-pair run
   produces no detail calls and no `MappingProposalItem`s, and the `MappingProposal` it would have
   produced is persisted with `status = failed`.
4. **Given** a shortlist failure on a **peer-peer** unordered pair (two directional analyses share the
   one failed shortlist), **when** the run resolves, **then** both directions' runs fail — see the
   README open question on whether that is recorded as one or two `failed` `MappingProposal` rows.
5. **Given** either failure, **when** it occurs, **then** it is surfaced as needing attention (an
   OTel/alert signal), with the shortlist failure alerted **more urgently** than the detail failure
   ([observability.md](../architecture/observability.md) *Alerting*), and is **never** silently
   swallowed in a retry loop.

### Out of scope

- The **review-UI** rendering of `analysisFailed` pairs and `failed` proposals as "needs attention" —
  Phase 3.

### Dependencies

Blocked by TD-3. Realized jointly with PP-1 (`status`) and PP-3 (`analysisFailed` in
`shortlistResult`).

---

## TD-5 — Confidence threshold sets `reviewRequired`; ambiguity and unmapped are surfaced

**As a** reviewer, **I** have low-confidence, ambiguous, and unmapped items flagged, **so that** the
Phase-3 review UI can default-sort the riskiest correspondences to the top instead of silently
best-guessing.

### Acceptance criteria

1. **Given** a proposal item with `confidenceScore` below a **configurable threshold** (default
   implementation-/config-defined, e.g. `< 0.7`), **when** the item is prepared, **then**
   `reviewRequired = true` is set for it; an item at or above the threshold is not so flagged
   ([mapping-engine.md](../architecture/mapping-engine.md) *Confidence & ambiguity*). *(See README
   open question: `reviewRequired` is named in the concept but not listed among
   `MappingProposalItem`'s fields — persist vs. derive is the decision.)*
2. **Given** the shape returned by a provider, **when** an item has multiple plausible targets,
   **then** its `ambiguousAlternatives[]` is populated (each with its own confidence) rather than
   collapsing to a single silent best guess.
3. **Given** a source element with no found counterpart, **when** the item is prepared, **then**
   `unmapped = true` and it carries no `targetRef`/`transformSuggestion`.
4. **Given** the threshold is configuration, **when** it is changed, **then** the same item's
   `reviewRequired` flag follows the new threshold (the threshold value is not hardcoded).

### Out of scope

- The review UI's default sort order and how flagged items are rendered — Phase 3
  ([mapping-review-and-approval.md](../flows/mapping-review-and-approval.md)).

### Dependencies

Blocked by TD-2. Realized with PP-2 (the flag rides on the persisted `MappingProposalItem`).
