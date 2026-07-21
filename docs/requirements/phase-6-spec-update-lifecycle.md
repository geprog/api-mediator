# Phase 6 — Spec-update lifecycle (`SpecDiff` → re-pin / stale / successor adoption)

The heart of Phase 6, and the first phase to ingest a **second** `ApiSpec` version. Registered apps
evolve; the mediator must react without either silently breaking or forcing a full re-approval every time.
This slice builds the `SpecDiff` engine and both of its branches: **additive** changes re-pin active
mappings mechanically and open a small delta proposal for the genuinely-new elements; **breaking** changes
mark only the affected `ApprovedMapping`s `stale`, pause their `SyncRule`s and flag their
`AdapterBinding`s, re-validate the spec's operational refs, and drive the **scoped re-analysis** that
produces each stale mapping's **successor** for ordinary human re-review. On re-approval, adoption
re-points everything in place — preserving sync cursors/snapshots and adapter composition — and supersedes
the stale row. It also owns the two sibling `ApprovedMapping` transitions the earlier phases deferred to
"the final phase": **manual suspend/resume** (SL-10) and the `analysisExclusions` **re-inclusion** trigger
(SL-9).

**The core safety promise still holds.** Additive **re-pinning** is automatic *because an additive diff
proves every referenced element is unchanged* — it changes the pinned version, never a correspondence, and
is recorded in the audit log. Every path that changes *what a mapping means* — the delta proposal, the
successor — is an **ordinary human review/approval** (Phase 3 flow). **Nothing new executes and nothing
changes meaning without a human**; the machinery here only *scopes* the review down to what actually
changed.

**What already exists vs. what Phase 6 adds** (checked against `packages/ir/src`,
`apps/backend/src/modules/sync/scope-lifecycle.ts`, `apps/backend/src/modules/adapter-composition/`):
the **scope-artifact re-validation policy** is already built and waiting for this trigger —
`@mediator/ir` `revalidateResourceBinding` / `revalidateScopeCorrespondence` (pure) and
`ScopeLifecycleService` (SS-16, persists the consequence: unconfirmed refs pause rules, `ScopeLink`s
archived), which its own header states is "deliberately **not** invoked from ingestion yet: `SpecRegistry`
still only ingests v1"; and `ScopeLinkRepository.archiveByCorrespondence` (the SS-10.5 archive capability
shipped ahead of its trigger). The **adapter-side successor adoption** is already built —
`AdapterCompositionService.adoptSuccessor` + the pure `adopt.ts` helpers (CO-7), which re-point bindings,
re-run composition validation against the successor, flag `composition-required` on a broken config, and
drop caches — and is unit-tested against a *simulated* succession, awaiting this phase's **live trigger**.
**`SpecDiff` computation, re-pin, stale-marking, the scoped re-/incremental analysis, and the successor
adoption transaction on the sync side do not exist** (`SpecRegistry` only ingests v1; the enums
`ApiSpecStatus = active|superseded|archived` and the `ApprovedMappingStatus` set already exist from Phase 3
but their **transitions** are Phase 6). Phase 6 builds those and **wires** the existing SS-16 and CO-7 seams.

**Actor:** system (Spec Registry diff + re-pin + stale-marking + scoped analysis + adoption); operator
(re-reviews the delta/successor proposal through the ordinary review flow; manually suspends/resumes;
edits `analysisExclusions`); mapping reviewer (the re-review itself).

