# Requirements backlog

This directory holds the **requirements artifacts** for the API Mediator: user stories with
numbered, individually-testable Given/When/Then acceptance criteria. They are **phase-scoped
vertical slices of the approved concept** in [`docs/architecture/`](../architecture/),
[`docs/flows/`](../flows/), and [`docs/glossary.md`](../glossary.md) — never a source of new
product behavior. Where these files and the architecture docs disagree, the architecture docs
win, and the disagreement is a finding for a human, not a silent reinterpretation here.

Every entity/field name used below is taken verbatim from [`docs/glossary.md`](../glossary.md)
and [`docs/architecture/data-model.md`](../architecture/data-model.md) (`RegisteredApp`,
`ApiSpec`, `ResourceBinding`, `Credential`, `SpecIngested`, …). Acceptance criteria are the
oracle for unit and e2e tests: if a criterion can't be turned into a test, it isn't a criterion.

## Roles

The concept defines three human roles. Phase 1 involves only the first; **Phase 2 is
system-driven** — the Mapping Engine reacts to `SpecIngested`, with the operator's only inputs being
the active provider (configuration) and `analysisExclusions` (captured in Phase 1):

- **operator** (landscape operator) — may mutate: register apps, store credentials, confirm/correct
  `ResourceBinding`s, set `analysisExclusions`, select the active `LLMMappingProvider`.
- **viewer** — read-only: app list, spec IR. (Full auth wiring lands in Phase 3; Phase 1 stories
  state the read/mutate split so it is testable once auth exists.)
- **mapping reviewer** / **consumer-app developer** — Phase 3 / Phase 5. Phase 2 *produces* what the
  mapping reviewer will act on (`MappingProposal`s), but does not itself exercise that role — no
  review/approval happens until Phase 3.

## Phase 1 — Registration + Spec ingestion + IR

The first vertical slice: **register a `RegisteredApp` → store its `Credential` write-only →
ingest each `ApiSpec` (parse to IR, derive `ResourceBinding`s) → operator confirms bindings →
emit `SpecIngested`.** It produces no executable artifact — the only human-in-the-loop step is
`ResourceBinding` confirmation (the derive-then-correct pattern that later gates execution).

| File | Stories | Realizes (concept component) |
|---|---|---|
| [phase-1-app-registration.md](phase-1-app-registration.md) | AR-1 … AR-3 | API/UI Layer (registration) |
| [phase-1-credential-storage.md](phase-1-credential-storage.md) | CR-1 … CR-2 | Credential Store (storage only) |
| [phase-1-spec-ingestion-ir.md](phase-1-spec-ingestion-ir.md) | SI-1 … SI-4 | Spec Registry + IR |
| [phase-1-resource-bindings.md](phase-1-resource-bindings.md) | RB-1 … RB-3 | Spec Registry (`ResourceBinding` derive/confirm) |
| [phase-1-event-bus.md](phase-1-event-bus.md) | EB-1 … EB-2 | Event Bus (`SpecIngested`) |

14 stories total.

## Suggested implementation order (blocking edges)

Layered per the plan (types → persistence → logic → HTTP → UI); the vertical dependencies are:

1. **CR-1** (envelope `store`) and **SI-1/SI-2** (IR builder + `ApiSpec` v1) and **RB-1** (binding
   derivation) — independent of each other, all needed before the registration orchestration.
2. **EB-1** (`SpecIngested` emit) — depends on SI-2 (spec must be stored first).
3. **AR-1** (registration orchestration) — depends on CR-1, SI-1/SI-2, RB-1, EB-1.
4. **RB-2** (confirm/correct) — depends on RB-1.
5. **SI-4** (`analysisExclusions`) — depends on SI-1 (needs resource groups to exclude).
6. **AR-2 / AR-3, SI-3, RB-3** (read APIs + UI: app list, IR viewer, binding panel, registration
   form) — depend on their backing backend stories above.
7. **CR-2** and **EB-2** are cross-cutting invariants verified against the stories that carry the
   payloads (registration, spec storage, event emission).

## Phase boundaries (explicitly out of scope in Phase 1)

Named here once so individual stories can reference "the owning later phase":

- **Mapping detection / LLM / `MappingProposal`** — Phase 2 ([mapping-engine.md](../architecture/mapping-engine.md)).
  Phase 1 emits `SpecIngested`; nothing consumes it into a proposal yet.
- **Mapping review / approval / `ApprovedMapping`** — Phase 3.
- **Sync (`SyncRule`, polling, `RecordLink`, `SyncFieldState`)** — Phase 4. This is where
  confirmed `ResourceBinding` refs are first *used*; Phase 1 only captures their confirmation state.
- **`CredentialStore.withCredential` (decrypt-for-use), OAuth2 refresh, outbound per-app
  concurrency/rate ceilings** — Phase 4. Phase 1 credential handling is write-only `store` only.
- **Adapter Engine, `adapterToken` issuance/hashing** — Phase 5.
- **`SpecDiff`, additional spec versions, re-pinning, successor adoption, `analysisExclusions`
  re-inclusion incremental analysis, disable/deregister cascade** — Phase 6
  ([extensibility.md](../architecture/extensibility.md), sections *Spec update lifecycle* and
  *App lifecycle*). **Phase 1 ingests `ApiSpec` version 1 only.**

## Open questions for a human (concept is silent or underspecified for Phase 1)

Each has a recommended default the stories adopt; confirm or override.

1. **Is `baseUrl` required when a `PROVIDER` spec is submitted?** The concept says `baseUrl` is
   optional and "absent for apps that only registered a `CONSUMER` spec" ([data-model.md](../architecture/data-model.md)
   `RegisteredApp`), but never states a hard rule for `PROVIDER` apps. *Recommended:* require
   `baseUrl` when the registration includes ≥1 `PROVIDER` spec (the mediator must be able to reach
   a provider to poll/call it); allow it to be absent only for consumer-only registrations. (AR-1)
2. **Are `capabilities` mandatory at registration, and what are the defaults?** The concept says
   they are "declared at registration" but gives no defaults. *Recommended:* accept them as
   provided; when omitted, default conservatively to `supportsPolling=false`,
   `supportsDeltaQuery=false`, `supportsChangeTimestamps=false`, and a config-level
   `defaultPollInterval` (implementation-defined, e.g. 300s). (AR-1)
3. **Is a `Credential` mandatory at registration?** Concept is silent. *Recommended:* optional — a
   public/no-auth provider or a consumer-only app may register with no `Credential`; outbound auth
   is a Phase 4 concern. (AR-1, CR-1)
4. **Is registration atomic across multiple specs?** Concept is silent on partial failure.
   *Recommended:* atomic — validate/parse every submitted spec before committing; any parse failure
   fails the whole `POST /apps` with no `RegisteredApp`, `Credential`, or `ApiSpec` persisted and
   no `SpecIngested` emitted. (AR-1)
5. **What does `contentHash` hash, and over what normalization?** Concept only names the field.
   *Recommended:* a deterministic hash over the canonicalized raw OpenAPI document as submitted, so
   an identical re-submission is detectable; exact algorithm/canonicalization is
   implementation-defined. (SI-2)
6. **What is the stable form of a `resourceRef` / resource-group id?** The IR groups "by `tags` or
   path-prefix heuristic"; `ResourceBinding.resourceRef` and `analysisExclusions[]` need a stable
   identifier for it. *Recommended:* a human-readable, document-stable ref (e.g. the tag name, or a
   normalized path-prefix when tag-less); exact format implementation-defined but must be stable
   across re-parses of the same document. (SI-1, RB-1, SI-4)
7. **Pagination for `GET /apps`?** Concept is silent; the landscape is ~15-20 apps
   ([overview.md](../architecture/overview.md) *Scale assumption*). *Recommended:* no pagination in
   Phase 1 — return all apps. (AR-2)
8. **Does `GET /apps/:id/specs` return `rawDocument`?** *Recommended:* return `ApiSpec` metadata
   (id, role, version, contentHash, status, createdAt) only; the IR is a separate endpoint
   (`GET /specs/:id/ir`), and the raw document is not exposed by default. (AR-2, SI-3)
9. **Preview-parse before commit.** The registration flow ([app-registration-and-mapping-detection.md](../flows/app-registration-and-mapping-detection.md)
   step 1) says the UI "preview-parses an uploaded document and offers its resource groups for
   exclusion" — but no such stateless endpoint is named in the concept. *Recommended:* add a
   stateless `POST /specs/preview` that parses to IR and returns resource groups **without**
   creating a `RegisteredApp`/`ApiSpec`; flagged as a minor concept gap, not a new product feature.
   (AR-3, SI-4)
10. **Per-app outbound concurrency/rate ceilings at registration.** [overview.md](../architecture/overview.md)
    *Outbound load discipline* calls these "operational configuration on the app registration", but
    the Phase 1 `RegisteredApp` model does not include them. *Recommended:* defer capture to
    Phase 4; keep the registration schema forward-compatible. (AR-1)

