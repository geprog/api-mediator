# Phase 2 — Candidate spec-pair enumeration

Given a newly ingested `ApiSpec`, deciding **which spec pairs get analyzed** — before any LLM call is
made. This is the deterministic, mechanical front of the Mapping Engine: it enumerates the candidate
*spec* pairs involving the new spec, fixes each analysis's `sourceSpecId`/`targetSpecId` and its kind
(peer-peer vs. consumer-provider), groups the two directions of a peer pair under one *unordered*
spec pair (so stage 1 runs once for them), and removes `analysisExclusions` from the in-scope
resource set before stage 1 ever sees it. None of this needs an LLM, so every criterion here is
**FakeProvider-deterministic** (indeed most need no provider at all).

**Actor:** system (Mapping Engine orchestrator), triggered by `SpecIngested` (see
[phase-2-detection-trigger.md](phase-2-detection-trigger.md)).

**Concept references (whole file):** [mapping-engine.md](../architecture/mapping-engine.md)
*Candidate pair selection* and *Scoping down: operator exclusions*;
[app-registration-and-mapping-detection.md](../flows/app-registration-and-mapping-detection.md)
step 4; [data-model.md](../architecture/data-model.md) `ApiSpec` (`role`, `status`,
`analysisExclusions`), `MappingProposal` (`sourceSpecId`/`targetSpecId`);
[overview.md](../architecture/overview.md) *Scale assumption*; [glossary.md](../glossary.md)
`PROVIDER spec`, `CONSUMER spec`, `Resource group`, `analysisExclusions`, `MappingProposal`.
Scenario fixtures: [scenario-1](../../scenarios/scenario-1-small-overlap/ground-truth.yaml),
[scenario-3](../../scenarios/scenario-3-consumer-provider/ground-truth.yaml),
[scenario-4](../../scenarios/scenario-4-mixed/ground-truth.yaml).

> **Enumeration is a pure function of registry state.** Its inputs are the new spec plus the set of
> other apps' active specs; its output is a set of candidate *analyses*. It performs no LLM call and
> persists no `MappingProposal` — that is stage 1/2 (see
> [phase-2-two-stage-detection.md](phase-2-two-stage-detection.md)) and persistence (see
> [phase-2-proposal-persistence.md](phase-2-proposal-persistence.md)).

---

## CE-1 — Enumerate sync candidates for a newly ingested `PROVIDER` spec (both directions)

**As the** Mapping Engine, **I** enumerate every peer-peer candidate for a newly ingested `PROVIDER`
spec, **so that** each provider↔provider correspondence gets analyzed in both directions as the two
independently-approvable one-way mappings a bidirectional sync needs.

### Acceptance criteria

1. **Given** a newly ingested `PROVIDER` `ApiSpec` `S` and every *other* app's active `PROVIDER`
   spec `P`, **when** enumeration runs, **then** it produces two directional candidate analyses per
   unordered pair `{S, P}` — one with `sourceSpecId = S, targetSpecId = P` and one with
   `sourceSpecId = P, targetSpecId = S` — each marked `kind = peer-peer`
   ([mapping-engine.md](../architecture/mapping-engine.md) *Candidate pair selection*, bullet 1).
2. **Given** the two directional analyses for `{S, P}`, **when** they are grouped, **then** they are
   associated with a **single unordered spec pair** so stage 1 (shortlist) runs once and is shared by
   both — no separate "bidirectional" analysis unit exists
   ([mapping-engine.md](../architecture/mapping-engine.md) *Stage 1*).
3. **Given** a landscape with only the new spec's app and no other active `PROVIDER` spec, **when**
   enumeration runs, **then** it produces **zero** peer-peer candidates.
4. **Given** scenario-1 (Gitea `PROVIDER` already active, Vikunja `PROVIDER` newly ingested), **when**
   enumeration runs, **then** it yields exactly the two directional analyses Gitea→Vikunja and
   Vikunja→Gitea under one unordered `{Gitea, Vikunja}` pair
   ([scenario-1 ground-truth](../../scenarios/scenario-1-small-overlap/ground-truth.yaml)).

### Out of scope

- Running the shortlist/detail calls, and persisting the two `MappingProposal`s — TD/PP stories.
- Instantiating `SyncRule`s from the eventual `ApprovedMapping`s — Phase 4
  ([sync-engine.md](../architecture/sync-engine.md)).

### Dependencies

Blocked by Phase-1 SI-2 (active `ApiSpec`s to enumerate over). Precedes TD-1.

---

## CE-2 — Enumerate adapter candidates involving a newly ingested spec (consumer as source)

**As the** Mapping Engine, **I** enumerate every consumer-provider candidate that the new spec
introduces, **always with the consumer spec as source**, **so that** the mediator can later serve the
consumer's wished-for API from real backends without ever calling the consumer itself.

### Acceptance criteria

1. **Given** a newly ingested `CONSUMER` `ApiSpec` `C` and every *other* app's active `PROVIDER` spec
   `P`, **when** enumeration runs, **then** it produces **one** candidate analysis per pair with
   `sourceSpecId = C, targetSpecId = P` and `kind = consumer-provider` — never a reverse-direction
   analysis ([mapping-engine.md](../architecture/mapping-engine.md) *Candidate pair selection*,
   bullet 2; [flow](../flows/app-registration-and-mapping-detection.md) step 4).
2. **Given** a newly ingested `PROVIDER` `ApiSpec` `P` and every *other* app's active `CONSUMER` spec
   `C`, **when** enumeration runs, **then** it produces one candidate analysis per pair with
   `sourceSpecId = C, targetSpecId = P` and `kind = consumer-provider` — the newly ingested provider
   becomes a backend candidate for consumers already in the landscape, still consumer-as-source
   ([flow](../flows/app-registration-and-mapping-detection.md) step 4, bullets 2-3).
