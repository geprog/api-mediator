# Phase 1 — Credential storage (write-only)

Storing per-app `Credential` material envelope-encrypted and **write-only**. Phase 1 needs only the
`store` path; decrypt-for-use (`withCredential`) is Phase 4 and explicitly out of scope here.

**Actor:** operator (via the registration orchestration — see AR-1).

**Concept references (whole file):** [security.md](../architecture/security.md) *Credential
storage* / *Least privilege* / *Summary of trust boundaries*; [data-model.md](../architecture/data-model.md)
`Credential`; [overview.md](../architecture/overview.md) *Components* (API/UI Layer write-only note,
Credential Store); [glossary.md](../glossary.md) `Credential`, `Credential Store`.

---

## CR-1 — Store credential material envelope-encrypted, write-only

**As an** operator, **I can** submit an app's credential material at registration, **so that** the
mediator can authenticate to that app later — without the material ever being retrievable again.

### Acceptance criteria

1. **Given** credential material for an app, **when** `CredentialStore.store(appId, material)` is
   called, **then** a `Credential` row is persisted with a generated `id`, the given `appId`, a
   `type` in {`apiKey`, `oauth2`, `basicAuth`, `custom`}, the `scopes` provided (if any), and
   `lastRotatedAt` set to creation time.
2. **Given** credential material is stored, **when** the row is written, **then**
   `Credential.encryptedPayload` holds the material under **envelope encryption** — a per-credential
   data key that is itself encrypted by a master key held by a key-management capability; the exact
   cipher and key-management binding are implementation-defined (the concept mandates the pattern,
   not a product).
3. **Given** an `encryptedPayload` and the master key, **when** the store's own internal accessor
   decrypts it (a test-only exercise of the envelope round-trip in Phase 1), **then** it recovers
   the exact original material — proving the envelope is reversible internally while remaining
   opaque externally.
4. **Given** an app registers with no credential material, **when** the registration is processed,
   **then** no `Credential` row is created and registration still succeeds (credential is optional —
   see [open question 3](README.md#open-questions-for-a-human-concept-is-silent-or-underspecified-for-phase-1)).
5. **Given** a submitted `type` outside the Phase 1 accepted set, **when** `store` is called,
   **then** it is rejected with a validation error. In particular `type = adapterToken` is **not**
   accepted through this path in Phase 1 (adapter-token issuance and its salted-hash storage are
   Phase 5 — see Out of scope).

### Security / invariant criteria

6. **Given** `CredentialStore.store` is the credential entry point, **when** used, **then** it is
   **write-only**: it returns no credential material (only a reference/id or nothing), and there is
   no Phase 1 API that reads decrypted credential material back out.
7. **Given** credential material passes through the store, **when** any log line is emitted by the
   store or its callers, **then** the plaintext material never appears in a log.

### Out of scope

- `CredentialStore.withCredential(appId, fn)` decrypt-for-outbound-call, OAuth2 access-token
  refresh, and "never held beyond one call" caller discipline — Phase 4
  ([security.md](../architecture/security.md) *Credential storage*).
- `adapterToken` generation, one-time display, salted-hash storage, and rotation-with-overlap —
  Phase 5 ([security.md](../architecture/security.md) *Inbound authentication to generated adapter
  servers*).
- Credential rotation / metadata management UI — later (Phase 1 stores at registration only).

### Dependencies

None (shared-kernel; needed by AR-1). Verified together with CR-2.

---

## CR-2 — Credential material never leaves the store (secrecy invariant)

**As an** operator, **I can** trust that credential material I submit is never returned, logged, or
emitted anywhere, **so that** the Credential Store's status as the highest-value target is honored.

### Acceptance criteria

1. **Given** an app has been registered with credential material, **when** any Phase 1 API response
   is inspected (`POST /apps`, `GET /apps`, `GET /apps/:id/specs`, `GET /specs/:id/ir`,
   `PATCH /resource-bindings/:id`), **then** none contains plaintext credential material or the
   `encryptedPayload`.
2. **Given** the full registration → ingestion flow runs, **when** all server logs for the flow are
   inspected, **then** no plaintext credential material is present in any log line.
3. **Given** a `SpecIngested` event is emitted for a registered app, **when** the event payload is
   inspected, **then** it contains no credential material and no reference that resolves to
   plaintext credential material (see EB-1).
4. **Given** the Phase 1 acceptance suite, **when** the envelope round-trip test runs, **then** it
   asserts that the plaintext supplied to `store` is byte-for-byte recoverable **only** through the
   store's internal accessor, and is absent from every externally observable surface enumerated in
   criteria 1-3.

### Security / invariant criteria

5. **Given** the two authorization roles, **when** either an `operator` or a `viewer` uses any
   Phase 1 endpoint, **then** neither role can retrieve stored credential material — the secrecy
   invariant is independent of role.

### Out of scope

- The single deliberate secret-return exception (`adapterToken` displayed once at issuance) — Phase 5;
  it does not exist in Phase 1, so Phase 1 has **zero** secret-returning endpoints.

### Dependencies

Cross-cutting; verified against CR-1, AR-1, AR-2, SI-3, EB-1.
