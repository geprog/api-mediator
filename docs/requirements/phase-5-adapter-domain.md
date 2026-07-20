# Phase 5 — Adapter composition & serving domain shapes

The **types + persistence** slice of Phase 5: the state the Adapter Engine reads at request time and the
composer writes at composition time — the `AdapterEndpoint` **composition/serving fields** that extend its
Phase-3 shape, the `AdapterBinding` **execution/chaining fields**, the `adapterToken` `Credential` shape, the
bounded **write-outcome store**, and the `adapter-request` columns of `SyncEvent`/`AuditLog`. No behavior lives
here: this is the single-naming-authority (`@mediator/domain`) layer plus **the one Phase-5 migration**, matching
how Phase 1/2/3/4 defined every glossary entity once before any slice consumed it.

**What already exists and must be *extended*, not re-specified.** Phase 3 shipped the **approval-derived**
`AdapterEndpoint` (`id`, `consumerAppId`, `consumerOperationId`, `status`) and `AdapterBinding` (`id`,
`adapterEndpointId`, `backendAppId`, `backendOperationId`, `approvedMappingId`, `role`, `status`) — see
[`packages/db/src/schema.ts`](../../packages/db/src/schema.ts), whose comment states explicitly that these carry
**no Phase-5 composition state**. The `adapter_endpoint_status` (`active` | `composition-required` | `disabled`),
`adapter_binding_role` (`primary` | `fallback` | `supplement`), and `adapter_binding_status`
(`active` | `proposed` | `disabled`) enums already exist and are **reused unchanged**. `Credential.type` already
owns `adapterToken`. `AuditLog.type` already owns `adapter-request`. Phase 5 **adds** the composition columns,
the write-outcome store, and the binding reference on the audit row.

**Actor:** system (shared kernel — types + schema only, no I/O).

**Concept references (whole file):** [data-model.md](../architecture/data-model.md) `AdapterEndpoint`,
`AdapterBinding`, `ParameterMapping`, `Credential`, `SyncEvent / AuditLog`;
[adapter-engine.md](../architecture/adapter-engine.md) *Binding: decided at composition time*, *Aggregation
strategies*, *Write operations*, *Caching*; [security.md](../architecture/security.md) *Inbound authentication
to generated adapter servers*, *Audit logging*; [glossary.md](../glossary.md) `AdapterEndpoint`,
`AdapterBinding`, `Aggregation strategy`, `postMergeFilters`, `postMergeSorts / postMergePagination`,
`composition-required`.

> **Entity *fields* are authoritative; their Zod/TypeScript/SQL encoding is the implementation choice** — the
> same latitude SD-1..SD-4 used. Where a field is meaningful only under one `aggregationStrategy`
> (`postMerge*` on `collection-union`, `chainInputs` with `dependsOnBindingId`), the domain may encode it as an
> optional field guarded by a refinement or as a discriminated union. **Two fields below are named by
> [adapter-engine.md](../architecture/adapter-engine.md) / [adapter-endpoint-composition.md](../flows/adapter-endpoint-composition.md)
> but absent from [data-model.md](../architecture/data-model.md)'s `AdapterEndpoint` field list** — the
> strict/degraded partial-failure mode and the union dedup configuration. They are flagged as concept gaps in
> the README open questions, not silently coined: the names below are descriptive placeholders pending a human
> decision on the canonical field names.

---

## AD-1 — Extend `AdapterEndpoint` with its composition / serving state

**As the** shared kernel, **I** extend the Phase-3 `AdapterEndpoint` shape with the serving fields the Request
Router, Resolution Planner, Response Aggregator, and cache need, **so that** an endpoint has one persisted,
reviewable referent for *how* it serves — never a per-request guess.

### Acceptance criteria

1. **Given** the Phase-3 `AdapterEndpoint` (`id`, `consumerAppId`, `consumerOperationId`, `status`), **when** it
   is extended, **then** it additionally carries `aggregationStrategy` and `cacheTtl` (nullable — absent means
   **no caching**, the documented default) ([data-model.md](../architecture/data-model.md) `AdapterEndpoint`).
   The four Phase-3 fields and the `adapter_endpoint_status` enum are **reused unchanged**.
2. **Given** `aggregationStrategy`, **when** defined, **then** it is exactly
   `single` | `fanout-merge` | `collection-union` | `fanout-first-success` — no value invented, no
   `list`-style extra ([data-model.md](../architecture/data-model.md) `AdapterEndpoint.aggregationStrategy`;
   [glossary.md](../glossary.md) `Aggregation strategy`).
