# Phase 3 — ApprovedMapping domain shapes

The **types** slice of Phase 3: the persisted, human-approved entities the Sync Engine and Adapter
Engine will later act on — `ApprovedMapping` and its `FieldMapping`/`OperationMapping`/
`ParameterMapping` children — plus the `MappingApproved` event and the *minimal* downstream-artifact
shapes (`SyncRule`, `AdapterEndpoint`/`AdapterBinding`, `GraphEdge`) Phase 3 instantiates **disabled**.
No behavior lives here: this is the single-naming-authority (`@mediator/domain`) layer, matching how
Phase 1/2 defined every glossary entity once as a Zod schema plus its inferred type before any slice
consumed it.

**What already exists (Phase 2, `@mediator/domain`)** and must **not** be re-specified: `MappingProposal`,
`MappingProposalItem`, `MappingSuggestionSet` (the peer-peer / consumer-provider discriminated union),
`ResourceShortlist`, and the enums `MappingVariant`, `TransformKind`, `MappingPhase`, `ReviewState`,
`MappingProposalStatus`. Phase 3 **adds** the approved-side entities below and reuses those enums
verbatim (a `FieldMapping.transform` is the same `TransformKind`; an approved field's `phase` is the
same `MappingPhase`).

**Actor:** system (shared kernel — types only, no I/O).

**Concept references (whole file):** [data-model.md](../architecture/data-model.md) `ApprovedMapping`,
`FieldMapping`, `OperationMapping`, `ParameterMapping`, `SyncRule`, `AdapterEndpoint`, `AdapterBinding`,
`GraphEdge`, and *Modeling notes* (conditionally-meaningful fields; one-directional mappings; mutual
exclusivity of `SyncRule` vs. `AdapterBinding`); [glossary.md](../glossary.md) `ApprovedMapping`,
`counterpartMappingId`, `FieldMapping`, `phase`, `OperationMapping`, `ParameterMapping`, `action`,
`identity key`, `MappingApproved`, `SyncRule`, `AdapterBinding`, `GraphEdge`, `Spec lineage`;
[mapping-review-and-approval.md](../flows/mapping-review-and-approval.md) steps 5-10.

> **The entity *fields* are authoritative; their Zod/TypeScript encoding is the implementation choice.**
> Where the concept models a distinction as a *conditionally-meaningful field on one entity*
> (`FieldMapping.phase`, `FieldMapping.conflictPolicy`, `OperationMapping.targetIdParamRef`), the domain
> may encode it either as an optional field guarded by a refinement or as a discriminated union on
> `MappingVariant` — the same latitude Phase 2 used for `MappingSuggestionSet`. `variant` is a
> **modeling discriminant** derivable mechanically from the pair's spec roles, **not** a new glossary
> entity (see [mapping-enums.ts `MappingVariant`](../../packages/domain/src/mapping-enums.ts)); it must
> not be surfaced as one.

---

## AM-1 — Approved-side enums: `OperationAction` and `ApprovedMapping.status`

**As the** shared kernel, **I** define the enumerations the approved-side entities need — the CRUD
`action` and the `ApprovedMapping` lifecycle status — **so that** every slice spells them identically.

### Acceptance criteria

1. **Given** the approved-side domain, **when** the `action` enum is defined, **then** its members are
   exactly `create`, `read`, `update`, `delete` — the verbatim vocabulary of
   [data-model.md](../architecture/data-model.md) `OperationMapping.action` and
   [glossary.md](../glossary.md) `action`. There is **no** `list` member — see the README open
   question flagging the plan's `list` against the concept's four-value enum.
2. **Given** the approved-side domain, **when** the `ApprovedMapping.status` enum is defined, **then**
   its members are exactly `active`, `suspended`, `stale`, `superseded`, `archived`
   ([data-model.md](../architecture/data-model.md) `ApprovedMapping.status`), even though Phase 3 only
   ever *creates* rows and the transitions into `stale`/`superseded`/`archived` are later phases — the
   single naming authority owns every value the column can hold (the same convention Phase 2 used for
   `MappingProposalStatus`).
3. **Given** these enums, **when** they are added, **then** the Phase-2 enums (`MappingVariant`,
   `TransformKind`, `MappingPhase`, `ReviewState`, `MappingProposalStatus`) are **reused unchanged** —
   no synonym is coined for an existing term.