**Concept references (whole file):** [extensibility.md](../architecture/extensibility.md) *Spec update
lifecycle*, *Successor adoption: what re-approval actually does*; [mapping-engine.md](../architecture/mapping-engine.md)
*Re-mapping on spec change*, *Scoping down: operator exclusions* (esp. *Re-inclusion*);
[data-model.md](../architecture/data-model.md) `ApiSpec` (`status`, `analysisExclusions`, versioning),
`ApprovedMapping` (`status = stale`/`suspended`/`superseded`/`archived`, `sourceSpecId`/`targetSpecId`,
`counterpartMappingId`), `SyncRule` (`pollOperationRef`, cursor/snapshot/backfill), `ResourceBinding`,
`RecordLink`, `SyncFieldState`; [overview.md](../architecture/overview.md) `SpecRegistry.diffSpec`;
[adapter-engine.md](../architecture/adapter-engine.md) *Stale bindings at request time* (`mapping-stale`);
[glossary.md](../glossary.md) `SpecDiff`, `Spec lineage`, `Re-pinning`, `Successor mapping`. Reused seams:
Phase-4 [sync-domain](phase-4-sync-domain.md) SD-1..SD-4 (`SyncRule` state + `SyncFieldState`/`RecordLink`);
[scoped-resource-sync.md](scoped-resource-sync.md)
SS-16 (`ScopeLifecycleService` + `revalidate*`), SS-10.5 (`archiveByCorrespondence`);
[phase-5-endpoint-composition.md](phase-5-endpoint-composition.md) CO-7 (`adoptSuccessor`);
[phase-2-two-stage-detection.md](phase-2-two-stage-detection.md) (detail-call machinery reused for scoped
analysis); [phase-6-cross-engine-invalidation.md](phase-6-cross-engine-invalidation.md) XI-2 (CH-5.3
cache drop on the transitions this phase produces).

> **Authoritative:** the additive/breaking classification and its two distinct consequences; **re-pinning
> is automatic, safe, and audited** (additive proves referenced elements unchanged) and keeps active
> mappings pointing at the active spec version; **staleness lives on the mapping alone** (derived records
> keep their own `status`) and is **scoped** to mappings that actually reference a changed element;
> re-review is the **ordinary review flow** over a scoped proposal (no auto-approval); adoption **replaces
> the stale mapping in place** (state + composition preserved) and marks the stale row `superseded`;
> exclusions carry forward and re-inclusion re-analyzes. **Implementation choice:** the diff algorithm's
> internal representation, how "affected by a changed element" is computed from the IR, ingestion
> endpoint shape, `priorFeedback` payload detail, UI copy.

---

## SL-1 — Ingest a new `ApiSpec` version and compute its `SpecDiff`

**As a** landscape operator, **I** register a new version of an app's spec and have the mediator classify
exactly what changed, **so that** the right — and only the right — reaction follows.

### Acceptance criteria

1. **Given** an app already has an `active` `ApiSpec` for a `(app, role)` lineage, **when** a new document
   for that lineage is ingested, **then** the Spec Registry parses it to IR, stores it as a new `ApiSpec`
   version, and the prior version becomes `superseded` — the lineage's active version advances
   ([data-model.md](../architecture/data-model.md) `ApiSpec`; [extensibility.md](../architecture/extensibility.md)
   *Spec update lifecycle* step 1).
2. **Given** the old and new IR, **when** `SpecRegistry.diffSpec` runs, **then** it produces a `SpecDiff`
   classifying **each** change as **additive** (new operation, new optional field, new schema/resource
   group) or **breaking** (removed operation/field, renamed field, changed type, a field newly-required
   that was not required before) ([extensibility.md](../architecture/extensibility.md) *Spec update
   lifecycle* step 2; [overview.md](../architecture/overview.md) `SpecRegistry.diffSpec`;
   [glossary.md](../glossary.md) `SpecDiff`).
3. **Given** a change the diff cannot **prove** additive, **when** it is classified, **then** it is treated
   as **breaking** — the conservative default, because a false "additive" would silently re-pin a mapping
   onto an element that actually changed (open question 4).
4. **Given** the diff is computed over the IR (resources → operations → schemas), **when** it runs, **then**
   it is protocol-agnostic — no OpenAPI-specific logic — reusing the same IR every downstream component
   reasons over ([glossary.md](../glossary.md) `IR`; [extensibility.md](../architecture/extensibility.md)
   *Beyond REST/OpenAPI*).
5. **Given** an identical re-submission (same `contentHash`) of the already-active version, **when** it is
   ingested, **then** **no** new version is created and **no** diff/reaction fires — a no-op
   ([data-model.md](../architecture/data-model.md) `ApiSpec.contentHash`).
6. **Given** the diff is persisted/available, **when** the additive/breaking reactions run (SL-2 … SL-6),
   **then** they read it rather than re-diffing — one classification, many consumers (the Phase-4/5 lesson:
   pin every cross-component contract).

### Out of scope

- Applying either reaction — SL-2 (additive) / SL-4 (breaking). A first (v1) ingestion — Phase 1 (there is
  no prior version to diff against).

### Dependencies

