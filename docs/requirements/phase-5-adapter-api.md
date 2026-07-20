# Phase 5 — Adapter operator HTTP API

The **HTTP** slice on the *operator* surface (not the adapter surface): read adapter state, compose/recompose
endpoints, enable/disable endpoints and bindings, issue/rotate adapter tokens, and read adapter request
history. These handlers are **thin**: they authenticate/authorize (Phase-3 OA-1/OA-2), validate the request
shape, and delegate every invariant to the composition/auth services (CO-*/AT-*) — they must not re-derive
composition logic.

**Actor:** viewer (reads), operator (mutations).

**Concept references (whole file):** [adapter-endpoint-composition.md](../flows/adapter-endpoint-composition.md)
step 4 (what a composer chooses) + *Notes* (recomposition); [adapter-engine.md](../architecture/adapter-engine.md)
*Role validity*, *Aggregation strategies*, *Caching*, *Observability hooks*;
[security.md](../architecture/security.md) *Operator authentication & authorization* (composing endpoints is an
operator mutation), *Inbound authentication to generated adapter servers* (token shown once);
[data-model.md](../architecture/data-model.md) `AdapterEndpoint`, `AdapterBinding`, `SyncEvent / AuditLog`;
[observability.md](../architecture/observability.md) *Alerting* (`composition-required` backlog);
[glossary.md](../glossary.md) `Endpoint composition`, `composition-required`, `Operator / Viewer`.

> **Routes and payloads are the implementation choice; the *contract* is authoritative** — the read/mutate
> gating, the delegation of every composition invariant to CO-2/CO-3, and the once-only token display. Paths
> below are illustrative, consistent with Phase-1's `POST /apps` and Phase-4's sync-API style.

---

## AP-1 — Read adapter state

**As a** viewer or operator, **I** can list adapter endpoints with their composition state and bindings, **so
that** I can see what serves what, and what is waiting on a decision.

### Acceptance criteria

1. **Given** endpoints exist, **when** the list endpoint is called, **then** each `AdapterEndpoint` is returned
   with `consumerAppId`, `consumerOperationId`, `status`, `aggregationStrategy`, `cacheTtl`, its union
   configuration where applicable, and its bindings (backend app/operation, `role`, `status`,
   `executionOrder`, `dependsOnBindingId`) ([data-model.md](../architecture/data-model.md) `AdapterEndpoint`,
   `AdapterBinding`).
2. **Given** an endpoint in `composition-required`, **when** state is read, **then** the response says **why**
   (which binding(s) are `proposed` and since when) and whether a previous configuration is still serving
   ([adapter-endpoint-composition.md](../flows/adapter-endpoint-composition.md) step 3-4).
3. **Given** a consumer operation with **no** endpoint or no `active` binding, **when** state is read, **then**
   it is listed as `not-yet-mapped` — the operator sees the consumer's unmet needs, not just what exists
   ([adapter-engine.md](../architecture/adapter-engine.md) *Binding: decided at composition time*).
4. **Given** a binding whose mapping is `stale`/`suspended` or whose backend app is disabled, **when** state is
   read, **then** that condition is reported per binding (the same causes the planner produces, RP-3) —
   derived at read time, not stored per binding
   ([extensibility.md](../architecture/extensibility.md) *App lifecycle*).
5. **Given** any read, **when** it is served, **then** it returns no credential material, no adapter token, and
   no live payload values ([security.md](../architecture/security.md)).
6. **Given** a `viewer`, **when** they call these reads, **then** they succeed (OA-2).

### Out of scope

- Graph rendering — Phase 6 ([graph-overview.md](../flows/graph-overview.md)).

### Dependencies

Blocked by AD-1, AD-2, Phase-3 OA-1/OA-2. Precedes CU-1.

---

## AP-2 — Compose / recompose an endpoint

**As an** operator, **I** submit a composition decision and get a precise rejection when it cannot execute,
**so that** I can fix the configuration rather than discover the problem through a live caller.

### Acceptance criteria

1. **Given** an `operator` and a `composition-required` (or `active`) endpoint, **when** they submit a
   composition — strategy, per-binding roles, `executionOrder`/`dependsOnBindingId`/`chainInputs`, strictness,
   `cacheTtl`, and union configuration — **then** the endpoint delegates to the composition service (CO-2/CO-3)
   and activates on success ([adapter-endpoint-composition.md](../flows/adapter-endpoint-composition.md) steps
   4-5).
2. **Given** an invalid composition, **when** it is submitted, **then** the endpoint returns a 4xx listing
   **exactly which rules were violated** (role table, order ties, chain input not provided by the upstream's
   response phase, unmapped required backend parameter, write-not-single) and activates nothing (CO-2).
3. **Given** the endpoint has never been composed and validation fails, **when** it is rejected, **then** the
   endpoint stays `composition-required`; **given** it was `active`, **then** the previous configuration keeps
   serving (CO-2 criterion 8).
