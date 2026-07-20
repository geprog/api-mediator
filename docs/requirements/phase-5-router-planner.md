# Phase 5 — Request Router, inbound validation & Resolution Planner

Steps 3-4 of the request pipeline: match the inbound request to its `AdapterEndpoint`, **validate it against
the consumer's own contract** before anything runs, then load the endpoint's **persisted** `AdapterBinding`s
and **re-validate their health** at request time. Bindings are decided at composition time and only *executed*
per request — the planner re-validates, it never re-plans.

This slice carries the phase's loudness guarantee: four of the six named causes are produced here, and RP-5
pins that all six (plus a generic upstream error) are mutually distinguishable — the Phase-4 lesson that a
component which cannot resolve must say so, never return a plausible-but-wrong answer.

**Actor:** consumer-app developer (the caller); system (router + planner).

**Concept references (whole file):** [adapter-engine.md](../architecture/adapter-engine.md) *Binding: decided at
composition time*, *Stale bindings at request time*, *Request pipeline* steps 3-4, *Aggregation strategies*
(request-validation rejections), *Error and partial-failure semantics*;
[adapter-request-resolution.md](../flows/adapter-request-resolution.md) steps 3-4 + *Notes*;
[data-model.md](../architecture/data-model.md) `AdapterEndpoint`, `AdapterBinding`, `ApprovedMapping.status`,
`ParameterMapping`; [extensibility.md](../architecture/extensibility.md) *Spec update lifecycle* (stale),
*App lifecycle* (disabled backend); [glossary.md](../glossary.md) `Request Router`, `Resolution Planner`,
`mapping-stale (error)`, `mapping-suspended (error)`, `backend-disabled`, `not-yet-mapped (error)`,
`endpoint-disabled (error)`, `mediator-transform-error`.

> **Error body shape and HTTP status codes are the implementation choice (README open question 2); the *set of
> distinguishable causes* and *what is rejected before any backend is called* are authoritative.** Validation
> and planning must fail closed: when the mediator cannot establish that a request is servable exactly as the
> consumer asked, it refuses — it never serves an approximation.

---

## RP-1 — Route an authenticated request to its `AdapterEndpoint`

**As a** consumer-app developer, **I** have each of my operations resolve to the endpoint composed for it,
**so that** the mediator serves the operation I actually called.

### Acceptance criteria

1. **Given** an authenticated request (AT-2) on a mounted route, **when** the Request Router runs, **then** it
   resolves the `AdapterEndpoint` by `(consumerAppId from the token, consumerOperationId from the matched
   route)` — never by path string alone ([data-model.md](../architecture/data-model.md) `AdapterEndpoint`;
   [glossary.md](../glossary.md) `Request Router`).
2. **Given** the matched consumer operation has no `AdapterEndpoint` row, **when** routing completes, **then**
   the request answers `not-yet-mapped` (RT-3 criterion 1) and no validation, transform, or backend call runs.
3. **Given** the endpoint's `status = disabled`, **when** routing completes, **then** the request answers
   `endpoint-disabled` (RT-3 criterion 2) and no backend call runs.
4. **Given** the router resolves an endpoint, **when** it hands off, **then** it passes an explicit resolved
   context (consumer app, consumer operation, endpoint, raw inbound request in protocol-neutral form) — the
   downstream stages never re-derive routing from the raw HTTP request
   ([extensibility.md](../architecture/extensibility.md) *Beyond REST/OpenAPI*).

### Out of scope

- Mounting the routes — RT-2. Token validation — AT-2.

### Dependencies

Blocked by RT-2, AT-2. Precedes RP-2.

---

## RP-2 — Validate the inbound request against the consumer's own contract

**As a** consumer-app developer, **I** get a rejection when my request violates the contract I published — or
uses an input the mediator cannot honor — **so that** I never receive a response computed from an input that
was quietly dropped.

### Acceptance criteria

1. **Given** a routed request, **when** validation runs, **then** the request body, path/query/header
   parameters, and required-ness are validated against the **consumer operation's** request schema, and a
   violation is rejected **before any transform runs or any backend is called**
   ([adapter-engine.md](../architecture/adapter-engine.md) *Request pipeline* step 3).