### Out of scope

- Any transition *logic* into `active`/`suspended`/`stale`/`superseded`/`archived` — enabling is
  Phase 4/5, staleness/succession/archival is Phase 6 ([extensibility.md](../architecture/extensibility.md)).

### Dependencies

None (extends Phase-2 `mapping-enums`). Precedes AM-2..AM-4.

---

## AM-2 — `ApprovedMapping` entity (one-directional; variant-shaped)

**As the** shared kernel, **I** define the `ApprovedMapping` entity as a one-directional mapping whose
peer-peer vs. consumer-provider shape carries only that variant's meaningful fields, **so that** an
adapter-only field can never be set on a sync mapping and vice versa.

### Acceptance criteria

1. **Given** the entity, **when** defined, **then** it carries `id`, `sourceSpecId`, `targetSpecId`,
   denormalized `sourceAppId`/`targetAppId`, `variant` (`MappingVariant`), `approvedBy`, `approvedAt`,
   and `status` ([data-model.md](../architecture/data-model.md) `ApprovedMapping`). `sourceSpecId`/
   `targetSpecId` are the source of truth; the app ids are query-convenience denormalizations.
2. **Given** a **peer-peer** `ApprovedMapping` (both sides `PROVIDER`), **when** defined, **then** it
   may carry `counterpartMappingId` (optional, nullable) linking the reverse-direction mapping between
   the same two **spec lineages** ([glossary.md](../glossary.md) `counterpartMappingId`, `Spec
   lineage`); a **consumer-provider** mapping carries **no** `counterpartMappingId` — the mediator
   never calls the consumer, so there is no reverse direction (a refinement or the variant union makes
   a present value on a consumer-provider mapping unrepresentable).
3. **Given** the mapping is always one-directional (`sourceSpecId → targetSpecId`, data flowing source
   → target), **when** defined, **then** the entity carries **no** `direction` field and **no**
   reversible-transform notion — bidirectional sync is two paired rows, per
   [data-model.md](../architecture/data-model.md) *Modeling notes*.
4. **Given** Phase 3 ingests version-1 specs only (versions/re-pinning are Phase 6), **when** the
   `counterpartMappingId` lineage rule is applied, **then** lineage identity reduces to the `(app,
   role)` pair — the full version-agnostic lineage semantics are Phase 6
   ([extensibility.md](../architecture/extensibility.md)).
5. **Given** any `ApprovedMapping`, **when** created, **then** it references its two `ApiSpec`s by id
   only and carries no credential material (derived from IR + review decisions, consistent with the
   Phase-1 no-secrets-in-derived-data invariant).

### Out of scope

- Setting `status` to anything but the Phase-3 creation value `active` (see AS-6 criterion 3 — the enum
  has no "disabled"/"pending" value, so non-execution is expressed by the disabled *artifacts*, not the
  mapping status); `suspended`/`stale`/`superseded`/`archived` transitions are Phase 4/5/6.
- Re-pinning `sourceSpecId`/`targetSpecId` across spec versions — Phase 6.

### Dependencies

Blocked by AM-1. Precedes AS-2, AM-5.

---

## AM-3 — `FieldMapping` entity (shared by both engines; conditionally-meaningful fields)

**As the** shared kernel, **I** define `FieldMapping` with its transform plus the fields that are
meaningful only on one variant (`phase`, `isIdentityKey`/`targetLookupParamRef`, `conflictPolicy`),
**so that** each engine's fields stay inert on the other's rows exactly as the concept models them.

### Acceptance criteria

1. **Given** a `FieldMapping`, **when** defined, **then** it carries `id`, `mappingId`, `sourcePath`,
   `targetPath`, `transform` (`TransformKind`), and `transformConfig` (for multi-input `aggregate`/
   `expression` transforms declaring additional input paths)
   ([data-model.md](../architecture/data-model.md) `FieldMapping`). `sourcePath` is always the
   transform's primary input, `targetPath` its output.
2. **Given** a **consumer-provider** `FieldMapping`, **when** defined, **then** `phase` (`request` |
   `response`, the Phase-2 `MappingPhase`) is **required**; on a **peer-peer** `FieldMapping` `phase`
   is **absent** ([data-model.md](../architecture/data-model.md) `FieldMapping.phase`).