3. **Given** the union-only configuration, **when** defined, **then** the endpoint carries `postMergeFilters[]`
   (`{ consumerParamRef, consumerFieldPath, operator }` with `operator` exactly `eq` | `contains` | `gte` |
   `lte`), `postMergeSorts[]` (`{ consumerParamRef, paramValue?, consumerFieldPath, direction }` with
   `direction` exactly `asc` | `desc`), and `postMergePagination` (which consumer parameters carry page/offset
   and size, plus their convention) — each **absent** on a non-`collection-union` endpoint
   ([data-model.md](../architecture/data-model.md) `AdapterEndpoint.postMergeFilters`, `postMergeSorts`,
   `postMergePagination`).
4. **Given** the **dedup configuration** a `collection-union` endpoint may carry (link-based dedup, a
   consumer-schema **dedup key** field, or neither), **when** defined, **then** the shape can represent all
   three states distinctly — "no dedup configured" must be representable and distinguishable from "dedup key
   configured" ([adapter-engine.md](../architecture/adapter-engine.md) *Aggregation strategies*;
   [adapter-endpoint-composition.md](../flows/adapter-endpoint-composition.md) step 4). *Field name pending —
   see README open question 3.*
5. **Given** the **strict vs. degraded** partial-failure mode the composer chooses, **when** defined, **then**
   the endpoint can represent both states, defaulting to **non-strict** for an auto-activated single-binding
   endpoint ([adapter-engine.md](../architecture/adapter-engine.md) *Binding: decided at composition time*,
   *Error and partial-failure semantics*). *Field name pending — see README open question 3.*
6. **Given** a Phase-3-instantiated endpoint that has never been composed, **when** it is loaded, **then**
   every field added here is **absent/unset** — a `composition-required` endpoint carries no serving
   configuration, exactly as a `disabled` `SyncRule` carries no execution state (AD-6 criterion 2; AI-2).

### Out of scope

- Choosing or validating any of these values — CO-2/CO-3 (composition) own that.
- Executing a strategy — AG-*.

### Dependencies

Blocked by Phase-3 AM-6/AI-2 (the shape it extends). Precedes every other Phase-5 story.

---

## AD-2 — Extend `AdapterBinding` with its execution / chaining state

**As the** shared kernel, **I** extend the Phase-3 `AdapterBinding` with `executionOrder`,
`dependsOnBindingId`, and `chainInputs`, **so that** parallel, sequential, and chained execution is persisted
composition state that survives a mapping being superseded.

### Acceptance criteria

1. **Given** the Phase-3 binding, **when** it is extended, **then** it additionally carries `executionOrder`
   (int, default `0`), `dependsOnBindingId` (optional, referencing another binding of the **same** endpoint),
   and `chainInputs[]` ([data-model.md](../architecture/data-model.md) `AdapterBinding`).
2. **Given** `chainInputs[]`, **when** defined, **then** each entry is
   `{ upstreamFieldPath, targetParamRef, transform?, transformConfig? }` — `upstreamFieldPath` a path into the
   **upstream binding's consumer-shape response** (never the upstream backend's native schema), `targetParamRef`
   a parameter of *this* binding's backend operation — reusing the `FieldMapping` transform vocabulary and its
   sandbox ([data-model.md](../architecture/data-model.md) `AdapterBinding.chainInputs`;
   [security.md](../architecture/security.md) *Transformation expression sandboxing*).
3. **Given** `chainInputs[]` is only meaningful with `dependsOnBindingId`, **when** the shape is defined,
   **then** a binding without `dependsOnBindingId` cannot carry non-empty `chainInputs`
   ([data-model.md](../architecture/data-model.md) `AdapterBinding.chainInputs`).
4. **Given** chain wiring is **composition state, not reviewed correspondence**, **when** its home is chosen,
   **then** it lives on the `AdapterBinding` — **not** under the mapping's `OperationMapping`s — precisely so
   successor adoption carries it over mechanically ([extensibility.md](../architecture/extensibility.md)
   *Successor adoption*; [data-model.md](../architecture/data-model.md) `ParameterMapping` closing note).
5. **Given** a Phase-3-attached `proposed` binding, **when** loaded, **then** `executionOrder` is its default
   and `dependsOnBindingId`/`chainInputs` are absent — attachment composes nothing (AI-2).

### Out of scope

- Validating strategy-scoped legality of these fields (ties under `fanout-first-success`, `dependsOnBindingId`
  outside `fanout-merge`) — CO-2.