2. **Given** a `collection-union` endpoint and a request using a **filter** parameter that is neither pushed
   down (mapped in *every* contributing binding) nor covered by a `postMergeFilters` entry, **when** validation
   runs, **then** the request is **rejected** — never answered with silently unfiltered results
   ([adapter-engine.md](../architecture/adapter-engine.md) *Aggregation strategies*;
   [data-model.md](../architecture/data-model.md) `AdapterEndpoint.postMergeFilters`).
3. **Given** a `collection-union` endpoint and a request using a **sort** or **pagination** parameter with no
   configured `postMergeSorts` / `postMergePagination` semantics, **when** validation runs, **then** the request
   is **rejected** — never answered unsorted or mispaged
   ([adapter-engine.md](../architecture/adapter-engine.md) *Aggregation strategies*;
   [data-model.md](../architecture/data-model.md) `postMergeSorts`, `postMergePagination`).
4. **Given** a request that **uses** a consumer parameter which the composition marked as **not mapped and not
   acknowledged** (CO-5), **when** validation runs, **then** the request is rejected with a cause naming that
   parameter — closing the "unmapped consumer inputs served silently" gap for non-union endpoints, by the same
   principle as criteria 2-3 (README open question 7).
5. **Given** a request that omits an **optional** consumer parameter which *is* mapped, **when** validation
   runs, **then** it is accepted and the corresponding backend input is simply not filled — absence is not an
   error ([data-model.md](../architecture/data-model.md) `ParameterMapping`).
6. **Given** any rejection above, **when** it is answered, **then** the response distinguishes "your request is
   invalid against your own schema" from "this input has no configured semantics here" — two different fixes
   (fix the caller vs. finish composition).

### Out of scope

- Validating the **response** — AG-7 (`mediator-transform-error`).
- Configuring post-merge semantics or acknowledging unmapped inputs — CO-3/CO-5.

### Dependencies

Blocked by RP-1, Phase-1 SI-1 (consumer IR/schemas). Precedes RP-3.

---

## RP-3 — Load persisted bindings and re-validate their state

**As a** landscape operator, **I** have every request re-check that its bindings are actually healthy, **so
that** a stale, suspended, or backend-disabled integration fails as *itself* instead of as a generic error —
or worse, as data.

### Acceptance criteria

1. **Given** a routed, validated request, **when** the Resolution Planner runs, **then** it **loads the
   endpoint's persisted `AdapterBinding`s** and only re-validates them; it does **not** re-derive bindings from
   mappings per request ([adapter-engine.md](../architecture/adapter-engine.md) *Binding: decided at composition
   time*; [adapter-request-resolution.md](../flows/adapter-request-resolution.md) *Notes*).
2. **Given** the loaded bindings, **when** the planner filters them, **then** only bindings with
   `status = active` participate: `proposed` and `disabled` bindings are skipped
   ([data-model.md](../architecture/data-model.md) `AdapterBinding.status`).
3. **Given** an `active` binding whose `ApprovedMapping.status` is `stale`, **when** the planner validates it,
   **then** it is reported as the distinct **`mapping-stale`** cause — not a generic upstream error
   ([adapter-engine.md](../architecture/adapter-engine.md) *Stale bindings at request time*).
4. **Given** an `active` binding whose `ApprovedMapping.status` is `suspended`, **when** the planner validates
   it, **then** it is reported as the distinct **`mapping-suspended`** cause — an operator hold, not a pending
   re-review ([adapter-engine.md](../architecture/adapter-engine.md) *Stale bindings at request time*;
   [data-model.md](../architecture/data-model.md) `ApprovedMapping.status`).
5. **Given** an `active` binding whose **backend app** has `status = disabled`, **when** the planner validates
   it, **then** it is reported as the distinct **`backend-disabled`** cause
   ([adapter-engine.md](../architecture/adapter-engine.md) *Error and partial-failure semantics*;
   [extensibility.md](../architecture/extensibility.md) *App lifecycle*).
6. **Given** an unhealthy binding under each strategy, **when** the outcome is decided, **then** it follows the
   **same role/strictness semantics as a call failure**: a `primary` fails the request under `single`/
   `fanout-merge`; under `fanout-first-success` it is **skipped** exactly like a failure and the next binding in
   `executionOrder` is tried (the request failing only when the chain is exhausted); a `supplement` degrades
   gracefully unless strict mode or a required consumer field makes it load-bearing — but the reported **cause**
   remains the specific one, not a generic upstream error
   ([adapter-engine.md](../architecture/adapter-engine.md) *Stale bindings at request time*, *Error and
   partial-failure semantics*).
