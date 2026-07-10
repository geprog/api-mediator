# Phase 1 — App registration

Registering a `RegisteredApp` and its role-tagged `ApiSpec`s through the API/UI Layer — the entry
point for the whole system ([app-registration-and-mapping-detection.md](../flows/app-registration-and-mapping-detection.md)
steps 1-3). This file owns the *orchestration* and the operator-facing read/write surfaces;
credential storage, IR parsing, `ResourceBinding` derivation, and `SpecIngested` emission are
specified in their own files and referenced here.

**Actor:** operator (mutations), viewer (reads). See the auth split note in the
[requirements README](README.md#roles) — enforcement wiring is Phase 3, but the read/mutate
boundary is stated so it is testable when it lands.

**Concept references (whole file):** [overview.md](../architecture/overview.md) *Components* /
*Key interfaces*; [data-model.md](../architecture/data-model.md) `RegisteredApp`, `ApiSpec`;
[app-registration-and-mapping-detection.md](../flows/app-registration-and-mapping-detection.md)
steps 1-3; [glossary.md](../glossary.md) `RegisteredApp`, `PROVIDER spec`, `CONSUMER spec`.

---

## AR-1 — Register an app with credentials and one or more role-tagged specs

**As an** operator, **I can** register an app by submitting a name, an optional `baseUrl`, its
`capabilities`, optional credential material, and one or more OpenAPI documents each tagged with a
`role`, **so that** the app enters the landscape and its specs become analyzable.

### Acceptance criteria

1. **Given** a valid registration request with a `name`, at least one OpenAPI document, and each
   document tagged `role = PROVIDER` or `role = CONSUMER`, **when** `POST /apps` is called,
   **then** a `RegisteredApp` is created with a generated `id`, the given `name`, `status = active`,
   `createdAt` set, and the response returns the created app's `id` and metadata.
2. **Given** a registration request, **when** `capabilities` is provided, **then** the
   `RegisteredApp.capabilities` persists exactly `{ supportsPolling, supportsDeltaQuery,
   supportsChangeTimestamps, defaultPollInterval }`; **when** `capabilities` is omitted, **then**
   it defaults to `supportsPolling=false`, `supportsDeltaQuery=false`,
   `supportsChangeTimestamps=false`, and the configured `defaultPollInterval`
   (default values — see [open question 2](README.md#open-questions-for-a-human-concept-is-silent-or-underspecified-for-phase-1)).
3. **Given** a registration that includes at least one `role = PROVIDER` spec, **when** `baseUrl`
   is omitted, **then** the request is rejected with a validation error naming `baseUrl`
   (recommended rule — see [open question 1](README.md#open-questions-for-a-human-concept-is-silent-or-underspecified-for-phase-1)).
4. **Given** a consumer-only registration (only `role = CONSUMER` specs) with no `baseUrl`,
   **when** `POST /apps` is called, **then** registration succeeds and the `RegisteredApp` persists
   with `baseUrl` absent (the mediator itself will host the reachable endpoint in Phase 5).
5. **Given** a registration with two documents tagged `PROVIDER` and `CONSUMER` respectively,
   **when** `POST /apps` is called, **then** two `ApiSpec` rows are created under the one
   `RegisteredApp`, each with its submitted `role`, and both are ingested (see SI-1/SI-2).
6. **Given** a registration request, **when** it is processed, **then** the orchestration performs,
   in order: create `RegisteredApp` → `CredentialStore.store(appId, material)` if credential
   material was supplied (see CR-1) → `SpecRegistry.ingestSpec(appId, specDoc, role)` per document
   (see SI-1/SI-2) → `SpecIngested` emitted per stored spec (see EB-1).
7. **Given** a registration request in which any submitted OpenAPI document fails to parse into an
   IR, **when** `POST /apps` is processed, **then** the entire request fails atomically: no
   `RegisteredApp`, `Credential`, or `ApiSpec` is persisted and no `SpecIngested` is emitted
   (recommended atomicity rule — see [open question 4](README.md#open-questions-for-a-human-concept-is-silent-or-underspecified-for-phase-1)).
8. **Given** a registration request missing a `name`, or with a spec document carrying no `role`,
   or with an unrecognized `role` value, **when** `POST /apps` is called, **then** it is rejected
   with a validation error identifying the offending field, and nothing is persisted.
9. **Given** any registration request, **when** it is processed, **then** exactly the two roles
   `PROVIDER` and `CONSUMER` are accepted for a spec document; no other role value is valid.

### Security / invariant criteria

10. **Given** a registration carrying credential material, **when** the `POST /apps` response is
    returned, **then** the response body contains no plaintext credential material and no
    envelope-encrypted `Credential.encryptedPayload` (see CR-2 for the full secrecy invariant).
11. **Given** a registration is processed, **when** any log line is written for it, **then** no
    credential material appears in the logs.

### Out of scope

- Mapping detection triggered by `SpecIngested` — Phase 2 ([mapping-engine.md](../architecture/mapping-engine.md)).
- Additional spec versions / re-ingestion / `SpecDiff` — Phase 6. Phase 1 registers version 1 only.
- Per-app outbound concurrency/rate ceilings ([open question 10](README.md#open-questions-for-a-human-concept-is-silent-or-underspecified-for-phase-1)) — Phase 4.
- Disable/deregister of an app — Phase 6 ([extensibility.md](../architecture/extensibility.md) *App lifecycle*).

### Dependencies

Blocked by CR-1 (credential store), SI-1/SI-2 (IR + `ApiSpec` v1), RB-1 (binding derivation),
EB-1 (`SpecIngested`).

---

## AR-2 — Browse registered apps and their specs

**As a** viewer or operator, **I can** list registered apps and see each app's specs, **so that**
I can confirm what is in the landscape and navigate to a spec's IR.

### Acceptance criteria

1. **Given** two apps have been registered, **when** `GET /apps` is called, **then** the response
   lists both `RegisteredApp`s with `id`, `name`, `status`, `baseUrl` (if present), `capabilities`,
   and `createdAt`; at Phase 1 landscape scale the full list is returned without pagination
   (see [open question 7](README.md#open-questions-for-a-human-concept-is-silent-or-underspecified-for-phase-1)).
2. **Given** an app with a `PROVIDER` and a `CONSUMER` spec, **when** `GET /apps/:id/specs` is
   called, **then** the response lists both `ApiSpec`s with `id`, `role`, `version`, `contentHash`,
   `status`, and `createdAt`.
3. **Given** `GET /apps/:id/specs`, **when** it responds, **then** it does **not** include
   `rawDocument`; the IR is obtained separately via `GET /specs/:id/ir` (see SI-3, and
   [open question 8](README.md#open-questions-for-a-human-concept-is-silent-or-underspecified-for-phase-1)).
4. **Given** an app id that does not exist, **when** `GET /apps/:id/specs` is called, **then** the
   response is a 404.

### Security / invariant criteria

5. **Given** any app-list or app-specs response, **when** returned, **then** it contains no
   credential material and no `Credential.encryptedPayload`.

### Out of scope

- Landscape graph rendering — Phase 6 ([graph-overview.md](../flows/graph-overview.md)).
- Filtering/search — not required at Phase 1 scale.

### Dependencies

Blocked by AR-1, SI-2.

---

## AR-3 — Registration form UI

**As an** operator, **I can** register an app through a form that uploads specs, assigns each a
role, declares capabilities, and previews resource groups for exclusion, **so that** I can onboard
an app without hand-crafting API calls.

### Acceptance criteria

1. **Given** the registration form, **when** it renders, **then** it collects `name`, optional
   `baseUrl`, the four `capabilities` fields, optional credential material, and one or more spec
   documents each with a `role` selector (`PROVIDER`/`CONSUMER`).
2. **Given** the operator uploads a spec document, **when** it is accepted, **then** the form
   preview-parses it and offers its resource groups as toggles for `analysisExclusions` (see SI-4),
   using a stateless preview parse that does **not** create a `RegisteredApp` or `ApiSpec`
   (see [open question 9](README.md#open-questions-for-a-human-concept-is-silent-or-underspecified-for-phase-1)).
3. **Given** a completed form, **when** the operator submits, **then** it issues one `POST /apps`
   carrying the collected fields, selected `role`s, and chosen `analysisExclusions`, and on success
   navigates to the created app (or the app list).
4. **Given** the operator adds a `PROVIDER` spec but leaves `baseUrl` empty, **when** they attempt
   to submit, **then** the form surfaces the same validation rule as AR-1 criterion 3 before or
   consistent with the server response.
5. **Given** a submission fails validation server-side, **when** the response returns, **then** the
   form surfaces the field-level error without losing already-entered input.

### Security / invariant criteria

6. **Given** the operator enters credential material in the form, **when** the app is created and
   the operator later views it, **then** the credential material is never displayed back (no
   round-trip of secrets to the UI — see CR-2).

### Out of scope

- Editing capabilities/`baseUrl` after registration — not required in Phase 1 (registration-time
  capture only; general app editing is later).
- `analysisExclusions` editing after registration — that is SI-4 (a separate surface), the form
  only sets them at registration.

### Dependencies

Blocked by AR-1, SI-1 (preview parse), SI-4.
