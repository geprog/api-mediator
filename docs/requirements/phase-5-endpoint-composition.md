# Phase 5 — Endpoint composition (derivation, validation, adoption)

Where the human decision lives. Mapping review decides the **data** semantics (which fields/operations
correspond); composition decides the **serving** semantics (how one or more approved backends combine into one
endpoint). The split follows mapping approval's philosophy exactly: anything with only one sensible answer
happens automatically; anything that is a real decision is made by a human, **never guessed**.

Phase 3 already instantiates `AdapterEndpoint`s with `proposed` `AdapterBinding`s on `MappingApproved`
(AI-2) and deliberately did **not** auto-activate, because no runtime existed. Phase 5 completes that flow:
first-binding auto-activation, the `composition-required` path, composition validation, and **successor
adoption** — the path that preserves chain/composition state when a mapping is replaced by re-review.

**Actor:** operator (the *composer* — the flow's word for an operator performing composition; not a new role);
system (derivation + validation).

**Concept references (whole file):** [adapter-endpoint-composition.md](../flows/adapter-endpoint-composition.md)
(all steps + *Notes*); [adapter-engine.md](../architecture/adapter-engine.md) *Binding: decided at composition
time*, *Role validity per aggregation strategy*, *Aggregation strategies*, *Write operations*, *Error and
partial-failure semantics*, *Caching*; [extensibility.md](../architecture/extensibility.md) *Successor
adoption*, *App lifecycle*; [data-model.md](../architecture/data-model.md) `AdapterEndpoint`, `AdapterBinding`,
`OperationMapping`, `ParameterMapping`, `ResourceBinding.nativeIdRef`/`paginationRef`;
[graph-overview.md](../flows/graph-overview.md) (adapter-dependency edges);
[security.md](../architecture/security.md) (composing endpoints is an `operator` mutation);
[glossary.md](../glossary.md) `Endpoint composition`, `composition-required`, `Successor mapping`.
Reused: [phase-3-artifact-instantiation.md](phase-3-artifact-instantiation.md) AI-2/AI-3.

> **Authoritative:** the role-validity table, the strategy-scoped `executionOrder`/`dependsOnBindingId` rules,
> "a write endpoint is always `single`", "the endpoint keeps serving its previous active configuration until a
> human completes composition", and "nothing is derived and auto-confirmed" — every heuristic pre-fill
> (`postMergePagination`, dedup candidates, supplement required-ness) is **derive-then-confirm**, exactly like
> `ResourceBinding` refs and `OperationMapping.action`. **Implementation choice:** UI copy, heuristic details,
> endpoint payload shapes.

---

## CO-1 — Derive endpoints from `MappingApproved`; auto-activate the first binding

**As a** landscape operator, **I** get a live endpoint the moment one backend can serve a consumer operation,
**so that** the common case is zero-friction — and a *second* backend never silently changes what is served.

### Acceptance criteria

1. **Given** `MappingApproved` for a **consumer-provider** `ApprovedMapping`, **when** the Adapter Engine
   reacts, **then** it reads the mapping's `OperationMapping`s to determine the affected **consumer
   operations**, and per operation finds the existing `AdapterEndpoint` or creates one
   ([adapter-endpoint-composition.md](../flows/adapter-endpoint-composition.md) step 2; AI-2).
2. **Given** a consumer operation with **no prior binding**, **when** the binding is attached, **then** the
   endpoint is created/updated with the safe defaults — `aggregationStrategy = single`, the binding `primary`
   and `active`, **no caching**, **non-strict** — and the endpoint is set `active` immediately: one backend
   leaves nothing ambiguous ([adapter-endpoint-composition.md](../flows/adapter-endpoint-composition.md) step 3;
   [adapter-engine.md](../architecture/adapter-engine.md) *Binding: decided at composition time*). *This
   supersedes the Phase-3 deferral in AI-2 criterion 4, which held only because no runtime existed.*
3. **Given** an operation that **already has** a binding, **when** a further mapping approval attaches another,
   **then** the new binding attaches `status = proposed` and the endpoint transitions to
   `composition-required`, while **the previously active configuration keeps serving unchanged**
   ([adapter-endpoint-composition.md](../flows/adapter-endpoint-composition.md) step 3).
4. **Given** the binding is created, **when** `backendOperationId` is chosen, **then** it is taken from the
   mapping's approved `OperationMapping`s (their **target** side) — never free-form
   ([data-model.md](../architecture/data-model.md) `AdapterBinding`).
5. **Given** the derivation runs, **when** it completes, **then** the Graph Service upserts the
   adapter-dependency `GraphEdge`(s) for the new/changed bindings
   ([adapter-endpoint-composition.md](../flows/adapter-endpoint-composition.md) step 6).
6. **Given** the event is redelivered or the mapping incrementally re-approved, **when** derivation re-runs,
   **then** it is **idempotent**: no duplicate endpoints/bindings, and an already-composed endpoint's
   configuration is left untouched (AI-3).
7. **Given** the Event Bus loses the event, **when** the reconciliation sweep runs, **then** the missing
   derivation is re-derived from persisted state — an approved consumer-provider mapping with no
   endpoint/binding is exactly what the sweep re-triggers
   ([overview.md](../architecture/overview.md) *Components*; AI-3).

### Out of scope

- Composing a multi-binding endpoint — CO-2. Serving — RT/RP/TE/AG.

### Dependencies

Blocked by AD-1, AD-2, Phase-3 AI-2/AI-3. Precedes everything that serves.

---

## CO-2 — The composition decision and its validation

**As an** operator (composer), **I** choose how multiple approved backends combine and have the mediator reject
combinations that cannot execute, **so that** an endpoint never goes live in a configuration whose semantics
are undefined.

### Acceptance criteria

1. **Given** a `composition-required` endpoint, **when** the composer submits a composition, **then** they
   supply: `aggregationStrategy`, each binding's `role`, `executionOrder`/`dependsOnBindingId` (with
   `chainInputs` where chained), strict-vs-degraded mode, and `cacheTtl`
   ([adapter-endpoint-composition.md](../flows/adapter-endpoint-composition.md) step 4).