---

## Phase 2 — Mapping detection (the "core bet")

The second vertical slice, and the product's central bet: **`SpecIngested` → enumerate candidate
spec pairs → stage-1 shortlist → stage-2 detail → validate → persist `MappingProposal`s for
review.** It stands up the LLM-assisted Mapping Engine end to end for a *newly ingested* spec, but
executes nothing and approves nothing — every output is a **reviewable proposal** whose human
approval is Phase 3. The two-stage design (recall-biased shortlist per spec pair, detail only on
shortlisted pairs) is what keeps a full landscape pass near ~1,000 LLM calls instead of ~38,000
(see [overview.md](../architecture/overview.md) *Scale assumption*).

Mechanical behaviors (enumeration rules, output shapes, validation-before-persist, the two failure
blast radii, set-difference enrichment) are specified so a **FakeProvider**-backed test asserts them
deterministically; **accuracy** (does a real model find the right pairs?) is separated out into the
eval harness, which **scores** produced proposals against `scenarios/*/ground-truth.yaml` rather than
asserting pass/fail.

| File | Stories | Realizes (concept component) |
|---|---|---|
| [phase-2-candidate-enumeration.md](phase-2-candidate-enumeration.md) | CE-1 … CE-4 | Mapping Engine (*Candidate pair selection* + `analysisExclusions` scoping) |
| [phase-2-llm-provider.md](phase-2-llm-provider.md) | LP-1 … LP-4 | `LLMMappingProvider` (Ollama + Fake) + `generatedBy` |
| [phase-2-two-stage-detection.md](phase-2-two-stage-detection.md) | TD-1 … TD-5 | Mapping Engine (shortlist → detail, validation/retry, blast radii, confidence) |
| [phase-2-proposal-persistence.md](phase-2-proposal-persistence.md) | PP-1 … PP-3 | `MappingProposal` / `MappingProposalItem` / `shortlistResult` |
| [phase-2-detection-trigger.md](phase-2-detection-trigger.md) | DT-1 … DT-2 | Event Bus consumer (`SpecIngested` → detection) |
| [phase-2-eval-harness.md](phase-2-eval-harness.md) | EH-1 … EH-3 | Detection quality scoring vs. ground truth |

21 stories total.

### Suggested implementation order (Phase 2, blocking edges)

1. **LP-1** (the `LLMMappingProvider` interface + the two context types) and **LP-3** (FakeProvider)
   — foundational; every mechanical test below runs on the fake.
2. **CE-1 … CE-4** (candidate enumeration + `analysisExclusions` scoping) — pure over registry state,
   needs no provider; produces the in-scope resource sets stage 1 consumes.
3. **TD-1** (stage-1 shortlist) → **TD-2** (stage-2 detail) → **TD-3** (validate + capped retry) →
   **TD-4** (two blast radii) → **TD-5** (confidence → `reviewRequired`).
4. **PP-1 / PP-2 / PP-3** (persist proposal, items, mechanically-enriched `shortlistResult`) — realize
   TD-4's `failed`/`analysisFailed` and TD-5's flag on persisted rows; **LP-4** (`generatedBy`) lands
   with PP-1.
5. **DT-1** (consume `SpecIngested`, auto-run detection) → **DT-2** (offload off the dispatcher
   transaction, idempotent, reconcilable) — depends on Phase-1 EB-1/EB-2 and all of CE/TD/PP.
6. **LP-2** (real Ollama provider) and **EH-1 … EH-3** (eval harness) — LP-2 backs the harness; the
   harness scores accuracy last, once the mechanical path is proven on the fake.

### Phase boundary map (Phase 2 → owning later phase)

Named once so each story can point at "the owning later phase":

| Deferred concern | Owning phase |
|---|---|
| Review/approval of proposal items; turning accepted items into `ApprovedMapping` / `FieldMapping` / `OperationMapping` / `ParameterMapping` | **Phase 3** ([mapping-review-and-approval.md](../flows/mapping-review-and-approval.md)) |
| The manual "analyze this resource pair anyway" **escape-hatch UI action** (the persisted `shortlistResult` that *enables* it is Phase 2 — PP-3) | **Phase 3** |
| Confirming `identityCandidate` → `FieldMapping.isIdentityKey`, `action` → `OperationMapping.action`, `targetLookupParamRef` | **Phase 3** |
| Instantiating `SyncRule`s; sync polling/backfill/`RecordLink`/`SyncFieldState` | **Phase 4** ([sync-engine.md](../architecture/sync-engine.md)) |
| Instantiating `AdapterEndpoint`/`AdapterBinding`; adapter serving/composition | **Phase 5** ([adapter-engine.md](../architecture/adapter-engine.md)) |
| `SpecDiff`, incremental delta re-analysis on spec change, re-mapping, `priorFeedback`, `analysisExclusions` re-inclusion trigger, re-pinning, successor adoption | **Phase 6** ([extensibility.md](../architecture/extensibility.md); [mapping-engine.md](../architecture/mapping-engine.md) *Re-mapping on spec change*, *Scoping down*) |

Phase 2 does a **full analysis of a newly-ingested spec's pairs**, never incremental delta analysis.

### Open questions for a human (Phase 2 — concept silent or underspecified)

Each has a recommended default the stories adopt; confirm or override.

1. **Confidence threshold for `reviewRequired`.** The concept gives "e.g. `< 0.7`"
   ([mapping-engine.md](../architecture/mapping-engine.md) *Confidence & ambiguity*) but fixes no
   value. *Recommended:* default `0.7`, config-defined. (TD-5)
2. **Corrective-retry cap.** Concept says "e.g. 3 attempts per call." *Recommended:* default `3` per
   call, config-defined. (TD-3)
3. **Does detection auto-run on every `SpecIngested`?** **Adopted (not open):** yes — the flow states
   a mapping orchestrator picks up `SpecIngested` and enumerates
   ([app-registration-and-mapping-detection.md](../flows/app-registration-and-mapping-detection.md)
   step 4). Flagged only to confirm there is **no** operator "run detection" trigger in Phase 2; the
   sole operator-initiated detail run (the escape hatch) is Phase 3. (DT-1)
4. **How does the eval harness invoke the engine — directly or via the bus?** Concept is silent.
   *Recommended:* invoke the **detection engine directly** over the fixture specs, bypassing the
   Event Bus/`SpecIngested` trigger, so a score is a function of inputs + provider only and is
   independent of trigger wiring. (EH-1)
5. **`reviewRequired` — persisted field or derived?** *Concept gap:* `reviewRequired` is named in
   [glossary.md](../glossary.md) and [mapping-engine.md](../architecture/mapping-engine.md), but is
   **not** among `MappingProposalItem`'s listed fields in
   [data-model.md](../architecture/data-model.md). *Recommended:* persist it on `MappingProposalItem`
   (or derive deterministically from `confidenceScore` < threshold at read time) — either is testable;
   a human should confirm which, and whether `data-model.md` should list the field. (TD-5)
6. **Transform vocabulary vs. ground-truth `direct`.** *Concept gap:* `MappingSuggestionSet.transform`
   and `FieldMapping.transform` enumerate `rename` | `coerce` | `aggregate` | `expression` — with **no
   identity/none/`direct` member** — yet a same-name, value-preserving field pair (`title`→`title`,
   `email`→`email`) is extremely common, and the scenario ground-truths use `direct` for exactly that
   (and their header even claims to "mirror data-model.md `FieldMapping`", which it does not).
   *Recommended:* represent a value-preserving same-name pair as `rename` (name-change-optional,
   value-preserving) and have the eval harness score ground-truth `direct` against that bucket; a
   human should decide whether to add an explicit identity kind to the concept or clarify that
   `rename` covers the no-rename case. (EH-3)
7. **Peer-peer shortlist failure: one `failed` proposal row or two?** A peer pair's two directional
   proposals share one shortlist; if that shortlist fails, "the whole spec-pair run" fails
   ([mapping-engine.md](../architecture/mapping-engine.md)), but the concept does not say whether that
   is recorded as one or two `failed` `MappingProposal` rows. *Recommended:* persist **two** `failed`
   proposals (one per direction) so the review UI has a per-direction referent; confirm. (TD-4, PP-1)
8. **Reconciliation's definition of "analyzed."** The sweep re-triggers "an ingested spec with no
   analysis run" ([overview.md](../architecture/overview.md)). *Recommended:* a persisted
   `MappingProposal` — **including a `failed` one** — counts as "analyzed," so a recorded shortlist
   failure is not re-looped indefinitely; a spec with *zero* proposals for a pair it should have is
   what the sweep re-triggers. (DT-2)

---

## Phase 3 — Review / Approval + operator auth + review UI