3. **Given** a **peer-peer** `FieldMapping`, **when** defined, **then** it may carry `isIdentityKey`
   (bool) and, alongside it, an optional `targetLookupParamRef`; these are **absent/inert** on a
   consumer-provider `FieldMapping` — the adapter never correlates records across apps
   ([data-model.md](../architecture/data-model.md) `FieldMapping.isIdentityKey`, `targetLookupParamRef`).
4. **Given** an identity `FieldMapping` (`isIdentityKey = true`), **when** the type is defined, **then**
   the value-preserving restriction is representable and enforceable: an identity `FieldMapping` may
   carry only `transform = rename` ([data-model.md](../architecture/data-model.md); enforced at review
   by AS-5).
5. **Given** a `FieldMapping`, **when** defined, **then** the optional `conflictPolicy` override
   (`manual-resolve`) is present in the type but **meaningful only on peer-peer (sync-driving)** rows —
   the same conditionally-meaningful shape as `phase` in reverse; **setting** it is a Phase-4 concern
   (conflict handling), Phase 3 leaves it absent.

### Out of scope

- Executing any `transform`, and the `expression` sandbox — Phase 4/5
  ([security.md](../architecture/security.md) *Transformation expression sandboxing*).
- Setting `conflictPolicy` at review — Phase 4.

### Dependencies

Blocked by AM-1, AM-2. Precedes AS-2, AS-5.

---

## AM-4 — `OperationMapping` and `ParameterMapping` entities

**As the** shared kernel, **I** define `OperationMapping` (with its `action` and peer-peer
`targetIdParamRef`) and the consumer-provider-only `ParameterMapping`, **so that** the executing
engines have a persisted referent for *which target operation to call* and *how to fill its inputs*.

### Acceptance criteria

1. **Given** an `OperationMapping`, **when** defined, **then** it carries `id`, `mappingId`,
   `sourceOperationRef`, `targetOperationRef`, and `action` (the AM-1 enum)
   ([data-model.md](../architecture/data-model.md) `OperationMapping`).
2. **Given** an `OperationMapping` on a **peer-peer** mapping with `action = update | delete`, **when**
   defined, **then** it may carry the optional `targetIdParamRef` — which target-operation parameter
   receives the linked record's target-side native id from the `RecordLink`
   ([data-model.md](../architecture/data-model.md) `OperationMapping.targetIdParamRef`). It is
   **absent** on consumer-provider `OperationMapping`s (those fill inputs via `ParameterMapping`s) and
   on `action = create | read` rows.
3. **Given** a **consumer-provider** mapping, **when** its `ParameterMapping`s are defined, **then**
   each carries `id`, `operationMappingId`, `sourceParamRef` (a consumer operation parameter),
   `targetParamRef` (a backend operation parameter), and an optional `transform`/`transformConfig`
   ([data-model.md](../architecture/data-model.md) `ParameterMapping`).
4. **Given** a **peer-peer** mapping, **when** defined, **then** it has **no** `ParameterMapping`s — the
   sync pipeline fills target parameters from the `RecordLink` via `OperationMapping.targetIdParamRef`,
   not per-parameter correspondences ([data-model.md](../architecture/data-model.md)).
5. **Given** an `OperationMapping`/`ParameterMapping`, **when** defined, **then** it is the persisted
   form of an accepted `kind = operation` / `kind = parameter` `MappingProposalItem` (AS-2), exactly as
   `FieldMapping` is the persisted form of a `kind = field` item
   ([data-model.md](../architecture/data-model.md) *Modeling notes*).

### Out of scope

- Selecting a target operation by matching `action` at sync time, and filling parameters at adapter
  request time — Phase 4/5.

### Dependencies

Blocked by AM-1, AM-2. Precedes AS-2, AS-4.

---

## AM-5 — `MappingApproved` event shape

**As the** shared kernel, **I** define the `MappingApproved` event over the existing domain-event
envelope, **so that** the Approval Service can announce an approval and the artifact-instantiation
consumer can react without either side importing the other.

### Acceptance criteria