2. **Given** the submitted roles, **when** validation runs, **then** they are checked against the
   **role-validity table**: `single` → `primary` only; `fanout-merge` → `primary` + `supplement` (no
   `fallback`); `collection-union` → `supplement` only; `fanout-first-success` → `primary` + `fallback` (no
   `supplement`) — a role outside its strategy's set is **rejected**
   ([adapter-engine.md](../architecture/adapter-engine.md) *Role validity per aggregation strategy*).
3. **Given** `dependsOnBindingId`, **when** validation runs, **then** it is accepted **only** under
   `fanout-merge`, only pointing at another binding of the same endpoint, and only in an acyclic arrangement;
   under `single` and `fanout-first-success` it is rejected
   ([adapter-engine.md](../architecture/adapter-engine.md) order/chaining validity rules).
4. **Given** `fanout-first-success`, **when** validation runs, **then** `executionOrder` must be a **strict
   total order** — **ties are rejected**, because "try two in parallel and take whichever succeeds first" is a
   different, unsupported semantic ([adapter-engine.md](../architecture/adapter-engine.md)).
5. **Given** a chained binding's `chainInputs`, **when** validation runs, **then** each `upstreamFieldPath`
   must be a field the upstream binding's **consumer-shape response** actually provides (per that mapping's
   `phase = response` `FieldMapping`s) and each `targetParamRef` must be a real parameter of this binding's
   backend operation — otherwise rejected
   ([adapter-endpoint-composition.md](../flows/adapter-endpoint-composition.md) step 5).
6. **Given** a binding whose backend operation has a **required** parameter with no `ParameterMapping` and no
   `chainInput`, **when** validation runs, **then** the binding is **not composable** and is rejected with that
   parameter named — the loud, composition-time form of TE-1 criterion 3 (this is precisely the scenario-4
   fixture's "rejected bindings: their `{owner}`/`{repo}` path params have no consumer counterpart", see
   [scenarios/scenario-4-mixed/specs/consumer/task-dashboard.yaml](../../scenarios/scenario-4-mixed/specs/consumer/task-dashboard.yaml)).
7. **Given** the consumer operation is a **write**, **when** validation runs, **then** the strategy must be
   `single` with exactly one `active` binding (WR-1)
   ([adapter-engine.md](../architecture/adapter-engine.md) *Write operations*).
8. **Given** validation passes, **when** the composition is activated, **then** `proposed` bindings become
   `active` and the endpoint returns to `active`; **given** validation fails, **then** **nothing** is activated
   and the endpoint keeps serving its previous configuration
   ([adapter-endpoint-composition.md](../flows/adapter-endpoint-composition.md) step 5).