Blocked by Phase-1 SI-1/SI-2 (IR builder + `ApiSpec` v1), Phase-1 RB-1 (`ResourceBinding` derivation).
Precedes SL-2 … SL-9. Registered live on the reconciliation sweep by RC-3.

---

## SL-2 — Additive change: automatic re-pin + carry-forward of refs and exclusions

**As a** landscape operator, **I** have a purely-additive spec bump keep every existing mapping running
against the new version untouched, **so that** additive evolution never costs a re-approval.

### Acceptance criteria

1. **Given** an **additive** `SpecDiff`, **when** it is applied, **then** **every** active `ApprovedMapping`
   pinned to the prior version (via `sourceSpecId`/`targetSpecId`) is **re-pinned** to the new version —
   automatically, because an additive diff proves each referenced element is unchanged — and each re-pin is
   recorded in the audit log ([extensibility.md](../architecture/extensibility.md) *Spec update lifecycle*
   step 3; [glossary.md](../glossary.md) `Re-pinning`).
2. **Given** re-pinning, **when** it commits, **then** it changes only the pinned spec version — **no**
   `FieldMapping`/`OperationMapping` content, **no** rule/binding state, and it never sets any mapping
   `stale`: nothing that executes changes, so no human review is required or performed (the safety promise
   is intact) ([extensibility.md](../architecture/extensibility.md) *Spec update lifecycle*).
3. **Given** the invariant "an `active` mapping always points at the currently active spec version",
   **when** the additive version supersedes the prior one, **then** after re-pin **no** active mapping
   still references a `superseded` spec row ([data-model.md](../architecture/data-model.md) `ApiSpec`;
   [extensibility.md](../architecture/extensibility.md) *Spec update lifecycle* step 3).
4. **Given** the spec's `ResourceBinding`s and `analysisExclusions`, **when** the new version is ingested,
   **then** both **carry forward** to it like refs on a lineage, and any ref/exclusion that **no longer
   resolves** in the new IR is **dropped** ([extensibility.md](../architecture/extensibility.md) *Spec
   update lifecycle* step 3; [mapping-engine.md](../architecture/mapping-engine.md) *Scoping down*).
5. **Given** the re-pin runs, **when** a mapping's counterpart pointer is considered, **then** the
   `counterpartMappingId` link (defined over **spec lineages**, version-agnostic) is undisturbed — each
   side's pinned version advances independently ([extensibility.md](../architecture/extensibility.md);
   [glossary.md](../glossary.md) `counterpartMappingId`, `Spec lineage`).
6. **Given** an additive change **inside an excluded resource group**, **when** the reaction runs, **then**
   it triggers **nothing** — an excluded resource is never analyzed
   ([mapping-engine.md](../architecture/mapping-engine.md) *Scoping down*).

### Out of scope

- The scoped delta proposal for genuinely-new elements — SL-3. Any breaking-change handling — SL-4.

### Dependencies

Blocked by SL-1, Phase-1 RB-1 (bindings), Phase-1 SI-4 (`analysisExclusions`). Coupled to XI-2 (no cache
drop needed — a re-pin changes no content — but the graph edge stays as-is via GR).

---

## SL-3 — Additive change: scoped incremental analysis → delta `MappingProposal`

**As a** mapping reviewer, **I** get a small proposal covering only the newly-added elements, **so that**
additive growth surfaces new correspondences to review without re-proposing the whole spec pair.

### Acceptance criteria

1. **Given** an additive change adds a **new resource group** (in analysis scope), **when** the Mapping
   Engine reacts, **then** it runs a **scoped** analysis: one shortlist call for that group's summary
   against each counterpart spec, then a detail call per shortlisted pair — producing a small delta
   `MappingProposal` ([mapping-engine.md](../architecture/mapping-engine.md) *Re-mapping on spec change*
   step 2).
2. **Given** an additive change adds a **field or operation inside an already-shortlisted resource**,
   **when** the Mapping Engine reacts, **then** it **skips stage 1** and goes straight to a scoped detail
   call for that resource pair ([mapping-engine.md](../architecture/mapping-engine.md) *Re-mapping on spec
   change* step 2).
