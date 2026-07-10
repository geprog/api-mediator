# Phase 1 — Spec ingestion & IR

Parsing an OpenAPI document into the normalized **Intermediate Representation** (IR: resource groups
→ operations → schemas, `$ref`-resolved), storing it as `ApiSpec` version 1 with a `contentHash`,
exposing it for viewing, and capturing operator `analysisExclusions`. This is the Spec Registry's
Phase 1 responsibility.

**Actor:** operator (ingest via AR-1; set exclusions), viewer (view IR).

**Concept references (whole file):** [mapping-engine.md](../architecture/mapping-engine.md)
*Spec decomposition* (the IR definition, shared with the Spec Registry) and *Scoping down: operator
exclusions*; [data-model.md](../architecture/data-model.md) `ApiSpec`; [overview.md](../architecture/overview.md)
*Components* (Spec Registry); [glossary.md](../glossary.md) `IR`, `Resource group`, `ApiSpec`,
`analysisExclusions`. Scenario fixtures: [scenarios/README.md](../../scenarios/README.md),
[scenario-1 README](../../scenarios/scenario-1-small-overlap/README.md).

> **IR shape is implementation-defined.** The concept fixes *what the IR must contain* (below), not
> its concrete JSON structure. Criteria are stated at the behavioral/content level; a specific field
> layout is an implementation choice as long as every listed element is present and retrievable.

---

## SI-1 — Parse an OpenAPI document into the normalized IR

**As an** operator, **I can** submit an OpenAPI document and have it decomposed into the shared IR,
**so that** everything downstream (mapping, sync, adapter) reasons over one normalized form rather
than the raw document.

### Acceptance criteria

1. **Given** an OpenAPI document, **when** it is ingested, **then** all `$ref`s are resolved
   (dereferenced) so no unresolved `$ref` remains in the IR.
2. **Given** a dereferenced document, **when** the IR is built, **then** operations are grouped into
   **resource groups** by OpenAPI `tags`, falling back to a path-prefix heuristic when a tag is
   absent ([mapping-engine.md](../architecture/mapping-engine.md) *Spec decomposition* step 2).
3. **Given** a resource group in the IR, **when** inspected, **then** each of its operations carries:
   HTTP method, path, summary/description, parameters, request schema, response schema, and
   `operationId` ([mapping-engine.md](../architecture/mapping-engine.md) step 2).
4. **Given** a resource group's referenced component schemas, **when** inspected, **then** each
   flattened schema field carries: field name, type, description, and required-ness.
5. **Given** a resource that references another resource's schema, **when** the IR is built, **then**
   that cross-resource reference is included only as a lightweight summary (schema name + top-level
   field list), not fully expanded ([mapping-engine.md](../architecture/mapping-engine.md) step 3).
