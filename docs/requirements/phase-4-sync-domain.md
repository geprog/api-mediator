# Phase 4 — Sync execution domain shapes

The **types** slice of Phase 4: the persisted execution state the Sync Engine reads and writes —
the `SyncRule` **execution fields** that extend its disabled Phase-3 shape, the new `RecordLink` and
`SyncFieldState` entities, and the per-record execution columns of `SyncEvent`/`AuditLog`. No behavior
lives here: this is the single-naming-authority (`@mediator/domain`) layer, matching how Phase 1/2/3
defined every glossary entity once as a Zod schema plus its inferred type before any slice consumed it.

**What already exists and must be *extended*, not re-specified.** Phase 3 shipped a **minimal, disabled**
`SyncRule` — [`downstream-artifacts.ts`](../../packages/domain/src/downstream-artifacts.ts) carries only
`id`, `approvedMappingId`, `resourcePairRef`, `status` (AM-6 criterion 1, which explicitly deferred every
execution field to Phase 4). Phase 3 also shipped `SyncEvent`/`AuditLog`
([`audit-log.ts`](../../packages/domain/src/audit-log.ts)) whose `type` enum already owns **all six** values
(`poll-run`/`backfill-run`/`sync-execution`/`adapter-request`/`mapping-decision`/`credential-access`), but
whose row shape holds only the `mapping-decision` fields — the per-record sync columns and the
success/failure/`skipped-*`/`conflict` status enum are deliberately Phase 4. Phase 4 **adds** `RecordLink`
and `SyncFieldState` (neither exists yet) and layers the execution fields onto the two shapes above.

**Actor:** system (shared kernel — types only, no I/O).

**Concept references (whole file):** [data-model.md](../architecture/data-model.md) `SyncRule`, `RecordLink`,
`SyncFieldState`, `SyncEvent / AuditLog`; [sync-engine.md](../architecture/sync-engine.md) *Identity
correlation: RecordLink*, *Conflict handling*, *Idempotency*, *What enablement seeds*;
[glossary.md](../glossary.md) `SyncRule`, `RecordLink`, `Tombstone`, `SyncFieldState`, `SyncEvent / AuditLog`,
`deletePropagation`, `Initial backfill`, `Idempotency key`.

> **Entity *fields* are authoritative; their Zod/TypeScript encoding is the implementation choice.** Where the
> concept models a distinction as a conditionally-meaningful or nullable field (`cursor` for delta only,
> `lastSyncedHash` absent on a divergent seed, `tombstoneReason` only on a tombstoned link), the domain may
> encode it as an optional field guarded by a refinement or as a discriminated union — the same latitude
> Phase 2/3 used. No new glossary term is coined here; every name below is verbatim from the data model.

---

## SD-1 — Extend `SyncRule` with its execution fields

**As the** shared kernel, **I** extend the disabled Phase-3 `SyncRule` shape with the execution fields the
Poller, backfill, and conflict pipeline need, **so that** an enabled rule has a persisted referent for its
cadence, poll operation, delete/drift policy, backfill mode/status, cursor, and snapshot.

### Acceptance criteria

1. **Given** the Phase-3 `SyncRule` (`id`, `approvedMappingId`, `resourcePairRef`, `status`), **when** it is
   extended, **then** it additionally carries `pollIntervalOverride` (optional), `pollOperationRef`,
   `deletePropagation`, `targetDriftCheck`, `backfillMode`, `backfillStatus`, `lastRunAt` (nullable),
   `lastEventAt` (nullable), `cursor` (nullable — delta polling only), and `lastSnapshotRef` (nullable)
   ([data-model.md](../architecture/data-model.md) `SyncRule`). The four Phase-3 fields are **reused
   unchanged** — no synonym is coined.
2. **Given** the delete/drift enums, **when** defined, **then** `deletePropagation` is exactly
   `ignore` | `propagate` (default `ignore`) and `targetDriftCheck` is exactly `none` | `read-before-write`
   (default `none`) ([data-model.md](../architecture/data-model.md) `SyncRule.deletePropagation`,
   `SyncRule.targetDriftCheck`).
3. **Given** the backfill enums, **when** defined, **then** `backfillMode` is exactly `link-only` | `push`
   and `backfillStatus` is exactly `pending` | `running` | `completed` | `skipped`
   ([data-model.md](../architecture/data-model.md) `SyncRule.backfillMode`, `backfillStatus`).