9. **Given** composition is an operator mutation, **when** a `viewer` attempts it, **then** it is rejected 403
   and attribution is recorded for operator actions (OA-2/OA-3;
   [security.md](../architecture/security.md)).

### Out of scope

- Union-specific configuration — CO-3. Supplement analysis — CO-4.

### Dependencies

Blocked by CO-1, AD-1, AD-2. Precedes AG-*, WR-1, AP-2.

---

## CO-3 — Union composition: dedup, post-merge filters, sorts, pagination

**As an** operator (composer), **I** configure exactly how a union filters, sorts, pages, and deduplicates,
**so that** a union endpoint never answers a request whose semantics nobody defined.

### Acceptance criteria

1. **Given** a `collection-union` composition, **when** the composer configures dedup, **then** the options are
   exactly: **link-based** dedup (existing `RecordLink`s), a **dedup key** (a consumer-schema field), or
   **none** — and "none" is an explicit choice, not an unset default that silently means something else
   ([adapter-engine.md](../architecture/adapter-engine.md) *Aggregation strategies*;
   [adapter-endpoint-composition.md](../flows/adapter-endpoint-composition.md) step 4).
2. **Given** link-based dedup, **when** it is offered, **then** it is offered **only** when **every**
   contributing backend resource has a **confirmed** `ResourceBinding.nativeIdRef` — because dedup needs each
   row's backend-native id as provenance ([adapter-engine.md](../architecture/adapter-engine.md) *Aggregation
   strategies*; TE-4 criterion 5).
3. **Given** dedup is enabled, **when** the composer sets orders, **then** the UI **nudges distinct
   `executionOrder` values** (field conflicts resolve by order precedence; ties fall back to binding id)
   ([adapter-engine.md](../architecture/adapter-engine.md) *Aggregation strategies*).
4. **Given** each consumer **filter** parameter of the operation, **when** composition validation runs, **then**
   each is classified as **pushdown-eligible** (mapped by a `ParameterMapping` in *every* contributing binding)
   or requiring a `postMergeFilters` entry (`consumerFieldPath` + `operator`); a filter with **neither** is
   recorded as unserviceable so requests using it are rejected at validation (RP-2 criterion 2)
   ([adapter-engine.md](../architecture/adapter-engine.md) *Aggregation strategies*).
5. **Given** each consumer **sort** and **pagination** parameter, **when** composition runs, **then** the
   mediator **heuristically pre-fills** `postMergeSorts` / `postMergePagination` and the composer **confirms or
   corrects** them — the same derive-then-confirm pattern as `ResourceBinding.paginationRef`; an unconfirmed
   entry is **not** treated as configured ([data-model.md](../architecture/data-model.md) `postMergeSorts`,
   `postMergePagination`; [adapter-engine.md](../architecture/adapter-engine.md) *Aggregation strategies*).
6. **Given** the composer confirms nothing for a sort or pagination parameter, **when** composition completes,
   **then** the endpoint may still activate, and requests using those parameters are **rejected** at request
   validation — never answered unsorted or mispaged (RP-2 criterion 3).
7. **Given** each contributing backend resource, **when** the union is validated, **then** its
   `collectionReadRef` (and `paginationRef` where the read is paged) must be confirmed — otherwise the union is
   not composable over it (AG-5 criterion 3)
   ([data-model.md](../architecture/data-model.md) `ResourceBinding`).
8. **Given** a union over large collections, **when** composition completes, **then** the endpoint is **flagged**
   for the size risk with `cacheTtl` named as the practical mitigation
   ([adapter-engine.md](../architecture/adapter-engine.md) *Aggregation strategies*).

### Out of scope

- Executing any of it — AG-3/AG-4/AG-5.

### Dependencies

Blocked by CO-2, Phase-1 RB-2 (`nativeIdRef`/`collectionReadRef`/`paginationRef` confirmation). Precedes AG-3.

---

## CO-4 — Supplement analysis: which supplements are load-bearing

**As an** operator (composer), **I** see per `supplement` binding whether a degraded response is even possible,
**so that** "non-strict" is an informed choice rather than a hopeful one.

### Acceptance criteria

