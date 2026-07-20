# Phase 5 — Auth Gateway & adapter token

The **inbound authentication** slice: the mediator's only app-initiated surface. Each consumer
`RegisteredApp` gets one mediator-issued token, **displayed exactly once** at issuance and stored only as a
salted hash; an Auth Gateway in front of the Adapter Server Runtime validates it per request and binds the
request to *that* consumer's endpoints.

This is the single deliberate exception to "secrets are never returned" — and a narrow one: the token is
*displayed* at generation, before only its hash is stored, so afterwards there is nothing retrievable to
return.

**What already exists:** `Credential.type = adapterToken` in the schema (Phase 1), the operator auth model
(Phase-3 OA-1..OA-3, which governs the *operator* API, not this surface), and AD-3's persisted shape.

**Actor:** operator (issues/rotates), consumer-app developer (uses the token).

**Concept references (whole file):** [security.md](../architecture/security.md) *Inbound authentication to
generated adapter servers*, *Least privilege*, *Audit logging*, *Summary of trust boundaries*;
[adapter-engine.md](../architecture/adapter-engine.md) *Request pipeline* step 2;
[adapter-request-resolution.md](../flows/adapter-request-resolution.md) step 2;
[data-model.md](../architecture/data-model.md) `Credential`;
[extensibility.md](../architecture/extensibility.md) *App lifecycle*; [glossary.md](../glossary.md)
`Auth Gateway`, `Credential`, `API/UI Layer` (the once-only display).

> **Token format, hash algorithm/parameters, header scheme, and UI copy are the implementation choice; the
> *invariants* are authoritative:** the raw token is returned exactly once and never again; only a salted hash
> is stored; an unauthenticated request never reaches a backend; one consumer's token never serves another
> consumer's endpoints.

---

## AT-1 — Issue an adapter token, shown exactly once

**As a** landscape operator, **I** issue a consumer app its adapter token and see the raw value exactly once,
**so that** I can hand it to the consumer team while the mediator retains nothing retrievable.

### Acceptance criteria

1. **Given** a consumer `RegisteredApp` (one carrying a `CONSUMER` `ApiSpec`), **when** an `operator` issues its
   adapter token, **then** the raw token is returned in **that response only**, and a `Credential` row of
   `type = adapterToken` is persisted holding **only its salted hash**
   ([security.md](../architecture/security.md); AD-3).
2. **Given** the token has been issued, **when** any subsequent read of the app, its credentials, or the audit
   log is performed, **then** the raw token is **never** returned again by any endpoint, and is absent from
   logs and telemetry ([security.md](../architecture/security.md); [glossary.md](../glossary.md)
   `API/UI Layer`).
3. **Given** issuance is a privileged mutation, **when** a `viewer` attempts it, **then** it is rejected (403)
   and no token is generated (Phase-3 OA-2); **when** an `operator` performs it, **then** the action is
   attributed to the authenticated identity in the audit log (OA-3, metadata only — no token value).
4. **Given** an app with **no** `CONSUMER` spec, **when** token issuance is attempted, **then** it is rejected —
   an adapter token authenticates calls to a generated adapter surface, which such an app does not have
   ([security.md](../architecture/security.md); [data-model.md](../architecture/data-model.md)
   `RegisteredApp.baseUrl` note).
5. **Given** the concept says the token is "generated at registration", **when** a consumer app registered
   **before** Phase 5 exists, **then** issuing on demand produces the identical state — issuance is idempotent
   in effect (one current token per app) and re-issuing follows the rotation path (AT-4), never silently
   invalidating a live consumer without an overlap window (README open question 4).

### Out of scope

- Operator authentication itself — Phase-3 OA-1/OA-2 (reused).
- Any means of recovering a lost token — by construction there is none; the answer is rotation (AT-4).

### Dependencies

Blocked by AD-3, Phase-3 OA-1/OA-2. Precedes AT-2, AP-4, CU-3.

---

## AT-2 — Validate the token on every adapter request

**As a** landscape operator, **I** know no unauthenticated caller can reach a live adapter that touches the
real landscape, **so that** the mediator's "no unauthenticated inbound traffic" property holds.

### Acceptance criteria

1. **Given** a request to any mounted adapter route, **when** it carries **no** token or an unrecognized one,
   **then** it is rejected by the Auth Gateway **before** routing, planning, transforms, and any backend call —
   nothing outbound happens ([adapter-engine.md](../architecture/adapter-engine.md) *Request pipeline* step 2;
   [security.md](../architecture/security.md)).
2. **Given** a request carrying a valid token, **when** it is validated, **then** validation is a **hash
   equality** check against the stored salted hash — the stored value is never decrypted and the raw token is
   never persisted or logged in the process ([security.md](../architecture/security.md);
   [data-model.md](../architecture/data-model.md) `Credential`).
