# Phase 6 — The landscape graph (materialized `GraphEdge` projection + graph UI)

The always-available overview the concept promises from the start: a graph whose **nodes** are every
`RegisteredApp` and whose **edges** are the `GraphEdge`s projected from `ApprovedMapping`-instantiated
`SyncRule`s and `AdapterBinding`s. Phases 3/5 already **create** edges on approval/derivation via an
**ensure-exists** upsert; what they cannot do is **change or remove** an edge when the underlying
rules/bindings change status, get recomposed, are re-pointed to a successor, or are deleted by an
app-lifecycle cascade. This phase completes the projection (incremental **update/remove** + a
**rebuild-from-state** path) and ships the graph read API and the Vue Flow UI.

**What already exists vs. what Phase 6 adds** (checked against `packages/domain/src/downstream-artifacts.ts`,
`packages/db/src/repositories/downstream-artifacts.ts`, `packages/db/src/mappers/graph-edge.ts`):
the `GraphEdge` domain shape (`graphEdgeSchema`, `graphEdgeMetadataSchema` with `direction` +
nullable `lastActivityAt`), the `graph_edge` table (unique on `(source_node_id, target_node_id, type)`,
nodes FK `registered_app`), and an **ensure-exists** `DownstreamArtifactRepository.upsertGraphEdge`
(`onConflictDoNothing` — deliberately unable to rewrite a later phase's `status`/`lastActivityAt`) and a
point read `getGraphEdge(source, target, type)`. Phase 5 CO-6 left two explicit
`// TODO(Phase 6 graph)` markers in `apps/backend/src/modules/adapter-composition/service.ts` (status
mutation ~line 295; recomposition ~line 545) noting that the ensure-exists upsert "cannot remove/rewrite
an edge". Phase 6 **adds** the update/remove projection operations, the incremental updaters, the
rebuild path, the `getGraph` read, and the UI. **No new domain entity or renamed field** is introduced —
the projection is derived, never a source of truth ([graph-overview.md](../flows/graph-overview.md);
[data-model.md](../architecture/data-model.md) `GraphEdge` *Modeling notes*).

**Actor:** system (the Graph/Overview Service maintains the projection); operator/viewer (both read the
graph — it is read-only; there is no operator mutation *of* the graph, only of the artifacts it
projects).

**Concept references (whole file):** [graph-overview.md](../flows/graph-overview.md) (all sections —
*Steps*, *Materialized projection*, *Relationship to the Grafana landscape-health dashboard*);
[overview.md](../architecture/overview.md) *Components* (Graph/Overview Service; `GraphService.getGraph`;
Event Bus not a source of truth + reconciliation sweep); [data-model.md](../architecture/data-model.md)
`GraphEdge`; [extensibility.md](../architecture/extensibility.md) *Spec update lifecycle*, *App lifecycle*
(the status/removal transitions the projection must reflect); [glossary.md](../glossary.md) `GraphEdge`,
`Graph/Overview Service`. Reused seams: [phase-3-artifact-instantiation.md](phase-3-artifact-instantiation.md)
AI-1 (edge upsert on approval); [phase-5-endpoint-composition.md](phase-5-endpoint-composition.md) CO-1.5
(adapter-dependency edge upsert), CO-6 (the recompose/enable/disable TODO markers), CO-7 (successor
adoption re-point).

> **Authoritative:** nodes = `RegisteredApp`s (no per-endpoint nodes — an app's adapter endpoints are edge
> detail); **one sync edge per (app pair, direction)** aggregating that direction's per-resource-pair
> `SyncRule`s; **one adapter-dependency edge per (consumer, backend) app pair** aggregating that pair's
> `AdapterBinding`s; the projection is **incrementally updated** on the three documented triggers **and
> wholesale rebuildable** from persisted state; per-resource/per-operation detail lives in the edge's
> `metadata`. **Implementation choice:** the graph library (Vue Flow, per open question 1), edge-status
> vocabulary (open question 2), layout, UI copy, filter query shape, `metadata` sub-structure.

---

## GR-1 — Extend the `GraphEdge` projection with update and remove

**As the** Graph/Overview Service, **I** can rewrite an edge's status/metadata and delete an edge that no
longer has any underlying rules/bindings, **so that** the graph reflects the *current* landscape and not
just what was ever approved.

### Acceptance criteria

1. **Given** an existing `graph_edge` row for `(sourceNodeId, targetNodeId, type)`, **when** the projection
   recomputes it, **then** an **update** operation writes the new `status` and `metadata` in place (same
   row id), **replacing** the prior values — the gap the ensure-exists `upsertGraphEdge`
   (`onConflictDoNothing`) cannot fill ([data-model.md](../architecture/data-model.md) `GraphEdge`;
   `packages/db/src/repositories/downstream-artifacts.ts` `upsertGraphEdge`).
2. **Given** an (app pair, direction, type) whose **last** underlying `SyncRule`/`AdapterBinding` is
   deleted (e.g. by the AL-2 deregister cascade) or otherwise leaves the aggregate empty, **when** the
   projection recomputes, **then** the edge **row is removed** — a graph never shows a dependency backed by
   nothing ([extensibility.md](../architecture/extensibility.md) *App lifecycle*;
   [graph-overview.md](../flows/graph-overview.md) *Materialized projection*).
3. **Given** the ensure-exists `upsertGraphEdge` used at approval/derivation (AI-1, CO-1.5), **when** GR-1
   lands, **then** it is **retained unchanged** for the create case; GR-1 adds *separate* update and
   remove operations, so an incremental updater chooses create-if-absent vs. update vs. remove explicitly
   (no operation silently clobbers on create — the AI-3 idempotency invariant is preserved).
4. **Given** an update or remove, **when** it runs, **then** it targets an edge by its stable
   `(sourceNodeId, targetNodeId, type)` key (nodes = app ids) — never by a mapping/rule/binding id, since
   one edge **aggregates many** of those ([graph-overview.md](../flows/graph-overview.md) *Steps*).
5. **Given** a recompute that finds the aggregate non-empty, **when** it writes, **then** `lastActivityAt`
   is **preserved** unless the triggering signal is itself a `SyncEvent` (GR-4) — a status recompute never
   resets activity, and an activity update never rewrites status (the two updaters touch disjoint
   `metadata`) ([graph-overview.md](../flows/graph-overview.md) *Materialized projection*).

### Out of scope

- Deciding *when* to recompute — GR-2/GR-3. The read side — GR-5.

### Dependencies

Blocked by Phase-3 AM-6/AI-1 (`GraphEdge` domain + `upsertGraphEdge`). Precedes GR-2 … GR-6.

---

## GR-2 — Incremental sync-edge projection

**As the** Graph/Overview Service, **I** keep each sync edge's status and activity current as its
resource-pair `SyncRule`s are approved, enabled, paused, and executed, **so that** the overview shows a
sync relationship's real state without recomputing the whole graph.

### Acceptance criteria

1. **Given** `MappingApproved` for a **peer-peer** `ApprovedMapping` instantiating `SyncRule`(s), **when**
   the Graph Service reacts, **then** it upserts **one** sync `GraphEdge` per **(source app → target app,
   direction)**, aggregating that direction's per-resource-pair `SyncRule`s; the per-resource-pair detail
   lands in `metadata` ([graph-overview.md](../flows/graph-overview.md) *Steps*, *Materialized
   projection*; AI-1).
2. **Given** a `SyncRule`'s **effective status** changes — enabled, disabled, or paused because its
   `ApprovedMapping` went `stale`/`suspended` (SL-4/SL-10) or its app was disabled (AL-1) — **when** the
   change commits, **then** the edge's `status` is **recomputed** via GR-1's update from the current
   aggregate of that direction's rules ([graph-overview.md](../flows/graph-overview.md) *Materialized
   projection*; [extensibility.md](../architecture/extensibility.md) *Spec update lifecycle*).