The third vertical slice, and the concept's core safety promise made testable: **a `MappingProposal`
→ per-item accept/edit/reject → partial approval → one `ApprovedMapping` → `MappingApproved` →
disabled downstream artifacts.** It stands up the **Approval Service** (turning proposals into
`ApprovedMapping`s under partial approval, edit-path validation, and the human-confirmed identity
key), wires the **operator/viewer auth** the earlier phases only described, and ships the **review
UI** — all while keeping the hard invariant that **nothing executes**: approval *instantiates*
`SyncRule`(s) `disabled` and `AdapterBinding`(s) `proposed`, but enabling, backfilling, and serving
are Phase 4/5.

The identity-key confirmation is the phase's sharpest invariant: a wrong identity key silently merges
unrelated records — the worst failure the Sync Engine has — so it is **never auto-confirmed**,
restricted to a **value-preserving (`rename`) pairing**, and **shared-locked** across a bidirectional
pair's two directions. Every approval invariant is asserted deterministically over a **replayed
proposal fixture**; the capstone e2e proves nothing executed before approval.

| File | Stories | Realizes (concept component) |
|---|---|---|
| [phase-3-approved-mapping-domain.md](phase-3-approved-mapping-domain.md) | AM-1 … AM-6 | `@mediator/domain` (approved-side entities + `MappingApproved` + disabled-artifact shapes) |
| [phase-3-approval-service.md](phase-3-approval-service.md) | AS-1 … AS-6 | Mapping Review/Approval Service (partial approval, edit validation, identity key, emission) |
| [phase-3-artifact-instantiation.md](phase-3-artifact-instantiation.md) | AI-1 … AI-3 | Event Bus consumer (`MappingApproved` → disabled `SyncRule`/`AdapterBinding`/`GraphEdge`) |
| [phase-3-operator-auth.md](phase-3-operator-auth.md) | OA-1 … OA-3 | Operator authentication & authorization (`operator`/`viewer`, local accounts, attribution) |
| [phase-3-approval-api.md](phase-3-approval-api.md) | RA-1 … RA-5 | API Layer (review/approval endpoints + escape hatch) |
| [phase-3-review-ui.md](phase-3-review-ui.md) | RU-1 … RU-5 | UI Layer (confidence-sorted review, identity-key panel, escape hatch) |

28 stories total.

### Suggested implementation order (Phase 3, blocking edges)

Layered per the plan (types → persistence → logic → HTTP → UI):

1. **AM-1 … AM-6** (domain types: approved-side enums, `ApprovedMapping` + `FieldMapping`/
   `OperationMapping`/`ParameterMapping`, `MappingApproved`, disabled-artifact shapes) — foundational;
   reuse the Phase-2 enums unchanged.
2. **OA-1 → OA-2 → OA-3** (auth: authenticated identity → role gating → attribution) — independent of
   the approval logic, needed before any Phase-3 HTTP route; also retro-enforces the Phase-1/2
   read/mutate split.
3. **AS-1** (per-item review states) → **AS-2** (partial-approval assembly) → **AS-3** (edit-path
   validation) → **AS-4** (`action` + `targetIdParamRef`) → **AS-5** (identity-key confirmation locks)
   → **AS-6** (counterpart link + emit `MappingApproved` + nothing-executes).
4. **AI-1 / AI-2** (instantiate disabled `SyncRule`s / `proposed` `AdapterBinding`s + `GraphEdge`) →
   **AI-3** (idempotent, in-dispatcher-tx, reconcilable) — depend on AS-6 (the event) and AM-5/AM-6.
5. **RA-1** (read, confidence-sorted) → **RA-2** (per-item decisions) → **RA-3** (identity-key confirm)
   → **RA-4** (approve) → **RA-5** (escape hatch) — thin HTTP over the Approval Service, gated by OA-2.
6. **RU-1 … RU-4** (review screen, per-item controls, escape-hatch/excluded surfacing, identity-key
   panel + partial approve) → **RU-5** (capstone e2e over a replayed proposal fixture proving nothing
   executes pre-approval).

### Phase boundary map (Phase 3 → owning later phase)

Named once so each story can point at "the owning later phase":

| Deferred concern | Owning phase |
|---|---|
| **Enabling** a `SyncRule`, its enablement gate (identity key + `pollOperationRef` + `ResourceBinding` refs), the initial backfill, polling/`RecordLink`/`SyncFieldState`, conflict handling, `deletePropagation` — Phase 3 only *instantiates disabled* rules | **Phase 4** ([sync-engine.md](../architecture/sync-engine.md)) |
| **Composing / activating / serving** an `AdapterEndpoint`: single-binding auto-activation, `composition-required`, aggregation strategy/roles/order/chaining, `postMerge*`, the Adapter Server Runtime, Auth Gateway, adapter token issuance — Phase 3 only creates the `AdapterEndpoint` + `proposed` `AdapterBinding`(s) | **Phase 5** ([adapter-engine.md](../architecture/adapter-engine.md), [adapter-endpoint-composition.md](../flows/adapter-endpoint-composition.md), [security.md](../architecture/security.md)) |
| Executing any `transform` and the `expression` sandbox; setting `FieldMapping.conflictPolicy` at review | **Phase 4/5** ([security.md](../architecture/security.md)) |
| `SpecDiff`-scoped incremental/delta proposals, re-review of `stale` mappings, `priorFeedback`, **re-pinning**, **successor adoption**, version-agnostic `counterpartMappingId` across versions, `analysisExclusions` re-inclusion re-analysis, `suspend`, disable/deregister cascade & archival | **Phase 6** ([extensibility.md](../architecture/extensibility.md); [mapping-engine.md](../architecture/mapping-engine.md) *Re-mapping on spec change*, *Scoping down*) |
| Graph **rendering** UI (Phase 3 only *upserts* the `GraphEdge` projection on approval) | **Phase 6** ([graph-overview.md](../flows/graph-overview.md)) |
| SSO/OIDC auth provider (Phase 3 ships local accounts behind the pluggable seam) | later |

Phase 3 operates on **version-1 specs only** (like Phase 1/2), so spec lineage identity reduces to the
`(app, role)` pair and no re-pinning path is exercised.

### Open questions for a human (Phase 3 — concept silent or underspecified)

Each has a recommended default the stories adopt; confirm or override.

1. **The plan's `list` action is not in the concept.** The implementation plan lists operation `action`
   as `create/read/update/delete/list`, but [data-model.md](../architecture/data-model.md)
   `OperationMapping.action` and [glossary.md](../glossary.md) `action` enumerate **only**
   `create | read | update | delete` — there is **no `list`**. *Recommended:* follow the concept
   (four values); classify a collection read as `read`. Do **not** silently coin a `list` member. A
   human should decide whether the concept should gain `list` or the plan should drop it. (AM-1, AS-4)
2. **`AdapterBinding` instantiation status: `disabled` vs. `proposed`, and single-binding
   auto-activation.** The plan says instantiate artifacts "disabled"; the flow
   ([mapping-review-and-approval.md](../flows/mapping-review-and-approval.md) step 9) says a
   single-binding `AdapterEndpoint` "activates immediately with safe defaults." These collide with the
   phased "nothing enabled/served in Phase 3" boundary. *Recommended:* instantiate `SyncRule`s
   `status = disabled` (concept-exact) and `AdapterBinding`s `status = proposed` (the concept's status
   for "attached by a mapping approval but not yet composed"); defer **all** composition, single-binding
   auto-activation, and serving to Phase 5, since there is no Adapter Server Runtime in Phase 3. This
   satisfies the plan's intent while using the concept's own vocabulary; flag for confirmation. (AI-2)
3. **Proposal `status` predicate: `partially_approved` vs. `approved` vs. `rejected`.** The flow states
   only that a subset approval yields `partially_approved`; the exact predicate for `approved`/`rejected`
   is not spelled out. *Recommended:* `partially_approved` while any item is `pending`; `approved` once
   every item is decided with ≥1 `accepted`/`edited`; `rejected` once every item is `rejected` (no
   `ApprovedMapping` then). (AS-2)
4. **One `ApprovedMapping` per directional proposal, updated in place.** The flow says approval assembles
   accepted items under "a new (or updated) `ApprovedMapping`", and `approvedBy` is "the *most recent*
   approval action." *Recommended:* incremental partial approvals update the **same** `ApprovedMapping`
   (adding child rows), not a new row per approve. (AS-2, AI-3)
5. **Escape-hatch output: attach to the existing proposal vs. a new delta proposal.** The concept says a
   reviewer can trigger a detail analysis for a missed pair, but not where the produced items land.
   *Recommended:* attach the new `MappingProposalItem`s to the existing proposal for that resource pair
   and remove the resource from the no-counterpart set. (RA-5, RU-3)
6. **Escape-hatch and edit are operator mutations, not viewer reads.** The escape hatch spends LLM budget
   and mutates the proposal; an edit changes review state. *Recommended:* gate both to `operator`. (OA-2,
   RA-2, RA-5)
7. **`GraphEdge` node identity.** [graph-overview.md](../flows/graph-overview.md) renders app nodes;
   `GraphEdge` carries `sourceNodeId`/`targetNodeId`. *Recommended:* node id = app id, so an approval
   upserts the edge for the mapping's `(sourceAppId → targetAppId)` pair; graph rendering is Phase 6.
   (AI-1, AI-2)