4. **Given** a union composition, **when** the composer requests the composition **form**, **then** the response
   includes the derivations they must confirm: pushdown-eligible vs. post-merge filters, heuristically
   pre-filled `postMergeSorts`/`postMergePagination`, dedup availability (link-based only where every
   contributor's `nativeIdRef` is confirmed), the supplement load-bearing analysis (CO-4), and the
   consumer-input coverage report (CO-5) — each marked **unconfirmed** until the composer confirms it.
5. **Given** a `viewer`, **when** they attempt composition, **then** it is rejected 403 (OA-2); **given** an
   operator succeeds, **then** the action is attributed (OA-3).

### Out of scope

- The validation logic itself — CO-2/CO-3 (this endpoint must not duplicate it).

### Dependencies

Blocked by CO-2, CO-3, CO-4, CO-5, Phase-3 OA-2. Precedes CU-1, CU-2.

---

## AP-3 — Enable / disable endpoints and bindings

**As an** operator, **I** can switch an endpoint or a single binding out of service, **so that** I can respond
to a misbehaving backend without deleting configuration or re-approving mappings.

### Acceptance criteria

1. **Given** an `operator`, **when** they disable an `AdapterEndpoint`, **then** its `status` becomes `disabled`
   and requests answer `endpoint-disabled` (RT-3 criterion 2); **when** they re-enable it, **then** it serves
   its stored configuration again ([data-model.md](../architecture/data-model.md) `AdapterEndpoint.status`).
2. **Given** an `operator`, **when** they disable an `AdapterBinding`, **then** its `status` becomes `disabled`,
   the planner skips it, and the row is retained for later reactivation
   ([data-model.md](../architecture/data-model.md) `AdapterBinding.status`).
3. **Given** disabling a binding would leave a **write** endpoint with zero or several active bindings, **or**
   would leave any endpoint's remaining configuration invalid under its strategy, **when** it is attempted,
   **then** it is rejected with that reason, or requires a recomposition — the endpoint is never left in an
   unexecutable state (CO-2, CO-6 criterion 5).
4. **Given** any enable/disable, **when** it commits, **then** the affected endpoint's cache entries are dropped
   (CH-5) and the action is attributed (OA-3).
5. **Given** a `viewer`, **when** they attempt any of these, **then** it is rejected 403 (OA-2).

### Out of scope

- Disabling a whole *app* — Phase-1/Phase-6 app lifecycle (its effect on bindings is `backend-disabled`, RP-3).

### Dependencies

Blocked by CO-6, CH-5, Phase-3 OA-2. Precedes CU-1.

---

## AP-4 — Issue / rotate an adapter token

**As an** operator, **I** issue or rotate a consumer's adapter token through the API and see the raw value
exactly once, **so that** onboarding and rotation are ordinary operator actions with no retrievable secret
left behind.

### Acceptance criteria

1. **Given** an `operator` and a consumer app, **when** they call issue, **then** the response contains the raw
   token **once**, and only its salted hash is persisted (AT-1)
   ([security.md](../architecture/security.md)).
2. **Given** the token exists, **when** any endpoint (app read, credential read, audit read) is called
   afterwards, **then** the raw token is never returned; only metadata (existence, `lastRotatedAt`, overlap
   state) is readable (AT-1 criterion 2).
3. **Given** rotation, **when** an `operator` calls it, **then** the new token is returned once, the previous
   one stays valid for the overlap window, and an explicit **confirm-cutover** action ends the overlap early
   (AT-4).
4. **Given** an app with no `CONSUMER` spec, **when** issue is called, **then** it is rejected (AT-1
   criterion 4).
5. **Given** a `viewer`, **when** they attempt issue/rotate/confirm-cutover, **then** it is rejected 403 and no
   token is generated (OA-2); operator actions are attributed with **no token value** in the audit record
   (OA-3, [security.md](../architecture/security.md) *Audit logging*).

### Out of scope

- Validating tokens — AT-2 (that happens on the adapter surface, not here).

### Dependencies

Blocked by AT-1, AT-4, Phase-3 OA-2. Precedes CU-3.

---

## AP-5 — Read adapter request history and endpoint health

**As a** viewer or operator, **I** can see what each endpoint has been answering, **so that** I can tell a
composition defect from a backend outage without reading logs.

### Acceptance criteria

1. **Given** `adapter-request` audit rows exist, **when** the history endpoint is called, **then** it returns
   them filtered by endpoint/binding/time with their outcome and **cause**, and `traceId`/`spanId` for
   correlation (AD-5; [observability.md](../architecture/observability.md) *Traces*).
2. **Given** the rows, **when** they are returned, **then** degraded responses are distinguishable from clean
   successes and from failures (AD-5 criterion 3).
3. **Given** endpoints exist, **when** health is read, **then** the response surfaces the operator-actionable
   conditions the concept alerts on: endpoints in `composition-required` (with age), bindings whose mapping is
   `stale` (a tighter threshold than sync staleness), and any `mediator-transform-error` occurrences
   ([observability.md](../architecture/observability.md) *Alerting*;
   [extensibility.md](../architecture/extensibility.md), adapter-vs-sync staleness asymmetry).
4. **Given** the history is metadata-only, **when** it is returned, **then** it contains no payload values and
   no credential material ([security.md](../architecture/security.md) *Audit logging*).
5. **Given** a `viewer`, **when** they call these reads, **then** they succeed (OA-2).

### Out of scope

- Grafana panels/alert rules — Phase-6 polish; this is the in-product read path.

### Dependencies

Blocked by AD-5, RT-5, Phase-3 OA-1/OA-2. Precedes CU-4.