3. **Given** the aggregate of a (pair, direction)'s rules is **mixed** (some enabled, some paused),
   **when** status is recomputed, **then** the edge carries a status that distinguishes "all healthy" from
   "some degraded" from "all paused" — the exact vocabulary is open question 2, but a partially-paused edge
   is **never** rendered identically to a fully-healthy one.
4. **Given** a `SyncEvent` is recorded for a rule of the pair, **when** the edge's activity is updated,
   **then** only `metadata.lastActivityAt` moves (via GR-4) — `status` is untouched
   ([graph-overview.md](../flows/graph-overview.md) *Materialized projection*).
5. **Given** the last `SyncRule` for a (pair, direction) is deleted (AL-2), **when** the projection
   recomputes, **then** the sync edge is **removed** (GR-1 criterion 2).
6. **Given** the reaction runs inside the Event-Bus dispatcher, **when** it executes, **then** it does
   only cheap DB reads + a projection write (no LLM/network work), honoring the dispatcher-tx constraint,
   and is **idempotent** on redelivery (a repeat recompute yields the same edge) (AI-3).

### Out of scope

- Adapter-dependency edges — GR-3. Activity-metadata mechanics — GR-4.

### Dependencies

Blocked by GR-1, Phase-3 AI-1. Coupled to SL-4/SL-10 (staleness/suspend transitions) and AL-1 (disable) —
those stories **produce** the status changes this story projects.

---

## GR-3 — Incremental adapter-dependency edge projection (the CO-6 TODO markers)

