# Phase 1 — Resource bindings (derive-then-correct)

Deriving each `ApiSpec` resource's operational bindings by heuristic at ingestion — **unconfirmed**
— and letting the operator confirm or correct them. OpenAPI declares none of these conventions
(record ids, collection reads, pagination, delta cursors, deletion reporting, change timestamps), so
the mediator guesses mechanically and a human ratifies. Phase 1 captures the confirmation state;
the refs are first *used* in Phase 4.

**Actor:** operator (confirm/correct), viewer (read).

**Concept references (whole file):** [data-model.md](../architecture/data-model.md) `ResourceBinding`
and `RegisteredApp.capabilities`; [glossary.md](../glossary.md) `ResourceBinding`; [sync-engine.md](../architecture/sync-engine.md)
(where refs are consumed — Phase 4 context only). Scenario fixtures:
[scenario-1 ground-truth](../../scenarios/scenario-1-small-overlap/ground-truth.yaml).

> **Heuristic field names are implementation-defined.** The concept gives examples ("a field named
> `id`", "parameters named `page`/`cursor`/`limit`", "a field named `updatedAt`") but does not fix
> them. Criteria state the heuristic *behaviorally* and always as an initial **unconfirmed** guess;
> exact field-name lists are an implementation choice.

---

## RB-1 — Derive unconfirmed `ResourceBinding`s at ingestion

**As an** operator, **I can** have each resource's operational bindings guessed automatically when a
spec is ingested, **so that** I start from mechanical defaults instead of a blank slate — while
nothing is trusted until I confirm it.

### Acceptance criteria

1. **Given** a spec is ingested into `n` resource groups, **when** ingestion completes, **then** one
   `ResourceBinding` is created per resource group, each with a generated `id`, the owning
   `apiSpecId`, and the group's `resourceRef`.
2. **Given** a resource's representation, **when** its binding is derived, **then** `nativeIdRef` is
   guessed by heuristic to the field that carries the record's native id (e.g. a field named `id`),
   left **unconfirmed**.
3. **Given** a resource that offers a collection (list) read operation, **when** its binding is
   derived, **then** `collectionReadRef` is guessed to that operation, **unconfirmed**; **given** a
   resource with no collection read, **then** `collectionReadRef` is absent.
4. **Given** a collection read that exposes paging parameters, **when** the binding is derived,
   **then** `paginationRef` is guessed from the paging parameters and exhaustion convention (e.g.
   parameters named `page`/`cursor`/`limit`, "empty page ends"), **unconfirmed**; **given** a
   collection read that returns the full result in one response, **then** `paginationRef` is absent.
5. **Given** the owning app declares `supportsChangeTimestamps`, **when** the binding is derived,
   **then** `changeTimestampRef` is guessed to the record's change-timestamp field (e.g. a field
   named `updatedAt`), **unconfirmed**; **given** the app does not declare `supportsChangeTimestamps`,
   **then** `changeTimestampRef` is treated as not-meaningful for that resource.
6. **Given** the owning app declares `supportsDeltaQuery`, **when** the binding is derived, **then**
   `deltaCursorRef` and `deltaDeletionRef` are guessed where the resource offers a delta operation,
   **unconfirmed**; **given** the app does not declare `supportsDeltaQuery`, **then** both are
   treated as not-meaningful for that resource.
7. **Given** any derived binding, **when** created, **then** every ref present carries
   `confirmedBy = null` and `confirmedAt = null` — all derivations start **unconfirmed**.
8. **Given** the vendored scenario-1 trimmed Gitea `PROVIDER` spec, **when** the `issues` resource's
   binding is derived, **then** `nativeIdRef` guesses the `id` field, **unconfirmed**, and
   `collectionReadRef` guesses a collection GET for issues (e.g.
   `GET /repos/{owner}/{repo}/issues`), **unconfirmed** — demonstrating the derive step produces a
   ratifiable guess, not a decision. (The identity key `title` from the ground truth is a *mapping*
   concern, Phase 3 — distinct from the native id here.)
9. **Given** the vendored scenario-1 trimmed Vikunja `tasks` resource, **when** its binding is
   derived, **then** `collectionReadRef` guesses the param-free `GET /tasks`, **unconfirmed**, and
   `changeTimestampRef` guesses `updated` if and only if Vikunja was registered with
   `supportsChangeTimestamps` (per its ground-truth `changeTimestamp.target: updated`).

### Security / invariant criteria

10. **Given** any unconfirmed ref, **when** the system operates in Phase 1, **then** the ref is used
    nowhere — it is a proposal awaiting operator confirmation. (Phase 1 has no consumers of these
    refs; the invariant is that a derived value is never treated as authoritative without
    confirmation. Enforcement at rule enablement is Phase 4 — [sync-engine.md](../architecture/sync-engine.md).)