7. **Given** **no** `active`, healthy binding remains after filtering and validation, **when** the request is
   answered, **then** it fails with the specific cause(s) that eliminated the bindings — never `not-yet-mapped`
   (which means "never wired"), and never an empty success.

### Out of scope

- Failing a live backend **call** — TE-2 (the generic upstream error).
- The transitions that set `stale`/`suspended`/`disabled` — Phase 6 / operator actions; Phase 5 only reads them.

### Dependencies

Blocked by RP-2, AD-1, AD-2. Precedes TE-1.

---

## RP-4 — The planner → executor contract is an explicit value

**As an** implementer, **I** have the planner hand the executor one explicit, inspectable plan, **so that** the
seam between "what should run" and "what ran" is testable in isolation — the seam class where every serious
Phase-4 defect lived.

### Acceptance criteria

1. **Given** a validated request, **when** the planner completes, **then** it produces an explicit **resolution
   plan** value naming: the endpoint's `aggregationStrategy`, the participating bindings in **execution
   groups** (equal `executionOrder` = one parallel group), each chained binding with its `dependsOnBindingId`
   and `chainInputs`, each binding's `role`, and the strict/degraded mode
   ([adapter-engine.md](../architecture/adapter-engine.md) *Request pipeline* steps 4-6).
2. **Given** a plan, **when** it is produced, **then** it is a **pure function** of (endpoint + bindings +
   mapping/app states + validated request) — no I/O, so a unit test can assert the plan for a fixture without
   any backend ([adapter-request-resolution.md](../flows/adapter-request-resolution.md) *Notes*).
3. **Given** bindings eliminated by RP-3, **when** the plan is produced, **then** the plan records **why** each
   was eliminated (cause per binding), so the aggregator can report the specific cause rather than reconstructing
   it (RP-3 criterion 7).
4. **Given** a plan whose groups contain a cycle or a `dependsOnBindingId` pointing outside the endpoint,
   **when** the plan is produced, **then** planning **fails loudly** rather than executing a partial order —
   such a state should be impossible after composition validation (CO-2), so its occurrence is a defect signal,
   not a served request.
5. **Given** the executor, **when** it runs, **then** it executes **exactly** the plan it was given and derives
   no additional bindings of its own — a test can assert executor behavior against a hand-built plan with no
   planner involved.

### Out of scope

- Executing the plan — TE-2/TE-3.

### Dependencies

Blocked by RP-3. Precedes TE-2.

---

## RP-5 — Six named causes, all mutually distinguishable

**As a** consumer-app developer, **I** can tell the six documented failure causes apart from each other and
from a backend outage, **so that** I know whether to wait, call my operator, or fix my own request.

### Acceptance criteria

1. **Given** each of the six named causes — `not-yet-mapped`, `endpoint-disabled`, `mapping-stale`,
   `mapping-suspended`, `backend-disabled`, `mediator-transform-error` — **when** each is provoked in turn,
   **then** each response carries a **distinct machine-readable cause token**, and no two of them are equal
   ([adapter-engine.md](../architecture/adapter-engine.md) *Error and partial-failure semantics*;
   [glossary.md](../glossary.md) adapter error entries).
2. **Given** a **live backend call failure** (timeout, 5xx, connection refused), **when** it is answered, **then**
   its upstream-error response is distinguishable from all six named causes and **names which backend failed**
   ([adapter-engine.md](../architecture/adapter-engine.md) *Error and partial-failure semantics*).
3. **Given** a **404** (path not in any consumer spec) and an **auth rejection**, **when** each is answered,
   **then** both are distinguishable from all seven outcomes above (RT-2 criterion 2, AT-2 criterion 4).
4. **Given** any failing request, **when** it is answered, **then** the response body **never** contains a
   partially-transformed or fabricated resource representation — a failure is a failure, never a plausible
   payload ([adapter-engine.md](../architecture/adapter-engine.md) *Error and partial-failure semantics*).
5. **Given** each cause fires, **when** the audit row is written, **then** the same cause token is recorded
   there, so the operator-side record and the caller-side answer agree (AD-5 criterion 2).

### Out of scope

- Choosing HTTP status codes per cause — README open question 2 (the cause token is the contract).

### Dependencies

Blocked by RT-3, RP-3, AG-7 (which produces the sixth cause). This is the phase's loudness invariant story;
its test suite is the regression net for every later serving change.