3. **Given** the delta proposal, **when** it is produced, **then** it is an **ordinary** `MappingProposal`
   reviewed through the Phase-3 flow — the human still accepts/edits/rejects and approves; nothing is
   auto-approved (the safety promise) ([mapping-engine.md](../architecture/mapping-engine.md) *Re-mapping on
   spec change*; Phase-3 AS-*).
4. **Given** an excluded resource group, **when** additive elements are added to or inside it, **then** the
   scoped analysis **excludes** it — the delta covers only in-scope new elements
   ([mapping-engine.md](../architecture/mapping-engine.md) *Scoping down*).
5. **Given** the analysis runs off the dispatcher transaction (LLM/network work), **when** it is
   triggered, **then** it records intent and works asynchronously, and is idempotent/reconcilable — the
   same offloading discipline as Phase-2 DT-2 (event-bus dispatcher-tx constraint).
6. **Given** existing `ApprovedMapping`s over unchanged elements, **when** the additive reaction runs,
   **then** they stay **active** and are untouched (SL-2) — the delta is purely additive review surface.

### Out of scope

- Breaking-change re-review — SL-6. Instantiating artifacts from the approved delta — that is the ordinary
  Phase-3 `MappingApproved` path (AI-*/CO-1).

### Dependencies

Blocked by SL-1, SL-2, Phase-2 CE-*/TD-* (enumeration + detail machinery), Phase-3 (review flow).
Precedes RC-3 (reconciler for a diff with no analysis run).

---

## SL-4 — Breaking change: mark affected mappings `stale`, pause rules, flag bindings

**As a** landscape operator, **I** have a breaking spec change stop exactly the mappings it broke — no more,
no less — **so that** a delta-review model keeps everything else running while I re-review only what changed.

### Acceptance criteria

1. **Given** a **breaking** `SpecDiff`, **when** it is applied, **then** **only** the `ApprovedMapping`s
   that actually reference a changed element are set `status = stale`; mappings referencing no changed
   element are **re-pinned** to the new version exactly as in the additive case (SL-2)
   ([extensibility.md](../architecture/extensibility.md) *Spec update lifecycle* step 4).
2. **Given** a mapping goes `stale`, **when** it does, **then** **staleness lives on the mapping alone** —
   its derived `SyncRule`s/`AdapterBinding`s keep their **own** `status` untouched but stop executing: the
   rule's polling **pauses** and the binding's live calls fail with the distinct **`mapping-stale`** error
   ([extensibility.md](../architecture/extensibility.md) *Spec update lifecycle* step 4;
   [adapter-engine.md](../architecture/adapter-engine.md) *Stale bindings at request time*; RP-3).
3. **Given** the stale mapping, **when** it is re-pinned, **then** it **stays pinned to the version it was
   reviewed against** (it describes the old shape) while unaffected mappings advance — re-review produces
   its successor against the new version ([extensibility.md](../architecture/extensibility.md) *Spec update
   lifecycle* step 4).
4. **Given** the mechanism is identical for `PROVIDER` and `CONSUMER` specs, **when** the breaking change is
   on a `PROVIDER` spec, **then** it affects both the `SyncRule`s that sync it **and** any `AdapterBinding`s
   backed by it; on a `CONSUMER` spec it affects that consumer's `AdapterBinding`s — both via the same
   `SpecDiff` → stale path ([extensibility.md](../architecture/extensibility.md) *Spec update lifecycle*).
5. **Given** the **operational impact asymmetry**, **when** a mapping goes `stale`, **then** an alert is
   emittable that treats a stale **`AdapterBinding`** (an externally-visible live failure) more urgently
   than a stale **`SyncRule`** (a silently paused background job) — the alert wiring is OB-5, but the
   transition here is what fires it ([extensibility.md](../architecture/extensibility.md); OB-5).
6. **Given** the transition commits, **when** downstream reactions run, **then** the affected endpoints'
   cached entries are dropped (XI-2 / CH-5.3) and the affected `GraphEdge`s recompute to the paused/stale
   status (GR-2/GR-3) — no cache or graph masks the pause.

### Out of scope

- Re-validating operational refs — SL-5. Producing the successor proposal — SL-6. The `mapping-stale`
  runtime response itself — Phase-5 RP-3 (already built; this story supplies the transition it reacts to).

### Dependencies

Blocked by SL-1. Coupled to XI-2 (CH-5.3), GR-2/GR-3, OB-5. **Supplies the live `stale` transition Phase-5
RP-3/CO-7 were built to consume.** Precedes SL-6.

