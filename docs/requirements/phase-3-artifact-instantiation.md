# Phase 3 — Disabled artifact instantiation (`MappingApproved` consumer)

The downstream reaction to approval: a `MappingApproved` consumer that instantiates the mapping's
executable artifacts in a **non-executing** state — `SyncRule`(s) **disabled** for a peer-peer mapping,
`AdapterEndpoint`/`AdapterBinding`(s) as **proposed** for a consumer-provider mapping — and upserts the
`GraphEdge` projection. This is the Phase-3 counterpart to Phase-2's detection-trigger: it replaces
nothing with a real reaction to a new event type, staying idempotent under at-least-once delivery.

The defining constraint versus detection: this consumer's work is **pure database** (create/upsert
rows from already-persisted `ApprovedMapping` content) — no LLM, no network — so, unlike the Phase-2
detection consumer, it may complete **inside** the event-bus dispatcher transaction rather than
offloading (see the event-bus-dispatcher-tx constraint the concept's outbox model implies).

**Actor:** system (Sync Engine / Adapter Engine / Graph Service, as `MappingApproved` consumers).

**Concept references (whole file):** [mapping-review-and-approval.md](../flows/mapping-review-and-approval.md)
steps 8-10; [data-model.md](../architecture/data-model.md) `SyncRule`, `AdapterEndpoint`,
`AdapterBinding`, `GraphEdge`, *Modeling notes* ("mutually exclusive outcomes"); [glossary.md](../glossary.md)
`MappingApproved`, `SyncRule`, `AdapterBinding`, `GraphEdge`, `Event Bus`; [overview.md](../architecture/overview.md)
*Components* (at-least-once, idempotent consumers, reconciliation sweep). Builds on Phase-1
[phase-1-event-bus.md](phase-1-event-bus.md) (EB-1/EB-2) and mirrors Phase-2
[phase-2-detection-trigger.md](phase-2-detection-trigger.md) (DT-2).

> **Plan-vs-concept reconciliation (surfaced, not silently folded):** the flow (step 9) says a
> single-binding `AdapterEndpoint` "activates immediately with safe defaults." In Phase 3 there is **no
> Adapter Server Runtime** (that is Phase 5), so "activate" cannot mean "serve." Phase 3 therefore
> persists the binding as `proposed` and the endpoint without activating or serving it; single-binding
> auto-activation, composition, and serving are **Phase 5**. This honors the plan's "Phase 3 only
> instantiates disabled artifacts / nothing is enabled" while staying faithful to the concept's status
> vocabulary (`proposed` = "attached by a mapping approval but not yet composed"). See the README open
> question.

---

## AI-1 — Peer-peer: instantiate one disabled `SyncRule` per mapped resource pair, upsert the `GraphEdge`

**As the** Sync Engine, **I** react to a peer-peer `MappingApproved` by creating one **disabled**
`SyncRule` per mapped resource pair and upserting the sync `GraphEdge`, **so that** the operator has
concrete, enable-able rules while nothing polls or writes yet.

### Acceptance criteria

1. **Given** a `MappingApproved` for a **peer-peer** `ApprovedMapping` covering N mapped resource pairs,
   **when** the consumer runs, **then** it creates **N** `SyncRule`s — one per mapped resource pair —
   each with `status = disabled` ([flow](../flows/mapping-review-and-approval.md) step 9: "each created
   disabled"; [data-model.md](../architecture/data-model.md) `SyncRule`).
2. **Given** a created `SyncRule`, **when** inspected, **then** it references its `approvedMappingId` and
   its `resourcePairRef` in the canonical direction-agnostic form, and carries **no** live execution
   state (no seeded `cursor`, no `lastSnapshotRef`, backfill not started) — instantiation seeds nothing,
   enablement (Phase 4) does.
3. **Given** the approval, **when** the consumer completes, **then** it upserts a `GraphEdge` with
   `type = sync` for the mapping's `(sourceAppId → targetAppId)` direction, reflecting the
   not-yet-executing state in `status`/`metadata`
   ([flow](../flows/mapping-review-and-approval.md) step 10; [data-model.md](../architecture/data-model.md)
   `GraphEdge`).
4. **Given** a counterpart mapping was linked (AS-6), **when** its own `MappingApproved` is later
   consumed, **then** it instantiates its **own** separate `SyncRule`s — two one-way rules per resource
   pair, never one bidirectional rule ([flow](../flows/mapping-review-and-approval.md) step 9).
5. **Given** instantiation, **when** it runs, **then** **no** outbound call to any registered app is
   made and no polling starts — the core "nothing executes before enable" invariant (AS-6) is
   preserved through the reaction, not just the approval.

### Out of scope

- Enabling a `SyncRule`, the enablement gate (identity key, `pollOperationRef`, `ResourceBinding` refs),
  and the initial backfill — Phase 4 ([sync-engine.md](../architecture/sync-engine.md)).
- Rendering the graph from `GraphEdge`s — Phase 6 ([graph-overview.md](../flows/graph-overview.md)).

### Dependencies

Blocked by AM-6, AM-5, AS-6, Phase-1 EB-2. Realized alongside AI-3.

---

## AI-2 — Consumer-provider: instantiate the `AdapterEndpoint` and `proposed` `AdapterBinding`(s), upsert the `GraphEdge`

**As the** Adapter Engine, **I** react to a consumer-provider `MappingApproved` by ensuring the
consumer operation's `AdapterEndpoint` exists and attaching its `AdapterBinding`(s) as **proposed**,
**so that** the binding is recorded without being composed, activated, or served.

### Acceptance criteria

1. **Given** a `MappingApproved` for a **consumer-provider** `ApprovedMapping`, **when** the consumer
   runs, **then** for each covered consumer operation it ensures an `AdapterEndpoint`
   (`consumerAppId`, `consumerOperationId`) exists — created if this is the first mapping covering that
   operation, reused (never duplicated) otherwise ([data-model.md](../architecture/data-model.md)
   `AdapterEndpoint`; [flow](../flows/mapping-review-and-approval.md) step 9).
2. **Given** the endpoint, **when** bindings are attached, **then** each `AdapterBinding` is created with
   `status = proposed` and references its `backendAppId`, a `backendOperationId` chosen from the
   `ApprovedMapping`'s `OperationMapping`s (not free-form), and its `approvedMappingId`
   ([data-model.md](../architecture/data-model.md) `AdapterBinding`).
3. **Given** the endpoint now has a binding, **when** the consumer completes, **then** it upserts a
   `GraphEdge` with `type = adapter-dependency` for the `(consumerAppId → backendAppId)` relationship
   ([flow](../flows/mapping-review-and-approval.md) step 10).
4. **Given** the plan-vs-concept reconciliation in this file's header, **when** a single-binding
   endpoint is instantiated, **then** it is **not** activated or served in Phase 3 — no
   `aggregationStrategy` is composed, no runtime hosts it, and its `status` reflects that composition
   and serving are deferred to Phase 5.
5. **Given** the mutual-exclusivity rule, **when** a consumer-provider mapping is instantiated, **then**
   it creates **only** `AdapterEndpoint`/`AdapterBinding` rows and **no** `SyncRule`
   ([data-model.md](../architecture/data-model.md) *Modeling notes*).

### Out of scope

- Endpoint composition, single-binding auto-activation, `composition-required` flagging, aggregation
  strategy/roles/order/chaining, and any request serving — Phase 5
  ([adapter-engine.md](../architecture/adapter-engine.md); [adapter-endpoint-composition.md](../flows/adapter-endpoint-composition.md)).
- Adapter token issuance / Auth Gateway — Phase 5 ([security.md](../architecture/security.md)).

### Dependencies

Blocked by AM-6, AM-5, AS-6, Phase-1 EB-2. Realized alongside AI-3.

---

## AI-3 — Idempotent, transactional, reconcilable instantiation

**As an** operator, **I** rely on artifact instantiation neither double-creating rows on redelivery nor
duplicating them when an approval is updated, **so that** "bus loss degrades timeliness, never
correctness" holds for the approval reaction just as it did for detection.

### Acceptance criteria

1. **Given** the **same** `MappingApproved` (same event id) delivered twice (at-least-once), **when**
   the consumer handles the redelivery, **then** the committed side effect — the set of
   `SyncRule`s / `AdapterBinding`s / the `GraphEdge` — is produced **once**, not duplicated (idempotent
   consumption, per Phase-1 EB-2).
2. **Given** an incremental approval that **updates** an existing `ApprovedMapping` (AS-2 criterion 4)
   and emits `MappingApproved` again, **when** the consumer runs, **then** it **upserts** — adding a
   `SyncRule`/`AdapterBinding` for a newly-covered resource pair/operation while leaving the existing
   disabled/proposed artifacts (and any operator state on them) untouched — never re-creating or
   resetting an already-instantiated artifact.
3. **Given** the consumer's work is pure database (no LLM/network), **when** it runs, **then** it may
   complete **within** the event-bus dispatcher transaction — the offload-outside-the-dispatcher
   constraint that detection needed (Phase-2 DT-2) does **not** apply here, and the whole instantiation
   commits atomically with the dispatch/ack.
4. **Given** an `ApprovedMapping` that ended up with **no** instantiated artifacts (e.g. the reaction was
   lost), **when** the reconciliation sweep runs, **then** it detects the missing instantiation and
   re-triggers it — the reaction is re-derivable from the persisted `ApprovedMapping`, matching the
   concept's reconciliation model ([overview.md](../architecture/overview.md) *Components*).
5. **Given** instantiation, **when** it commits, **then** it holds no long-running work open (unlike
   detection's ~1,000-call analysis): a single approval instantiates a bounded, small set of rows.

### Out of scope

- The broader reconciliation sweep beyond this reaction (missing enablement/backfill/serving) — Phase
  4/5/6.
- Ordering/partitioned delivery of `MappingApproved` — not required (each event is independently
  processable).

### Dependencies

Blocked by AI-1, AI-2, Phase-1 EB-2.