1. **Given** the Phase-1 domain-event envelope (`id`, `type`, `occurredAt`), **when**
   `MappingApproved` is defined, **then** it extends the envelope with `type` narrowed to the literal
   `"MappingApproved"` and carries at least the `approvedMappingId` and the `variant` needed to route
   instantiation ([glossary.md](../glossary.md) `MappingApproved`; the same envelope pattern as
   `SpecIngested`).
2. **Given** a `MappingApproved` payload, **when** inspected, **then** it identifies the approved
   mapping by id (the consumer re-loads the full `ApprovedMapping` + children from persisted state, so
   the event stays re-derivable and small, matching the `SpecIngested` convention).
3. **Given** a `MappingApproved` payload, **when** inspected, **then** it contains **no** credential
   material and no reference that resolves to any (the CR-2 invariant, carried into Phase 3).
4. **Given** the event is emitted on both a first approval and a later incremental approval that
   updates the same `ApprovedMapping`, **when** defined, **then** the payload shape is identical for
   both — "created/updated" per [glossary.md](../glossary.md) `MappingApproved`; the consumer's
   idempotent upsert (AI-3) absorbs the difference.

### Out of scope

- Emitting the event — AS-6.
- Consuming it to instantiate artifacts — AI-1..AI-3.

### Dependencies

Blocked by AM-2. Precedes AS-6, AI-1.

---

## AM-6 — Disabled downstream-artifact shapes (`SyncRule`, `AdapterEndpoint`/`AdapterBinding`, `GraphEdge`)

**As the** shared kernel, **I** define the minimal shapes needed to instantiate the downstream
artifacts in a non-executing state, **so that** Phase 3 can create them disabled while their
execution-only fields are layered on in Phase 4/5.

### Acceptance criteria

1. **Given** a peer-peer outcome, **when** the `SyncRule` shape is defined, **then** it carries at
   least `id`, `approvedMappingId`, `resourcePairRef` (canonical direction-agnostic form), and `status`
   (`enabled` | `disabled`), sufficient to persist it **disabled**
   ([data-model.md](../architecture/data-model.md) `SyncRule`). Execution-only fields (`cursor`,
   `lastSnapshotRef`, `backfillMode`/`backfillStatus`, `pollOperationRef`, `deletePropagation`,
   `targetDriftCheck`, intervals) are **Phase 4** and out of scope of this shape.
2. **Given** a consumer-provider outcome, **when** the `AdapterEndpoint` and `AdapterBinding` shapes are
   defined, **then** `AdapterEndpoint` carries at least `id`, `consumerAppId`, `consumerOperationId`,
   and `status`; `AdapterBinding` carries at least `id`, `adapterEndpointId`, `backendAppId`,
   `backendOperationId`, `approvedMappingId`, `role`, and `status` (`active` | `proposed` | `disabled`)
   — sufficient to persist a freshly-attached binding as `proposed`
   ([data-model.md](../architecture/data-model.md) `AdapterEndpoint`, `AdapterBinding`).
   Composition-only fields (`aggregationStrategy` specifics, `postMergeFilters`/`Sorts`/`Pagination`,
   `executionOrder`, `dependsOnBindingId`, `chainInputs`, `cacheTtl`) are **Phase 5** and out of scope.
3. **Given** either outcome, **when** the `GraphEdge` shape is defined, **then** it carries `id`,
   `sourceNodeId`, `targetNodeId`, `type` (`sync` | `adapter-dependency`), `status`, and `metadata`
   (direction, last-activity) — sufficient to upsert the projection on approval
   ([data-model.md](../architecture/data-model.md) `GraphEdge`).
4. **Given** the mutual-exclusivity rule, **when** these shapes are used, **then** a single
   `ApprovedMapping` instantiates **either** `SyncRule`(s) **or** `AdapterBinding`(s), never both
   ([data-model.md](../architecture/data-model.md) *Modeling notes*: "mutually exclusive outcomes").

### Out of scope

- All execution/composition fields listed above — Phase 4 ([sync-engine.md](../architecture/sync-engine.md))
  and Phase 5 ([adapter-engine.md](../architecture/adapter-engine.md)).
- Enabling a `SyncRule`, composing/activating/serving an `AdapterEndpoint`, and rendering the graph —
  Phase 4/5/6.

### Dependencies

Blocked by AM-2. Precedes AI-1, AI-2.