---

## SL-5 — Breaking change: re-validate operational refs (`ResourceBinding`, `pollOperationRef`, scope artifacts)

**As a** landscape operator, **I** have a breaking change to an operational ref — a pagination parameter, a
native-id field, the poll operation — pause the rules that depend on it, **so that** mapping-level
staleness never misses an operational break it wouldn't otherwise catch.

### Acceptance criteria

1. **Given** a breaking change touches a bound ref of a spec's `ResourceBinding` (a pagination parameter,
   the native-id field, `recordAddressRef`, `sourceScopeRef`, a `scopePathBindings` ref), **when** the
   diff is applied, **then** that ref is returned to **unconfirmed** and the `SyncRule`s depending on it
   **pause** — even when no mapping content was affected; unaffected refs carry forward with the re-pin
   ([extensibility.md](../architecture/extensibility.md) *Spec update lifecycle* step 4). *This is exactly
   the capability `ScopeLifecycleService.revalidateSpecBindings` (SS-16) shipped ahead of this trigger.*
2. **Given** `SyncRule.pollOperationRef` — pinned to a source operation typically referenced by **no**
   mapping element — **when** a breaking change touches that operation, **then** the ref is returned to
   unconfirmed and the rule pauses; **re-confirming it onto a different operation clears the delta cursor
   and rebuilds the snapshot** with a fresh complete fetch
   ([extensibility.md](../architecture/extensibility.md) *Spec update lifecycle* step 4;
   [data-model.md](../architecture/data-model.md) `SyncRule`).
3. **Given** a scoped resource pair's `ScopeCorrespondence` / `ScopeLink`s, **when** a breaking change
   invalidates the scope identity key or a container ref, **then** the correspondence returns to unconfirmed
   and its `ScopeLink`s are **archived (never deleted)** — a container-gone break archives **all** links; a
   scope-identity-key break archives only `identity-match` links (`constant`/`manual` are operator-pinned).
   *This is `ScopeLifecycleService.revalidateCorrespondence` (SS-16.4/16.5) wired to the diff*
   ([extensibility.md](../architecture/extensibility.md); [scoped-resource-sync.md](scoped-resource-sync.md)
   SS-16).
4. **Given** the pause is **derived at execution time** (an unconfirmed ref is refused by the runtime,
   never used as-is), **when** a ref goes unconfirmed, **then** no rule `status` is written — pausing is a
   condition, exactly as `pollOperationRef` re-validation and app-disable pause a rule
   (`apps/backend/src/modules/sync/scope-lifecycle.ts` *How a rule "pauses"*).
5. **Given** re-confirmation is the human correction path, **when** an operator re-confirms an unconfirmed
   ref through the existing confirm panels (RB-3 / SS-6/9/15), **then** the rule resumes — **nothing here
   auto-confirms** a ref ([extensibility.md](../architecture/extensibility.md)).
6. **Given** the same breaking diff also produced stale mappings (SL-4), **when** both reactions run,
   **then** they are consistent: a rule can pause for a stale mapping, an unconfirmed ref, or both, and
   resuming requires clearing **every** applicable condition.

### Out of scope

- Producing the successor proposal — SL-6. Building the re-validation policy — already exists
  (`@mediator/ir` `revalidate*` + `ScopeLifecycleService` SS-16); this story **wires** it to the diff.

### Dependencies

Blocked by SL-1, SL-4. **Wires the existing SS-16 `ScopeLifecycleService` / `@mediator/ir` `revalidate*`
seams** to the `SpecDiff`. Coupled to Phase-1 RB-3 and scoped-sync SS-6/9/15 confirm panels.

---

## SL-6 — Breaking change: scoped re-analysis → the successor re-review proposal

**As a** mapping reviewer, **I** re-review only the correspondences a breaking change actually touched, with
my prior approvals carried in as context, **so that** re-review effort concentrates on the break rather
than re-doing the whole mapping.

### Acceptance criteria

1. **Given** a mapping marked `stale` (SL-4), **when** the Mapping Engine reacts, **then** it immediately
   runs a **scoped re-analysis**: one **detail** call per affected resource pair against the **new** spec
   version, with **no new shortlist** (the correspondence is already established)
   ([extensibility.md](../architecture/extensibility.md) *Spec update lifecycle* step 4;
   [mapping-engine.md](../architecture/mapping-engine.md) *Re-mapping on spec change* step 3).