8. **UI copy / equal-confidence tie-breaking / no pagination.** The concept fixes the sort *criteria*
   (ascending confidence, descending ambiguity, `reviewRequired` first) but not wording, tie-breaks, or
   paging. *Recommended:* implementation-defined copy; a stable secondary sort (e.g. by `sourceRef`) for
   ties; no item pagination at Phase-3 scale (the shortlist already bounds proposal size). (RA-1, RU-1)
9. **`MappingApproved` payload breadth.** The concept names the event but not its fields. *Recommended:*
   carry `approvedMappingId` + `variant` (for routing) and re-load the rest from persisted state, mirroring
   `SpecIngested`'s identifier-only convention. (AM-5)

---

## Phase 4 — The Sync Engine (execution begins)

The largest, hardest slice, and where the concept's documented **risk register** is turned into testable
criteria: the **disabled** `SyncRule`s Phase 3 instantiated are **enabled and run**. Phase 4 stands up the
Sync Engine end to end — poll a source, correlate records into `RecordLink`s, transform, and write to the
other side — **without echo loops, without clobbering, and without ever silently merging unrelated records**.
It is the first phase that makes real outbound calls to landscape apps, so it completes the Phase-1
`CredentialStore.withCredential` decrypt-for-call seam and the shared Transformation/Outbound executors.

Everything is a **thin vertical slice**: spec ingestion → proposal → review → approval (Phases 1-3) → **one
enabled `SyncRule` polling one direction with no echo back**. Phase 4 operates on **version-1 specs only**
(no re-pinning, no `SpecDiff` — Phase 6), and instantiates/serves **no** adapter (Phase 5). The risk-register
items are specified as explicit Given/When/Then, not hand-waved.

**What already exists vs. what Phase 4 adds** (checked against `packages/domain/src` + the Phase-3 output):
`SyncRule` exists as the **minimal disabled** Phase-3 shape (`id`/`approvedMappingId`/`resourcePairRef`/
`status` — [`downstream-artifacts.ts`](../../packages/domain/src/downstream-artifacts.ts)) and Phase 4
**extends** it with execution fields (SD-1); `SyncEvent`/`AuditLog` exists
([`audit-log.ts`](../../packages/domain/src/audit-log.ts)) already owning all six `type` values but only the
`mapping-decision` columns — Phase 4 **extends** it with the per-record sync columns + the
`success/failure/skipped-*/conflict` status (SD-4); **`RecordLink` and `SyncFieldState` do not exist yet** and
Phase 4 **adds** them (SD-2/SD-3). The reconciliation sweep ([`event-bus/src/reconciliation.ts`](../../packages/event-bus/src/reconciliation.ts))
is **extended** to sync derivations (RS-*), not replaced.

| File | Stories | Realizes (concept component) |
|---|---|---|
| [phase-4-sync-domain.md](phase-4-sync-domain.md) | SD-1 … SD-4 | `@mediator/domain` (extend `SyncRule`/`SyncEvent`; add `RecordLink`/`SyncFieldState`) |
| [phase-4-transformation-executor.md](phase-4-transformation-executor.md) | TX-1 … TX-5 | Transformation Executor + `expression` sandbox |
| [phase-4-credential-decrypt.md](phase-4-credential-decrypt.md) | CD-1 … CD-3 | Credential Store (`withCredential` decrypt-for-call, OAuth2 refresh) |
| [phase-4-outbound-executor.md](phase-4-outbound-executor.md) | OC-1 … OC-5 | Outbound Call Executor + REST Protocol Client + idempotency + retry/park |
| [phase-4-scheduler-poller.md](phase-4-scheduler-poller.md) | SP-1 … SP-5 | Sync Engine (Scheduler + Poller; enqueue-then-advance) |
| [phase-4-identity-record-link.md](phase-4-identity-record-link.md) | RL-1 … RL-5 | Identity Resolution + `RecordLink` lifecycle |
| [phase-4-ordering-queue.md](phase-4-ordering-queue.md) | OQ-1 … OQ-4 | Per-`RecordLink` ordering queue (cross-direction serialization) |
| [phase-4-loop-prevention.md](phase-4-loop-prevention.md) | EP-1 … EP-4 | Loop Prevention (no echo) |
| [phase-4-conflict-detection.md](phase-4-conflict-detection.md) | CF-1 … CF-7 | Conflict Detection & resolution |
| [phase-4-backfill-enablement.md](phase-4-backfill-enablement.md) | BE-1 … BE-6 | `SyncRule` enablement gate + initial backfill |
| [phase-4-reconciliation-sweep.md](phase-4-reconciliation-sweep.md) | RS-1 … RS-2 | Reconciliation sweep (sync) |
| [phase-4-sync-api.md](phase-4-sync-api.md) | SA-1 … SA-5 | API Layer (enable/link/resolve/replay/read) |
| [phase-4-sync-ui.md](phase-4-sync-ui.md) | SU-1 … SU-6 | UI Layer (enablement/linking/resolution/replay + capstone e2e) |

61 stories total.

### Risk-register → owning criteria (the documented hard problems, each specified)

| Risk-register item | Owning criteria |
|---|---|
| PUT-clobber read-carry | CF-5 (esp. criterion 3-4) |
| Unobserved-target silent overwrite + `targetDriftCheck` | CF-6 |
| Deletes never auto-resolve against drift | CF-7 (esp. criterion 3, 6) |
| Ambiguous identity match → manual only | RL-4 (esp. criterion 1, 5) |
| Backfill enable-gating + deliberately-early cursor seeding | BE-1/BE-3, BE-6 (esp. criterion 4-5) |
| Cross-direction ordering race (key by `RecordLink`, pre-link identity keying, continuation handoff) | OQ-2, OQ-3, OQ-4 |
| Enqueue-then-advance crash window | SP-5 |
| Idempotency key includes prior reconciled state | OC-2 (esp. criterion 1-2) |
| Target-wins = withhold + baselines untouched | CF-4 (esp. criterion 2, 6) |
| Reconciliation sweep makes "bus loss degrades timeliness, never correctness" true | RS-1, RS-2 |
| No echo (loop prevention hard invariant) | EP-1 … EP-4 |

### Suggested implementation order (Phase 4, blocking edges)

Layered per the plan (types → persistence → logic → HTTP → UI):

1. **SD-1 … SD-4** (domain types: extend `SyncRule`/`SyncEvent`, add `RecordLink`/`SyncFieldState`) —
   foundational; every slice below imports them.
2. **CD-1 … CD-3** (`withCredential` decrypt-for-call + OAuth2 refresh) and **TX-1 … TX-5** (Transformation
   Executor + sandbox) — **parallelizable**: CD depends only on the Phase-1 store, TX only on the Phase-3
   `FieldMapping` shape; **OQ-1** (queue mechanics) can also start here (needs only SD-2).
3. **OC-1 … OC-5** (Outbound Call Executor + idempotency + retry/park) — depends on CD, TX, SD.
4. The **pipeline core**, in dependency order: **RL-1 … RL-5** (identity/`RecordLink`) → **OQ-2 … OQ-4**
   (keying + continuation handoff, once RL exists) → **EP-1 … EP-4** (loop prevention) → **SP-1 … SP-5**
   (scheduler/poller) → **CF-1 … CF-7** (conflict detection). RL/EP and SP can partly overlap once OC lands.
5. **BE-1 … BE-6** (enablement gate + backfill + early seeding) — depends on RL, OC, SP; **RS-1 … RS-2**
   (reconciliation) follows BE + SP.
6. **SA-1 … SA-5** (HTTP: enable/link/resolve/replay/read) — thin over the engine services, gated by Phase-3
   OA-2.
7. **SU-1 … SU-5** (enablement/linking/resolution/replay/binding-blocker screens) → **SU-6** (capstone e2e:
   a real scenario-1 sync round with no echo back, plus an identity-less pair blocked from enabling), driven
   by the deterministic poll-trigger hook (SP-5).

**What can parallelize:** TX ∥ CD ∥ OQ-1 (step 2); within the pipeline, the invariant unit-test suites
(dedup/no-echo, enqueue-then-advance, ambiguous→manual, target-wins-withhold, PUT read-carry, cross-direction
ordering, deletes, idempotency) attach to their owning stories and can be written alongside them; the UI
stories (SU-1..SU-5) parallelize once their backing SA-* endpoint lands.

### Phase boundary map (Phase 4 → owning later phase)

