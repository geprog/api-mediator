# Flow: Mapping Review & Approval

Nothing produced by the [Mapping Engine](../architecture/mapping-engine.md) takes effect until a human reviews and approves it. This flow turns a `MappingProposal` into an `ApprovedMapping`, which is what the [Sync Engine](../architecture/sync-engine.md) and [Adapter Engine](../architecture/adapter-engine.md) actually act on.

## Steps

1. The user opens the proposal list in the API/UI Layer, filtered by app pair.
2. The Approval Service returns `MappingProposalItem`s sorted by ascending confidence / descending ambiguity — items flagged `reviewRequired` (confidence below threshold) surface first.
3. The user reviews each item: accept as-is, edit it (change the `targetPath`, change the `transform`, pick a different option from `ambiguousAlternatives`), or reject it.
4. The user can approve a subset of items — undecided items remain `pending` and the proposal's status becomes `partially_approved` rather than requiring an all-or-nothing decision.
5. On the approve action, the Approval Service validates the edited paths against the target spec's IR, then assembles the accepted items into `FieldMapping`s under a new (or updated) `ApprovedMapping`.
6. The Approval Service emits `MappingApproved(ApprovedMapping)` on the Event Bus.
7. Depending on the spec-pair roles:
   - If both apps are `PROVIDER`-role peers, the Sync Engine instantiates a `SyncRule` — see [sync-webhook-push.md](sync-webhook-push.md) / [sync-polling-pull.md](sync-polling-pull.md).
   - If one side is a `CONSUMER` spec, the Adapter Engine instantiates an `AdapterEndpoint`/`AdapterBinding` — see [adapter-request-resolution.md](adapter-request-resolution.md).
8. The Graph Service updates the corresponding `GraphEdge` — see [graph-overview.md](graph-overview.md).

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
    U->>Appr: approve(selection)
    Appr->>Appr: validate edits against target IR; build ApprovedMapping + FieldMappings
    Appr-->>Bus: MappingApproved(ApprovedMapping)
    Bus->>Sync: instantiate SyncRule (if peer-peer)
    Bus->>Adapt: instantiate AdapterEndpoint/Binding (if consumer-provider)
    Bus->>Graph: upsert GraphEdge
```

## Notes

- This same review UI and approval action is reused for the small delta `MappingProposal`s produced when a registered app's spec changes additively (see [architecture/extensibility.md](../architecture/extensibility.md)) — the user experience for approving a delta proposal is identical to approving an initial one, just scoped to fewer items.
- Rejecting an item permanently marks it `rejected` on the `MappingProposalItem` — it will not be re-suggested by future incremental analyses of the same spec pair unless the underlying elements change.
