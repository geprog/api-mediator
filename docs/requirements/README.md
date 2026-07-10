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

The concept defines three human roles. Phase 1 involves only the first:

- **operator** (landscape operator) — may mutate: register apps, store credentials, confirm/correct
  `ResourceBinding`s, set `analysisExclusions`.
- **viewer** — read-only: app list, spec IR. (Full auth wiring lands in Phase 3; Phase 1 stories
  state the read/mutate split so it is testable once auth exists.)
- **mapping reviewer** / **consumer-app developer** — Phase 3 / Phase 5, not exercised here.

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