| Deferred concern | Owning phase |
|---|---|
| The **Adapter/Gateway Engine** and all serving: request routing, resolution planning, aggregation strategies, `postMerge*`, Adapter Server Runtime, Auth Gateway, adapter-token validation, `mediator-transform-error` response validation | **Phase 5** ([adapter-engine.md](../architecture/adapter-engine.md), [security.md](../architecture/security.md)) — Phase 4 defines the shared Transformation/Outbound executors + the transform-error signal the adapter reuses, but runs **no** adapter |
| `SpecDiff`, additional spec versions, **re-pinning** `pollOperationRef`/`sourceSpecId`, `stale`/`suspended` transitions, successor adoption re-pointing rules, `analysisExclusions` re-inclusion, disable/deregister cascade + `archived` links/field-state | **Phase 6** ([extensibility.md](../architecture/extensibility.md)) — Phase 4 uses **version-1 specs only** and honors the `stale`/`suspended` *pause gate* (SP-1) without owning the transitions |
| Graph **rendering** and the graph/observability/lifecycle **polish** (Grafana dashboards are provisioned; Phase 4 emits the metrics they read) | **Phase 6** ([graph-overview.md](../flows/graph-overview.md), [observability.md](../architecture/observability.md)) |
| High availability / active-passive standby | later ([overview.md](../architecture/overview.md) *Deployment model*) |

### Open questions for a human (Phase 4 — concept silent, underspecified, or thinner than the plan)

Each has a recommended default the stories adopt; confirm or override.

1. **`transformConfig` per-kind schema.** *Concept gap:* [data-model.md](../architecture/data-model.md)
   names `FieldMapping.transformConfig` and says multi-input transforms "declare their additional input paths"
   there, but specifies no per-kind shape. *Recommended:* define a structured, discriminated
   `transformConfig` per `TransformKind` (coerce: conversion spec; aggregate: additional input paths + combine
   rule; expression: the expression text + additional input paths); implementation-defined internally, but a
   human should confirm the shape is a Phase-4 modeling choice, not new product behavior. (TX-1..TX-3)
2. **Reconciliation-sweep sync derivations are thinner in the concept than the plan implies.** *Concept
   gap / flag:* the sweep's named examples ([overview.md](../architecture/overview.md) *Components*) are
   detection and instantiation; for the **polling loop itself** the concept leans on cursor/snapshot
   self-healing ([overview.md](../architecture/overview.md) *Deployment model*), not the sweep. *Recommended:*
   the sweep's sync role is (a) re-derive a lost enablement reaction, (b) re-trigger a crashed/stuck backfill,
   (c) re-schedule an enabled+backfilled rule that isn't polling (RS-1); polling *within* a live rule
   self-heals via cursors independently. Confirm this is the intended derivation set. (RS-1, RS-2)
3. **The deterministic poll-trigger hook is a test seam, not concept behavior.** *Flag:* the concept has the
   Scheduler wake rules on wall-clock intervals; a synchronous single-cycle trigger for e2e is a testing
   affordance the plan requires. *Recommended:* ship it as an internal/test-only entry point (not a public
   operator API), so e2e is deterministic without changing the product's scheduling model. (SP-5, SU-6)
4. **LWW epsilon and idempotency lookback window are unset.** The concept gives "e.g. a few seconds" for the
   epsilon and "e.g. the last N events or a configured retention period" for the lookback. *Recommended:*
   both **config-defined**, with conservative defaults; never unbounded lookback. (CF-2, OC-2)
5. **Per-app concurrency/rate ceilings: where captured.** [overview.md](../architecture/overview.md)
   *Outbound load discipline* calls them "operational configuration on the app registration," but the Phase-1
   `RegisteredApp` model deferred them (Phase-1 README open question 10). *Recommended:* capture them on the
   `RegisteredApp` now (a Phase-4 additive field), config-level defaults where omitted. (OC-3)
6. **Setting `FieldMapping.conflictPolicy = manual-resolve`: at review or as rule config?** Phase 3 (AM-3)
   left it absent and called setting it "a Phase-4 concern." *Concept gap:* the concept does not fix *when* it
   is set. *Recommended:* let the operator set it as a rule-configuration action (SA-1) since it governs
   execution, not correspondence; confirm whether it should instead be a review-time control. (CF-3, SA-1)
7. **Re-enabling a disabled rule does not re-run backfill.** Concept is silent on disable→re-enable.
   *Recommended:* disabling retains `cursor`/snapshot/links/field-state; re-enabling resumes polling without a
   fresh backfill (backfill is the *initial* reconciliation, run once). (SA-1)
8. **No glossary term for the per-record ordering queue or the "recently-written" cache.** *Flag (not a coin):*
   [sync-engine.md](../architecture/sync-engine.md) describes both in prose (*Ordering and consistency*, *Loop
   prevention*) but [glossary.md](../glossary.md) has no dedicated entry. The stories use **descriptive**
   naming ("per-`RecordLink` ordering queue", "recently-written cache") rather than coining a glossary entity;
   a human should decide whether either deserves a glossary line. (OQ-*, EP-2)
9. **`OperationMapping.action` has no `list` value** (carried over from the Phase-3 open question). Sync's
   change-type → operation selection (SP-3, OC-1) classifies a collection read as `read`; it never needs a
   `list` action. Flagged again here because the Sync Engine is the first *consumer* of `action`. (SP-3)
10. **Recently-written cache TTL and passthrough-tag header name.** Concept says "short-TTL" and "a passthrough
    header/field where the target API supports write metadata" without fixing values. *Recommended:*
    implementation-defined; correctness is independent of both (EP-2), so they are tuning knobs, not
    contracts. (EP-2)

### Deferred feature (post-Phase-4, phase-sized)

- [scoped-resource-sync.md](scoped-resource-sync.md) — SS-1 … SS-18, in three layers (L1 constants, L2
  record-derived scope, L3 `ScopeLink` + discovery + scoped identity). Shipped alongside Phase 4's tail; its
  open question 3 (adapter fallback to a scope binding) is **resolved in Phase 5** — see Phase-5 open
  question 8 below.

---

## Phase 5 — The Adapter/Gateway Engine (the on-demand half)

The product's second capability, and the first inbound surface: a newly introduced app's `CONSUMER` spec is
**hosted as a live server** and its calls resolved on demand against real backends, using the same
`ApprovedMapping`s, Transformation Executor, Outbound Call Executor, and Credential Store access pattern the
Sync Engine uses. Where Phase 4 pushes proactively, Phase 5 resolves on request — the mediator as a **virtual
provider**, which never calls the consumer.

Phase 5 completes what Phase 3 deliberately left non-serving: AI-2 instantiated `AdapterEndpoint`s with
`proposed` `AdapterBinding`s and no composition state, because there was no runtime. Phase 5 adds the runtime,
the Auth Gateway, the planner/executor/aggregator pipeline, writes, caching, and the human **composition**
decision — under the same core safety promise: **nothing serves that a human has not approved and (where it is
ambiguous) composed.** A single approved backend auto-activates because one backend leaves nothing to decide;
a *second* one always waits for a human.

**What already exists vs. what Phase 5 adds** (checked against `packages/db/src/schema.ts` +
`packages/domain/src`): `adapter_endpoint` / `adapter_binding` exist with the `adapter_endpoint_status`
(incl. `composition-required`), `adapter_binding_role`, and `adapter_binding_status` enums, and
`Credential.type` already owns `adapterToken`; `AuditLog.type` already owns `adapter-request`. All of these
carry **only approval-derived data** — no aggregation strategy, ordering, chaining, post-merge semantics, or
caching. Phase 5 **extends** them (AD-*), and **adds** the write-outcome store and `audit_log.related_binding_id`.
`packages/adapter-engine` and `apps/backend/src/http/adapter-runtime` are unbuilt.

| File | Stories | Realizes (concept component) |
|---|---|---|
| [phase-5-adapter-domain.md](phase-5-adapter-domain.md) | AD-1 … AD-6 | `@mediator/domain` + **the one Phase-5 migration** (composition/serving state, `adapterToken`, write-outcome store) |
| [phase-5-adapter-runtime.md](phase-5-adapter-runtime.md) | RT-1 … RT-5 | Adapter Server Runtime (dynamic mount, `not-yet-mapped`, lifecycle, tracing) |
| [phase-5-auth-gateway.md](phase-5-auth-gateway.md) | AT-1 … AT-4 | Auth Gateway + adapter token (shown once, salted hash, rotation) |
| [phase-5-router-planner.md](phase-5-router-planner.md) | RP-1 … RP-5 | Request Router + inbound validation + Resolution Planner (+ the six-cause invariant) |
| [phase-5-transform-execution.md](phase-5-transform-execution.md) | TE-1 … TE-5 | Transformation Executor (request/response phases, `ParameterMapping`s) + Outbound execution + chaining |
| [phase-5-response-aggregation.md](phase-5-response-aggregation.md) | AG-1 … AG-7 | Response Aggregator (four strategies) + consumer-schema response validation |
| [phase-5-write-operations.md](phase-5-write-operations.md) | WR-1 … WR-5 | Adapter writes (single-target, idempotency + write-outcome store, not loop-tagged) |
| [phase-5-caching.md](phase-5-caching.md) | CH-1 … CH-5 | Response cache + coarse invalidation (`SyncEvent` / adapter write / TTL / config change) |
| [phase-5-endpoint-composition.md](phase-5-endpoint-composition.md) | CO-1 … CO-7 | Endpoint composition (derivation, validation, recomposition, successor adoption) |
| [phase-5-adapter-api.md](phase-5-adapter-api.md) | AP-1 … AP-5 | API Layer (read/compose/enable/token/history) |
| [phase-5-adapter-ui.md](phase-5-adapter-ui.md) | CU-1 … CU-5 | UI Layer (composition, union panel, token panel, health + capstone e2e) |