6. **Given** each resource group, **when** the IR is built, **then** it is addressable by a stable
   `resourceRef` (its group identifier), stable across re-parses of the same document — the same ref
   `ResourceBinding.resourceRef` and `analysisExclusions[]` use (see
   [open question 6](README.md#open-questions-for-a-human-concept-is-silent-or-underspecified-for-phase-1)).
7. **Given** the vendored scenario-1 trimmed Vikunja `PROVIDER` spec
   (`scenarios/scenario-1-small-overlap/specs/trimmed/vikunja.trimmed.swagger.json`), **when**
   ingested, **then** the IR contains distinct resource groups including `labels` and `tasks`
   (matching the document's `tags`).
8. **Given** the vendored scenario-1 trimmed Gitea and Vikunja specs, **when** each is ingested,
   **then** parsing tolerates the documented real-world messiness — Swagger-2.0-origin conversions,
   strict-schema violations, and duplicate `operationId`s — without aborting ingestion
   ([scenario-1 README](../../scenarios/scenario-1-small-overlap/README.md) *Concept probes*;
   [scenarios/README.md](../../scenarios/README.md) *Specs*).
9. **Given** a document that cannot be parsed at all (not resolvable OpenAPI), **when** ingestion is
   attempted, **then** it fails with an error identifying the parse problem and no `ApiSpec` is
   stored (feeding the atomic-registration rule AR-1 criterion 7).

### Out of scope

- Sending the IR (or its summaries) to an LLM for shortlist/detail analysis — Phase 2
  ([mapping-engine.md](../architecture/mapping-engine.md) *Matching approach*).
- `SpecDiff` (additive/breaking classification between IR versions) — Phase 6
  ([extensibility.md](../architecture/extensibility.md) *Spec update lifecycle*).
- Non-OpenAPI protocol inputs (GraphQL/AsyncAPI/gRPC via the Spec Adapter seam) —
  ([extensibility.md](../architecture/extensibility.md) *Beyond REST/OpenAPI*).

### Dependencies

None (shared-kernel `ir` builder). Needed by SI-2, RB-1, AR-1.

---

## SI-2 — Store the parsed spec as `ApiSpec` version 1 with a `contentHash`

**As an** operator, **I can** have an ingested spec persisted as `ApiSpec` version 1, **so that** it
has a stable identity, a content fingerprint, and a role the rest of the system pins to.

### Acceptance criteria

1. **Given** a successfully parsed document with a `role`, **when** it is stored, **then** an
   `ApiSpec` row is created with a generated `id`, the owning `appId`, the given `role`
   (`PROVIDER`|`CONSUMER`), the `rawDocument`, the `parsedIR`, `version = 1`, a `contentHash`,
   `status = active`, `analysisExclusions` (default empty — see SI-4), and `createdAt`.
2. **Given** the same OpenAPI document is ingested twice (byte-identical), **when** each is stored,
   **then** both produce the **same** `contentHash` — the hash is deterministic over the
   canonicalized raw document (see [open question 5](README.md#open-questions-for-a-human-concept-is-silent-or-underspecified-for-phase-1)).
3. **Given** two materially different documents, **when** each is ingested, **then** their
   `contentHash` values differ.
4. **Given** any Phase 1 ingestion, **when** an `ApiSpec` is created, **then** its `version` is
   exactly `1` — Phase 1 never creates version 2+ (re-ingestion and versioning are Phase 6).
5. **Given** an app that carries both a `PROVIDER` and a `CONSUMER` spec, **when** both are stored,
   **then** they are distinct `ApiSpec` rows whose `version` counters increment independently (each
   starts at 1), disambiguated by `role`.

### Out of scope

- `status` transitions to `superseded`/`archived` — Phase 6 (`superseded` on re-ingestion,
  `archived` on deregistration; [data-model.md](../architecture/data-model.md) `ApiSpec`).
- Version 2+ ingestion, re-pinning, `SpecDiff` — Phase 6.

### Dependencies

Blocked by SI-1. Precedes EB-1 (a stored `ApiSpec` is what `SpecIngested` announces).

---

## SI-3 — View a spec's IR

**As a** viewer or operator, **I can** view a stored spec's IR, **so that** I can inspect how the
mediator decomposed it (resource groups → operations → schemas) before and after confirming
bindings.

### Acceptance criteria

1. **Given** a stored `ApiSpec`, **when** `GET /specs/:id/ir` is called, **then** it returns the
   `parsedIR`: the resource groups, each with its operations (method, path, summary, parameters,
   request/response schema, `operationId`) and flattened schema fields (name, type, description,
   required-ness).
2. **Given** a spec id that does not exist, **when** `GET /specs/:id/ir` is called, **then** the
   response is a 404.
3. **Given** the IR viewer UI on a stored spec, **when** it renders, **then** it displays the
   resource groups and lets the operator drill into each group's operations and schema fields.

### Security / invariant criteria

4. **Given** an IR response or the IR viewer, **when** rendered, **then** it contains no credential
   material (the IR is derived from the OpenAPI document only).

### Out of scope

- Editing the IR — the IR is derived, not hand-edited; operator correction happens on
  `ResourceBinding`s (RB-2), not on the IR itself.

### Dependencies

Blocked by SI-2.

---

## SI-4 — Scope analysis down with `analysisExclusions`

**As an** operator, **I can** exclude resource groups of a spec from mapping analysis, **so that** a
large spec whose landscape uses only a fraction of it doesn't flood later analysis with noise.

### Acceptance criteria

1. **Given** a newly ingested `ApiSpec`, **when** no exclusions are supplied, **then**
   `analysisExclusions` defaults to empty (every resource group is in analysis scope).
2. **Given** registration, **when** the operator selects resource groups to exclude, **then** those
   `resourceRef`s persist on `ApiSpec.analysisExclusions` (settable at registration —
   [app-registration-and-mapping-detection.md](../flows/app-registration-and-mapping-detection.md)
   step 1).
3. **Given** a stored `ApiSpec`, **when** the operator edits its exclusions (e.g.
   `PATCH /specs/:id/analysis-exclusions`), **then** the updated `resourceRef` list persists —
   exclusions are editable any time ([data-model.md](../architecture/data-model.md) `ApiSpec`).
4. **Given** an edit that references a `resourceRef` not present in the spec's IR, **when** applied,
   **then** it is rejected with a validation error (only refs that resolve to an IR resource group
   are valid exclusions).
5. **Given** exclusions are set or edited in Phase 1, **when** the operation completes, **then** it
   only persists the operator's declared scope — it triggers **no** analysis (the Mapping Engine
   does not exist until Phase 2), and existing artifacts are unaffected (there are none in Phase 1).

### Out of scope

- The *effect* of exclusions — omission from shortlist prompts, no detail calls — Phase 2
  ([mapping-engine.md](../architecture/mapping-engine.md) *Scoping down*).
- Re-inclusion triggering a scoped incremental analysis, and carry-forward of exclusions across new
  spec versions — Phase 2/6 ([mapping-engine.md](../architecture/mapping-engine.md) *Scoping down*;
  [extensibility.md](../architecture/extensibility.md)). Phase 1 only stores/edits the list.

### Dependencies

Blocked by SI-1 (needs resource groups to reference) and SI-2 (needs a stored `ApiSpec` to edit).
