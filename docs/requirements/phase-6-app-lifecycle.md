# Phase 6 — App lifecycle (disable & deregister cascades)

Spec versioning (SL-*) covers an app that *changes*; two coarser transitions cover an app that goes
**away**, driven by `RegisteredApp.status`: **disable** (reversible) and **deregister** (destructive,
confirmed). Both cascade across the sync, adapter, graph, cache, and audit surfaces the earlier phases
built — this slice wires those cascades and the operator controls that trigger them.

**What already exists vs. what Phase 6 adds** (checked against `packages/db/src/schema.ts`,
`packages/domain/src`): `registered_app_status` is already `active | disabled` (so the disable state
exists, but nothing reacts to it); the archival statuses exist across the model — `ApiSpec.status`
(`active | superseded | archived`), `ApprovedMapping.status` (… `archived`), `SyncFieldState.status`
(`active | archived`), `ScopeLink.status` (… `archived`), and `ScopeLinkRepository.archiveByCorrespondence`
— so the **archive capability** is present, but the **deregister cascade that drives it** is not. Phase 5
already specified the **adapter-side** deregister effects (torn-down consumer surface, binding-less
endpoints reverting to `not-yet-mapped`, adapter-token revocation) as *behaviors* awaiting this cascade.
Phase 6 **adds** the disable-condition wiring, the deregister cascade orchestration, the re-registration
guard, and the operator API/UI. **No new entity or renamed status** is coined — deregister deletes some
rows and moves others to their existing `archived` status.

**Actor:** operator (disables/re-enables; deregisters with explicit confirmation); system (the cascades).

**Concept references (whole file):** [extensibility.md](../architecture/extensibility.md) *App lifecycle:
disable & deregister*; [data-model.md](../architecture/data-model.md) `RegisteredApp.status`,
`ApiSpec.status`, `ApprovedMapping.status = archived`, `RecordLink`/`SyncFieldState` `status = archived`,
`Credential`; [adapter-engine.md](../architecture/adapter-engine.md) *backend-disabled*, *not-yet-mapped*,
torn-down consumer surface; [security.md](../architecture/security.md) (adapter-token revocation with the
app; credential deletion; audit retained); [glossary.md](../glossary.md) `backend-disabled`,
`not-yet-mapped`, `Tombstone`. Reused seams: Phase-4 [sync-domain](phase-4-sync-domain.md) SD-1..SD-4
(`SyncRule` pause gate + `RecordLink`/`SyncFieldState`);
[phase-5-router-planner.md](phase-5-router-planner.md) RP-3 (`backend-disabled`),
[phase-5-adapter-runtime.md](phase-5-adapter-runtime.md) RT-3 (`not-yet-mapped`),
[phase-5-auth-gateway.md](phase-5-auth-gateway.md) AT-* (token revocation); scoped-sync SS-10.5
(`archiveByCorrespondence`); [phase-6-graph.md](phase-6-graph.md) GR-1 (edge removal),
[phase-6-cross-engine-invalidation.md](phase-6-cross-engine-invalidation.md) XI-2 (CH-5.3 cache drop on
disable/deregister).

> **Authoritative:** disable is **reversible** and touches no rule's own `status` (a derived, execution-time
> condition — a disabled app is simply no longer polled, and its bindings fail `backend-disabled`);
> re-enable resumes from stored cursors/snapshots with **no re-backfill**; deregister is **destructive and
> requires explicit confirmation**; the deregister cascade (delete rules/bindings, revert binding-less
> endpoints to `not-yet-mapped`, tear down a consumer surface + revoke its token, archive
> mappings/specs/links/field-state, clear counterpart links, **delete** credentials outright); a
> re-registration is a **new** `RegisteredApp` (no state resurrected). **Implementation choice:** the
> confirmation mechanism (open question 5), UI copy, cascade transaction boundaries.

---

## AL-1 — Disable an app (reversible) and re-enable it

**As a** landscape operator, **I** can take an app out of service without losing any of its sync/adapter
state, **so that** a temporary outage or maintenance window does not force a re-approval or re-backfill
when the app returns.

### Acceptance criteria

1. **Given** an `active` app that is a **source or target** of `SyncRule`s, **when** the operator disables
   it (`RegisteredApp.status = disabled`), **then** every such rule **stops executing** and the app is **no
   longer polled** — the pause touches **no** rule's own `status`; being disabled is a condition of the
   *app*, derived at execution time ([extensibility.md](../architecture/extensibility.md) *App lifecycle*).
2. **Given** a disabled app that backs `AdapterBinding`s, **when** a live adapter caller resolves to one of
   those bindings, **then** the request fails with the distinct **`backend-disabled`** cause, following the
   endpoint's normal role/strictness semantics (a `supplement` may degrade; a `primary`/load-bearing
   failure fails the request) ([extensibility.md](../architecture/extensibility.md) *App lifecycle*;
   [adapter-engine.md](../architecture/adapter-engine.md); RP-3).
