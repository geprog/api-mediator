# Flow: Mapping Review & Approval

Nothing produced by the [Mapping Engine](../architecture/mapping-engine.md) takes effect until a human reviews and approves it. This flow turns a `MappingProposal` into an `ApprovedMapping`, which is what the [Sync Engine](../architecture/sync-engine.md) and [Adapter Engine](../architecture/adapter-engine.md) actually act on.

## Steps

1. The user opens the proposal list in the API/UI Layer, filtered by app pair.
2. The Approval Service returns `MappingProposalItem`s sorted by ascending confidence / descending ambiguity — items flagged `reviewRequired` (confidence below threshold) surface first.
3. The user reviews each item: accept as-is, edit it (change the `targetPath`, change the `transform`, pick a different option from `ambiguousAlternatives`), or reject it.
4. The user can approve a subset of items — undecided items remain `pending` and the proposal's status becomes `partially_approved` rather than requiring an all-or-nothing decision.
5. On the approve action, the Approval Service validates the edited paths against the target spec's IR, then assembles the accepted items under a new (or updated) `ApprovedMapping`: `kind = field` items become `FieldMapping`s, `kind = operation` items become `OperationMapping`s — each classified with an `action` (create/read/update/delete) from the target operation's IR, correctable by the reviewer where the heuristic gets it wrong (see [architecture/data-model.md](../architecture/data-model.md)). Since a `MappingProposal` is always one-directional (`sourceSpecId → targetSpecId`), the resulting `ApprovedMapping` is always one-directional too — there is no separate "approve as bidirectional" action.
6. For a **peer-peer** proposal, the reviewer confirms the **identity key**: exactly one `FieldMapping` per mapped resource pair gets `isIdentityKey = true`, pre-selected from the LLM's `identityCandidate` suggestion but never auto-confirmed (see [architecture/mapping-engine.md](../architecture/mapping-engine.md)). Approval can complete without this confirmation, but the resulting `SyncRule` cannot be *enabled* until it exists — record correlation is impossible without it (see *Identity correlation* in [architecture/sync-engine.md](../architecture/sync-engine.md)).
7. If the reverse-direction `MappingProposal` for the same spec pair has *also* already been approved (recall peer-peer candidates are generated in both directions, see [architecture/mapping-engine.md](../architecture/mapping-engine.md)), the Approval Service links the two `ApprovedMapping`s via `counterpartMappingId`. Approving only one direction is a perfectly valid, common end state — it simply yields a one-way sync/adapter relationship; the counterpart link is opportunistic, not required.
8. The Approval Service emits `MappingApproved(ApprovedMapping)` on the Event Bus.
9. Depending on the spec-pair roles:
   - If both apps are `PROVIDER`-role peers, the Sync Engine instantiates a `SyncRule` for this one direction — created disabled until the identity key is confirmed (step 6) and its initial backfill has run or been explicitly skipped (see [architecture/sync-engine.md](../architecture/sync-engine.md)) — see [sync-webhook-push.md](sync-webhook-push.md) / [sync-polling-pull.md](sync-polling-pull.md). If a counterpart mapping exists (or is approved later), its own `SyncRule` is a separate instantiation — two one-way rules, not one bidirectional rule.
   - If one side is a `CONSUMER` spec, the Adapter Engine attaches bindings to the affected `AdapterEndpoint`s — activating single-binding endpoints immediately with safe defaults, flagging endpoints that now have multiple candidate bindings as `composition-required` for an explicit human composition decision — see [adapter-endpoint-composition.md](adapter-endpoint-composition.md).
10. The Graph Service updates the corresponding `GraphEdge` — see [graph-overview.md](graph-overview.md). Two counterpart `ApprovedMapping`s render as two directed edges (or a single bidirectional rendering at the UI's discretion) between the same pair of nodes.

## Sequence diagram

```mermaid
sequenceDiagram
    participant U as User
    participant Appr as Approval Service
    participant Bus as Event Bus
    participant Sync as Sync Engine
    participant Adapt as Adapter Engine
    participant Graph as Graph Service

    U->>Appr: view MappingProposal
    U->>Appr: edit/accept/reject individual items
    U->>Appr: confirm identity FieldMapping (peer-peer)
    U->>Appr: approve(selection)
    Appr->>Appr: validate edits against target IR; build one-way ApprovedMapping + FieldMappings + OperationMappings
    Appr->>Appr: link counterpartMappingId if reverse direction already approved
    Appr-->>Bus: MappingApproved(ApprovedMapping)
    Bus->>Sync: instantiate SyncRule, disabled until identity key + backfill (if peer-peer)
    Bus->>Adapt: attach binding(s): activate or flag composition-required (if consumer-provider)
    Bus->>Graph: upsert GraphEdge
```

## Notes

- This same review UI and approval action is reused for the small delta `MappingProposal`s produced when a registered app's spec changes additively (see [architecture/extensibility.md](../architecture/extensibility.md)) — the user experience for approving a delta proposal is identical to approving an initial one, just scoped to fewer items.
- Rejecting an item permanently marks it `rejected` on the `MappingProposalItem` — it will not be re-suggested by future incremental analyses of the same spec pair unless the underlying elements change.
