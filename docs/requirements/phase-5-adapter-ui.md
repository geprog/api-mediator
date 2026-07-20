# Phase 5 — Composition UI, token panel (+ the capstone adapter e2e)

The **UI** slice: Vue 3 (`<script setup lang="ts">`, Composition API) screens that drive the Adapter Engine
through the Phase-5 API — a composition screen (strategy, roles, order/chaining, strictness, `cacheTtl`), a
union-specific panel (dedup, post-merge filters/sorts/pagination), the adapter-token panel that shows a token
exactly once, and an endpoint-health view — plus the capstone e2e that serves real consumer requests from
**running** scenario-3/4 landscapes. These stories are deliberately **thin**: they render and call the API;
every invariant is enforced server-side.

**Actor:** operator (mutations, as *composer*), viewer (read-only).

**Concept references (whole file):** [adapter-endpoint-composition.md](../flows/adapter-endpoint-composition.md)
step 4 (everything the UI must surface) + *Notes*; [adapter-engine.md](../architecture/adapter-engine.md)
*Role validity per aggregation strategy*, *Aggregation strategies*, *Error and partial-failure semantics*,
*Caching*; [security.md](../architecture/security.md) *Inbound authentication to generated adapter servers*
(shown once), *Operator authentication & authorization*;
[observability.md](../architecture/observability.md) *Alerting*; [glossary.md](../glossary.md)
`Endpoint composition`, `composition-required`, `Operator / Viewer`. E2e landscapes:
[scenarios/README.md](../../scenarios/README.md) — scenario 3
([todo-widget.yaml](../../scenarios/scenario-3-consumer-provider/specs/consumer/todo-widget.yaml), port
`13900`) and scenario 4
([task-dashboard.yaml](../../scenarios/scenario-4-mixed/specs/consumer/task-dashboard.yaml), port `14900`).

> **Copy and layout are the implementation choice; the surfaced *distinctions and warnings* are
> authoritative.** The composition screen must make the role-validity constraints, the load-bearing-supplement
> analysis, the union's unconfigured-parameter consequences, the input-coverage gaps, and the cache-freshness
> coverage visible; it must never let an invalid composition be submitted as if valid, and never present a
> derived value as confirmed.

---

## CU-1 — Composition screen

**As an** operator (composer), **I** compose an endpoint from its approved bindings with the illegal choices
visibly unavailable, **so that** I can make the serving decision without memorizing the role-validity table.

### Acceptance criteria

1. **Given** the endpoint list, **when** it renders, **then** endpoints in `composition-required` are surfaced
   as a queue with their age, and it is stated that each **keeps serving its previous configuration** meanwhile
   ([adapter-endpoint-composition.md](../flows/adapter-endpoint-composition.md) step 4;
   [observability.md](../architecture/observability.md) *Alerting*).
2. **Given** the composition form, **when** a strategy is chosen, **then** the roles offered per binding are
   exactly that strategy's valid set (`single` → `primary`; `fanout-merge` → `primary`/`supplement`;
   `collection-union` → `supplement`; `fanout-first-success` → `primary`/`fallback`), and
   `executionOrder`/`dependsOnBindingId` are offered only where they are meaningful
   ([adapter-engine.md](../architecture/adapter-engine.md) *Role validity per aggregation strategy*).
3. **Given** `fanout-first-success`, **when** orders are entered, **then** ties are flagged before submission
   (and rejected server-side regardless, CO-2 criterion 4).
4. **Given** a chained binding, **when** `chainInputs` are configured, **then** the form offers the **upstream
   binding's consumer-shape response fields** as the source options — never the upstream backend's native
   fields ([data-model.md](../architecture/data-model.md) `AdapterBinding.chainInputs`).
5. **Given** the supplement analysis (CO-4) and input-coverage report (CO-5), **when** the form renders,
   **then** it states per supplement whether a degraded response is possible or the supplement is
   **load-bearing**, and lists every consumer input that reaches no backend, requiring explicit acknowledgement
   ([adapter-endpoint-composition.md](../flows/adapter-endpoint-composition.md) step 4).
6. **Given** the consumer operation is a **write**, **when** the form renders, **then** only `single` is offered
   and the reason is stated ([adapter-engine.md](../architecture/adapter-engine.md) *Write operations*).
7. **Given** a `viewer`, **when** they open the screen, **then** it renders read-only — compose/enable/disable
   controls are absent or disabled (OA-2).

### Out of scope

- Validation itself — CO-2 (the UI mirrors it; the server enforces it).

### Dependencies

Blocked by AP-1, AP-2, AP-3, Phase-3 OA-2.

---

## CU-2 — Union composition panel (dedup, post-merge semantics, cache coverage)

