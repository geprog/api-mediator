# Deferred feature — Scoped / hierarchical resource sync

The highest-impact Phase-4 deferred item, now in its full shape. It began as "constant path-parameter
binding" (fix a Gitea `/repos/{owner}/{repo}/issues/{index}` scope param to a literal) and generalizes
to **scoped resource sync**: a record lives inside a **container** (a Gitea issue in a repo, a Vikunja
task in a project), the container is itself a path parameter (`{owner}`/`{repo}`, project `{id}`), and
the same logical container has **different ids in the two apps** (Gitea repo `alice/phoenix` is Vikunja
project id `42`). Sync must (a) fill each scoped operation's non-record-id path parameters, and (b)
translate a record's *source* container to its *target* container. Because peer-peer sync now fills
target path parameters from more than the record id, it acquires **parameter-level bindings** it did
not have before — reconciled honestly against the data model (`ParameterMapping` stays the Adapter's
inbound-request mechanism; scope filling is a new operational/identity binding).

This is a **sizable feature that warrants phase-style treatment** (new entity, new discovery pipeline,
resolver, gate, UI, lifecycle) but is designed to ship in **three layers** so scope can be approved and
delivered incrementally.

**Actor:** operator (supplies/confirms scope bindings + scope identity keys, links containers, enables
rules); system (derives scope sets, discovers/resolves `ScopeLink`s, enumerates + polls scopes,
substitutes at resolution, gates at enablement); viewer (read-only).

**Concept references (whole file):** [data-model.md](../architecture/data-model.md) `ResourceBinding`
(`scopePathBindings`, `sourceScopeRef`), `ScopeLink`, `RecordLink`, `OperationMapping.targetIdParamRef`,
`ParameterMapping`, `SyncRule`, `FieldMapping.isIdentityKey`;
[sync-engine.md](../architecture/sync-engine.md) *Change detection*, *Identity correlation*, *Change
types*, *Ordering and consistency* (scoped record identity), *Initial backfill*;
[extensibility.md](../architecture/extensibility.md) *Spec update lifecycle*;
[security.md](../architecture/security.md) (scope values are operator config, not secrets);
[glossary.md](../glossary.md) `scope path-parameter binding`, `ScopeLink`, `scope identity key`.
Reused: [phase-1-resource-bindings.md](phase-1-resource-bindings.md) RB-1/2/3;
[phase-4-backfill-enablement.md](phase-4-backfill-enablement.md) BE-1/BE-2;
[phase-4-identity-record-link.md](phase-4-identity-record-link.md) RL-*;
[phase-4-ordering-queue.md](phase-4-ordering-queue.md) OQ-*;
[phase-4-sync-ui.md](phase-4-sync-ui.md) SU-1/SU-2/SU-5/SU-6. Real-spec evidence:
`scenarios/scenario-1-small-overlap/specs/oas3/{gitea,vikunja}.trimmed.oas3.json` +
[ground-truth.yaml](../../scenarios/scenario-1-small-overlap/ground-truth.yaml). Resolvers
`packages/outbound/src/binding-resolvers.ts`; backstop `packages/outbound/src/rest-single-record-reader.ts`.

> **Authoritative:** a scope value is *operator-supplied/confirmed or resolved through a confirmed
> `ScopeLink`* before use; an unconfirmed/unresolved scope is *used nowhere* (resolver refuses,
> backstop throws — never a fabricated URL, never a fabricated not-found); the record-id parameter is
> *never* filled from a scope, and a scope is *never* filled from the `RecordLink`; record-level
> identity matching under scoping is *always* scoped to the resolved container. **Implementation
> choice:** field names, heuristic candidates, UI copy, exact discovery scheduling.

---

## Real-spec analysis + read-side recommendation (Gitea + Vikunja, scenario-1)

Verified against the trimmed OAS3 specs and ground truth:

- **Records self-carry their scope.** A Gitea `Issue` carries `repository → { owner, name, full_name, id }`;
  a Vikunja `Task` carries `project_id`. So the read side can capture each record's container from a
  **scope-source field path** without a separate lookup.
- **A cross-scope source read exists.** Gitea `GET /repos/issues/search` (`issueSearchIssues`) returns
  issues across *all* repos, each with `repository.owner/name`, and exposes `since`/`before`
  (changed-since = delta) + `page`/`limit`. Its path has **no** `{owner}/{repo}`.
- **Scoping is asymmetric per operation.** Vikunja `POST /tasks/{id}` (update) and `DELETE /tasks/{id}`
  need only the record id; but `PUT /projects/{id}/tasks` (**create**) needs the project `{id}`. Gitea's
  issue ops are all repo-scoped.
- **Value-spaces are arbitrary.** Gitea repo `alice/phoenix` ↔ Vikunja project **id 42**: create
  genuinely needs a container correspondence, not a shared value. Vikunja **does** offer `GET /projects`
  (target containers are enumerable); the **trimmed Gitea spec has no repo-list** (source containers are
  not enumerable there — only `/repos/issues/search` and scoped paths).

**Read-side recommendation (feasible, and my recommended default): cross-scope collection read +
record-carried scope-source, single cursor.** Pin `pollOperationRef = GET /repos/issues/search`; capture
each issue's scope from `repository.owner`+`repository.name` (the source resource's `sourceScopeRef`);
the Poller keeps its **existing single per-rule `cursor`/snapshot unchanged** (native id keyed globally;
`since`/`before` gives delta). The write side translates each record's captured source scope → target
project via the `ScopeLink` (repo → project) and fills `PUT /projects/{id}/tasks`'s `{id}`. This is the
least-invasive mechanism, needs **no** per-scope cursor/snapshot, and works on the *trimmed* spec (which
cannot enumerate repos).