59 stories total.

### Phase-4 lessons → owning criteria (encoded, not retold)

Every serious Phase-4 defect lived at a seam between individually-correct components, or in a silent
approximation. Those three lessons are carried here as testable criteria:

| Lesson | Owning criteria |
|---|---|
| **Failures are loud, never plausible-but-wrong** | RP-5 (six causes mutually distinguishable + never a fabricated body), RT-3 (`not-yet-mapped` / `endpoint-disabled` / 404), RP-2 (reject unserviceable inputs before any backend), AG-5.2 (fail, never truncate a union), AG-7 (`mediator-transform-error`), TE-1.3 / TE-3.4 (refuse rather than send an unfilled/guessed parameter), WR-3.3 (recorded outcome, never a fabricated success) |
| **Derive-then-confirm, never auto-confirm** | CO-3.5 (`postMergeSorts`/`postMergePagination` pre-filled, composer-confirmed), CO-3.1 ("no dedup" is an explicit choice), CO-4.3 (strict/degraded is a decision, not an inference), CO-5.5 (input-coverage acknowledged, not assumed), AT-1 (token shown once — issuance is an explicit act) |
| **Pin every cross-component contract** | RP-4 (planner → executor plan is an explicit, pure value), TE-5 (executor → aggregator envelope, pure aggregation), AG-7.5 (aggregator → validator seam), CH-3.2 / CH-4.3 / CH-5.6 (one invalidation seam, two key kinds), WR-4.2 (adapter-write → Sync Engine: *not* `skipped-loop`) |

### Suggested implementation order (Phase 5, blocking edges)

Layered per the plan (types → persistence → logic → HTTP → UI), sliced so each step is independently
reviewable and demonstrable:

1. **AD-1 … AD-6 — the *only* migration slice of the phase.** All composition/serving columns, the
   write-outcome store, and `audit_log.related_binding_id` land in one migration; every column nullable with no
   DB default so Phase-3 rows keep loading. **No later Phase-5 slice should need a migration** — if one appears
   to, that is a finding for a human, not a second migration in flight.
2. **RT-1 … RT-4** ∥ **AT-1 … AT-4** — the runtime on its own port serving the full consumer surface as
   `not-yet-mapped` behind a validated token. Demonstrable on its own (call scenario-3's `/todos`, get
   `not-yet-mapped`; call it without a token, get rejected). **RT-5** (trace + audit row) lands with them.
3. **CO-1** — derivation from `MappingApproved` + first-binding auto-activation. Small, and it unblocks
   everything that serves.
4. **The thin end-to-end slice:** **RP-1 → RP-2 → RP-3 → RP-4** → **TE-1 → TE-2 → TE-4 → TE-5** →
   **AG-1** → **AG-7**. At the end of this step, scenario-3's `GET /todos` returns real Vikunja data and every
   failure has a distinct cause. **RP-5** is written here as the phase's loudness regression net.
5. **CO-2** (composition + validation) → **CO-4** (supplement analysis) → **CO-5** (input coverage) — the human
   decision, before the strategies that consume it.
6. **AG-2** (fanout-merge) + **TE-3** (chaining) — parallelizable with each other's tests.
7. **CO-3** (union configuration) → **AG-3** → **AG-4** → **AG-5** (materialization bound) → **AG-6**
   (first-success).
8. **WR-1 … WR-5** — writes; depends on CO-2 (single-binding rule) and Phase-4 OC-2 (idempotency).
9. **CH-1 … CH-4**, then **CH-5** (config/health invalidation, which needs CO-6).
10. **CO-6** (recomposition/enable/disable) → **CO-7** (successor adoption; its live trigger arrives with
    Phase 6 — Phase 5 unit-tests the adoption behavior against a simulated succession).
11. **AP-1 … AP-5** — thin HTTP over the composition/auth services, gated by Phase-3 OA-2.
12. **CU-1 … CU-4** → **CU-5** (capstone e2e against running scenario-3/4 landscapes).

**What can parallelize:** step 2's two files (RT ∥ AT); TE-3 ∥ AG-2; the AG-* strategy suites once TE-5's
envelope exists; the CU-* screens once their backing AP-* endpoint lands. **What must not:** any second
migration alongside AD.

### Phase boundary map (Phase 5 → owning phase)

| Deferred concern | Owning phase |
|---|---|
| `SpecDiff`, additional spec versions, re-pinning, marking mappings `stale`, producing the **successor** mapping and its re-review | **Phase 6** ([extensibility.md](../architecture/extensibility.md)) — Phase 5 *consumes* `stale`/`suspended` as runtime conditions (RP-3) and specifies the **adapter side** of successor adoption (CO-7); it never sets those states |
| Graph **rendering**, Grafana dashboards/alert rules | **Phase 6** ([graph-overview.md](../flows/graph-overview.md), [observability.md](../architecture/observability.md)) — Phase 5 upserts adapter-dependency edges (CO-1.5) and emits the metrics those panels read |
| App **deregistration** cascade UI/flow (Phase 5 specifies only the adapter-side effects: torn-down surface, `not-yet-mapped` on binding-less endpoints, token deletion) | **Phase 6** ([extensibility.md](../architecture/extensibility.md) *App lifecycle*) |
| Webhook/push change detection, GraphQL/gRPC protocols, multi-tenancy, high availability, inbound rate limiting | **Out of scope / later** ([extensibility.md](../architecture/extensibility.md), [overview.md](../architecture/overview.md), [security.md](../architecture/security.md)) |

Phase 5 operates on **version-1 specs only**, like Phases 1-4.

### Open questions for a human (Phase 5 — concept silent, underspecified, or in tension)

Each has a recommended default the stories adopt; confirm or override. Items 3, 4, 7, 10, 11, 13 are **concept
gaps** — a name or rule the docs use but do not define.