2. **Given** the re-analysis, **when** the detail call is made, **then** the stale mapping's approved
   content is passed as **`priorFeedback`**, so unaffected correspondences come back intact and review
   effort focuses on what the change broke ([mapping-engine.md](../architecture/mapping-engine.md)
   *Re-mapping on spec change* step 3; `MappingPromptContext.priorFeedback`).
3. **Given** the re-analysis result, **when** it is persisted, **then** it is an **ordinary**
   `MappingProposal`; "re-review" is the **ordinary review flow** over it (Phase-3 AS-*) — no auto-approval
   ([extensibility.md](../architecture/extensibility.md) *Spec update lifecycle* step 4).
4. **Given** the re-review's approval, **when** it is approved, **then** it yields the stale mapping's
   **successor** `ApprovedMapping` — a **new row** pinned to the new version, so the audit trail keeps
   exactly what was approved against which shape ([extensibility.md](../architecture/extensibility.md)
   *Successor adoption*; [glossary.md](../glossary.md) `Successor mapping`).
5. **Given** a scoped re-analysis or one of its detail calls **fails** its retry ceiling, **when** it does,
   **then** it is surfaced distinctly (`analysisFailed` on the pair) so the stale mapping's re-review is not
   silently lost — the same failure surfacing as a first-time analysis (Phase-2 TD-4; OB-5 alert).
6. **Given** the analysis is offloaded off the dispatcher transaction, **when** it runs, **then** it is
   idempotent and reconcilable (Phase-2 DT-2) — a lost trigger is re-derived by the sweep (RC-3).

### Out of scope

- Adopting the approved successor (re-pointing artifacts) — SL-7/SL-8. Suspend — SL-10.

### Dependencies

Blocked by SL-4, Phase-2 TD-2 (detail machinery + `priorFeedback`), Phase-3 (review flow). Precedes SL-7.

---

## SL-7 — Successor adoption: re-point in place, transfer the counterpart, supersede the stale row

**As a** landscape operator, **I** have re-approval replace a stale mapping in place across everything
derived from it — rather than starting the relationship over — **so that** a spec bump preserves the sync
and adapter relationships I already established.

### Acceptance criteria

1. **Given** a successor is **approved** (SL-6), **when** adoption runs, **then** the stale mapping's
   `SyncRule`s and `AdapterBinding`s are **re-pointed** (`approvedMappingId`) to the successor, and the
   stale row itself becomes **`superseded`** — retained for audit, never executed again
   ([extensibility.md](../architecture/extensibility.md) *Successor adoption*;
   [data-model.md](../architecture/data-model.md) `ApprovedMapping.status`).
2. **Given** adoption is triggered by the successor's `MappingApproved`, **when** it fires, **then** it is
   an ordinary consequence of human approval — adoption **never** runs without the successor having been
   reviewed and approved (the safety promise; SL-6 criterion 3).
3. **Given** the peer pair's cross-link, **when** adoption commits, **then** the `counterpartMappingId`
   pairing **transfers** to the successor (the link is defined over spec lineages), and a
   `counterpartMappingId` pointing at a now-`superseded`/`archived` row is updated/cleared accordingly
   ([extensibility.md](../architecture/extensibility.md) *Successor adoption*).
4. **Given** the **identity key** is a `FieldMapping` like any other, **when** the breaking change removed
   or retyped it, **then** the successor's rules stay **unenableable** until a new identity key is confirmed
   — adoption does not silently drop the identity guarantee
   ([extensibility.md](../architecture/extensibility.md) *Successor adoption*).
5. **Given** the **adapter half** of adoption, **when** the successor is adopted, **then** it drives the
   **already-built CO-7 `AdapterCompositionService.adoptSuccessor`** — re-pointing bindings in place,
   keeping composed configuration (incl. `chainInputs`), re-running composition validation against the
   successor's content, and flagging `composition-required` where an assumption no longer holds (never
   serving a broken config); this is the **live trigger** CO-7 was built and unit-tested (against a
   simulated succession) to receive ([phase-5-endpoint-composition.md](phase-5-endpoint-composition.md)
   CO-7; `apps/backend/src/modules/adapter-composition/adopt.ts`).
