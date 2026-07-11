# Phase 3 — Operator authentication & authorization

Phase 3 wires the auth the earlier phases *stated but deferred*: the `operator` vs. `viewer` split the
Phase-1/2 stories described as "testable once auth exists." The mediator's own API/UI is its most
privileged surface — approving mappings is the action everything downstream trusts — so every request
carries an authenticated identity, mutations require `operator`, and every mutation is attributed. Per
the concept, authentication is via a **pluggable provider** (SSO/OIDC in a typical deployment) with
**local accounts as the fallback** — Phase 3's dev target.

**Actor:** operator (mutations), viewer (reads); the auth layer gates both.

**Concept references (whole file):** [security.md](../architecture/security.md) *Operator
authentication & authorization*, *Summary of trust boundaries*; [glossary.md](../glossary.md)
`Operator / Viewer`; [data-model.md](../architecture/data-model.md) `ApprovedMapping.approvedBy`,
`SyncEvent / AuditLog` (`mapping-decision` actor); [overview.md](../architecture/overview.md)
*Deployment model* (single-tenant, self-hosted).

> **The auth *provider* is pluggable; local accounts are the Phase-3 implementation.** The concept
> mandates an authenticated operator identity and the two roles, not a specific IdP. Phase 3 implements
> local accounts (the documented fallback) behind a provider seam so SSO/OIDC can slot in later without
> touching route gating. **There is deliberately no unauthenticated mode** — approval accountability is
> only meaningful if identities are real ([security.md](../architecture/security.md)).

---

## OA-1 — Authenticated identity on every operator-API request (no unauthenticated mode)

**As the** mediator, **I** require an authenticated identity on every operator-API request via a
pluggable provider with local-account fallback, **so that** no privileged surface is ever reachable
anonymously.

### Acceptance criteria

1. **Given** any operator-API request without a valid authenticated identity, **when** it reaches the
   API layer, **then** it is rejected as unauthenticated (401-equivalent) and no handler side effect
   runs ([security.md](../architecture/security.md): "an unauthenticated deployment mode does not
   exist").
2. **Given** the pluggable authentication seam, **when** Phase 3 configures it, **then** a **local
   accounts** provider authenticates a request to a principal carrying a stable identity and a `role`
   (`operator` | `viewer`) — the documented fallback provider
   ([security.md](../architecture/security.md)).
3. **Given** the provider is a seam, **when** a different provider (e.g. SSO/OIDC) is substituted later,
   **then** route gating (OA-2) and attribution (OA-3) are unchanged — they depend on the resolved
   principal, not on how it was authenticated.
4. **Given** the single-tenant model, **when** authorization is defined, **then** there are exactly two
   roles and **no** tenant hierarchy ([security.md](../architecture/security.md); a scope guard against
   accidentally introducing multi-tenancy — see Out of scope).
5. **Given** an authenticated request, **when** it is handled, **then** the resolved principal
   (identity + role) is available to downstream handlers for gating and attribution.

### Out of scope

- SSO/OIDC provider implementation — later; Phase 3 ships local accounts behind the seam.
- Multi-tenant isolation, tenant hierarchy, per-resource ACLs — **explicitly out of scope** in the
  concept ([overview.md](../architecture/overview.md); [security.md](../architecture/security.md)); do
  not introduce them.
- The adapter servers' per-consumer token auth (Auth Gateway) — a **different** inbound surface, Phase 5
  ([security.md](../architecture/security.md) *Inbound authentication to generated adapter servers*).

### Dependencies

None (foundational for OA-2/OA-3 and all Phase-3 HTTP). Retroactively enforces the Phase-1/2 read/mutate
split.

---

## OA-2 — `operator` vs. `viewer` route gating (read/mutate split)

**As an** operator, **I** alone may mutate the landscape, while a `viewer` may read it, **so that** the
review/approval surface enforces the split the earlier phases only described.

### Acceptance criteria

1. **Given** a `viewer` principal, **when** it calls a **read** operator-API route (list apps, view a
   `MappingProposal` and its items, view the audit log, view dashboards), **then** the request succeeds
   ([security.md](../architecture/security.md): "viewer — read-only").
2. **Given** a `viewer` principal, **when** it calls any **mutating** operator-API route — register/
   disable an app, store credentials, confirm a `ResourceBinding`, set `analysisExclusions`, accept/
   edit/reject a proposal item, confirm an identity key, approve a proposal, trigger the escape-hatch
   analysis — **then** it is rejected as forbidden (403-equivalent) and nothing is mutated.
3. **Given** an `operator` principal, **when** it calls those mutating routes, **then** it is authorized
   ([security.md](../architecture/security.md): "operator — may mutate … review and approve mappings").
4. **Given** the review/approval endpoints specifically ([phase-3-approval-api.md](phase-3-approval-api.md)),
   **when** gating is applied, **then** the read endpoints (RA-1) are `viewer`-readable and every
   mutation (RA-2..RA-5) requires `operator`.
5. **Given** the escape-hatch "analyze this resource pair anyway" action (RA-5), **when** gating is
   applied, **then** it requires `operator` — it spends LLM budget and mutates the proposal, so it is a
   mutation, not a read (see README open question confirming this).
6. **Given** the Phase-1/2 endpoints (`POST /apps`, `PATCH /resource-bindings/:id`, `analysisExclusions`
   edits), **when** Phase-3 auth lands, **then** they are gated to `operator` too, realizing the
   read/mutate boundary those stories declared but left unwired.

### Out of scope

- Finer-grained permissions within `operator` (e.g. approver vs. registrar) — the concept's
  authorization is "deliberately minimal, two roles."

### Dependencies

Blocked by OA-1.

---

## OA-3 — Attribute every mutation to its authenticated identity

**As an** auditor, **I** can see who performed every mutation — especially every approval decision — 
**so that** approval accountability is real, which is the whole reason unauthenticated mode does not
exist.

### Acceptance criteria

1. **Given** an approve action, **when** the `ApprovedMapping` is created/updated, **then** its
   `approvedBy` records the authenticated operator identity and `approvedAt` the time
   ([data-model.md](../architecture/data-model.md) `ApprovedMapping.approvedBy`;
   [security.md](../architecture/security.md)).
2. **Given** any per-item review decision (accept/edit/reject) or identity-key confirmation, **when** it
   is recorded, **then** a `mapping-decision` audit entry attributes it to the authenticated identity —
   the incremental-approval history lives in the audit log, not on the mapping
   ([data-model.md](../architecture/data-model.md) `SyncEvent / AuditLog`;
   [security.md](../architecture/security.md) *Audit logging*).
3. **Given** any mutation across the Phase-3 surface, **when** it commits, **then** it is attributed to
   an identity — an unattributed mutation is impossible because OA-1 guarantees every request has one.
4. **Given** an audit entry, **when** written, **then** it records metadata only (who/what/when/status)
   and **never** secret material ([security.md](../architecture/security.md) *Audit logging*).

### Out of scope

- The audit-log *query/browse UI* — a viewer read surface that can land with or after Phase 3 (the
  concept lists "audit log" among viewer reads; the store already exists from Phase 2's
  `mapping-decision` write path).

### Dependencies

Blocked by OA-1, and by AS-1/AS-2 (the decisions being attributed).