- Executing the chain — TE-3.

### Dependencies

Blocked by Phase-3 AI-2. Precedes CO-2, TE-2, TE-3.

---

## AD-3 — `adapterToken` `Credential` shape (salted hash, rotation overlap)

**As the** shared kernel, **I** define how a consumer app's mediator-issued adapter token is persisted, **so
that** validation needs only equality, the raw token is unrecoverable after issuance, and rotation can keep two
tokens valid during a cutover window.

### Acceptance criteria

1. **Given** `Credential.type = adapterToken`, **when** a row is defined, **then** it holds a **salted hash** of
   the token — not envelope-encrypted material — because validation needs equality and never the original value
   ([data-model.md](../architecture/data-model.md) `Credential`; [security.md](../architecture/security.md)
   *Inbound authentication to generated adapter servers*).
2. **Given** the raw token, **when** the row is written, **then** the raw value is **not persisted anywhere**
   (not in the row, not in the audit log, not in logs) — it exists only in the issuing response
   ([security.md](../architecture/security.md); [glossary.md](../glossary.md) `API/UI Layer`).
3. **Given** rotation with an **overlap window** ("old and new both valid until the consumer confirms
   cutover"), **when** the shape is defined, **then** two `adapterToken` rows can be simultaneously valid for
   one app and the superseded one carries a bounded validity end, so "still valid" is a queryable property and
   not an unbounded one ([security.md](../architecture/security.md)). *The overlap bound has no modeled field in
   [data-model.md](../architecture/data-model.md) — see README open question 4.*
4. **Given** `scopes` and `lastRotatedAt` already exist on `Credential`, **when** the adapter-token shape is
   defined, **then** they are **reused** rather than duplicated by a parallel field
   ([data-model.md](../architecture/data-model.md) `Credential`).
5. **Given** a consumer app that is disabled or deregistered, **when** the shape is defined, **then** it can
   represent revocation (implicit, derived from app status, or explicit) — the concept requires the token to be
   revoked in both cases ([security.md](../architecture/security.md);
   [extensibility.md](../architecture/extensibility.md) *App lifecycle*).

### Out of scope

- Issuing/validating/rotating behavior — AT-1..AT-4.
- OAuth2/apiKey credential handling — Phase 1 CR-*/Phase 4 CD-* (unchanged).

### Dependencies

Blocked by Phase-1 CR-1 (the `Credential` shape it specializes). Precedes AT-*.

---

## AD-4 — The bounded write-outcome store

**As the** shared kernel, **I** define the bounded store that retains a deduplicated adapter write's original
outcome, **so that** a repeated delivery is answered with what actually happened — never re-executed, and never
answered with a fabricated success.

### Acceptance criteria

1. **Given** the store, **when** defined, **then** a record holds the write's **idempotency key**, the
   originating `AdapterEndpoint`/`AdapterBinding`, the recorded **status and response body** of the original
   execution, and its timestamp ([adapter-engine.md](../architecture/adapter-engine.md) *Write operations* —
   *Idempotency*).
2. **Given** the Audit Log stays **metadata-only**, **when** the store's home is chosen, **then** it is a
   **separate** store, deliberately not `SyncEvent`/`AuditLog` rows, because it retains a response body
   ([adapter-engine.md](../architecture/adapter-engine.md) *Write operations*;
   [security.md](../architecture/security.md) *Audit logging*).
3. **Given** the store is **bounded**, **when** defined, **then** its retention is scoped to the dedup lookback
   window — never unbounded — and expiry is representable ([adapter-engine.md](../architecture/adapter-engine.md)
   *Write operations*). The window value is config-defined (README open question 5).
4. **Given** the store holds live response payloads, **when** defined, **then** it holds **no credential
   material** and is never returned through the operator API/UI as a payload dump — only its metadata is
   readable ([security.md](../architecture/security.md) *Credential storage*, *Audit logging*).
5. **Given** a write that failed, **when** its outcome is recorded, **then** the shape distinguishes a recorded
   **failure** outcome from a recorded success, so a replayed delivery of a failed write is answered with the
   failure rather than treated as never-executed
   ([adapter-engine.md](../architecture/adapter-engine.md) *Write operations* — *Failure semantics*).

### Out of scope

- Computing the idempotency key and the dedup decision — WR-3 (which reuses the Phase-4 OC-2 mechanism).

### Dependencies

Blocked by Phase-4 OC-2 (the shared idempotency treatment). Precedes WR-3.

---

## AD-5 — `adapter-request` fields on `SyncEvent`/`AuditLog`

**As the** shared kernel, **I** extend the audit row so an adapter request is a first-class business record,
**so that** every served request — including every distinct failure cause — is queryable after the fact.

### Acceptance criteria

1. **Given** the row already owns `type = adapter-request` and the Phase-4 `status` enum, **when** it is
   extended, **then** it gains `relatedBindingId` (named by the data model, absent from the current table) and
   can carry the `AdapterEndpoint` it served ([data-model.md](../architecture/data-model.md)
   `SyncEvent / AuditLog`; [`schema.ts`](../../packages/db/src/schema.ts) `audit_log`).
2. **Given** an adapter request that failed, **when** the row is written, **then** the row can record **which**
   of the six named causes applied (`not-yet-mapped`, `endpoint-disabled`, `mapping-stale`, `mapping-suspended`,
   `backend-disabled`, `mediator-transform-error`) or a generic upstream error, distinguishably
   ([adapter-engine.md](../architecture/adapter-engine.md) *Error and partial-failure semantics*;
   [glossary.md](../glossary.md) adapter error entries).
3. **Given** a **degraded** response (a failed `supplement` under non-strict mode), **when** the row is written,
   **then** that outcome is representable and distinguishable from both a clean success and a failure
   ([adapter-engine.md](../architecture/adapter-engine.md) *Error and partial-failure semantics*).
4. **Given** the row is metadata-only, **when** written, **then** it carries ids/hashes/status/`traceId`/`spanId`
   — **never** request or response payload values and never credential material
   ([security.md](../architecture/security.md) *Audit logging*).
5. **Given** the Phase-4 `status` enum, **when** adapter rows are written, **then** they reuse it; **no** new
   status value is invented for the adapter (the *cause* is a separate field, per criterion 2)
   ([data-model.md](../architecture/data-model.md) `SyncEvent / AuditLog` `status`).

### Out of scope

- Emitting the rows — RT-5 (per request) and WR-* (writes).
- OTel metrics — emitted separately from these rows
  ([observability.md](../architecture/observability.md) *Relationship to the Audit/Event Log*).

### Dependencies

Blocked by Phase-4 SD-4. Precedes RT-5, WR-*.

---

## AD-6 — One Phase-5 migration, backward-compatible with Phase-3 rows

**As the** shared kernel, **I** land **all** of the above as a **single** schema migration whose every new
column is nullable with no DB default, **so that** rows written by Phase-3 instantiation keep loading unchanged
and no later Phase-5 slice needs a migration of its own.

### Acceptance criteria

1. **Given** the Phase-5 state above, **when** it is persisted, **then** it lands in **one** migration covering
   the `adapter_endpoint` composition columns, the `adapter_binding` execution/chaining columns, the
   write-outcome store table, and `audit_log.related_binding_id` — the house rule of one migration slice in
   flight at a time.
2. **Given** an `adapter_endpoint`/`adapter_binding` row written by Phase-3 AI-2 (minimal columns only),
   **when** it is read after the migration, **then** it loads successfully with every Phase-5 field **absent**
   — mirroring the SD-1 discipline: no column default may reconstruct a *present* value on a non-composed row
   ([`schema.ts`](../../packages/db/src/schema.ts) Phase-4 SD-1 note).
3. **Given** `dependsOnBindingId`, **when** persisted, **then** the schema constrains it to a binding of the
   **same** `adapterEndpointId` (at the repository or check level) — a cross-endpoint dependency is not
   representable ([data-model.md](../architecture/data-model.md) `AdapterBinding`).
4. **Given** an endpoint is deleted or its consumer app deregistered, **when** the cascade runs, **then**
   bindings, composition state, and write-outcome rows scoped to it are removed with it, and `AdapterEndpoint`s
   left with **no** bindings revert to serving `not-yet-mapped`
   ([extensibility.md](../architecture/extensibility.md) *App lifecycle*).
5. **Given** unit-test fakes for the new repositories, **when** they are written, **then** they mirror the real
   Drizzle repositories' upsert/absent-key semantics, and every persistence mutation added here has a real-DB
   integration test — the standing rule that a diverging fake masks bugs that pass `verify`.

### Out of scope

- Any later Phase-5 slice adding schema — by construction, none should; if one is discovered, it is a finding
  for the human, not a second migration slipped in.

### Dependencies

Blocked by AD-1..AD-5. Precedes every persistence-touching Phase-5 story.