4. **Given** the rule has **no** separate `direction` field (the mapping it instantiates is one-directional),
   **when** the shape is defined, **then** none is added — direction is `sourceSpecId`'s app → `targetSpecId`'s
   app of the parent `ApprovedMapping` ([data-model.md](../architecture/data-model.md) `SyncRule`).
5. **Given** `cursor`, `lastSnapshotRef`, `lastRunAt`, `lastEventAt`, `backfillStatus`, **when** a rule is
   freshly instantiated by Phase-3 AI-1, **then** they are unset/`pending` and are only ever seeded at the
   transition to live polling (SD is types-only; the seeding *behavior* is BE-6) — a `disabled` rule carries
   no live execution state ([data-model.md](../architecture/data-model.md) `SyncRule`; AM-6 criterion 2).

### Out of scope

- Any seeding/advancing behavior of `cursor`/`lastSnapshotRef`/`lastRunAt` — the Poller (SP) and enablement
  (BE) own that.
- Re-validating `pollOperationRef` on a new spec version (a breaking change returning it to unconfirmed) —
  Phase 6 ([extensibility.md](../architecture/extensibility.md)); Phase 4 uses version-1 specs only.

### Dependencies

Blocked by Phase-3 AM-6 (the minimal shape it extends). Precedes SP-*, BE-*, CF-*.

---

## SD-2 — `RecordLink` entity

**As the** shared kernel, **I** define the `RecordLink` — the persisted pairing of one logical record's
native id in app A with its native id in app B — **so that** update routing, conflict detection, delete
propagation, and delete-echo detection all have the explicit id pairing they depend on.

### Acceptance criteria

1. **Given** the entity, **when** defined, **then** it carries `id`, `appAId`, `appANativeId`, `appBId`,
   `appBNativeId`, and `resourcePairRef` in the **canonical direction-agnostic form** (the two
   (spec lineage, resource) sides ordered by a stable key, never by mapping direction) — the same form as
   `SyncRule.resourcePairRef`, so both directions of a pair name the same link
   ([data-model.md](../architecture/data-model.md) `RecordLink`).
2. **Given** the entity, **when** defined, **then** `establishedBy` is exactly
   `create-propagation` | `identity-match` | `manual` ([data-model.md](../architecture/data-model.md)
   `RecordLink.establishedBy`).
3. **Given** the entity, **when** defined, **then** `status` is exactly `active` | `tombstoned` | `archived`
   and `tombstoneReason` is exactly `propagated-delete` | `observed-delete` — present only on a `tombstoned`
   link (a link is **tombstoned, never deleted**) ([data-model.md](../architecture/data-model.md)
   `RecordLink.status`, `tombstoneReason`; [glossary.md](../glossary.md) `Tombstone`).
4. **Given** the link retains the **establishing execution's pre-link ordering-queue key**, **when** defined,
   **then** the shape can hold that retained key (so OQ-4's link-keyed queue opens strictly as a continuation
   of the queue that created it); a `manual` link records the pair's identity-key value as that key, or — absent
   a confirmed identity key — carries a marker that the link-keyed queue opens only after both native-id-keyed
   queues drain ([data-model.md](../architecture/data-model.md) `RecordLink.establishedBy`;
   [sync-engine.md](../architecture/sync-engine.md) *Ordering and consistency*).
5. **Given** the entity, **when** defined, **then** it carries `createdAt` and `tombstonedAt` (nullable) and
   references its two apps by id only, carrying **no** credential material.

### Out of scope

- Establishing / tombstoning / archiving behavior — RL-* and (archival on deregistration) Phase 6.
- The queue keyed by it — OQ-*.

### Dependencies

None (new entity). Precedes SD-3 (keyed by it), RL-*, OQ-*, EP-*, CF-*.

---

## SD-3 — `SyncFieldState` entity

**As the** shared kernel, **I** define `SyncFieldState` — one row per mapped field **on one side** of a
linked record, in that side's own canonical representation — **so that** echo detection and conflict
detection compare incoming changes against durable per-side baselines that never cross a transform boundary.

### Acceptance criteria

1. **Given** the entity, **when** defined, **then** it carries `id`, `recordLinkId`, `side` (`A` | `B`), and
   `fieldPath` — keyed by the `RecordLink` plus a **side** plus a **field path**, deliberately **not** by
   field *pairing* and **not** by `SyncRule` ([data-model.md](../architecture/data-model.md)
   `SyncFieldState`; [sync-engine.md](../architecture/sync-engine.md) *Conflict handling*).