**As an** operator (composer), **I** configure a union's dedup and its filter/sort/pagination semantics with
the consequences of leaving them unset stated up front, **so that** I know a parameter I skip will make
requests using it fail — by design.

### Acceptance criteria

1. **Given** a `collection-union` composition, **when** the panel renders, **then** each consumer filter
   parameter is shown as **pushed down** or **needing post-merge semantics**, and an unconfigured one is
   labelled with its consequence: requests using it are **rejected**, never answered unfiltered
   ([adapter-engine.md](../architecture/adapter-engine.md) *Aggregation strategies*).
2. **Given** sort and pagination parameters, **when** the panel renders, **then** the heuristic pre-fill is
   shown as **unconfirmed** and must be explicitly confirmed or corrected — a pre-filled value is never
   displayed as if the composer had chosen it (derive-then-confirm, CO-3 criterion 5).
3. **Given** dedup options, **when** the panel renders, **then** link-based dedup is offered **only** when every
   contributing backend resource has a confirmed `nativeIdRef` (with the missing ones named as the reason
   otherwise); the dedup-key option lists consumer-schema fields; **no dedup** is an explicit choice. When dedup
   is enabled, distinct `executionOrder` values are **nudged**
   ([adapter-engine.md](../architecture/adapter-engine.md) *Aggregation strategies*).
4. **Given** `cacheTtl` is being set, **when** the panel renders, **then** it states **which invalidation
   signals cover the backends involved** — and, for a backend that is neither peer-synced nor written through
   the adapter, that **TTL is the only freshness bound**
   ([adapter-engine.md](../architecture/adapter-engine.md) *Caching*;
   [adapter-endpoint-composition.md](../flows/adapter-endpoint-composition.md) step 4).
5. **Given** a union over large collections, **when** the panel renders, **then** it **flags** the size risk and
   names `cacheTtl` as the practical mitigation, and states the per-request row ceiling that will fail the
   request rather than truncate it (AG-5)
   ([adapter-engine.md](../architecture/adapter-engine.md) *Aggregation strategies*).
6. **Given** a `viewer`, **when** they open the panel, **then** it renders read-only (OA-2).

### Out of scope

- Executing any of it — AG-3/AG-4/AG-5.

### Dependencies

Blocked by CU-1, AP-2, CO-3.

---

## CU-3 — Adapter-token panel: shown exactly once

**As an** operator, **I** issue or rotate a consumer's adapter token and copy it in the moment it is shown,
**so that** the one deliberate exception to "secrets are never returned" stays a narrow one.

### Acceptance criteria

1. **Given** a consumer app with no token, **when** the operator issues one, **then** the raw token is displayed
   **once**, with explicit copy affordance and an unmistakable statement that it cannot be retrieved again
   ([security.md](../architecture/security.md); [glossary.md](../glossary.md) `API/UI Layer`).
2. **Given** the panel is reloaded, navigated away from, or reopened, **when** it renders, **then** the raw
   token is **not shown again** — only metadata (existence, `lastRotatedAt`, overlap state) is displayed (AT-1
   criterion 2).
3. **Given** rotation, **when** the operator rotates, **then** the new token is shown once and the panel states
   that the previous token stays valid during the overlap window until cutover is confirmed or the window
   elapses (AT-4).
4. **Given** the consumer app's adapter base URL, **when** the panel renders, **then** it shows how the consumer
   should call the adapter surface (host/port and auth scheme) — the operational handoff the consumer team
   needs.
5. **Given** a `viewer`, **when** they open the panel, **then** issue/rotate controls are absent or disabled and
   no token value is ever rendered (OA-2).

### Out of scope

- Delivering the token to the consumer team — out of the product's scope.

### Dependencies

Blocked by AP-4, Phase-3 OA-2.

---

## CU-4 — Endpoint health view

**As a** viewer or operator, **I** see which consumer operations are unserved, degraded, or failing and why,
**so that** I can act on a live consumer's breakage before they report it.

### Acceptance criteria

1. **Given** the consumer app's operations, **when** the view renders, **then** each is shown as served,
   `not-yet-mapped`, `composition-required`, or `disabled` — the four states a consumer-app developer would
   experience differently (RT-3, AP-1 criterion 3).
2. **Given** bindings whose mapping is `stale` or `suspended`, or whose backend app is disabled, **when** the
   view renders, **then** each is shown with its specific cause and the note that adapter staleness breaks a
   **live caller now** (unlike a paused sync rule)
   ([extensibility.md](../architecture/extensibility.md); [observability.md](../architecture/observability.md)
   *Alerting*).