3. **Given** the app is re-enabled, **when** the operator lifts the disable, **then** rules **resume under
   their stored `status`** and polling resumes from **stored cursors/snapshots** — **no separate
   re-backfill** is performed (re-enabling simply lifts the condition)
   ([extensibility.md](../architecture/extensibility.md) *App lifecycle*).
4. **Given** disable/enable are operator mutations, **when** a `viewer` attempts either, **then** it is
   rejected 403 and each transition is attributed to the authenticated operator in the audit log
   (OA-2/OA-3).
5. **Given** disable/enable commit, **when** downstream reactions run, **then** the disabled app's
   endpoints' cached entries are dropped (XI-2 / CH-5.3) and the affected `GraphEdge`s recompute (GR-2/GR-3)
   to reflect the paused dependency; the app **remains a node** (disable does not remove it) (GR-5.4).
6. **Given** disable is derived-at-execution, **when** the condition is evaluated, **then** it composes with
   the SL-4/SL-10 mapping conditions: a rule can be paused by an app disable, a stale/suspended mapping, or
   an unconfirmed ref simultaneously, and resumes only when **all** applicable conditions clear.

### Out of scope

- Deregistration (destructive) — AL-2. The `backend-disabled` runtime cause itself — Phase-5 RP-3 (this
  story supplies the app condition it reads).

### Dependencies

Blocked by Phase-4 (rule pause gate + cursors/snapshots), Phase-5 RP-3 (`backend-disabled`). Coupled to
XI-2, GR-2/GR-3, OB-1/OB-3 (per-app sync status).

---

## AL-2 — Deregister an app (destructive, confirmed) and cascade

**As a** landscape operator, **I** can remove an app from the landscape and have every dependent artifact
cleaned up deterministically, **so that** a departed app leaves no dangling rules, endpoints, credentials,
or graph edges — while the audit trail is preserved.

### Acceptance criteria

1. **Given** an app, **when** the operator deregisters it, **then** the action **requires explicit
   confirmation** before it proceeds (open question 5) — deregister is destructive, unlike the reversible
   disable ([extensibility.md](../architecture/extensibility.md) *App lifecycle*).
2. **Given** confirmation, **when** the cascade runs, **then** the app's `SyncRule`s and `AdapterBinding`s
   are **deleted**, and any `AdapterEndpoint` left with **no** bindings reverts to serving `not-yet-mapped`
   ([extensibility.md](../architecture/extensibility.md) *App lifecycle*;
   [adapter-engine.md](../architecture/adapter-engine.md) *not-yet-mapped*; RT-3).
3. **Given** the deregistered app itself registered a **`CONSUMER`** spec, **when** the cascade runs,
   **then** its **adapter server is torn down** — its `AdapterEndpoint`s and their bindings are deleted, the
   spec's surface stops being served entirely (callers now hit **nothing**, not `not-yet-mapped`), and the
   **adapter token is revoked** with the app ([extensibility.md](../architecture/extensibility.md) *App
   lifecycle*; [security.md](../architecture/security.md); AT-*).
4. **Given** `ApprovedMapping`s involving the app, **when** the cascade runs, **then** they are **archived**
   (`status = archived`) — retained for audit, never executed again — and `counterpartMappingId` links
   pointing at archived rows are **cleared**; the app's `ApiSpec`s are **archived** the same way (archived
   mappings still pin them, so they stay resolvable for audit)
   ([extensibility.md](../architecture/extensibility.md) *App lifecycle*;
   [data-model.md](../architecture/data-model.md) `ApiSpec.status`, `ApprovedMapping.status`).
5. **Given** `RecordLink`s and `SyncFieldState` involving the app, **when** the cascade runs, **then** they
   are **archived** (`status = archived`) — deliberately **not** tombstoned, since no record was deleted;
   the app left the landscape — and any scoped `ScopeLink`s/`ScopeCorrespondence` for the app are archived
   (reusing `ScopeLinkRepository.archiveByCorrespondence`)
   ([extensibility.md](../architecture/extensibility.md) *App lifecycle*;
   [glossary.md](../glossary.md) `Tombstone` — contrast).
6. **Given** the app's `Credential`s, **when** the cascade runs, **then** they are **deleted from the
   Credential Store outright** (not archived), while the **audit log retains all historical events**
   ([extensibility.md](../architecture/extensibility.md) *App lifecycle*;
   [security.md](../architecture/security.md)).
7. **Given** the cascade commits, **when** downstream reactions run, **then** the deregistered app is
   **removed from the graph** — its node and all its edges are gone (GR-1 removal / GR-5.4), and the
   affected endpoints' cached entries are dropped (XI-2 / CH-5.3).