**Read-side fallback (the human's literal "list scopes, then poll each"): per-scope enumeration,
per-scope cursor/snapshot.** When the source offers **no** cross-scope read (only
`/repos/{owner}/{repo}/issues`), the Poller enumerates source containers (a container `collectionReadRef`
on the container resource — present in the *full* Gitea spec, absent in the trimmed one), resolves each
`ScopeLink`, and polls each scope's scoped read filling its scope path params per container — keeping a
**cursor + snapshot per scope**. Heavier (N polls, per-scope state); use only where no cross-scope read
exists. Where neither a cross-scope read nor an enumerable container resource exists, the scope set is
whatever the operator has pinned as `constant`/`manual` `ScopeLink`s.

**Feasibility verdict:** end-to-end scenario-1 sync is feasible. The **single-repo** case is fully served
by Layer 1 (constants) and **drops the SU-6 hand-authored IR workaround**. **Multi-repo → multi-project**
is served by Layer 3 via the cross-scope read + `ScopeLink(repo→project)`; per-scope enumeration is a
general fallback but not exercisable against scenario-1's *trimmed* source (no repo-list).

## Design decisions (coordinator's six questions)

1. **Scope correspondence = new entity `ScopeLink`** (instances) under a new **`ScopeCorrespondence`** (config,
   the finalized home of the **scope identity key** — see the *Finalized L3 decisions* box in Layer 3), not a
   `RecordLink` extension. Structurally identical to `RecordLink` (two apps' own ids, established by
   constant/identity-match/manual, resource-pair-scoped) but a different granularity/key/lifecycle; repos↔projects
   is explicitly **not** an `ApprovedMapping`. Discovered (list source + target containers + match) or harvested
   from record-carried scope where a container-list op is absent. **Delete routing:** `RecordLink` gains
   `scopeRef` (persisted container at establishment) so a delete — which has no captured scope — still routes;
   this also fixes the L2 record-derived-delete gap.
2. **Per-param binding references its source via a discriminated union** on `ResourceBinding.scopePathBindings`:
   `constant` (literal) | `record-derived` (`sourceScopeKey` selecting a component of the source
   resource's `sourceScopeRef`, shared value-space) | `scope-link` (`scopeKeyRef` into the resolved
   `ScopeLink`). Exact shape in `data-model.md` `ResourceBinding`.
3. **Poll enumeration:** prefer cross-scope read + record-carried scope-source (single cursor, unchanged Poller);
   fall back to per-scope enumeration (container `collectionReadRef` + per-scope cursor/snapshot) only where no
   cross-scope read exists. See the analysis above.
4. **Record identity under scoping is scope-qualified.** Match/lookup runs *within* the resolved target container;
   the pre-link ordering-queue key becomes `(scope, identity-value)`; the ambiguous-match guard runs within the
   scope; snapshot keys by globally-unique native id (unchanged).
5. **Enablement gate:** a scoped rule needs its scope bindings confirmed; for any `scope-link` binding, the scope
   identity key confirmed and the relevant `ScopeLink`(s) resolvable (constant/manual present, or discovery
   viable); for per-scope enumeration, the container `collectionReadRef` confirmed. UI: SU-1/SU-5 surface these as
   blockers; a container-linking screen mirrors SU-2.
6. **Layers (clean edges):** **L1** single-scope constants (drops SU-6 workaround, one-repo↔one-board); **L2**
   record-carried scope with shared value-space (cross-scope read, single cursor, no `ScopeLink`); **L3** explicit
   `ScopeLink` + discovery + per-scope polling + scoped record identity (true multi-scope).

---

# Layer 1 — Single-scope constants (`kind: constant`)

Ships first, standalone. Unblocks one-repo↔one-board Gitea↔Vikunja sync and **removes the SU-6
hand-authored `issues` IR workaround**. This is the original constant-path-parameter-binding work, framed
as the `constant` kind of a scope binding.

## SS-1 — Domain + persistence: `ResourceBinding.scopePathBindings` (constant kind)

**As an** operator, **I** have scope path-parameter constants persisted as confirmable per-parameter
bindings, **so that** the values needed to reach a scoped app are stored with the same discipline as
every other operational binding.

### Acceptance criteria

1. **Given** a `ResourceBinding`, **when** the domain model is extended, **then** it carries
   `scopePathBindings`: a collection of per-parameter entries keyed by parameter name; empty for a
   resource with no non-record-id path parameter ([data-model.md](../architecture/data-model.md)
   `ResourceBinding`).
2. **Given** an entry, **when** modeled, **then** it is a discriminated union over `kind`; Layer 1
   implements `kind: "constant"` with `{ parameterName, value, confirmedBy, confirmedAt }`, where
   `parameterName` is a path parameter present in the resource's IR and `value` is a literal string.
3. **Given** a `constant` entry, **when** validated, **then** only `parameterName` is validated against
   the IR (contrast RB-2 criterion 4); `value` is a free literal, not an IR pointer.
4. **Given** `confirmedBy`/`confirmedAt`, **when** modeled, **then** both are null while unconfirmed and
   both set together on confirmation — mirroring `ConfirmableRef`.
5. **Given** two confirmed constants (`owner`, `repo`), **when** persisted and reloaded (a migration adds
   the field), **then** both round-trip identically, independently confirmable.

### Out of scope

- Deriving the required set — SS-2. The confirm action — SS-3. Non-constant kinds — Layers 2/3.

### Dependencies

Blocked by Phase-1 RB-1. Precedes SS-2, SS-3, SS-4.

---

## SS-2 — Derive the scope-parameter set at ingestion (unconfirmed)

**As an** operator, **I** have the mediator work out *which* path parameters are scope parameters at
ingestion, **so that** I start from a concrete list instead of a blank slate — nothing used until
confirmed.

### Acceptance criteria

1. **Given** a spec is ingested (extends RB-1), **when** a resource's binding is derived, **then** it
   enumerates path parameters across the resource's operations, **subtracts the record-id parameter**,
   and creates one **unconfirmed** entry per remaining distinct parameter name (default `kind: constant`).
2. **Given** a derived entry, **when** created, **then** `confirmedBy`/`confirmedAt` are null and the
   `constant` value is empty (or a heuristic candidate from a single-value `enum`/`default`/`example`/
   server-variable default — still unconfirmed).
3. **Given** the scenario-1 trimmed Gitea `issues` resource, **when** its binding is derived, **then** it
   yields unconfirmed scope entries for `owner` and `repo` and **none** for `{index}` (the record id).
4. **Given** the scenario-1 trimmed Vikunja `tasks` resource, **when** its binding is derived, **then**
   the id-only/param-free ops (`GET /tasks`, `/tasks/{id}`) yield **no** scope entry, while the
   create op `PUT /projects/{id}/tasks` yields an unconfirmed scope entry for its project `{id}`
   — demonstrating **per-operation asymmetric scoping** within one resource.
5. **Given** any unconfirmed scope entry, **when** the system operates, **then** it is used nowhere
   (mirrors RB-1 criterion 10).

### Out of scope

- Supplying/confirming the value — SS-3. Substitution — SS-4.

### Dependencies

Blocked by SS-1, Phase-1 RB-1. Precedes SS-3, SS-5.

---

## SS-3 — Supply + confirm a scope constant

**As an** operator, **I** can supply and confirm the literal for each scope parameter, **so that** the
mediator only ever substitutes human-ratified scope values.

### Acceptance criteria

1. **Given** an unconfirmed `constant` entry, **when** the operator supplies a value and confirms it via
   the binding confirm/correct action (extends RB-2 `PATCH /resource-bindings/:id`), **then** `value` is
   set and `confirmedBy`/`confirmedAt` are stamped in the same action.
2. **Given** several scope parameters, **when** one is confirmed, **then** confirmation is **per
   parameter** (mirrors RB-2 criterion 3).
3. **Given** a confirm with an empty value, **when** attempted, **then** it is **rejected** — a scope
   binding cannot be confirmed into use without a value.
4. **Given** a correction naming a `parameterName` absent from the resource's IR, **when** applied,
   **then** it is rejected (as RB-2 criterion 4); a supplied *value* is accepted as a free literal.
5. **Given** confirmation is a mutation, **when** performed, **then** the operator identity is recorded
   in `confirmedBy`; a **viewer cannot** confirm ([security.md](../architecture/security.md)).
6. **Given** a bindings read endpoint, **when** it returns state, **then** each scope entry reports its
   parameter, kind, value, and confirmed/unconfirmed state.

### Out of scope

- UI — SS-6. The enablement check — SS-5.

### Dependencies

Blocked by SS-1, SS-2, Phase-1 RB-2. Precedes SS-4, SS-5, SS-6.

---

## SS-4 — Resolver substitution (constant) + the backstop

**As an** operator, **I** have the binding resolvers substitute confirmed constants into every scoped
outbound path while the record-id parameter still comes from the `RecordLink`, **so that** scoped
operations resolve to real URLs and an unconfirmed scope never fabricates one.

### Acceptance criteria

1. **Given** a source-read binding (`resolveSourceReadBinding`), **when** the poll operation carries scope
   path parameters, **then** each is filled from the **source** resource's confirmed `constant` bindings;
   the composed `path` contains no `{…}`.
2. **Given** a write binding (`resolveWriteOperationBinding`), **when** the target op carries scope path
   parameters, **then** each **non-id** parameter is filled from the **target** resource's confirmed
   `constant` bindings, while the record-id parameter (`OperationMapping.targetIdParamRef`) stays
   templated for the per-record id-fill.
3. **Given** a single-record target read (`resolveSingleRecordReadBinding`/`resolveSingleRecordRead`,
   CF-5/CF-6), **when** it carries scope path parameters, **then** each non-id parameter is filled from
   the target's confirmed `constant` bindings; the id parameter stays templated.
4. **Given** a non-id path parameter with **no confirmed** binding, **when** a binding is composed,
   **then** the resolver returns `undefined` (never fabricated) — defense-in-depth behind the gate (SS-5).
5. **Given** an unfilled `{…}` non-id parameter reaches the outbound reader/executor, **when** the
   request is built, **then** it **throws** rather than sending a literal `{owner}` (the existing
   `rest-single-record-reader.ts` guard; equivalent guards added to the source reader and write
   executor) — a 404 is never fabricated into a not-found.
6. **Given** scenario-1 Gitea with confirmed `owner = alice`/`repo = phoenix`, **when** bindings are
   composed, **then** the source poll path resolves to `/repos/alice/phoenix/issues…` and the target
   update path to `/repos/alice/phoenix/issues/{index}` with `{index}` filled per record from the
   `RecordLink` — the SU-6 hand-authored `issues` group is no longer required.

### Out of scope

- Resolver execution-detail config (`defaultPageSize`, delta cursor path — `BindingResolverOptions`) — a
  distinct deferred item. Non-constant kinds — Layers 2/3.

### Dependencies

Blocked by SS-1, SS-3, Phase-4 SP-2/OC-1/CF-5. Precedes SS-6; unblocks a constant-only SU-6.

---

## SS-5 — Enablement gate: required scope bindings (constant)

**As an** operator, **I** can only enable a scoped `SyncRule` once every scope parameter of the
operations it calls is confirmed, **so that** a rule never goes live to fail on a literal `{owner}`.

### Acceptance criteria

1. **Given** enable (extends BE-2), **when** the gate checks bindings, **then** it is rejected unless
   every scope path parameter of the operations the rule will call has a confirmed binding: source poll
   (`pollOperationRef`), backfill collection read (`collectionReadRef`), the target identity-lookup
   collection read (whenever the lookup path **issues** it — both `fetch-and-match` and `filtered-read`
   run `GET <collectionRead>[?<lookupParam>=…]`, resolved with the target binding's scope), and the target
   create/update/delete for what it propagates.
2. **Given** the rule needs a single-record target read (PUT read-carry / `read-before-write`), **when**
   the gate runs, **then** that read's scope parameters must also be confirmed.
3. **Given** an operation whose only path parameter is the record id, **when** the gate checks it,
   **then** it contributes **no** required scope binding.
4. **Given** an unconfirmed required scope binding, **when** enable is attempted, **then** it is blocked
   and appears in the "still needs" list (extends BE-1/BE-2) with the parameter and its resource named.
5. **Given** source-vs-target sidedness, **when** the gate evaluates, **then** a source-operation scope
   parameter is checked on the source binding, a target-operation one on the target binding.

### Out of scope

- `scope-link`/scope-identity-key preconditions — Layer 3 (SS-15).

### Dependencies

Blocked by SS-3, SS-4, Phase-4 BE-1/BE-2. Precedes SS-6.

---

## SS-6 — UI: scope-binding blocker + supply (constant)

**As an** operator, **I** see which scope parameters a rule still needs and supply their values, **so
that** I can unblock enablement — reusing the Phase-1 binding panel.

### Acceptance criteria

1. **Given** a rule blocked on a scope binding (SS-5), **when** the enablement panel renders (extends
   SU-1/SU-5), **then** each such parameter is a blocker linking to the Phase-1 binding panel (RB-3).
2. **Given** the binding panel (RB-3), **when** it renders a `constant` scope parameter, **then** it
   offers an **input for the value** plus a confirmed/unconfirmed indicator — a value to supply, not a
   ref to ratify.
3. **Given** the operator supplies + confirms, **when** they return, **then** the enablement checklist
   reflects the satisfied item (mirrors SU-5 criterion 3).
4. **Given** a `viewer`, **when** they open either panel, **then** it is read-only.
5. **Given** the panels render, **when** they load, **then** they show no live payload/credential values
   ([security.md](../architecture/security.md)) — the constant is operator config, shown as entered.

### Out of scope

- Kind-selection UI (`record-derived`/`scope-link`) and container linking — Layers 2/3.

### Dependencies

Blocked by SS-3, SS-5, Phase-4 SU-1/SU-5, Phase-1 RB-3.

---

# Layer 2 — Record-carried scope, shared value-space (`kind: record-derived`)

Adds per-record scope handling where the two apps **share (or can transform between)** the scope value.
No `ScopeLink` yet. Enables cross-scope polling (one call, records self-carry scope) and derived write
scope where value-spaces coincide.

## SS-7 — `sourceScopeRef`: where a record carries its scope

**As an** operator, **I** confirm the field path(s) on a resource's record that carry its container
identity, **so that** the pipeline can capture each record's scope and route its write.

### Acceptance criteria

1. **Given** a resource whose records carry their container, **when** its binding is derived (extends
   RB-1), **then** a `sourceScopeRef` is guessed **unconfirmed** as a **keyed set of scope components**,
   each `{ key, fieldPath }` — `key` a stable component name (defaulting to the `fieldPath`'s leaf
   segment, operator-correctable), `fieldPath` an IR field path — e.g. Gitea `Issue`'s `owner` + `name`
   (from `repository.owner`/`repository.name`), Vikunja `Task`'s `project` (from `project_id`).
2. **Given** the operator, **when** they confirm/correct `sourceScopeRef`, **then** each component's
   `fieldPath` is validated against the resource's response schema (a real field path) and the ref is
   stamped `confirmedBy`/`confirmedAt`.
3. **Given** a resource whose records do **not** carry a container field, **when** derived, **then**
   `sourceScopeRef` is absent (record-derived scope is unavailable for that resource — the parameter
   needs a `constant` or `scope-link` binding).
4. **Given** an unconfirmed `sourceScopeRef`, **when** the system operates, **then** it is used nowhere.
5. **Given** a confirmed `sourceScopeRef`, **when** the Poller reads a source record, **then** it
   extracts that record's **captured scope** — the `{ key → value }` map over the ref's components
   (Gitea `{ owner: "alice", name: "phoenix" }`, Vikunja `{ project: 42 }`) — the routing key a
   `record-derived` **target** binding (SS-8) and, under multi-scope, scoped identity (SS-14) consume.
   `sourceScopeRef` is **resource-level** (a property of the *source* resource); the per-parameter
   selector that reads a captured component is the `record-derived` binding's `sourceScopeKey` (SS-8),
   a **distinct** field.

### Out of scope

- Using it to fill a target scope — SS-8. Container correspondence for arbitrary value-spaces — Layer 3.

### Dependencies

Blocked by SS-1, Phase-1 RB-1/RB-2. Precedes SS-8.

---

## SS-8 — `record-derived` scope binding + cross-scope read (single cursor)

**As an** operator, **I** can bind a scope parameter to a value carried on the record when the two apps
share the scope value-space, **so that** one cross-scope poll syncs records across many containers without
per-scope state.

### Acceptance criteria

1. **Given** a `scopePathBindings` entry on a **target** resource, **when** set to
   `kind: "record-derived"`, **then** it carries `{ parameterName, sourceScopeKey, transform? }` — where
   `sourceScopeKey` names which captured-scope component fills this parameter (the `key` of a component
   of the **source** resource's `sourceScopeRef`, resolved through the rule's source↔target resource
   pair) — and is confirmed per parameter like any other binding. A target with N scope parameters
   carries N such entries, one per parameter.
2. **Given** a source **cross-scope collection read** (e.g. Gitea `GET /repos/issues/search`) pinned as
   `pollOperationRef`, **when** the Poller runs, **then** it makes **one** call, captures each record's
   scope via the source resource's `sourceScopeRef` (SS-7), and keeps its **existing single per-rule
   `cursor`/snapshot** unchanged (native id keyed globally; a `since`/`before` param drives delta) —
   **no per-scope state**.
3. **Given** a target scope parameter bound `record-derived`, **when** a write is composed, **then** the
   parameter is filled from the record's **captured scope** by the entry's `sourceScopeKey` (applying
   `transform` if set); `transform` is **value-preserving only** (mirroring identity-key discipline) and
   a value-altering one is **rejected at confirm time** — the captured scope must round-trip (it also
   keys scoped identity), so altering it would break container round-tripping.
4. **Given** the mediator **cannot infer** value-space equivalence, **when** the operator selects
   `record-derived` for a target scope parameter, **then** that selection **is** the operator's assertion
   that the captured component and the target parameter share a value-space (recorded at confirm time);
   where the operator knows the value-spaces are arbitrary (Gitea repo name vs Vikunja project id)
   `record-derived` is the wrong choice and a `scope-link` (Layer 3) is required — the UI presents this
   as guidance and the operator chooses; it is **not** machine-detected.
5. **Given** a captured scope, **when** its change is durably enqueued, **then** the captured scope
   travels **with that detected change** through the pipeline as an in-flight attribute of the enqueued
   per-record change (alongside its native id, action, and content) — **not** new persisted sync state,
   so the Poller's single per-rule `cursor`/snapshot is unchanged (SS-8.2) — reaching the write side
   (this story) and scoped record identity (SS-14).

### Out of scope

- Arbitrary value-space translation — Layer 3 `ScopeLink`. Per-scope enumeration — SS-13.

### Dependencies

Blocked by SS-7, SS-4, Phase-4 SP-2. Precedes SS-9.

---

## SS-9 — Enablement + UI delta for `record-derived`

**As an** operator, **I** see a `record-derived` scope binding's requirements and choose it where valid,
**so that** enablement reflects record-carried scope without a container link.

### Acceptance criteria

1. **Given** a `record-derived` binding, **when** the gate runs (extends SS-5), **then** it requires
   (a) the **source** resource's `sourceScopeRef` confirmed with the component named by the binding's
   `sourceScopeKey` present, and (b) for a target binding, the binding itself confirmed (the operator's
   shared-value-space assertion); a parameter the operator has flagged arbitrary-value-space is listed as
   needing a `scope-link` instead. The gate checks **structural presence**, never value-space equivalence
   (which the mediator cannot verify).
2. **Given** the binding panel, **when** it renders a scope parameter, **then** it offers the **kind
   choice** (`constant` / `record-derived` / `scope-link`) with `record-derived` requiring a
   `sourceScopeKey` pick — one component of the source resource's confirmed `sourceScopeRef`.
3. **Given** a `viewer`, **when** they view, **then** it is read-only.

### Out of scope

- `scope-link` UI and container linking — Layer 3 (SS-15).

### Dependencies

Blocked by SS-8, Phase-4 SU-1/SU-5.

---

# Layer 3 — Explicit scope correspondence + multi-scope (`kind: scope-link`)

Adds the `ScopeCorrespondence` config (home of the **scope identity key**), the first-class `ScopeLink`
instances (container ↔ container), their discovery/linking, the `scope-link` binding fill, the
`RecordLink.scopeRef` that routes deletes, per-scope polling, and scope-qualified record identity. Enables
**true multi-repo → multi-project sync** with arbitrary container-id value-spaces.

> **Finalized L3 decisions (coordinator's four items):**
> **(1) Scope-identity-key home** = a new direction-agnostic config entity **`ScopeCorrespondence`** (one
> per scoped resource pair), not `ResourceBinding` (single-spec) nor `SyncRule` (one-directional). The
> scope identity key is the value-preserving pairing *source `sourceScopeRef` component(s) ↔ target
> container field(s)* — reusing the already-built `sourceScopeRef` for the source side.
> **(2) Discovery** = an enablement-time link-only pass (mini container backfill) + steady-state on-demand
> harvest + sweep re-run + manual; an unresolvable/ambiguous container **parks** (never guessed, never
> dropped). Not a second scheduler.
> **(3) Delete routing** = `RecordLink` gains `scopeRef` (persisted container, captured at establishment),
> so a delete — which carries **no captured scope** (source record gone) — and any no-capture read route
> from stored state; this **closes the L2 record-derived-delete generic-Error gap** for both layers.
> **(4) Scoped record identity** = match within the resolved container; pre-link queue key becomes
> scope-qualified; ambiguous guard runs within the container; snapshot still keys by globally-unique
> native id.

## SS-10 — `ScopeCorrespondence` config + scope identity key + `ScopeLink` / `RecordLink.scopeRef` domain

**As an** operator, **I** have the container-correspondence configuration, its instances, and each
record's stored container persisted, **so that** a record's source container translates to its target
container (even with unrelated ids) and a delete can still find its container.

### Acceptance criteria

1. **Given** the domain model, **when** `ScopeCorrespondence` is added, **then** it carries
   `{ id, resourcePairRef, scopeIdentityKey, targetContainerRef, sourceContainerRef?, confirmedBy, confirmedAt }`,
   **one per scoped resource pair**, `resourcePairRef` in the canonical direction-agnostic form
   ([data-model.md](../architecture/data-model.md) `ScopeCorrespondence`).
2. **Given** `scopeIdentityKey`, **when** modeled, **then** it is the **value-preserving** pairing of the
   source resource's `sourceScopeRef` component(s) to the target **container** resource's identity
   field(s) (source `name` ↔ target `title`), restricted to value-preserving comparison (reject
   `coerce`/`aggregate`/`expression`, mirroring `FieldMapping.isIdentityKey`'s `rename`-only rule), and
   **derive-then-confirm** (proposed by name/type similarity, operator-confirmed).
3. **Given** the domain model, **when** `ScopeLink` is added, **then** it carries
   `{ id, scopeCorrespondenceId, appAId, appAScopeKey, appBId, appBScopeKey, resourcePairRef,
   establishedBy (constant|identity-match|manual), status (active|archived), createdAt }`, `resourcePairRef`
   direction-agnostic so both directions resolve the same link.
4. **Given** `RecordLink`, **when** extended, **then** it gains an optional `scopeRef`:
   `{ kind: "scope-link", scopeLinkId }` (L3, arbitrary value-spaces) **or** `{ kind: "resolved", values }`
   (L2 shared value-space — the frozen `{ parameterName → value }`); **absent** on a non-scoped rule's
   links ([data-model.md](../architecture/data-model.md) `RecordLink.scopeRef`).
5. **Given** a container or app leaves the landscape, **when** the cascade runs, **then** the
   `ScopeCorrespondence`'s affected `ScopeLink`s are set `status = archived` (not deleted); a
   `RecordLink.scopeRef` pointing at an archived `ScopeLink` still resolves its frozen key for a final
   delete/audit.
6. **Given** the config is cross-app + direction-agnostic, **when** its home is chosen, **then** it is
   **not** placed on `ResourceBinding` (single-spec) or `SyncRule` (one-directional) — the reason
   `ScopeCorrespondence` is its own entity.

### Out of scope

- Establishing links (discovery/manual) — SS-11. Filling/routing from a link — SS-12.

### Dependencies

Blocked by SS-1, Phase-4 SD-2 (`RecordLink` domain, as sibling). Precedes SS-11..SS-16.

---

## SS-11 — Establish `ScopeLink`s: constant | identity-match discovery | manual

**As an** operator, **I** have container correspondences established by a constant, by discovery, or
manually — at enablement and on demand — **so that** every record's container resolves to a target
container, and one that cannot is parked, not guessed.

### Acceptance criteria

1. **Given** a single source container, **when** the operator maps it to a target container by literal,
   **then** a `ScopeLink` is written `establishedBy = constant` under the pair's `ScopeCorrespondence`.
2. **Given** enablement (**before** record backfill), **when** the container-level **link-only discovery
   pass** runs and both container resources are **enumerable** (a confirmed container `collectionReadRef`
   on each — e.g. Vikunja `GET /projects`), **then** it lists both sides and establishes `ScopeLink`s
   `establishedBy = identity-match` where the two sides' `scopeIdentityKey` values match; an **ambiguous**
   container match is never auto-linked (parked for manual linking, mirroring RL-4).
3. **Given** the source container resource is **not** enumerable (scenario-1 trimmed Gitea has no
   repo-list), **when** records stream from a cross-scope read, **then** scopes are **harvested** from the
   records' captured `sourceScopeRef` values and matched to target containers (listed via
   `targetContainerRef`'s `collectionReadRef`), establishing `ScopeLink`s `identity-match`.
4. **Given** steady state, **when** a polled record's container has **no resolved `ScopeLink`**, **then**
   an **on-demand harvest** attempts resolution inline (captured scope → match/lookup target container →
   establish the link) — the container analog of a steady-state identity match.
5. **Given** a container that is **ambiguous or cannot be resolved**, **when** a record needs it, **then**
   the record is **parked** for manual container linking — recorded, surfaced, replayable — **never**
   written to a guessed container and never silently dropped.
6. **Given** the operator, **when** they link/unlink containers in the UI, **then** a `ScopeLink`
   `establishedBy = manual` is written/severed.
7. **Given** the reconciliation sweep, **when** an enablement discovery pass was lost/crashed, **then** it
   **re-triggers** the pass (mirrors RS-1's backfill re-trigger); container discovery is enablement-time +
   on-demand + sweep + manual — **not** a second continuous scheduler.
8. **Given** discovery, **when** it runs, **then** its executions are ordinary `SyncEvent`s and it **never
   writes** to either app (a container-level link-only pass).

### Out of scope

- Filling/routing params from a link — SS-12. Per-scope polling — SS-13.

### Dependencies

Blocked by SS-10, Phase-4 RL-3/RL-4 (identity-match + ambiguous guard), RS-1 (sweep). Precedes SS-12, SS-13.

---

## SS-12 — `scope-link` resolver + delete/no-capture routing via `RecordLink.scopeRef`

**As an** operator, **I** have the write side fill a scope parameter from the record's resolved container —
from its captured scope while creating, from its **stored** container thereafter — **so that** arbitrary
target ids (project `42`) are reached and a **delete** (which has no source record) still routes.

### Acceptance criteria

1. **Given** the `scopePathBindings` union, **when** extended, **then** it gains the `kind: "scope-link"`
   member `{ kind, parameterName, scopeKeyRef, confirmedBy, confirmedAt }`, slotting into the existing
   discriminated union beside `constant`/`record-derived` without reshaping the collection.
2. **Given** a **create** (no `RecordLink` yet), **when** a write is composed, **then** the target scope
   parameter is filled from the record's **captured scope** resolved through its matched/looked-up
   `ScopeLink` — the target `appXScopeKey` selected by `scopeKeyRef` (e.g. `PUT /projects/{id}/tasks`'s
   `{id}` = the linked project id); on link establishment, `RecordLink.scopeRef =
   { kind: "scope-link", scopeLinkId }` is persisted.
3. **Given** a **linked** update/delete/read, **when** a write is composed, **then** the target scope is
   resolved from **`RecordLink.scopeRef`** (the authoritative stored container), **not** from a captured
   scope — so a **delete**, which carries no captured scope (source record gone), and a
   `read-before-write`/PUT read-carry route to the right container.
4. **Given** a delete (or no-capture read) under a scoped rule whose `RecordLink.scopeRef` is
   **absent/unresolvable**, **when** it runs, **then** the execution is **parked** for manual container
   linking — **not** a generic transient throw (this closes the L2 record-derived-delete gap where
   `targetDriftCheck != none` throws today) and never a guessed container.
5. **Given** the record id and the scope, **when** a write is composed, **then** they are **never
   crossed**: the id parameter from the `RecordLink`'s native id, the scope parameter(s) from the
   `ScopeLink`/`scopeRef`.
6. **Given** a create whose captured scope has **no** resolvable `ScopeLink`, **when** a write is
   attempted, **then** the resolver returns `undefined` and the execution is parked (SS-11.5) — never a
   fabricated scope.
7. **Given** an **L2 `record-derived`** rule, **when** a record is linked, **then** its
   `RecordLink.scopeRef = { kind: "resolved", values }` is persisted from the resolved scope, so its
   **deletes route from stored values** too — the delete fix is unified across L2 and L3.
8. **Given** scenario-1 with `ScopeLink(alice/phoenix ↔ project 42)`, **when** a Gitea issue create is
   propagated, **then** it resolves to `PUT /projects/42/tasks` with the transformed task body — the true
   multi-scope create.

### Out of scope

- Cross-scope vs per-scope read choice — SS-13. Scoped record identity/queue key — SS-14.

### Dependencies

Blocked by SS-11, SS-4, Phase-4 OC-4 (park mechanics). Precedes SS-13, SS-14.

---

## SS-13 — Poll enumeration: cross-scope (single cursor) vs per-scope (per-scope cursor)

**As an** operator, **I** have the Poller either cross-scope-read once or enumerate scopes and poll each,
**so that** multi-container sources are polled correctly whichever read shape the source offers.

### Acceptance criteria

1. **Given** a source with a **cross-scope collection read** and a confirmed `sourceScopeRef`, **when** the
   rule polls, **then** it uses the single-cursor cross-scope mechanism of SS-8 (recommended default).
2. **Given** a source with **no** cross-scope read but an enumerable **container resource** (confirmed
   container `collectionReadRef`), **when** the rule polls, **then** it **enumerates scopes**, resolves
   each `ScopeLink`, and polls each scope's scoped read filling its scope path params per container.
3. **Given** per-scope polling, **when** it runs, **then** each scope keeps its **own `cursor`/snapshot**
   (per-scope state), and deletion inference remains per-scope-complete-fetch (a partial scope fetch
   aborts that scope's run, never mass-deletes — mirrors SP-4).
4. **Given** a source with **neither** a cross-scope read nor an enumerable container, **when** the rule is
   configured, **then** its scopes are exactly the `constant`/`manual` `ScopeLink`s the operator pinned,
   polled per-scope.
5. **Given** the enumeration mode is derived from the pinned `pollOperationRef` + container binding,
   **when** it is chosen, **then** it is operator-visible and correctable (derive-then-correct).

### Out of scope

- The per-scope cursor **seeding** specifics beyond "per scope, same rules as BE-6" — reuse BE-6 per scope.
- **Live re-listing** the source container set at poll time and the **per-scope backfill fetch fan-out** —
  deferred to **SS-17**. SS-13 as built iterates the *already-established* `ScopeLink`s; SS-17 re-lists the
  live enumerable container list each poll cycle (its "enumerate scopes" step) and fans out backfill per
  scope, closing the two SS-13-review gaps that leave a **per-scope-enumerated** rule un-runnable
  end-to-end (a container created after the first discovery pass is otherwise never polled, and per-scope
  backfill reads the collection with no scope fill and aborts fail-loud).

### Dependencies

Blocked by SS-12, Phase-4 SP-2/SP-5/BE-6. Precedes SS-14, SS-15, SS-17.

---

## SS-14 — Scoped record identity: match within container, scope-qualified queue key, ambiguous guard

**As an** operator, **I** have record-level identity resolved **within** a container, **so that** two
records sharing a `title` in different containers are never merged or serialized together.

### Acceptance criteria

1. **Given** a record whose identity key is unique only within its container, **when** identity-match
   runs, **then** the target lookup/fetch-and-match is **scoped to the record's resolved target
   container**: a filtered read (`FieldMapping.targetLookupParamRef`) fills the container scope
   parameters from the `ScopeLink` so it searches only within project `42`; fetch-and-match enumerates
   only that container — never a global lookup.
2. **Given** the pre-link ordering-queue key (OQ), **when** a record has no `RecordLink` yet, **then** the
   key is **scope-qualified**: for an **L2 shared value-space**, `(shared-scope-value, identity-value)`;
   for an **L3 arbitrary value-space**, `(ScopeLink canonical key, identity-value)` — each side's captured
   scope resolved to the shared `ScopeLink` **first**, so both directions compute the **same** key and do
   not cross-match. Extends OQ's pre-link identity-value fallback key.
3. **Given** a record whose container is **unresolved**, **when** it would be enqueued, **then** it is
   **parked before cross-direction queueing** (it cannot be safely scope-keyed) — consistent with SS-12.6.
4. **Given** an **ambiguous** match **within** the resolved container, **when** detected, **then** it is
   parked for manual linking (never auto-picked), mirroring RL-4 — the guard runs in the scoped domain.
5. **Given** snapshot keying, **when** a snapshot is written, **then** it keys by **globally-unique native
   id** (confirmed unchanged) — scoping affects matching and queue keys, not snapshot keys; per-scope
   polling (SS-13) keeps a per-scope snapshot still keyed by native id within it.
6. **Given** the data path, **when** identity resolves, **then** it is fed by the **captured scope**
   (create/update path, from the source record) and by the **resolved `ScopeLink` / `RecordLink.scopeRef`**
   (linked path) — consistent with SS-8 (L2 capture) and SS-12 (L3 store).

### Out of scope

- The container-linking / parked-scope UI — SS-15.

### Dependencies

Blocked by SS-12, Phase-4 RL-1..RL-4, OQ-2..OQ-4. Precedes SS-15.

---

## SS-15 — Enablement gate + UI for scoped rules (scope-link)

**As an** operator, **I** see what a scoped rule needs — the scope identity key, resolvable `ScopeLink`s,
the container list op — confirm the scope identity key, and link containers, **so that** a multi-scope
rule enables only when it can resolve every record's container.

### Acceptance criteria

1. **Given** a rule with any `kind: scope-link` scope binding, **when** the gate runs (extends SS-5),
   **then** it requires the pair's `ScopeCorrespondence.scopeIdentityKey` **confirmed** and, **by the
   rule's effective poll-scope mode (SS-13.5)**, the `ScopeLink`(s) it needs **resolvable**:
   - **cross-scope** (SS-13.1) — discovery must be **viable**: the confirmed `scopeIdentityKey` plus the
     confirmed **target** container list op (`targetContainerRef.collectionReadRef`, which the SS-11.3
     harvest lists to match records' captured scopes against). The gate **does not** require the per-scope
     `ScopeLink`s pre-established — the steady-state harvest / on-demand resolution (SS-11.3/11.4)
     establishes them from streamed records.
   - **per-scope-enumerated** (SS-13.2) — as cross-scope, **plus** the confirmed **source** container list
     op of criterion 2; the gate still **does not** require the per-scope `ScopeLink`s pre-established,
     because **SS-17 establishes them live** (the enablement discovery pass, re-listed each poll cycle and
     at backfill fan-out) — a landscape that grows containers after enablement must not become permanently
     un-enableable.
   - **per-scope-pinned** (SS-13.4) — the source container is not enumerable, so the gate requires
     `constant`/`manual` `ScopeLink`s **covering the scopes in play** (nothing lists them live).
2. **Given** the effective mode is **per-scope-enumerated** (SS-13.2 / SS-17), **when** the gate runs,
   **then** the source container's `collectionReadRef` (and `paginationRef` where it pages) must be
   confirmed on the pair's `ScopeCorrespondence.sourceContainerRef`, and the `targetContainerRef`'s
   `collectionReadRef` must be confirmed — these are exactly the ops **SS-17**'s poll-time enumeration and
   per-scope backfill fan-out consume, so an enumerated-mode rule whose container list ops are unconfirmed
   can neither discover nor poll its scopes and is blocked.
3. **Given** an unmet scope precondition, **when** enable is attempted, **then** it is blocked and listed
   in "still needs" (extends BE-1/BE-2, SU-5), **distinguishing** an unconfirmed **scope identity key**,
   an absent/unresolved **`ScopeLink`** (per-scope-pinned — the scopes are not covered), and an unconfirmed
   **container list op** (per-scope-enumerated — SS-17 cannot enumerate without it).
4. **Given** a **scope-identity-key confirmation panel** (mirrors the record identity-key panel / RB-3),
   **when** it renders, **then** the operator confirms the value-preserving pairing *source `sourceScopeRef`
   component ↔ target container field* (derive-then-correct — the mediator pre-selects a candidate).
5. **Given** the **container-linking screen** (mirrors SU-2), **when** it renders, **then** it lists
   unresolved/ambiguous/**parked** container matches from SS-11.5 / SS-12.4 **and SS-17** (a new container
   the poll-time re-list or backfill fan-out could not auto-resolve) with candidate target containers, and
   lets the operator link/unlink `ScopeLink`s; a parked record or scope leaves the queue once its container
   is linked and it replays.
6. **Given** a `viewer`, **when** they open any of these surfaces, **then** they render read-only (OA-2).
7. **[Carried-over SS-14 hardening, folded into this gate slice]** **Given** the pre-link ordering-queue
   key resolver is handed a **scoped** context (a confirmed target scope path binding present) but **no**
   `PreLinkScopeResolver` is wired, **when** it resolves a key, **then** it **throws** (fail-loud) rather
   than falling through to the non-scoped identity-value key — mirroring the Poller's "scoped park but no
   sink wired" throw (the `not-scoped` fall-through at
   `packages/sync-engine/src/ordering/queue-key-resolver.ts:192` today): a scoped rule must never be keyed
   as if it were non-scoped.

> **Carried-over SS-14 review item (documented gate-gating, no code change).** The container-park sink
> skips dedup for a parked record whose **captured scope is absent**
> (`apps/backend/src/modules/sync/pre-link-scope.ts:100`). Because this gate requires a scoped rule's
> `ScopeCorrespondence.scopeIdentityKey` confirmed (criterion 1) and that key is built on the source
> `sourceScopeRef` (SS-7), a **gated** scoped rule always has a confirmed `sourceScopeRef` — so a parked
> record that captured no scope is an anomaly and that dedup-skip is **unreachable in a gated rule**. It is
> folded into this slice as a documented gate-gating, **not** a code change; if a future mode ever allows a
> scoped rule without a `sourceScopeRef`, revisit it.

### Out of scope

- The discovery engine — SS-11. The **live-enumeration + per-scope backfill fan-out engine** — SS-17.

### Dependencies

Blocked by SS-11..SS-14, Phase-4 SU-1/SU-2/SU-5. The gate is coherent standalone (it blocks enablement),
but a **per-scope-enumerated** rule only *runs* once **SS-17** ships — see the slice ordering below.

---

## SS-16 — Lifecycle: scope bindings + `ScopeLink`s on spec/app change

**As an** operator, **I** rely on scope bindings and container links being re-validated exactly when a
change invalidates them, **so that** a stale or newly-required scope is never used silently.

### Acceptance criteria

1. **Given** an additive re-pin leaving a bound scope parameter untouched, **when** ingested, **then** its
   binding (kind + value/source + confirmation) carries forward unchanged.
2. **Given** a breaking change that removes/renames a bound scope parameter, **when** applied, **then** the
   binding returns to unconfirmed and the dependent `SyncRule`s pause (mirrors `pollOperationRef`
   re-validation).
3. **Given** a change introducing a **new** required path parameter on an operation an enabled rule calls,
   **when** applied, **then** a new unconfirmed scope binding is created and the rule pauses.
4. **Given** a breaking change to a **scope-identity-key** field (a source `sourceScopeRef` component or a
   target container field), **when** applied, **then** the pair's `ScopeCorrespondence.scopeIdentityKey` is
   returned to **unconfirmed**, `identity-match` `ScopeLink` resolution is invalidated, and the rule stays
   unenableable until it is re-confirmed (mirrors record identity-key handling under successor adoption).
5. **Given** a container or app leaves the landscape, **when** the cascade runs, **then** the
   `ScopeCorrespondence`'s affected `ScopeLink`s are **archived** (SS-10 criterion 5), not deleted; a
   `RecordLink.scopeRef` pointing at an archived link still resolves its frozen key for a final
   delete/audit.
6. **Given** the SpecDiff/re-pin machinery is **Phase-6-owned**, **when** this story is scoped, **then** it
   specifies only the `scopePathBindings`/`ScopeCorrespondence`/`ScopeLink` behavior within that lifecycle.

### Out of scope

- The `SpecDiff`/re-pin/successor-adoption machinery — Phase 6 ([extensibility.md](../architecture/extensibility.md)).

### Dependencies

Blocked by SS-1, SS-10, and the Phase-6 spec-update lifecycle.

---

## SS-17 — Live container enumeration for enumerable per-scope sources (poll + backfill fan-out)

**As an** operator, **I** have an **enumerable** per-scope source's containers **re-listed live** — each
poll cycle and at backfill — so that a container added after enablement is discovered, linked, backfilled,
and polled without a manual step, **so that** "the mediator lists all available scopes and polls each"
holds for a *growing* landscape, not only for the scopes that existed at enablement.

> **Why this story exists.** The SS-13 review found a **per-scope-enumerated** rule is not yet end-to-end
> runnable, because two things were deferred (both **fail-safe** — no corruption, no guessed container, no
> false delete — but blocking): **Call 5** — the Poller iterates only the **already-established**
> `ScopeLink`s (`RepoPollPlanResolver.#resolveScopes` over `listByCorrespondence`), so a container created
> *after* the first discovery pass is silently never polled (the sweep's `needsDiscovery` returns false
> once *any* link exists, and the SS-11.4 on-demand harvest can't fire without a record, which per-scope
> mode never reads for a not-yet-enumerated container); **Call 6** — a per-scope rule's initial backfill
> reads the collection with **no scope fill** and aborts fail-loud, so it cannot seed its baseline. This
> story closes both **by reusing SS-11 establishment and SS-13 per-scope state** — it adds only the
> *triggers* that feed the SS-11 discovery pass at poll and backfill time (the read-side realization of the
> user's stated ideal: *"detect that we first need to query for all available scopes and do the polling for
> each scope"*). It coins **no new domain term** and needs **no migration**.

### Acceptance criteria

1. **Given** a rule whose effective poll-scope mode is **per-scope-enumerated** (SS-13.5 — a confirmed
   `scope-link` **source** scope binding **and** a confirmed `ScopeCorrespondence.sourceContainerRef`),
   **when** its poll cycle runs, **then** **before** the per-scope loop the Poller **re-lists the live
   source container list** via the confirmed `sourceContainerRef.collectionReadRef` (paged to exhaustion)
   and runs the **SS-11 enablement discovery pass** (`establishByIdentityMatch`) over it — establishing a
   `ScopeLink` for every newly-appeared container whose `scopeIdentityKey` value matches a target container
   — and only then enumerates the (now-refreshed) active `ScopeLink`s as the scope set (SS-13.2). It
   **reuses** SS-11.2, never re-implementing container matching.
2. **Given** container discovery is defined as enablement-time + on-demand + sweep + manual — **not** a
   second scheduler (Finalized L3 decision 2), **when** the poll-time re-list runs, **then** it executes
   **on the Poller's existing per-rule cadence** as the "enumerate scopes" step of a per-scope-enumerated
   poll (SS-13.2), **not** as a new background loop; the reconciliation sweep's `needsDiscovery`
   (crash-recovery re-trigger for a pair with **zero** links) is left **unchanged**.
3. **Given** the live container re-list, **when** the container fetch is **incomplete/partial** (a page
   failed), **then** the re-list **aborts** (SP-4 discipline) and the poll proceeds over the
   **previously-established** `ScopeLink`s only — never mass-polling, never dropping a known scope; and a
   newly-appeared container that is **ambiguous or unresolvable** is **parked** for manual container
   linking (SS-11.5 / SS-12.4), never polled as a guessed container.
4. **Given** a rule whose effective mode is **per-scope** — enumerated **or** pinned — **when** its initial
   backfill runs, **then** instead of a single un-scoped collection read it **fans out**: it resolves the
   scope set (enumerated: the SS-17.1 live re-list + SS-11 establishment; pinned: the operator's
   `constant`/`manual` `ScopeLink`s — SS-13.4) and runs the source `collectionReadRef` **once per scope**,
   filled with that scope's confirmed **source-side** scope path parameters (SS-4 / SS-12 fill, source
   side), linking + seeding baselines per scope (BE-4 `link-only` / BE-5 `push` behavior unchanged within a
   scope).
5. **Given** per-scope backfill fan-out, **when** a scope completes, **then** it seeds that scope's **own**
   snapshot / cursor in `poll_scope_state`, keyed by its `ScopeLink` id (SS-13.3 / BE-6, per scope); an
   **incomplete** fetch within one scope **aborts only that scope** (never seeds its snapshot, never
   mass-deletes — SP-4 per scope) and does **not** abort the others; a scope whose source-side fill does
   not resolve, or whose container cannot be resolved, is **parked** (SS-11.5) and skipped, never guessed.
6. **Given** a **cross-scope** rule (SS-13.1 / SS-8), **when** it polls or backfills, **then** it is
   **untouched** — one cross-scope call, single per-rule cursor/snapshot, record-carried capture; the
   source container is neither re-listed nor fanned out (it may not even be enumerable — scenario-1's
   trimmed Gitea has no repo-list). **Given** a **per-scope-pinned** rule (SS-13.4), **when** it polls,
   **then** it keeps polling exactly the operator-pinned links with **no** live re-list (there is no
   `sourceContainerRef` to enumerate).
7. **Given** SS-17 is built, **when** its persistence is reviewed, **then** it introduces **no** new entity
   or column: it reuses `ScopeLink` (SS-10) for establishment, `poll_scope_state` (SS-13) for the per-scope
   cursor/snapshot, and the SS-11 discovery service / establishment pass — so it ships **without a
   migration**.

### Out of scope

- The gate that lets an enumerated rule be enabled — SS-15 (reused). Scoped identity match **within** a
  container — SS-14 (reused). Non-enumerable sources — SS-13.4 pinned (no re-list) / SS-8 cross-scope
  (record-carried).
- A **continuous container scheduler** — explicitly *not* this (Finalized L3 decision 2); the re-list rides
  the Poller's existing cadence.

### Dependencies

Blocked by SS-11 (establishment / discovery pass), SS-12 (source-side scope fill), SS-13 (per-scope state +
modes), SS-14 (scoped identity within a container), Phase-4 BE-4/BE-5/BE-6 (backfill + seeding). Precedes
the per-scope-enumerated capstone e2e. **No migration.**

---

## SS-18 — Author / derive a scope-linked resource pair (the L3 configuration entry point)

**As an** operator, **I** have the mediator **propose** that a resource pair is scope-linked — deriving its
container correspondence and a candidate scope identity key — and let me select `scope-link` as a scope
parameter's fill source, **so that** a multi-container pair can actually be configured, instead of every L3
capability being unreachable.

> **Why this story exists.** SS-10..SS-17 built the whole L3 **mechanism** (domain, establishment, resolver
> + delete routing, per-scope poll, scoped identity, gate, live enumeration, confirm/link UI), but nothing
> **configures** it: there is **no production writer of `ScopeCorrespondence`** (the SS-15.4 confirm handler
> 404s unless the row already exists), and `scope-link` is a **disabled** option in the SS-9 kind selector
> (`SelectableScopeBindingKind` = `constant` | `record-derived`). SS-10.2 specifies "derive-then-confirm
> (**proposed** by name/type similarity, operator-confirmed)" — the *proposal* half was never built. So an
> L3 pair cannot be configured end to end and every SS-10..17 capability is unreachable in production.
> SS-18 is the missing **proposal/derivation + kind-enablement glue**, not a parallel mechanism: it reuses
> the SS-15.4 confirmation panel, the RB-3 binding-confirm flow, the SS-9 kind selector, and
> `ScopeCorrespondenceRepository.confirmOrUpdate`. It coins **no new domain term** and needs **no
> migration**.

### Acceptance criteria

1. **Given** a resource pair whose approved target write operation carries a **container path parameter** (a
   scope path parameter that is not the record id — SS-4) satisfied by neither a single `constant` container
   nor a `record-derived` shared value-space, **when** the pair's downstream artifacts are instantiated on
   `MappingApproved` (the moment source *and* target resources are both known — Phase-3 approval), **then**
   the mediator **proposes** a `ScopeCorrespondence` for that pair, created **unconfirmed**
   (`confirmedBy`/`confirmedAt` null), carrying derived `sourceContainerRef`, `targetContainerRef`, and a
   candidate `scopeIdentityKey` — **one per scoped resource pair** (SS-10.1).
2. **Given** container-resource derivation, **when** the proposal runs, **then** `targetContainerRef` is the
   IR resource whose native id addresses the target container path parameter (Vikunja `projects` for
   `PUT /projects/{id}/tasks`), and `sourceContainerRef` is the IR resource whose identity the source's
   `sourceScopeRef` components address (Gitea `repos` for `{owner}`/`{repo}`); `sourceContainerRef` is
   **absent** when the source container is not enumerable (the SS-13.4 pinned case) — which is exactly what
   makes the rule derive as `per-scope-pinned` rather than `per-scope-enumerated` (SS-13.5).
3. **Given** the candidate `scopeIdentityKey`, **when** it is derived, **then** each source `sourceScopeRef`
   component is paired to the target container field of closest **name/type similarity** (source `name` ↔
   target `title`), restricted to **value-preserving** (`rename`-only) pairings (SS-10.2) — **proposed,
   never auto-confirmed**; the operator confirms or corrects it in the SS-15.4 panel, which remains the only
   writer of `confirmedBy`/`confirmedAt`.
4. **Given** a pair with a proposed `ScopeCorrespondence`, **when** the SS-9 scope-binding kind selector
   renders for one of that pair's container path parameters, **then** `scope-link` is **selectable** (no
   longer the disabled "Layer 3 — not yet available" option); **when** the operator selects it, **then** a
   `scope-link` `scopePathBinding` is written `{ kind, parameterName, scopeKeyRef, confirmedBy,
   confirmedAt }` with a **derived** `scopeKeyRef` (which target `appXScopeKey` component addresses this
   parameter), left **unconfirmed** until the operator confirms it (SS-9.2 semantics otherwise unchanged).
5. **Given** the container list operations SS-11/SS-13/SS-15/SS-17 consume, **when** the correspondence is
   proposed, **then** `targetContainerRef.collectionReadRef` and — where the source container is enumerable
   — `sourceContainerRef.collectionReadRef` + `paginationRef` are derived on those container resources and
   surfaced as **ordinary RB-3 binding-confirmation rows** (reusing the Phase-1 confirm mechanism, not a new
   one), so the SS-15.2 gate can block on them until confirmed.
6. **Given** re-derivation (a re-ingested spec, a re-run instantiation, a second approval), **when** it
   runs, **then** it is **idempotent**: never a duplicate `ScopeCorrespondence` (one per pair), and it
   **never clobbers a confirmed** `scopeIdentityKey` or a confirmed `scope-link` binding; an **unconfirmed**
   candidate may be refreshed by a newer derivation.
7. **Given** a spec change that removes or renames the container path parameter or the target container
   identity field, **when** it is applied, **then** the affected `scope-link` binding and/or
   `scopeIdentityKey` return to **unconfirmed** and the dependent `SyncRule`s pause — the SS-16 lifecycle
   rules apply to these proposed artifacts exactly as to any other derived-then-confirmed binding.
8. **Given** any authoring surface this story adds, **when** a `viewer` opens it, **then** it renders
   **read-only** (OA-2); and **given** the whole flow, **when** it completes, **then** nothing is silently
   auto-confirmed — every proposed artifact is unconfirmed until an operator ratifies it (derive-then-confirm
   end to end).

### Out of scope

- Establishing `ScopeLink` **instances** (container↔container) — SS-11. Confirming the scope identity key —
  SS-15.4. Linking/unlinking containers — SS-15.5. Enabling the rule — SS-15.1-3.
- Proposing a correspondence for a pair that is **not** scoped (no container path parameter): nothing is
  created and the SS-9 selector keeps `scope-link` unavailable for it.

### Dependencies

Blocked by SS-10 (the entity + `confirmOrUpdate`), SS-4 (record-id-vs-scope classification), SS-7
(`sourceScopeRef`), SS-9 (the kind selector this extends), Phase-1 **RB-3** (binding confirmation), and
Phase-3 approval / downstream-artifact instantiation (the proposal trigger). Precedes the **Slice D**
capstone e2e, which cannot configure an L3 pair without it. **No migration** — `scope_correspondence`,
`scope_link`, and `resource_binding.scope_path_bindings` all already exist (migrations 0016-0019).

---

## Out of scope (whole file)

- **The Adapter-Engine `ParameterMapping` path (Phase 5).** Separate mechanism (fills from an inbound
  consumer request). A provider that is both a sync target and an adapter backend uses `scopePathBindings`
  / `ScopeLink` for sync and `ParameterMapping`s for adapter serving. Whether the adapter should fall back
  to a scope binding for a scope param a consumer omits is a Phase-5 question (open question 3 below).
- **Non-path scope inputs.** A required query/header parameter that scopes a whole rule (`?project=`) is a
  plausible sibling but not the concept problem here; open question 2.
- **Resolver execution-detail configuration** (`defaultPageSize`, delta cursor path, deletion sentinel —
  `BindingResolverOptions`) — a distinct deferred item.
- **Syncing containers as data** (repo↔project field-level sync). `ScopeLink` correlates containers for
  scoping only; if an operator wants repos↔projects themselves synced, that is an ordinary peer-peer
  `ApprovedMapping` + `SyncRule`, unrelated to this feature.

## Layer edges + what each unblocks

| Layer | Adds | Unblocks | Removes SU-6 workaround? | Multi-scope? |
|---|---|---|---|---|
| **L1** (SS-1..6) | `constant` scope bindings | one-repo↔one-board Gitea↔Vikunja | **Yes** | No |
| **L2** (SS-7..9) | `record-derived` + cross-scope read (single cursor) | cross-container polling where value-spaces shared | (already gone) | partial (read side) |
| **L3** (SS-10..17) | `ScopeCorrespondence` + `ScopeLink` + `RecordLink.scopeRef` + discovery + per-scope poll + scoped identity + live container enumeration | **true multi-repo → multi-project** (+ fixes L2 record-derived delete routing) | (already gone) | **Yes** |

## Suggested build order

Domain → derive → confirm → resolver → gate → UI, per layer. Ship **L1 for approval first** (drops the
SU-6 workaround, smallest surface). Then L2 (record-carried scope, single cursor — cheap, high value for
shared value-spaces). Then L3 (the entities + discovery + per-scope polling — the largest slice). Within
L3: SS-10 (`ScopeCorrespondence` + `ScopeLink` + `RecordLink.scopeRef` domain) → SS-11 (establish/discover)
→ SS-12 (`scope-link` fill + delete routing) → SS-13 (poll modes) → SS-14 (scoped identity) → SS-15
(gate + scope-identity-key panel + container-linking UI) → SS-16 (lifecycle) → **SS-17 (live enumeration +
per-scope backfill fan-out)**.

### Remaining scoped-sync slices (each an independently reviewable/mergeable feature branch)

SS-10..SS-14 are **built and merged**. What remains ships as four cohesive-module slices — order and
dependencies below. **None needs a migration** (all reuse `ScopeLink` + `poll_scope_state` +
`ScopeCorrespondence`, already migrated).

1. **Slice A — Enablement gate (backend), SS-15.1–3 + SS-15.7 + the SS-14 dedup note.** The mode-aware
   scope-link gate (extends the SS-5 / BE-2 gate) plus the two carried-over SS-14 hardening items folded in
   (the fail-loud queue-key throw at `queue-key-resolver.ts:192`; the documented gate-gating of the
   `pre-link-scope.ts:100` dedup skip). Backend only. **Blocked by** SS-10..SS-14 (built). Unblocks
   enabling a scoped rule; precedes B, C, D.
2. **Slice B — Live-enumeration + per-scope backfill fan-out engine, SS-17.** Closes Call 5 + Call 6 (the
   read-side realization of the user's ideal). Pure engine (Poller + backfill + the reused SS-11 discovery
   service). **Blocked by** SS-11/SS-12/SS-13/SS-14 (built) **and Slice A** (so an enumerated rule can be
   enabled to exercise it). Unit/integration-testable against fakes independently of the UI. Precedes D.
3. **Slice C — Scope-identity-key confirmation panel + container-linking UI (Vue), SS-15.4–6.** Mirrors
   SU-1 (blockers/checklist), SU-2 (manual linking), SU-5 (binding-blocker surfacing) — no new UI patterns.
   **Blocked by** Slice A (the gate API + its "still needs" distinctions) and Slice B (the container-linking
   screen also lists SS-17's newly-parked containers, SS-15.5). May proceed in parallel with D once A + B
   land.
4. **Slice C2 — SS-18 authoring / derivation (the L3 configuration entry point).** Propose the
   `ScopeCorrespondence` on `MappingApproved` (derived container refs + a candidate `scopeIdentityKey` by
   name/type similarity), surface the container list ops as RB-3 confirm rows, and make `scope-link` a
   **selectable** SS-9 kind that writes a derived-but-unconfirmed `scope-link` binding. **Blocked by**
   SS-10/SS-9/RB-3 (built) and Slices A-C (merged). **Unblocks Slice D** — without it no L3 pair can be
   configured, so every SS-10..17 capability is unreachable. No migration.
5. **Slice D — Capstone scoped e2e.** A real Gitea↔Vikunja multi-scope round: per-scope enable → backfill →
   poll each container → propagate → **no echo** (mirrors SU-6). **Blocked by** Slices A + B (enable + run)
   and C where the journey is UI-driven. **Fixture caveat — see open question 9:** scenario-1's *trimmed*
   Gitea spec has **no repo-list**, so per-scope-**enumerated** read (SS-17.1) cannot run against it; the
   capstone either (a) ingests the **full** Gitea spec (repo-list present) to exercise SS-17's enumerated
   read + backfill fan-out, or (b) runs the multi-scope round in **cross-scope read + per-scope
   `ScopeLink` write** mode (which the trimmed spec supports, SS-12.8) and leaves SS-17's per-scope
   fan-out to Slice B's deterministic unit/integration tests. Recommended: (a) for a true "poll each
   container" e2e; keep (b) as the deterministic backstop.

## Open questions for a human (concept silent or a decision to ratify)

1. **Home granularity for scope bindings — per-`ResourceBinding` (chosen) vs an app-level shared default.**
   `{owner}/{repo}` recur across a Gitea app's resources; per-resource re-confirmation repeats them.
   *Recommended:* per-resource now, an app-level default as a future ergonomic layer.
2. **Non-path scope inputs** (query/header scoping a whole rule). *Recommended:* out of scope now; keep the
   union forward-compatible.
3. **Phase-5 adapter fallback to a scope binding** when a consumer omits a scope param on a dual-role
   provider. *Recommended:* decide in Phase 5; keep separate.
4. **[FINALIZED] `ScopeLink` is its own entity** (not a `RecordLink` subtype) — different key, cardinality,
   lifecycle, and it is not an `ApprovedMapping`. Residual ratification: none expected.
5. **[FINALIZED] The scope identity key lives on a new `ScopeCorrespondence` config** (one per scoped
   resource pair), reusing the source `sourceScopeRef` for the source side and pairing it to a target
   container field. Not on `ResourceBinding` (single-spec) or `SyncRule` (one-directional). **Residual for
   the human:** confirm `ScopeCorrespondence` as a new entity vs. folding the scope identity key onto the
   existing `ScopeLink`-per-pair config differently — recommended as specified.
6. **[FINALIZED] Discovery** = enablement-time link-only pass + steady-state on-demand harvest + sweep
   re-run + manual; an unresolvable/ambiguous container **parks** (SS-11.5, SS-12.4). Not continuous
   polling. **Residual for the human:** confirm parked-scope records surface in the container-linking
   screen (SS-15.5) vs. the existing conflict/parked screen.
7. **[FINALIZED] Delete routing** = `RecordLink.scopeRef` (persisted container at establishment), covering
   L2 (`resolved` values) and L3 (`scope-link` id). **Residual for the human:** confirm storing a
   `scopeLinkId` reference (chosen) vs. denormalizing the resolved values for L3 too — recommended as the
   reference, since a container's native id is stable and an archived link still resolves it.
8. **Should this become its own phase (e.g. Phase 4.5 / a Phase-6 addendum)?** *Recommended:* yes — it is a
   phase-sized feature; L1/L2 already shipped inside Phase 4's tail (L1 dropped the SU-6 workaround), and
   L3 is the largest remaining slice.
9. **[RESOLVED by the human, 2026-07-20 — full Gitea spec]** The SS-17 per-scope-enumerated capstone
   (Slice D) runs against the **full** Gitea spec (which has a repo-list), for a **true "poll each
   container"** e2e that genuinely exercises SS-17.1's live enumeration + backfill fan-out; the deterministic
   Slice-B unit/integration tests cover the same fan-out as a backstop. (The trimmed-spec cross-scope-read
   round remains available but is not the capstone.)
10. **[RESOLVED by the human, 2026-07-20 — ratified as specified]** The poll-time live re-list (SS-17.1) is
    accepted as the "enumerate scopes" step *of* a per-scope-enumerated poll — **not** a second scheduler:
    it rides the Poller's existing per-rule cadence, enumerated mode only (cross-scope + pinned untouched),
    and is the read-side realization of the user's stated ideal ("query for all available scopes and poll
    each"). SS-17 is greenlit as written; Finalized L3 decision 2 stands (no new background loop).