**As the** Graph/Overview Service, **I** keep each adapter-dependency edge current as bindings are
composed, enabled, disabled, adopted, and deleted, **so that** the two `// TODO(Phase 6 graph)` markers
CO-6 left — where a recompose/enable-disable *should* update the edge but the ensure-exists upsert
**cannot** — are resolved.

### Acceptance criteria

1. **Given** a consumer-provider `ApprovedMapping` derivation (CO-1) or recomposition (CO-6), **when** the
   Graph Service reacts, **then** it upserts **one** adapter-dependency `GraphEdge` per **(consumer app →
   backend app)** pair, aggregating that pair's `AdapterBinding`s; per-operation detail lands in
   `metadata` ([graph-overview.md](../flows/graph-overview.md) *Steps*; CO-1.5).
2. **Given** an operator **recomposes** an endpoint or sets a binding `disabled`/re-enabled (CO-6), **when**
   the change commits, **then** the affected (consumer → backend) edge's `status` is **recomputed via
   GR-1's update** — this is exactly the recompute the CO-6 markers said it "cannot invoke cheaply now"
   (`apps/backend/src/modules/adapter-composition/service.ts` ~lines 295, 545).
3. **Given** a binding's `ApprovedMapping` transitions to `stale`/`suspended`/`superseded` (SL-4/SL-7/SL-10),
   **when** the transition is observed, **then** the (consumer → backend) edge status reflects the paused
   dependency ([extensibility.md](../architecture/extensibility.md) *Spec update lifecycle*).
4. **Given** successor adoption re-points a binding's `approvedMappingId` (CO-7/SL-7) with the endpoint
   still `active`, **when** adoption commits, **then** the edge stays present and is recomputed — adoption
   preserves the dependency, it does not tear it down.
5. **Given** the **last** `AdapterBinding` for a (consumer → backend) pair is deleted or the backend/consumer
   app is deregistered (AL-2), **when** the projection recomputes, **then** the adapter-dependency edge is
   **removed** (GR-1 criterion 2); a consumer-only app that loses its adapter surface is still a node with
   no adapter-dependency edges ([extensibility.md](../architecture/extensibility.md) *App lifecycle*;
   [graph-overview.md](../flows/graph-overview.md) *Steps*).
6. **Given** the recompute, **when** it runs, **then** it is idempotent and attributed nowhere (the graph
   is a projection, not an audited mutation) — the operator action that triggered it is already audited by
   its own story (CO-6.6, AL-2).

### Out of scope

- The composition/adoption logic itself — CO-2/CO-6/CO-7. Activity metadata — GR-4.

### Dependencies

Blocked by GR-1, Phase-5 CO-1/CO-6/CO-7. **Resolves the CO-6 `// TODO(Phase 6 graph)` markers.** Coupled
to SL-4/SL-7/SL-10 and AL-2.

---

## GR-4 — Activity metadata from `SyncEvent`s

**As the** Graph/Overview Service, **I** stamp an edge's last-activity time from the Audit/Event Log,
**so that** the overview shows which relationships are live without querying execution history per render.

### Acceptance criteria

1. **Given** a `SyncEvent`/`AuditLog` entry attributable to a rule or binding of an edge, **when** it is
   recorded, **then** the edge's `metadata.lastActivityAt` is advanced to that event's timestamp; nothing
   else on the edge changes ([graph-overview.md](../flows/graph-overview.md) *Materialized projection*;
   [data-model.md](../architecture/data-model.md) `GraphEdge`).
2. **Given** an out-of-order or redelivered event with an **older** timestamp, **when** the activity
   update runs, **then** `lastActivityAt` is **never moved backwards** (monotonic), so a slow redelivery
   cannot make a live edge look stale.
3. **Given** `lastActivityAt` is nullable, **when** an edge has been upserted on approval but its
   rules/bindings have never executed, **then** it renders with **no** last-activity — the null the domain
   shape already permits (`graphEdgeMetadataSchema.lastActivityAt` nullable;
   `packages/db/src/mappers/graph-edge.ts` reconstructs a jsonb ISO string back to a `Date`).
4. **Given** activity is sourced from `SyncEvent`/audit summaries and **not** from OpenTelemetry, **when**
   this is implemented, **then** it reads the durable Audit/Event Log (a source other components already
   read), never the telemetry pipeline — the two are complementary
   ([observability.md](../architecture/observability.md) *Relationship to the Audit/Event Log*).

### Out of scope

- Rendering activity over time / trends — that is the Grafana landscape-health dashboard (OB-3/OB-4), not
  the structural graph ([graph-overview.md](../flows/graph-overview.md) *Relationship to the Grafana
  landscape-health dashboard*).

### Dependencies