3. **Given** a valid token, **when** validation succeeds, **then** the request is bound to the **consumer
   `RegisteredApp` that token belongs to**, and that binding is what subsequent routing resolves within (RT-2
   criterion 3).
4. **Given** a rejected request, **when** it is answered, **then** the rejection is distinguishable from every
   serving cause (`not-yet-mapped`, `endpoint-disabled`, the four resolution causes) — an auth failure is never
   reported as an unmapped or broken endpoint (RP-5).
5. **Given** any request (accepted or rejected), **when** it is recorded, **then** the audit row/telemetry
   records the outcome without the token value ([security.md](../architecture/security.md) *Audit logging*).

### Out of scope

- Rate limiting / abuse protection on the adapter surface — the concept specifies outbound ceilings
  ([overview.md](../architecture/overview.md) *Outbound load discipline*), not inbound throttling; flagged as
  README open question 6.

### Dependencies

Blocked by AT-1, RT-1. Precedes RP-1.

---

## AT-3 — One consumer's token serves only that consumer's endpoints

**As a** landscape operator, **I** know a token cannot be used to call another consumer's adapter surface,
**so that** the single-tenant simplicity of one-token-per-app does not become a shared key to everything.

### Acceptance criteria

1. **Given** consumer apps A and B are both registered with adapter surfaces, **when** A's token is used to
   call an operation that exists **only** in B's consumer spec, **then** the request is rejected — it is not
   served from B's endpoints ([security.md](../architecture/security.md) *Inbound authentication*, one token
   per consumer app).
2. **Given** A and B declare the **same path and method**, **when** A's token calls it, **then** the request
   resolves to **A's** `AdapterEndpoint` (matched by `consumerAppId` + `consumerOperationId`) and never to B's
   ([data-model.md](../architecture/data-model.md) `AdapterEndpoint`).
3. **Given** authorization is deliberately minimal, **when** the model is implemented, **then** there is **no**
   per-operation or per-scope permission model on the adapter surface — a valid token authorizes that
   consumer's whole surface, matching the single-tenant design
   ([security.md](../architecture/security.md); [overview.md](../architecture/overview.md) *Deployment model*).
4. **Given** a token belonging to a **provider-only** app (no `CONSUMER` spec) somehow exists, **when** it is
   presented, **then** it authorizes nothing on the adapter surface (AT-1 criterion 4).

### Out of scope

- Multi-tenancy, tenant hierarchies, per-endpoint scopes — explicitly out of scope in the concept
  ([security.md](../architecture/security.md); [overview.md](../architecture/overview.md) *Deployment model*).

### Dependencies

Blocked by AT-2. Precedes RP-1.

---

## AT-4 — Rotation with an overlap window; revocation on disable/deregister

**As a** landscape operator, **I** rotate a consumer's token without breaking its live traffic, and know it
dies with the app, **so that** credential hygiene doesn't require an outage.

### Acceptance criteria

1. **Given** a consumer app with a current token, **when** an `operator` rotates it, **then** a new token is
   generated and **displayed exactly once** (AT-1 criterion 1), the previous token stays **valid during an
   overlap window**, and `lastRotatedAt` is updated
   ([security.md](../architecture/security.md); [data-model.md](../architecture/data-model.md) `Credential`).
2. **Given** the overlap window, **when** the consumer confirms cutover (an explicit operator action) **or** the
   window's bound elapses, **then** the previous token stops validating and only the current one is accepted
   ([security.md](../architecture/security.md)). The window's default length is config-defined (README open
   question 4).
3. **Given** two tokens are valid during the overlap, **when** either is presented, **then** both resolve to the
   **same** consumer app, and the audit record distinguishes which one was used (by credential id, never by
   value).
4. **Given** the consumer app is **disabled**, **when** its token is presented, **then** validation fails —
   revocation is implicit in the app's status ([security.md](../architecture/security.md);
   [extensibility.md](../architecture/extensibility.md) *App lifecycle*).
5. **Given** the consumer app is **deregistered**, **when** the cascade runs, **then** its adapter-token
   credentials are **deleted** from the Credential Store outright (credentials are deleted, not archived) and
   the surface is torn down (RT-4 criterion 3)
   ([extensibility.md](../architecture/extensibility.md) *App lifecycle*).
6. **Given** rotation is a mutation, **when** a `viewer` attempts it, **then** it is rejected 403 and nothing
   changes (OA-2).

### Out of scope

- Automatic/scheduled rotation policies — the concept models rotation as an operator action only.

### Dependencies

Blocked by AT-1, AD-3. Precedes AP-4, CU-3.