1. **Given** a `fanout-merge` composition, **when** it is presented, **then** the mediator derives, per
   `supplement` binding, **which consumer response fields it supplies** (from that mapping's `phase = response`
   `FieldMapping`s) and whether **all** of them are `optional` in the consumer response schema
   ([adapter-endpoint-composition.md](../flows/adapter-endpoint-composition.md) step 4;
   [adapter-engine.md](../architecture/adapter-engine.md) *Error and partial-failure semantics*).
2. **Given** a supplement supplying at least one **required** consumer field, **when** the composition is
   presented, **then** it is stated to be **load-bearing**: its failure fails the whole request even in
   non-strict mode ([adapter-engine.md](../architecture/adapter-engine.md) *Error and partial-failure
   semantics*).
3. **Given** the strict-vs-degraded choice, **when** it is made, **then** it is an explicit composer decision
   recorded on the endpoint (AD-1 criterion 5) — never inferred from the analysis
   ([adapter-endpoint-composition.md](../flows/adapter-endpoint-composition.md) step 4).
4. **Given** the analysis is a **derivation**, **when** it is used at request time, **then** the runtime
   re-derives required-ness from the consumer schema rather than trusting a stale composition-time snapshot
   (AG-2 criterion 4) — the analysis informs the human; the schema governs execution.
5. **Given** a `primary` binding in `fanout-merge`, **when** the analysis runs, **then** it is stated that a
   primary failure always fails the request, independent of strictness
   ([adapter-engine.md](../architecture/adapter-engine.md) *Error and partial-failure semantics*).

### Out of scope

- Executing degradation — AG-2.

### Dependencies

Blocked by CO-2. Precedes AG-2, CU-1.

---

## CO-5 — Consumer-input coverage: derive the unmapped inputs, make the composer acknowledge them

**As an** operator (composer), **I** see exactly which consumer inputs no backend receives, **so that** an
endpoint never quietly ignores a parameter its caller believes is being honored.

### Acceptance criteria

1. **Given** a composition, **when** it is presented, **then** the mediator lists, per binding, every consumer
   operation **parameter** with no `ParameterMapping` and no `chainInput`, and every consumer **request-phase
   body field** that maps to no backend field
   ([data-model.md](../architecture/data-model.md) `ParameterMapping`, `FieldMapping.phase`).
2. **Given** such an unmapped consumer parameter, **when** composition is submitted, **then** the composer must
   either leave the endpoint unable to serve requests using it (RP-2 criterion 4 rejects them) or
   **explicitly acknowledge** that it is ignored — silence is not a valid third option
   ([adapter-engine.md](../architecture/adapter-engine.md) *Aggregation strategies*, the same principle as an
   unconfigured union filter). *This generalizes a union-only rule to all strategies — README open question 7.*
3. **Given** a **required** consumer parameter or required request-body field that reaches no backend, **when**
   composition is validated, **then** it is surfaced as a blocking finding — a required input that goes nowhere
   is a mapping defect, not a composition preference.
4. **Given** an acknowledged-ignored input, **when** a request uses it, **then** the request is **served** and
   the acknowledgement is what makes that non-silent — it is visible in the endpoint's composition and in the
   operator UI (CU-1 criterion 5).
5. **Given** the input-coverage report, **when** it is produced, **then** it is a **derivation** the composer
   confirms — never auto-acknowledged
   ([adapter-endpoint-composition.md](../flows/adapter-endpoint-composition.md), derive-then-confirm).

### Out of scope

- Fixing the coverage — that means re-reviewing the mapping (Phase 3 / Phase-6 re-review), not composing around
  it.

### Dependencies

Blocked by CO-2. Precedes RP-2 criterion 4, CU-1.

---

## CO-6 — Recomposition, endpoint/binding enable & disable

**As an** operator, **I** can change an active endpoint's serving semantics or take a binding out of service
without deleting anything, **so that** operational adjustments do not require re-approving mappings.

### Acceptance criteria

1. **Given** an `active` endpoint, **when** the operator changes its strategy, roles, order/chaining,
   `postMerge*`, dedup, strictness, or `cacheTtl`, **then** it runs through the **same** validation as CO-2/CO-3
   and activates on success — recomposition is the same action minus the triggering approval
   ([adapter-endpoint-composition.md](../flows/adapter-endpoint-composition.md) *Notes*).
2. **Given** a binding is set `disabled` at (re)composition, **when** the endpoint serves, **then** the
   Resolution Planner **skips** it and the binding row is retained, so a later recomposition can reactivate it
   ([data-model.md](../architecture/data-model.md) `AdapterBinding.status`).