3. **Given** recent adapter requests, **when** the view renders, **then** it shows per-endpoint request/error
   counts, cause breakdown, degraded-response count, and cache hit rate, sourced from AP-5
   ([observability.md](../architecture/observability.md) *Metrics*).
4. **Given** any `mediator-transform-error` occurred, **when** the view renders, **then** it is surfaced
   prominently as a **defect to fix**, not an operational blip
   ([observability.md](../architecture/observability.md) *Alerting*).
5. **Given** the view renders, **when** it loads, **then** it shows no payload values, no token, and no
   credential material ([security.md](../architecture/security.md)).

### Out of scope

- Grafana dashboards — Phase-6 polish.

### Dependencies

Blocked by AP-1, AP-5, Phase-3 OA-2.

---

## CU-5 — Capstone e2e: real consumer requests served from running scenario-3/4 landscapes

**As a** product owner, **I** have an end-to-end journey where a consumer app calls its generated adapter
server and gets real landscape data back, **so that** the Adapter Engine's promises are a tested guarantee, not
a claim.

### Acceptance criteria

1. **Given** a running **scenario-3** landscape (Vikunja + the `todo-widget` CONSUMER spec,
   [scenarios/README.md](../../scenarios/README.md)) with the consumer-provider mapping approved, **when** the
   operator issues the adapter token, **then** it is displayed **exactly once** and a second read of the same
   screen/endpoint never returns it again (AT-1, CU-3).
2. **Given** the approved mapping produced a first binding, **when** the endpoint is derived, **then**
   `GET /todos` is **auto-activated** as `single`/`primary` with no composition step, and calling it on the
   adapter port (`13900`) with the token returns Vikunja tasks mapped into `TodoItem` shape — a real
   single-binding round trip (CO-1, AG-1).
3. **Given** the same consumer surface, **when** `POST /lists/{listId}/todos` is called with the token, **then**
   a **real Vikunja task is created** via `PUT /api/v1/projects/{id}/tasks` (the `listId → id` parameter
   mapping applied) and the created resource is returned in consumer shape; **when** the identical request is
   repeated inside the dedup window, **then** the recorded outcome is returned and **no second task** is created
   (WR-2, WR-3).
4. **Given** a running **scenario-4** landscape (Gitea + Forgejo + Vikunja + the `task-dashboard` CONSUMER
   spec), **when** the operator composes `GET /work-items` as a **`collection-union`** over the three backends
   (all `supplement`, dedup and post-merge semantics confirmed) and calls it on port `14900`, **then** the
   response is one merged, sorted, paged list of `WorkItem`s spanning all three real backends (AG-3, AG-4).
5. **Given** that union endpoint, **when** a request uses `page`/`pageSize` **without** confirmed
   `postMergePagination`, **then** it is **rejected** at request validation — demonstrating "never mispaged"
   against a real landscape (RP-2 criterion 3).
6. **Given** one backend of the union is stopped (or its app disabled), **when** the union is called in
   non-strict mode, **then** the merged result is returned **without** that contributor, the response header
   names the failed/disabled backend, the body still validates against the consumer schema, and the response is
   **not cached** (AG-3 criterion 2, CH-2 criterion 5).
7. **Given** a consumer operation with **no** approved mapping, **when** it is called, **then** it returns
   `not-yet-mapped` — distinguishable from a 404 for an undeclared path and from an upstream failure (RT-3,
   RP-5).
8. **Given** any of these calls **without** a token or with another consumer's token, **when** they are made,
   **then** they are rejected and **no backend call is made** (AT-2, AT-3).
9. **Given** a `viewer` drives the operator half of the journey (issuing a token, composing the union), **when**
   they reach any mutation, **then** the UI/API blocks it (OA-2).
10. **Given** the **`fanout-merge`** strategy has no natural fixture in scenario 3/4, **when** it is proven,
    **then** it is covered by a deterministic integration test (chained binding via `chainInputs`, supplement
    degradation, and load-bearing-supplement failure) against a stubbed backend — **unless** the human approves
    adding a merge-shaped operation to a consumer fixture spec (README open question 14).

### Out of scope

- Sync in the same journey — Phase 4's capstone (SU-6) covers that; this one stops at adapter serving. The
  adapter-write-is-picked-up-by-sync contract (WR-4 criterion 2) is asserted as an integration test, not folded
  into this journey.
- Exhaustive per-scenario coverage — this capstone exercises scenarios 3 and 4; the strategy/role/error-cause
  matrices are carried deterministically by the AG-*/RP-5 unit suites.

### Dependencies

Blocked by CU-1..CU-4, RT-*, AT-*, RP-*, TE-*, AG-*, WR-*, CH-*, CO-1..CO-3, and running scenario-3/4
landscapes. The capstone e2e for Phase 5.