8. **Given** deregister is an operator mutation, **when** a `viewer` attempts it, **then** it is rejected
   403, and the deregistration (with its cascade summary) is attributed to the authenticated operator in
   the audit log (OA-2/OA-3).

### Out of scope

- Re-registration behavior — AL-3. The `not-yet-mapped` / token-revocation runtime behavior itself — Phase-5
  RT-3/AT-* (this story supplies the cascade that produces those conditions).

### Dependencies

Blocked by Phase-4 (rules/links/field-state), Phase-5 RT-3/AT-* (adapter surface + token), scoped-sync
SS-10.5 (`archiveByCorrespondence`). Coupled to GR-1 (edge removal), XI-2 (CH-5.3). Precedes AL-3.

---

## AL-3 — Re-registration is a new `RegisteredApp` (no state resurrection)

**As a** landscape operator, **I** have re-registering a previously-deregistered system establish a clean
relationship, **so that** stale identity or sync state is never silently resurrected under a returning app.

### Acceptance criteria

1. **Given** a system that was previously deregistered, **when** the same system is registered again,
   **then** it becomes a **new** `RegisteredApp` with a new id — **no** identity, `RecordLink`,
   `SyncFieldState`, `ScopeLink`, mapping, or credential from the prior registration is reused or reactivated
   ([extensibility.md](../architecture/extensibility.md) *App lifecycle*).
2. **Given** the new registration, **when** its first mapping is approved and a `SyncRule` enabled, **then**
   a **fresh initial backfill** re-establishes links deliberately (Phase-4 BE-*) — links are re-derived, not
   inherited from the archived prior state ([extensibility.md](../architecture/extensibility.md) *App
   lifecycle*).
3. **Given** the archived rows from the prior registration, **when** the new app is queried/executed,
   **then** those archived `ApprovedMapping`s / `RecordLink`s / `SyncFieldState` / `ApiSpec`s remain
   **archived and audit-only** — visible in history, never read or written by the new app.
4. **Given** the audit log, **when** the same system is registered, deregistered, and re-registered, **then**
   the full historical event sequence is retained across all three, distinguishable by the `RegisteredApp`
   id each event belongs to ([security.md](../architecture/security.md); audit retained).

### Out of scope

- The registration flow itself — Phase-1 AR-* (this story only guards that a re-registration does **not**
  resurrect state).

### Dependencies

Blocked by AL-2, Phase-1 AR-* (registration), Phase-4 BE-* (backfill). No downstream dependents.

---

## AL-4 — Disable / deregister API + UI (with confirmation)

**As a** landscape operator, **I** can disable, re-enable, and deregister an app from the UI, with the
destructive action guarded, **so that** lifecycle transitions are deliberate and their cascade is visible
before I commit.

### Acceptance criteria

1. **Given** the app detail screen, **when** an operator opens it, **then** it exposes **disable/enable**
   (reversible) and **deregister** (destructive) actions, gated to `operator` (a `viewer` sees them
   disabled/absent) (OA-2; [glossary.md](../glossary.md) *Operator / Viewer*).
2. **Given** the operator triggers **deregister**, **when** the action is initiated, **then** the UI
   requires an **explicit confirmation** and states the cascade that will run (rules/bindings deleted,
   endpoints reverted/torn down, mappings/specs/links archived, credentials deleted) before it commits
   (open question 5) ([extensibility.md](../architecture/extensibility.md) *App lifecycle*).
3. **Given** the operator triggers **disable**, **when** the action commits, **then** it takes effect
   without a destructive-confirmation step (it is reversible) and the app's status flips to `disabled` in
   the list/detail views.
4. **Given** either transition commits, **when** the operator returns to the graph, **then** it reflects the
   change (a disabled app still a node with paused edges; a deregistered app gone) (GR-5.4/GR-6).
5. **Given** the frontend convention, **when** the screens are built, **then** they use Vue 3 with
   `<script setup lang="ts">` (Composition API), no Options API (CLAUDE.md).
6. **Given** a capstone e2e, **when** a scenario app with an enabled sync rule and a composed adapter
   endpoint is disabled, **then** its rule stops polling and its endpoint returns `backend-disabled`; when
   it is **re-enabled**, polling resumes from the stored cursor with no re-backfill — proving AL-1 end to
   end; a separate deregister case proves the cascade (rules/endpoints gone, credential deleted, node
   removed from the graph).

### Out of scope

- The cascade logic itself — AL-1/AL-2 (this story is the thin HTTP + UI over them).

### Dependencies

Blocked by AL-1, AL-2, Phase-3 OA-2. UI blocked by GR-6 (for the graph-reflects-change criterion).