Blocked by GR-1. Reads Phase-4 `SyncEvent`/audit (SD-4) and Phase-5 `adapter-request` audit rows.

---

## GR-5 — `GraphService.getGraph(filter)` read API

**As a** landscape operator or viewer, **I** fetch the whole landscape as `{ nodes, edges }`, optionally
filtered, **so that** the overview loads responsively from the materialized projection rather than
recomputing from first principles.

### Acceptance criteria

1. **Given** a graph request, **when** it is served, **then** it returns `{ nodes, edges }` where `nodes`
   is **every** `RegisteredApp` (including consumer-only apps, which are ordinary nodes) and `edges` is the
   materialized `GraphEdge` set — assembled from the projection, not recomputed
   ([overview.md](../architecture/overview.md) `GraphService.getGraph`;
   [graph-overview.md](../flows/graph-overview.md) *Steps*).
2. **Given** an optional filter by **app**, by **status**, or by **connection type** (sync /
   adapter-dependency), **when** it is applied, **then** the returned nodes/edges are restricted
   accordingly ([graph-overview.md](../flows/graph-overview.md) *Steps* step 1).
3. **Given** each returned edge, **when** it is serialized, **then** it carries `type`, `status`, and
   `metadata` (direction + `lastActivityAt` + per-resource/per-operation detail) so the UI needs no
   second call for edge detail ([graph-overview.md](../flows/graph-overview.md) *Steps* step 2).
4. **Given** a **disabled** app (AL-1), **when** the graph is read, **then** the app still appears as a
   node with its edges reflecting the paused/`backend-disabled` condition — disable does not remove a node;
   a **deregistered** app (AL-2) is gone from nodes and edges entirely.
5. **Given** the read is a query, **when** a `viewer` requests it, **then** it succeeds — the graph is
   read-only for both roles (viewer read access; no operator-only gate)
   ([glossary.md](../glossary.md) *Operator / Viewer*).
6. **Given** the small-landscape scale assumption (~15-20 apps), **when** the graph is returned, **then**
   it is returned **unpaginated** (open question 3) ([overview.md](../architecture/overview.md) *Scale
   assumption*).

### Out of scope

- Grafana's operational-health view — that is a separate, complementary surface (OB-4).

### Dependencies

Blocked by GR-1 … GR-4. Precedes GR-6.

---

## GR-6 — Vue Flow graph UI

**As a** landscape operator or viewer, **I** see the landscape as an interactive node/edge diagram,
**so that** I can grasp what is mapped to what — and which relationships are healthy, paused, or stale — at
a glance.

### Acceptance criteria

1. **Given** the graph page loads, **when** it renders, **then** it draws one node per `RegisteredApp` and
   one edge per `GraphEdge` from `GraphService.getGraph`, using **Vue Flow** (open question 1), with
   `<script setup lang="ts">` and no Options API (CLAUDE.md frontend convention).
2. **Given** an edge's `status`, **when** it renders, **then** its visual style distinguishes at least:
   healthy, paused/degraded (some rules/bindings paused), and stale/suspended — a stale edge is never
   indistinguishable from a healthy one ([graph-overview.md](../flows/graph-overview.md) *Steps*).
3. **Given** an edge's `type`, **when** it renders, **then** sync edges (source → target, directional) and
   adapter-dependency edges (consumer → backend) are visually distinct and directional
   ([graph-overview.md](../flows/graph-overview.md) *Steps*).
4. **Given** a user selects an edge, **when** its detail opens, **then** the per-resource-pair (sync) or
   per-operation (adapter) `metadata` and `lastActivityAt` are shown — the edge is the carrier of endpoint
   detail; there are **no** per-endpoint nodes ([graph-overview.md](../flows/graph-overview.md) *Steps*).
5. **Given** the filter controls (by app, status, connection type), **when** the user changes them,
   **then** the rendered graph updates via GR-5's filtered read.
6. **Given** the page offers a link to operational health, **when** the user follows it, **then** it points
   at the Grafana **Landscape health** dashboard (OB-4) — the in-app graph is *structural*, Grafana is
   *operational over time*, and the UI states they are complementary
   ([graph-overview.md](../flows/graph-overview.md) *Relationship to the Grafana landscape-health
   dashboard*).
7. **Given** a capstone e2e, **when** a scenario landscape with an enabled sync pair and a composed adapter
   endpoint is running, **then** the graph shows both edges; after one side's mapping is marked `stale`
   (SL-4), a graph reload shows that edge as stale — proving the incremental update path end to end.

### Out of scope

- Editing artifacts from the graph (enabling a rule, composing an endpoint) — those live on their own
  screens (Phase 4 SU-*, Phase 5 CU-*); the graph is read-only.

### Dependencies

Blocked by GR-5. Capstone criterion 7 depends on SL-4 (staleness transition).