3. **Given** an endpoint is set `disabled` by an operator, **when** it is called, **then** requests are rejected
   with `endpoint-disabled` (RT-3 criterion 2), and re-enabling restores its stored configuration
   ([data-model.md](../architecture/data-model.md) `AdapterEndpoint.status`).
4. **Given** any of these changes commits, **when** it takes effect, **then** the endpoint's cached entries are
   dropped (CH-5) — a change never takes up to `cacheTtl` to become visible.
5. **Given** a recomposition would leave a **write** endpoint with more than one `active` binding or a role
   outside its strategy's set, **when** it is validated, **then** it is rejected and the prior configuration
   keeps serving (CO-2 criteria 2/7-8).
6. **Given** every recomposition, **when** it commits, **then** it is attributed to the authenticated operator
   in the audit log (OA-3) and the adapter-dependency `GraphEdge`s are updated
   ([adapter-endpoint-composition.md](../flows/adapter-endpoint-composition.md) step 6).

### Out of scope

- Deleting bindings/endpoints outside the app-lifecycle cascade — Phase-6 deregistration
  ([extensibility.md](../architecture/extensibility.md) *App lifecycle*).

### Dependencies

Blocked by CO-2, CO-3, CH-5. Precedes AP-2, AP-3.

---

## CO-7 — Successor adoption re-validates composition without decomposing the endpoint

**As a** landscape operator, **I** have re-approval after a breaking spec change re-point my bindings in place,
keeping chain and composition state, **so that** a spec bump does not force me to compose every endpoint again
— and never leaves a broken configuration serving.

### Acceptance criteria

1. **Given** a `stale` mapping's successor is approved and adopted, **when** adoption runs, **then** the stale
   mapping's `AdapterBinding`s are **re-pointed** (`approvedMappingId`) to the successor and the endpoint keeps
   its composed configuration — including `chainInputs`, which live on the binding precisely so they carry over
   ([extensibility.md](../architecture/extensibility.md) *Successor adoption*).
2. **Given** adoption, **when** it runs, **then** it is deliberately **not** the "new binding attaches as
   `proposed` → `composition-required`" path — a successor takes over its predecessor's slot
   ([extensibility.md](../architecture/extensibility.md) *Successor adoption*).
3. **Given** adoption, **when** it runs, **then** the endpoint's **composition validation is re-run against the
   successor's content** — not only the adopted binding's own `chainInputs`, but every composition-time
   derivation that depends on mapping content: (a) the `chainInputs` of bindings that **depend on** the adopted
   binding (their `upstreamFieldPath`s must still be populated by the successor's response phase), (b) union
   filter **pushdown eligibility** (revoked if the successor drops a `ParameterMapping`), (c) the **dedup key**'s
   coverage by the successor's response phase, and (d) each supplement's supplied-fields/required-ness analysis
   ([extensibility.md](../architecture/extensibility.md) *Successor adoption*).
4. **Given** any of those assumptions no longer holds, **when** adoption completes, **then** the endpoint is
   flagged `composition-required` rather than serving a broken configuration — and, per CO-1 criterion 3, it
   keeps serving its previous configuration only where that configuration is still valid; where it is not, the
   affected requests fail loudly rather than silently changing meaning
   ([extensibility.md](../architecture/extensibility.md) *Successor adoption*).
5. **Given** adoption commits, **when** caching is considered, **then** the affected endpoints' cached entries
   are dropped (CH-5 criterion 4).
6. **Given** a binding whose mapping went `stale`, **when** no successor has been adopted yet, **then** the
   binding keeps its composed configuration and simply fails live calls with `mapping-stale` (RP-3) — staleness
   **pauses** a binding, it does not decompose the endpoint
   ([adapter-endpoint-composition.md](../flows/adapter-endpoint-composition.md) *Notes*).

### Out of scope

- Producing the successor (re-review), computing `SpecDiff`, and marking mappings `stale` — **Phase 6**
  ([extensibility.md](../architecture/extensibility.md) *Spec update lifecycle*). Phase 5 owns only the
  **adapter-side adoption behavior**; if Phase 6 lands first, this story is its adapter half.

### Dependencies

Blocked by CO-2, CO-3, CO-4, CH-5. Depends on Phase-6 staleness/succession for its trigger — Phase 5 specifies
and unit-tests the adoption behavior against a simulated succession; the live trigger arrives with Phase 6.