2. **Given** the entity, **when** defined, **then** it carries `lastSyncedHash` and `lastSyncedAt` — this
   field's last **reconciled** value in this side's canonical stored representation — both **absent** when the
   seeding pass found the sides divergent for this field's pairing (the first subsequent change is then a
   conflict by construction) ([data-model.md](../architecture/data-model.md) `SyncFieldState.lastSyncedHash`;
   [sync-engine.md](../architecture/sync-engine.md) *Initial backfill*).
3. **Given** the entity, **when** defined, **then** it carries `observedHash`, `observedAt`, and
   `observedChangeTimestamp` (nullable — absent when the side declares no `supportsChangeTimestamps` or its
   `changeTimestampRef` is unconfirmed) ([data-model.md](../architecture/data-model.md)
   `SyncFieldState.observedHash`, `observedChangeTimestamp`).
4. **Given** the entity, **when** defined, **then** it carries `lastWrittenByMappingId` (the direction that
   produced the last write, for audit) and `status` (`active` | `archived`)
   ([data-model.md](../architecture/data-model.md) `SyncFieldState.status`).
5. **Given** both directions of a bidirectional pair read and write the **same** per-side rows, **when** the
   shape is defined, **then** a row exists for every field that participates in *either* direction's mapping —
   as a transform's primary input, an additional `aggregate`/`expression` input, or an output — so echo and
   conflict detection stay well-defined for non-1:1 transforms
   ([data-model.md](../architecture/data-model.md) `SyncFieldState.side`, `fieldPath`).

### Out of scope

- Seeding baselines (BE), updating observed state (SP/OC), the echo comparison (EP), the drift check (CF).
- `archived`-on-succession/deregistration transitions — Phase 6 ([extensibility.md](../architecture/extensibility.md)).

### Dependencies

Blocked by SD-2 (keyed by `RecordLink`). Precedes EP-*, CF-*, BE-4/BE-5.

---

## SD-4 — Extend `SyncEvent`/`AuditLog` with per-record execution fields and the status enum

**As the** shared kernel, **I** extend the Phase-3 `SyncEvent`/`AuditLog` row with the per-record sync columns
and the execution `status` enum, **so that** every processed change — including one that stopped before any
outbound call — is recorded exactly once, and idempotency dedup / parked-event supersession / manual replay
can query by it.

### Acceptance criteria

1. **Given** the Phase-3 row (which already owns the six `type` values), **when** it is extended, **then** a
   `status` enum is added with exactly `success` | `failure` | `skipped-loop` | `skipped-policy` | `conflict`
   ([data-model.md](../architecture/data-model.md) `SyncEvent / AuditLog` `status`). No value is invented;
   `mapping-decision` rows leave it unset.
2. **Given** a per-record (`sync-execution`) row, **when** defined, **then** it can carry `relatedRuleId`,
   `recordLinkId`, `sourceNativeId`, `originAppId`, `idempotencyKey`, and `payloadHash` — exactly what
   idempotency's per-record lookback, parked-event supersession, and manual replay query by
   ([data-model.md](../architecture/data-model.md) `SyncEvent / AuditLog`).
3. **Given** a `sync-execution` row, **when** defined, **then** it is written **once per processed change
   whatever its outcome**, including executions that stopped before any outbound call (`skipped-loop`,
   `skipped-policy`) ([data-model.md](../architecture/data-model.md) `SyncEvent / AuditLog` `type`).
4. **Given** `skipped-policy`, **when** its meaning is encoded, **then** the shape can represent all four of
   its causes — a deletion under `deletePropagation = ignore`, a create with no approved `create` operation,
   an update on a create-only rule, and a change to a record whose link is tombstoned `observed-delete`
   ([data-model.md](../architecture/data-model.md) `SyncEvent / AuditLog` `status`).
5. **Given** every row, **when** defined, **then** it carries `traceId`/`spanId` (correlation to the OTel
   trace) and is **metadata-only** — never credential material or live payload values, only hashes/ids/status
   ([data-model.md](../architecture/data-model.md); [security.md](../architecture/security.md) *Audit logging*).

### Out of scope

- Computing the `idempotencyKey`/`payloadHash` (OC-2) and writing rows (every pipeline story).
- Deriving OTel metrics from these rows — the metrics are emitted separately (see the observability hooks
  referenced by each engine story); this is the durable business record only
  ([observability.md](../architecture/observability.md) *Relationship to the Audit/Event Log*).

### Dependencies

Blocked by Phase-3 `audit-log.ts` (the shape it extends), SD-2. Precedes OC-*, EP-*, CF-*, SP-*.
