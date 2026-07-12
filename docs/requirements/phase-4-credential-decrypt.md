# Phase 4 — Credential decrypt-for-call (`withCredential` completion)

The **decrypt-for-use** slice: completing the Phase-1 `CredentialStore.withCredential(appId, fn)` so the
Outbound Call Executor can make authenticated calls, while the store's hard guarantees hold — plaintext is
decrypted only for the duration of one call, never returned to callers, never logged, never held beyond that
scope, and OAuth2 refresh happens **inside** the store. Phase 1 shipped `store` (write-only) and the
`withCredential` **skeleton** ([`store.ts`](../../packages/credentials/src/store.ts)) with the decrypt path in
place but two Phase-4 seams marked as TODO: OAuth2 access-token refresh, and the Outbound Call Executor
driving `fn`. This file specifies those seams.

**Actor:** system (Credential Store; called by the Outbound Call Executor).

**Concept references (whole file):** [security.md](../architecture/security.md) *Credential storage*
(`withCredential`, envelope encryption, OAuth2 lifecycle inside the store), *Least privilege*, *Audit logging*;
[overview.md](../architecture/overview.md) *Components* (Credential Store: "decrypts for the duration of a
single outbound call"); [data-model.md](../architecture/data-model.md) `Credential` (`type`,
`encryptedPayload`, `scopes`, `lastRotatedAt`); [glossary.md](../glossary.md) `Credential Store`, `Credential`.

> **Security invariants, not conveniences.** Every "never" below (never returned, never logged, never held,
> never landscape-wide) is a hard, tested guarantee. A fast path may not skip them. Builds directly on the
> Phase-1 store — it must not weaken any Phase-1 CR-* guarantee.

---

## CD-1 — Decrypt-for-call: hand `fn` a currently-valid secret, return only its result

**As the** Outbound Call Executor, **I** obtain an app's credential only via `withCredential(appId, fn)`,
receiving a currently-valid secret for the duration of that one call, **so that** I can authenticate an
outbound request without the secret ever leaking out of the store's scope.

### Acceptance criteria

1. **Given** an app with a stored `Credential`, **when** `withCredential(appId, fn)` is called, **then** the
   store decrypts the envelope, invokes `fn` with the plaintext secret, and returns **only `fn`'s return
   value** — the secret itself is never part of the return
   ([security.md](../architecture/security.md) *Credential storage*).
2. **Given** `fn` has returned (or thrown), **when** the call completes, **then** the decrypted plaintext is
   **not retained** beyond that scope (the plaintext buffer is zeroed and no reference survives) — "never held
   in memory beyond the scope of that one call" ([security.md](../architecture/security.md)).
3. **Given** the store logs the access, **when** it writes an audit/log line, **then** the line carries
   **metadata only** (credential id, app id, type) and **never** the secret value
   ([security.md](../architecture/security.md) *Credential storage*, *Audit logging*).
4. **Given** an app with **no** stored `Credential` (a valid public/no-auth provider), **when**
   `withCredential` is called, **then** `fn` is **not** invoked and a distinct `no-credential` outcome is
   returned — the caller handles the no-auth app explicitly rather than via a nullable secret (preserving the
   Phase-1 CR-1 contract).
5. **Given** the least-privilege rule, **when** the executor requests a credential, **then** it requests it for
   **exactly the one app it is calling at that moment** — never landscape-wide, never cached across calls to
   different apps ([security.md](../architecture/security.md) *Least privilege*).

### Out of scope

- The outbound call `fn` itself (issuing the REST request) — OC-1.
- Adapter-token validation (`type = adapterToken`, salted-hash equality) — Phase 5
  ([security.md](../architecture/security.md) *Inbound authentication to generated adapter servers*).

### Dependencies

Blocked by Phase-1 CR-1/CR-2 (the store skeleton). Precedes OC-1.

---

## CD-2 — OAuth2 access-token refresh inside the store

**As the** Outbound Call Executor, **I** am handed a currently-valid OAuth2 access token without ever seeing or
triggering a refresh, **so that** expiring credentials just work and refresh-token handling stays entirely
inside the store.

### Acceptance criteria

1. **Given** an app whose stored `oauth2` access token is **expired** (or within a refresh threshold), **when**
   `withCredential` runs, **then** the store refreshes it internally using the envelope-encrypted **refresh
   token**, persists the re-encrypted updated tokens, and hands `fn` a **currently-valid access token** — the
   caller never sees the refresh token and never triggers the refresh
   ([security.md](../architecture/security.md) *Credential storage*: "OAuth2 token lifecycle is handled
   entirely inside the Credential Store").
2. **Given** a stored `oauth2` access token that is still valid, **when** `withCredential` runs, **then** no
   refresh occurs and the existing access token is handed to `fn`.
3. **Given** a refresh persists new tokens, **when** they are stored, **then** they are re-**envelope-encrypted**
   exactly as at `store` time and `lastRotatedAt` semantics are preserved — refreshed material is never
   persisted in plaintext ([security.md](../architecture/security.md); [data-model.md](../architecture/data-model.md)
   `Credential`).
4. **Given** a refresh **fails** (revoked refresh token, provider error), **when** it occurs, **then** the store
   surfaces a distinct credential-refresh failure to the caller (no valid token to hand `fn`) — the outbound
   call cannot proceed and the failure is recorded as such (OC-4), never a call attempted with a stale token
   masquerading as valid.
5. **Given** non-`oauth2` credential types (`apiKey`, `basicAuth`, `custom`), **when** `withCredential` runs,
   **then** no refresh path is exercised — they are handed to `fn` as-is
   ([data-model.md](../architecture/data-model.md) `Credential.type`).

### Out of scope

- The specific OAuth2 grant/endpoints per provider — implementation configuration, not a requirement here.
- Proactive background refresh independent of a call — the concept refreshes on use, inside `withCredential`.

### Dependencies

Blocked by CD-1. Precedes OC-1.

---

## CD-3 — `credential-access` audit trail, metadata-only

**As an** operator, **I** have every credential decrypt recorded as a `credential-access` audit entry with no
secret material, **so that** the highest-value action in the system is traceable without the audit log itself
becoming a secret store.

### Acceptance criteria

1. **Given** a successful `withCredential` decrypt, **when** it completes, **then** a `credential-access`
   `SyncEvent`/`AuditLog` entry is recorded referencing the credential (`relatedCredentialId`) and app, with
   **no** secret value ([data-model.md](../architecture/data-model.md) `SyncEvent / AuditLog` (`credential-access`
   type); [security.md](../architecture/security.md) *Audit logging*).
2. **Given** a refresh occurred (CD-2), **when** the access is audited, **then** the entry can note that a
   refresh happened (metadata only) — never the old or new token value.
3. **Given** the `no-credential` outcome (CD-1 criterion 4), **when** it occurs, **then** it is distinguishable
   in the record from an actual decrypt — a public app's call is auditable as "no credential used," not a
   silent gap.
4. **Given** every credential-access entry, **when** written, **then** it carries `traceId`/`spanId` correlating
   it to the outbound-call trace (SD-4) so an operator can jump from the credential access to the call that used
   it ([observability.md](../architecture/observability.md) *Relationship to the Audit/Event Log*).

### Out of scope

- The durable audit-log persistence layer beyond this event type — shared with SD-4 and every pipeline story.

### Dependencies

Blocked by CD-1, SD-4. Precedes OC-1.