6. **Given** adoption commits, **when** downstream reactions run, **then** the affected endpoints' cached
   entries are dropped (XI-2 / CH-5.3 criterion 4) and the affected `GraphEdge`s recompute (GR-3),
   reflecting the successor.
7. **Given** adoption is deliberately **not** the "new binding attaches `proposed` → `composition-required`"
   path, **when** it runs, **then** the successor **takes over its predecessor's slot** rather than
   attaching as a genuinely-new correspondence (CO-7 criterion 2)
   ([extensibility.md](../architecture/extensibility.md) *Successor adoption*).

### Out of scope

- Preserving sync operational state + reconciling field pairs — SL-8. The CO-7 adapter behavior itself —
  already built (Phase-5); this story supplies its trigger.

### Dependencies

Blocked by SL-6, Phase-5 CO-7 (`adoptSuccessor`). **Supplies the Phase-6 succession trigger CO-7 consumes.**
Coupled to XI-2, GR-3. Precedes SL-8.

---

## SL-8 — Successor adoption: preserve sync operational state, reconcile `SyncFieldState`/`RecordLink`

**As a** landscape operator, **I** have adoption keep my rules' cursors, snapshots, and links, and keep
conflict detection well-defined across the field-pair change, **so that** a spec bump never forces a full
re-backfill.

### Acceptance criteria

1. **Given** the successor is adopted, **when** the re-pointed `SyncRule`s are updated, **then** they
   **keep** their cursor, snapshot, backfill status, and enablement — the operational state describes the
   *relationship*, which persisted through re-review; only the correspondence content changed
   ([extensibility.md](../architecture/extensibility.md) *Successor adoption*).
2. **Given** the rule's `pollOperationRef` is re-validated against the new version during adoption, **when**
   the ref is **still valid**, **then** the cursor and snapshot are **untouched**; **when** it **changed**,
   **then** it is re-confirmed with the **cursor cleared and the snapshot rebuilt** (SL-5 criterion 2)
   ([extensibility.md](../architecture/extensibility.md) *Successor adoption*).
3. **Given** `RecordLink`s and `SyncFieldState` are **app-pair-scoped**, **when** adoption runs, **then**
   they are **unaffected** as records — no link is severed and no record re-correlated
   ([extensibility.md](../architecture/extensibility.md) *Successor adoption*).
4. **Given** a field pair the successor **drops**, **when** adoption runs, **then** that field pair's
   `SyncFieldState` is **archived** (`status = archived`), retained but never read/written again
   ([extensibility.md](../architecture/extensibility.md) *Successor adoption*;
   [data-model.md](../architecture/data-model.md) `SyncFieldState.status`).
5. **Given** a field pair the successor **adds**, **when** adoption runs, **then** its baselines are
   **seeded by a scoped link-only pass** over existing `RecordLink`s (the same seeding backfill performs),
   so conflict detection is well-defined for it immediately — **no full re-backfill**
   ([extensibility.md](../architecture/extensibility.md) *Successor adoption*).
6. **Given** adoption is a single logical transition, **when** it partially fails (e.g. adapter validation
   flags `composition-required` while sync re-point succeeds), **then** the outcome is consistent and
   recoverable — a lost/half-applied adoption is re-derivable by the reconciliation sweep (RC-3), never a
   silently half-adopted mapping.

### Out of scope

- The adapter-side re-validation — SL-7 criterion 5 / CO-7. Building the link-only backfill seeding — Phase-4
  BE (reused here for the added field pairs).

### Dependencies

Blocked by SL-7, Phase-4 BE-* (link-only seeding), Phase-4 SD-2/SD-3 (`RecordLink`/`SyncFieldState`).
Coupled to RC-3.

---

## SL-9 — `analysisExclusions` re-inclusion triggers scoped incremental analysis

**As a** landscape operator, **I** have removing a resource group from a spec's `analysisExclusions`
re-open it for mapping, **so that** correcting an over-broad exclusion is not silent and does not require a
full re-analysis.

### Acceptance criteria