1. **How do several consumer apps share one adapter listener?** The concept names one Adapter Server Runtime
   and one token per consumer app, but never says how two consumer specs declaring `/todos` coexist (the
   scenario fixtures declare bare paths at `servers: http://localhost:1<scenario>900`). *Recommended:*
   **token-derived routing** — the Auth Gateway resolves the consumer app from the token, and routing happens
   within that app's surface, so consumer paths stay verbatim and collisions are impossible. Alternatives: a
   per-app path prefix (breaks the fixtures' `servers` URLs) or one listener per consumer app (port sprawl).
   (RT-2.3, AT-2.3, AT-3.2)
2. **HTTP status codes per error cause.** The concept fixes the *causes*, never the codes. *Recommended:* the
   machine-readable **cause token** is the contract; status codes implementation-defined with a suggested
   mapping (`not-yet-mapped` → 501, `endpoint-disabled`/`mapping-stale`/`mapping-suspended`/`backend-disabled`
   → 503, `mediator-transform-error` → 500, upstream → 502, auth → 401/403, request-validation → 400).
   (RT-3.5, RP-5.1)
3. **Two `AdapterEndpoint` fields are named in prose but absent from the data model.** *Concept gap:*
   [adapter-engine.md](../architecture/adapter-engine.md) and
   [adapter-endpoint-composition.md](../flows/adapter-endpoint-composition.md) both require a **strict vs.
   degraded** partial-failure mode and a union **dedup configuration** (link-based / dedup key / none), but
   [data-model.md](../architecture/data-model.md)'s `AdapterEndpoint` lists neither. *Recommended:* add both to
   the data model (e.g. `partialFailureMode: strict | degraded` and a `dedup` union); the stories use
   descriptive placeholders until a human fixes the canonical names. (AD-1.4, AD-1.5)
4. **Adapter-token rotation overlap has no modeled field.** *Concept gap:* `Credential` carries
   `lastRotatedAt` but nothing bounding an overlap window, and "old and new both valid" implies two
   simultaneously-valid rows. *Recommended:* two `adapterToken` rows with a bounded validity end on the
   superseded one (a nullable column in the AD migration) + an explicit confirm-cutover action; default window
   config-defined. Also confirm that a consumer app registered **before** Phase 5 gets its token issued on
   demand (the concept says "generated at registration"). (AD-3.3, AT-1.5, AT-4)
5. **Write dedup lookback window length.** Concept says "a bounded lookback window" without a value.
   *Recommended:* config-defined, sharing the Phase-4 idempotency window's configuration; never unbounded.
   (AD-4.3, WR-3)
6. **Inbound rate limiting on the adapter surface.** The concept specifies *outbound* ceilings only.
   *Recommended:* none in Phase 5 (single-tenant, token-gated); note it as a future hardening item rather than
   inventing a policy. (AT-2)
7. **Unmapped consumer inputs are rejected only for unions in the concept.** *Concept gap / carried-over
   evaluation finding:* [adapter-engine.md](../architecture/adapter-engine.md) rejects an unconfigured union
   filter/sort/pagination parameter, but says nothing about a **non-union** endpoint whose consumer parameter
   maps to no backend — today that would be silently dropped and answered with a plausible-but-wrong result.
   *Recommended:* generalize the same discipline — composition derives the unmapped-input set, the composer
   must **acknowledge** each one, and a request *using* an unacknowledged unmapped parameter is rejected; a
   **required** consumer input that reaches no backend is a blocking composition finding. (CO-5, RP-2.4)
8. **[RESOLVED here — scoped-resource-sync open question 3] Should the adapter fall back to a scope binding
   for a scope parameter the consumer omits?** **No.** Three concept anchors: (a)
   [data-model.md](../architecture/data-model.md) `ParameterMapping` states scope filling is an
   *operational/identity* binding "deliberately kept distinct" from a request-driven `ParameterMapping`, and
   `scopePathBindings` are explicitly "not sourced from an inbound request"; (b) falling back would make the
   adapter serve one silent scope while the consumer believes the call is unscoped — precisely the
   plausible-but-wrong answer the phase forbids; (c) the scenario-4 fixture already documents the intended
   behavior ("the Gitea/Forgejo creates are **rejected bindings** — their `{owner}`/`{repo}` path params have
   no consumer counterpart"). *Adopted:* a backend operation with a **required** parameter that has no
   `ParameterMapping` and no `chainInput` is **not composable**, rejected loudly at composition (CO-2.6) and
   refused at execution if it ever reaches it (TE-1.3). **Residual for the human:** if operators later want a
   fixed backend scope for adapter calls, the honest expression is a **constant `ParameterMapping`**
   (operator-authored, composition-time, reviewed) — which the data model does not currently support
   (`ParameterMapping` requires a `sourceParamRef`). Confirm whether to leave that as a documented limitation
   or open it as a future concept change. (TE-1.4, CO-2.6)
9. **Read-side retry bound for a live adapter request.** The Phase-4 executor retries and parks; an adapter
   read has a live caller and must not park. *Recommended:* a bounded, config-defined retry for adapter calls,
   with the park/dead-letter path explicitly not applicable. (TE-2.6)
10. **Union row provenance: the scenario-4 fixture contradicts the concept.**
    [adapter-engine.md](../architecture/adapter-engine.md) states that **no per-row source annotation is
    injected into the body** (provenance lives in the trace; a response header names contributors), but
    [task-dashboard.yaml](../../scenarios/scenario-4-mixed/specs/consumer/task-dashboard.yaml) declares a
    `source` field "annotated by the mediator". *Recommended:* the concept wins — `source` is **optional** in
    that schema, so leaving it absent stays schema-valid; either update the fixture's comment or (a human
    decision) revisit whether a composer-configured provenance field is a wanted feature. (AG-3.6)
11. **Union materialization has no bound in the concept.** *Carried-over evaluation finding:* "a union endpoint
    materializes the complete (filtered) merged collection per request" with no ceiling. *Recommended:* a
    config-defined per-request row ceiling that **fails** the request (naming the backend and ceiling) rather
    than truncating. **Residual:** whether this deserves its own named cause in
    [glossary.md](../glossary.md) alongside the six, or should be reported as an upstream-shaped error.
    (AG-5)
12. **A backend write that returns no body.** *Carried-over evaluation finding (no-body-204).* *Recommended:*
    do not fabricate a response; fail as `mediator-transform-error` when the consumer schema requires a body.
    **Residual:** whether a follow-up read (as the sync side does for echo baselines) should be performed
    instead — a small behavioral addition the concept does not describe. (WR-2.3)
13. **Cache lifecycle on configuration/health changes.** *Concept gap / carried-over evaluation finding:*
    invalidation lists only sync activity, adapter writes, and TTL — nothing for recomposition, binding
    enable/disable, a mapping going `stale`/`suspended`, successor adoption, or backend disable. *Recommended:*
    all of them drop the affected endpoint's entries, as a direct extension of the documented "coarse
    invalidation never costs correctness" principle. (CH-5)
14. **No `fanout-merge` fixture exists.** Scenarios 3/4 give a single call, a union, and a write — but no
    consumer operation whose fields naturally come from two backends. *Recommended:* cover `fanout-merge`
    (chaining, degradation, load-bearing supplement) deterministically with a stubbed backend, **or** approve a
    small merge-shaped operation added to a consumer fixture spec so the capstone can exercise all four
    strategies live. (CU-5.10)
15. **"Composer" is not a role.** [adapter-endpoint-composition.md](../flows/adapter-endpoint-composition.md)
    says "the composer"; [security.md](../architecture/security.md) lists only `operator`/`viewer`, with
    "compose endpoints" as an operator mutation. *Adopted (not open):* composer = an `operator` performing
    composition; **no new role is coined**. Flagged only so a human can confirm the glossary needs no line.
    (CO-*, CU-*)

---

## Phase 6 — Landscape evolution (the final phase)

The last vertical slice, and the one that makes the landscape a **living** system rather than a
one-time-configured one: an app's spec **changes**, an app **goes away**, and the mediator reacts without
either silently breaking or forcing a full re-approval. Phase 6 ingests a **second** `ApiSpec` version and
runs the whole `SpecDiff` lifecycle (additive re-pin vs. breaking → `stale` → scoped re-review → successor
adoption); it runs the disable/deregister cascades; it completes the always-available **landscape graph**
(the incremental `GraphEdge` update/remove the ensure-exists upsert could never do, plus the Vue Flow UI);
it wires the two cross-engine cache-invalidation seams Phase 5 left inert; it registers the reconciliation
sweep's Phase-6 reconcilers so **"bus loss degrades timeliness, never correctness"** becomes a *tested*
guarantee; and it stands up the full observability metric/dashboard/alert surface.

The core safety promise is unchanged: **re-pinning is automatic only because an additive diff proves nothing
executable changed**; every path that changes what a mapping *means* — the additive delta proposal, the
breaking-change successor, a re-inclusion — is an **ordinary human review/approval**. Nothing new executes,
and nothing changes meaning, without a human.

Phase 6 is where several deliberately-deferred seams get their **live trigger** — the stories are scoped to
the **wiring**, not a rebuild, and each names the merged seam it activates.

| File | Stories | Realizes (concept component) |
|---|---|---|
| [phase-6-graph.md](phase-6-graph.md) | GR-1 … GR-6 | Graph/Overview Service (`GraphEdge` update/remove + rebuild + `getGraph` + Vue Flow UI) |
| [phase-6-spec-update-lifecycle.md](phase-6-spec-update-lifecycle.md) | SL-1 … SL-10 | Spec Registry `SpecDiff` + Mapping Engine re-mapping + successor adoption ([extensibility.md](../architecture/extensibility.md) *Spec update lifecycle*, *Successor adoption*) |
| [phase-6-app-lifecycle.md](phase-6-app-lifecycle.md) | AL-1 … AL-4 | `RegisteredApp` disable/deregister cascades ([extensibility.md](../architecture/extensibility.md) *App lifecycle*) |
| [phase-6-cross-engine-invalidation.md](phase-6-cross-engine-invalidation.md) | XI-1 … XI-2 | CH-3 `sync-execution` outbox producer + CH-5.3 lifecycle-transition triggers |
| [phase-6-reconciliation.md](phase-6-reconciliation.md) | RC-1 … RC-4 | Reconciliation sweep wired to Phase-6 derivations (bus-loss capstone) |
| [phase-6-observability.md](phase-6-observability.md) | OB-1 … OB-5 | OpenTelemetry business metrics + Grafana dashboards + alerting ([observability.md](../architecture/observability.md)) |

31 stories total.

### Merged seams → their Phase-6 trigger (wiring, not rebuild)

Where a mechanism **already exists and only needs its trigger/wiring**, the story is scoped to the wiring.

| Existing merged seam | Phase-6 story that activates it |
|---|---|
| CO-7 `AdapterCompositionService.adoptSuccessor` (adapter-side adoption, unit-tested against a *simulated* succession) | **SL-7** supplies the breaking-change → re-review → **successor** live trigger |
| SS-16 `ScopeLifecycleService` + `@mediator/ir` `revalidate*` (scope-artifact re-validation policy, "not invoked from ingestion yet") | **SL-5** wires it to the `SpecDiff` |
| SS-10.5 `ScopeLinkRepository.archiveByCorrespondence` (archive capability shipped ahead of trigger) | **SL-5** / **AL-2** cascade |
| CH-3 `SyncEventCacheInvalidationConsumer` (registered but inert — no producer) | **XI-1** emits `sync-execution` `SyncEvent`s onto the `event_outbox` |
| CH-5 `CacheInvalidator.invalidateEndpoint` by-endpoint seam (wired only for CO-6) | **XI-2** drives it from stale/suspend/superseded + disable/deregister |
| `DownstreamArtifactRepository.upsertGraphEdge` (ensure-exists; **cannot** update/remove) + the CO-6 `// TODO(Phase 6 graph)` markers | **GR-1** adds update/remove; **GR-3** resolves the CO-6 markers |
| `ReconciliationSweep` framework + Phase-2/3/4 reconcilers | **RC-1** registers the Phase-6 reconcilers live |
| `AdapterTelemetry`, `createDetectionMetricsSink`, `SyncExecutionReconcilerMetrics` ports | **OB-1/OB-2** fill the sync + mapping metric gaps around them |

### Suggested implementation order (Phase 6, blocking edges)

Layered per the plan (types → persistence → logic → HTTP → UI), sliced so each step is demonstrable:

1. **SL-1** (`SpecDiff` computation) — the classification every lifecycle reaction reads; nothing else in
   the spec-update lifecycle starts without it.
2. **GR-1** (projection update/remove) — small, unblocks every graph and lifecycle status/removal reaction.
3. **SL-2 → SL-3** (additive re-pin + carry-forward → scoped delta analysis) — the demonstrable additive
   slice: an additive v2 keeps everything running and opens a small delta proposal.
4. **SL-4 → SL-5** (breaking: stale/pause/flag + operational-ref re-validation, wiring SS-16) →
   **XI-2** (CH-5.3 cache drop on staleness) → **GR-2/GR-3** (edges recompute; GR-3 clears the CO-6 TODOs).
5. **SL-6** (scoped re-analysis → successor proposal) → **SL-7 → SL-8** (adoption: re-point in place, drive
   CO-7, preserve sync state + reconcile field pairs) — the breaking end-to-end slice.
6. **SL-9** (`analysisExclusions` re-inclusion) and **SL-10** (manual suspend/resume) — the sibling
   transitions, reusing SL-3's scoped analysis and the XI-2/GR/RP-3 plumbing.
7. **AL-1 → AL-2 → AL-3** (disable/enable → deregister cascade → re-registration guard) → **AL-4** (API/UI).
8. **XI-1** (the CH-3 `sync-execution` outbox producer) — independent of the SL/AL chain; needs only the
   Phase-4 executor + Phase-5 CH-3 consumer.
9. **GR-4 → GR-5 → GR-6** (activity metadata → `getGraph` read → Vue Flow UI).
10. **RC-1 … RC-4** (register Phase-6 reconcilers → graph/spec-lifecycle/adoption reconcilers → bus-loss
    capstone) — follows the derivations they recover.
11. **OB-1 … OB-5** (sync metrics → mapping-metric gaps → landscape/lifecycle metrics → dashboards → alerts)
    — the metrics precede the dashboards/alerts that consume them; runnable in parallel with the rest.

**What can parallelize:** XI-1 ∥ the whole SL/AL chain; OB-* ∥ everything (metrics only read what the other
stories already produce); GR-4..GR-6 once GR-1..GR-3 land. **What must not:** any lifecycle status/removal
reaction (SL-4/SL-7/SL-10, AL-1/AL-2) before **GR-1** and **XI-2** exist — otherwise a stale/removed
relationship is masked by a stale edge or a stale cache.

### Phase boundary map (Phase 6 is the final phase — what remains is *out of scope*, not a later phase)

| Deferred concern | Status |
|---|---|
| Webhook/push change detection | **Out of scope** — polling is the only change-detection transport; a push detector is a documented future *seam* that reintroduces an unauthenticated inbound surface with its own trust design ([extensibility.md](../architecture/extensibility.md) *Beyond REST/OpenAPI*; [sync-engine.md](../architecture/sync-engine.md); [security.md](../architecture/security.md)) |
| GraphQL / AsyncAPI / gRPC protocols | **Out of scope** — a future Spec Adapter + Protocol Client/Server pair; the IR core is deliberately protocol-agnostic so this needs no rewrite ([extensibility.md](../architecture/extensibility.md) *Beyond REST/OpenAPI*) |
| Multi-tenancy | **Out of scope** — single-tenant, self-hosted; no tenant-isolation concern in any component ([overview.md](../architecture/overview.md) *Deployment model*) |
| High availability / active-passive standby | **Out of scope** for the initial version — components are stateless over a shared store so a standby can be added as a deployment choice without architectural change; the reconciliation sweep is a single-instance self-heal, not HA ([overview.md](../architecture/overview.md) *Deployment model*; RC-4) |
| SSO/OIDC auth provider | **Later** — Phase 3 shipped local accounts behind the pluggable seam |
| Auto-approval of mappings / bypassing re-review | **Never** — the core safety promise; re-pinning is the *only* automatic mapping-state change, and only because an additive diff proves nothing executable changed (SL-2) |

### Open questions for a human (Phase 6 — concept silent, underspecified, or in tension)

Each has a recommended default the stories adopt; confirm or override. Items 2, 4, 10 touch **concept gaps**
— a name or rule the docs use but do not fully define.

1. **Graph library.** The task names **Vue Flow**; the concept says only "graph rendering" / "always-available
   overview" and mandates no library. *Recommended:* Vue Flow (matches the CLAUDE.md Vue 3 + `<script setup>`
   convention); a rendering-library choice, not product behavior. (GR-6)