3. **Given** a consumer-provider candidate, **when** enumerated, **then** its unordered spec pair
   carries exactly that one directional analysis (there is no second direction to share a shortlist
   with).
4. **Given** scenario-3 (`todo-widget` `CONSUMER` spec, Vikunja `PROVIDER` active), **when**
   enumeration runs, **then** it yields exactly one analysis `todo-widget → Vikunja`,
   `kind = consumer-provider` ([scenario-3 ground-truth](../../scenarios/scenario-3-consumer-provider/ground-truth.yaml)).

### Out of scope

- Instantiating `AdapterEndpoint`/`AdapterBinding` from the eventual `ApprovedMapping` — Phase 5
  ([adapter-engine.md](../architecture/adapter-engine.md)).
- Request/response phase and parameter handling inside the single analysis — TD-2.

### Dependencies

Blocked by Phase-1 SI-2. Precedes TD-1.

---

## CE-3 — Enumeration guardrails: same-app exclusion, active-only, new-spec-scoped

**As the** Mapping Engine, **I** never analyze a spec against itself, its own app's other-role spec,
or an inactive spec, and I never re-analyze pairs that do not involve the new spec, **so that**
detection stays correct and someone else's registration never silently re-runs existing pairs.

### Acceptance criteria

1. **Given** an app that carries **both** a `PROVIDER` and a `CONSUMER` spec, **when** enumeration
   runs for either of them, **then** the two specs of that *same app* are **never** paired with each
   other ([mapping-engine.md](../architecture/mapping-engine.md) *Candidate pair selection*, bullet
   2: "An app's `CONSUMER` spec is never paired with the same app's own `PROVIDER` spec").
2. **Given** any candidate analysis, **when** enumerated, **then** its `sourceSpecId` and
   `targetSpecId` are never equal (no spec vs. itself).
3. **Given** other apps' specs in `status` `superseded` or `archived`, **when** enumeration runs,
   **then** those specs are **excluded** — only specs with `status = active` are eligible counterparts
   ([data-model.md](../architecture/data-model.md) `ApiSpec.status`).
4. **Given** two apps whose specs were already active before the new spec was ingested, **when**
   enumeration runs for the new spec, **then** the pre-existing pair between those two other apps is
   **not** enumerated — only pairs **involving the newly ingested spec** are produced
   ([flow](../flows/app-registration-and-mapping-detection.md) step 4: "existing pairs are never
   re-analyzed by someone else's registration").
5. **Given** a `PROVIDER`↔`PROVIDER` candidate, **when** enumerated, **then** it is never emitted as
   `kind = consumer-provider`, and a `CONSUMER`↔`PROVIDER` candidate is never emitted as
   `kind = peer-peer` (kind follows the role pairing).

### Out of scope

- Re-analysis on a *new version* of an existing spec (`SpecDiff`-scoped incremental analysis) —
  Phase 6 ([extensibility.md](../architecture/extensibility.md)). Phase 2 enumerates for a version-1
  ingestion of a spec.

### Dependencies

Blocked by CE-1, CE-2 (shares their enumeration logic).

---

## CE-4 — Apply `analysisExclusions` to the in-scope resource set before stage 1

**As an** operator, **I** have my declared `analysisExclusions` remove resource groups from **both
sides** of a spec pair before the shortlist ever sees them, **so that** a large spec the landscape
only partly uses does not flood detection with summary-prompt bulk, wasted detail calls, and review
noise.

### Acceptance criteria

1. **Given** a candidate analysis over specs `S` and `P`, **when** the in-scope resource set is
   computed, **then** every resource group listed in `S.analysisExclusions` and every group listed in
   `P.analysisExclusions` is removed — **on whichever side it appears** — before stage 1
   ([mapping-engine.md](../architecture/mapping-engine.md) *Scoping down*).
2. **Given** an excluded resource group, **when** detection runs, **then** it appears in **no**
   shortlist prompt and receives **no** detail call for that spec pair.
3. **Given** an `ApiSpec` with empty `analysisExclusions` (the default), **when** the in-scope set is
   computed, **then** every resource group of that spec is in scope.
4. **Given** an exclusion `resourceRef` that no longer resolves to a resource group in the spec's
   current IR, **when** the in-scope set is computed, **then** that stale ref is simply ignored (it
   excludes nothing), consistent with the "a ref that no longer resolves is dropped" rule
   ([data-model.md](../architecture/data-model.md) `ApiSpec.analysisExclusions`).
5. **Given** an excluded resource group, **when** enumeration and stage 1 complete, **then** it is
   **not** listed among the "no counterpart shortlisted" resources in `shortlistResult` — excluded is
   distinct from no-counterpart (excluded resources carry no escape-hatch action; see PP-3 and the
   Phase-3 review UI).

### Out of scope

- **Editing** `analysisExclusions` (persistence of the list) — Phase-1 SI-4.
- **Re-inclusion** triggering a scoped incremental analysis when an exclusion is removed — Phase 6
  ([mapping-engine.md](../architecture/mapping-engine.md) *Scoping down*, *Re-inclusion*). Phase 2
  reads the current exclusion list for a full analysis; it does not react to exclusion edits.

### Dependencies

Blocked by Phase-1 SI-4 (exclusion list) and SI-1 (resource groups). Feeds TD-1 (the in-scope
resource set is the shortlist's input) and PP-3 (excluded ≠ no-counterpart).