### Out of scope

- Using any confirmed ref (polling, backfill, snapshot keying, fetch-and-match, delta cursors,
  deletion detection, change-timestamp conflict resolution) — Phase 4
  ([sync-engine.md](../architecture/sync-engine.md)).
- Returning a ref to unconfirmed on a breaking spec change, and carry-forward across versions —
  Phase 6 ([extensibility.md](../architecture/extensibility.md)).

### Dependencies

Blocked by SI-1 (resource groups) and SI-2 (stored `ApiSpec`). Runs as part of ingestion within AR-1.

---

## RB-2 — Confirm or correct `ResourceBinding` refs

**As an** operator, **I can** confirm each derived ref or correct it to the right field/parameter/
operation, **so that** the mediator only ever acts on human-ratified operational bindings.

### Acceptance criteria

1. **Given** a `ResourceBinding` with an unconfirmed ref, **when** the operator confirms it via
   `PATCH /resource-bindings/:id`, **then** that ref's `confirmedBy` is set to the operator identity
   and `confirmedAt` to the confirmation time, with the ref value unchanged.
2. **Given** a `ResourceBinding` whose heuristic guessed the wrong element, **when** the operator
   corrects a ref to a different field/parameter/operation and confirms, **then** the ref's value is
   updated **and** `confirmedBy`/`confirmedAt` are set in the same action.
3. **Given** a binding has multiple refs, **when** the operator confirms one, **then** confirmation
   is **per-ref**: confirming `nativeIdRef` does not implicitly confirm `collectionReadRef`,
   `paginationRef`, or any other ref.
4. **Given** a correction that names a field/parameter/operation not present in the spec's IR for
   that resource, **when** applied, **then** it is rejected with a validation error.
5. **Given** a ref that is not meaningful for the resource (e.g. `deltaCursorRef` when the app does
   not declare `supportsDeltaQuery`), **when** the operator attempts to confirm it, **then** the
   action is rejected or the ref is presented as not-applicable — a not-meaningful ref is never
   confirmed into use.
6. **Given** a `GET /specs/:id/ir` or a bindings read endpoint, **when** returning binding state,
   **then** each ref reports its current value and its `confirmedBy`/`confirmedAt` (or unconfirmed),
   so a caller can tell confirmed from unconfirmed.

### Security / invariant criteria

7. **Given** confirmation is a mutation, **when** performed, **then** it records the acting operator
   identity in `confirmedBy` (real attributed identity — [security.md](../architecture/security.md)
   *Operator authentication*); a `viewer` cannot confirm.

### Out of scope

- Rule-enablement gating that *requires* specific confirmed refs before a `SyncRule` runs — Phase 4
  ([sync-engine.md](../architecture/sync-engine.md); [data-model.md](../architecture/data-model.md)
  `SyncRule`). Phase 1 captures confirmation; it enforces no downstream gate yet.

### Dependencies

Blocked by RB-1.

---

## RB-3 — `ResourceBinding` confirmation panel UI

**As an** operator, **I can** review each resource's derived bindings in one panel and confirm or
correct them, **so that** I can see at a glance which operational bindings are still unconfirmed.

### Acceptance criteria

1. **Given** a spec's resources, **when** the confirmation panel renders, **then** for each resource
   it lists every applicable ref (`nativeIdRef`, `collectionReadRef`, `paginationRef`,
   `deltaCursorRef`, `deltaDeletionRef`, `changeTimestampRef`) with its heuristic guess and a
   confirmed/unconfirmed indicator.
2. **Given** a ref shown in the panel, **when** the operator confirms it, **then** the panel issues
   `PATCH /resource-bindings/:id` (RB-2) and reflects the new confirmed state.
3. **Given** a ref shown in the panel, **when** the operator corrects it, **then** the panel lets
   them pick a different field/parameter/operation from that resource's IR and confirm the
   correction in one action.
4. **Given** a resource with unconfirmed refs, **when** the panel renders, **then** it makes the set
   of still-unconfirmed refs visually distinguishable (this is the same signal a Phase 4
   rule-enablement UI will consume).
5. **Given** a ref that is not meaningful for a resource (per the app's `capabilities`), **when** the
   panel renders, **then** it presents that ref as not-applicable rather than as an unconfirmed
   actionable guess.

### Out of scope

- Rule-enablement UI listing "which refs a rule still needs" — Phase 4 ([sync-engine.md](../architecture/sync-engine.md)).

### Dependencies

Blocked by RB-2, SI-3 (IR for the correction picker).
