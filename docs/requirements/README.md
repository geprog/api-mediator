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