2. **`GraphEdge.status` value set.** *Concept gap:* [data-model.md](../architecture/data-model.md) does **not**
   enumerate `GraphEdge.status` (the domain models it as a plain string precisely because "the concept does
   not enumerate the value set"), yet GR-2/GR-3/GR-6 need it to distinguish healthy / partially-paused /
   stale/suspended edges. *Recommended:* derive a small status vocabulary from the aggregate of the edge's
   underlying rules/bindings (e.g. `active` | `degraded` | `paused` | `stale`), documented as a projection
   detail; a human should decide whether [data-model.md](../architecture/data-model.md) should enumerate it.
   (GR-2, GR-3)
3. **Graph read pagination.** Concept is silent; the landscape is ~15-20 apps
   ([overview.md](../architecture/overview.md) *Scale assumption*). *Recommended:* return the whole graph
   unpaginated, as Phase 1 did for `GET /apps`. (GR-5)
4. **Additive-vs-breaking classification of ambiguous diffs.** The concept lists clear examples but not every
   case (a widened type, a loosened enum, a new optional-with-default). *Recommended:* classify **breaking**
   unless the change is *provably* additive — a false "additive" would silently re-pin onto a changed element,
   the one outcome re-pinning must never produce; a human should confirm the conservative default and whether
   the concept should enumerate the edge cases. (SL-1)
5. **Deregister confirmation mechanism.** [extensibility.md](../architecture/extensibility.md) requires
   "explicit confirmation" but not its form. *Recommended:* a typed confirmation (e.g. re-entering the app
   name) plus a shown cascade summary; implementation-defined. (AL-2, AL-4)
6. **CH-3 producer placement: in the executor's write transaction or a following step?** The event is already
   durably recorded in the Audit Log; enqueuing on the `event_outbox` is the addition. *Recommended:* enqueue
   in the same transaction as the `SyncEvent` write so a committed write always has its outbox row (bus loss
   then only affects *delivery*, which the sweep/`cacheTtl` already tolerate); confirm. (XI-1)
7. **Successor re-review is the ordinary review flow — confirmed, not new behavior.** The concept states
   re-review is "the ordinary review flow" over the scoped proposal. *Adopted (not open):* the successor goes
   through Phase-3 accept/edit/reject/approve; adoption is triggered only by the successor's `MappingApproved`.
   Flagged so a human confirms there is **no** auto-adoption path. (SL-6, SL-7)
8. **`suspend`/`resume` ownership.** Phase 3 deferred `suspend` to "the final phase" without stating which area
   owns it. *Recommended:* home it with its sibling `ApprovedMapping`-status transitions in the spec-update
   lifecycle file (SL-10), since it shares the stale-path plumbing (pause + `mapping-suspended` runtime +
   CH-5.3 + graph recompute); confirm the placement. (SL-10)
9. **Alert thresholds.** The concept gives shapes ("N× its expected interval", "crosses a threshold",
   "growing unbounded") but no values. *Recommended:* every threshold config-defined with a conservative
   default; the stale-`AdapterBinding` alert defaults to a **tighter** threshold than sync staleness, per the
   documented asymmetry. (OB-5)
10. **Dashboards/alerts are not unit-testable; the testable oracle is the metrics they read.** *Flag:* a
    Grafana dashboard/alert JSON is not exercised by a unit/e2e test the way engine code is. *Recommended:*
    the acceptance criteria assert (a) the **business metrics** the panels/alerts consume are emitted (OB-1..3,
    testable against a fake meter), and (b) a **static consistency check** that every metric name referenced by
    a provisioned dashboard/alert exists among the emitted instruments (OB-4.6/OB-5.6). A human should confirm
    this is a sufficient definition of "the dashboard is real"; the alternative (a live Grafana in CI) is
    heavier than the single-instance model warrants. (OB-4, OB-5)