1. **Given** an operator removes a resource group from `ApiSpec.analysisExclusions`, **when** the change
   commits, **then** the Mapping Engine runs the **same scoped incremental analysis** as an additively-added
   resource group (SL-3): one scoped shortlist call for that resource's summary against each counterpart
   spec, then detail calls for whatever gets shortlisted ([mapping-engine.md](../architecture/mapping-engine.md)
   *Scoping down* — *Re-inclusion*).
2. **Given** re-inclusion, **when** it runs, **then** it produces an **ordinary** `MappingProposal` reviewed
   through the Phase-3 flow — re-inclusion is **not silent** and is **not** auto-approved
   ([mapping-engine.md](../architecture/mapping-engine.md) *Scoping down*).
3. **Given** exclusions govern **analysis only**, **when** a resource is re-included, **then** existing
   `MappingProposal`s and `ApprovedMapping`s are **untouched** — re-inclusion adds new review surface, it
   never pauses or removes what a human already approved
   ([mapping-engine.md](../architecture/mapping-engine.md) *Scoping down*).
4. **Given** the review-UI escape hatch, **when** a resource is **excluded**, **then** it is listed **as
   excluded** (distinct from "no counterpart shortlisted") and carries **no** "analyze anyway" action —
   re-inclusion is the only way to analyze it, keeping the operator's declared scope the single source of
   truth ([mapping-engine.md](../architecture/mapping-engine.md) *Scoping down*;
   [mapping-review-and-approval.md](../flows/mapping-review-and-approval.md)).
5. **Given** the re-inclusion count is observable, **when** a re-inclusion-triggered analysis runs, **then**
   it is countable for the mapping dashboard (`analysisExclusions` re-inclusions, OB-2)
   ([observability.md](../architecture/observability.md) *Metrics*).

### Out of scope

- Setting/removing exclusions in the UI at registration — Phase 1 SI-4 (this story adds the *re-inclusion
  trigger* over an already-registered spec).

### Dependencies

Blocked by SL-3 (shared scoped-analysis machinery), Phase-1 SI-4 (`analysisExclusions`). Coupled to OB-2.

---

## SL-10 — Manual suspend / resume of an `ApprovedMapping`

**As a** landscape operator, **I** can put a mapping on a deliberate hold and later resume it, **so that**
I can stop a mapping executing for an operational reason without deregistering apps or editing the mapping
— a hold distinct from spec-driven staleness.

### Acceptance criteria

1. **Given** an `active` `ApprovedMapping`, **when** an operator suspends it, **then** its `status` becomes
   `suspended`: its `SyncRule`s pause and its `AdapterBinding`s fail live calls with the distinct
   **`mapping-suspended`** error — a deliberate hold, distinct from `mapping-stale`'s pending re-review
   ([data-model.md](../architecture/data-model.md) `ApprovedMapping.status`;
   [glossary.md](../glossary.md) `mapping-suspended (error)`; RP-3).
2. **Given** a `suspended` mapping, **when** the operator **resumes** it, **then** its `status` returns to
   `active` and its rules/bindings resume under their stored state — resume is the exact inverse of suspend
   (no re-backfill, no re-composition).
3. **Given** suspend/resume are operator mutations, **when** a `viewer` attempts either, **then** it is
   rejected 403 and every suspend/resume is attributed to the authenticated operator in the audit log
   (OA-2/OA-3).
4. **Given** suspend/resume commit, **when** downstream reactions run, **then** the affected endpoints'
   cached entries are dropped (XI-2 / CH-5.3) and the affected `GraphEdge`s recompute (GR-2/GR-3) — a
   suspended relationship is never masked by cache or graph.
5. **Given** suspend is a **manual** hold, **when** a `SpecDiff` is later computed for the suspended
   mapping's spec, **then** the diff still classifies and (for a breaking change) can additionally mark it
   `stale` — the two conditions are independent, and resuming requires clearing whichever applies (a
   suspended-then-stale mapping needs re-review to reach `active`).

### Out of scope

- The `mapping-suspended` runtime response — Phase-5 RP-3 (already built; this story supplies the manual
  transition). Auto-suspend on any condition — there is none; suspend is always an explicit human action.

### Dependencies

Blocked by Phase-3 AM-*/OA-2 (`ApprovedMapping` domain + auth), Phase-5 RP-3 (`mapping-suspended` runtime).
Coupled to XI-2, GR-2/GR-3. **Completes the `suspend` transition Phase 3 deferred to "the final phase".**
