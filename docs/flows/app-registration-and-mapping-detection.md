# Flow: App Registration → Ingestion → Mapping Detection

This is the entry point for everything else in the system: an app cannot be synced or served until it has been registered and its spec analyzed against the rest of the landscape. See [architecture/overview.md](../architecture/overview.md) for the components involved and [architecture/mapping-engine.md](../architecture/mapping-engine.md) for the detection details.

## Steps

1. The user submits an app registration through the API/UI Layer: a name, a `baseUrl` (optional if this is a consumer-only registration), credential material, and one or more OpenAPI documents, each tagged with a role (`PROVIDER` and/or `CONSUMER`).
2. The API/UI Layer creates a `RegisteredApp`, stores the `Credential` (encrypted via the Credential Store), and hands each spec document to the Spec Registry.
3. The Spec Registry parses the document, resolves all `$ref`s, builds the IR (resource groups → operations → schemas), stores it as `ApiSpec` version 1, and emits a `SpecIngested` event on the Event Bus.
4. A mapping orchestrator (part of the Mapping Engine) picks up `SpecIngested` and decides which spec pairs to analyze:
   - Every `PROVIDER` spec vs. every other active `PROVIDER` spec, both directions — sync candidates.
   - Every `CONSUMER` spec vs. every *other* app's active `PROVIDER` spec — adapter candidates; one analysis per pair with the consumer as source, covering both request and response phases (see [architecture/mapping-engine.md](../architecture/mapping-engine.md)).
5. For each candidate spec pair, the Mapping Engine decomposes both specs into resource-level IR and runs the two-stage detection (see [architecture/mapping-engine.md](../architecture/mapping-engine.md)): one `shortlistResourcePairs` call per unordered spec pair over resource *summaries* shortlists the plausibly-corresponding resource pairs, then one `generateMappingProposal` detail call runs per shortlisted resource pair.
6. The Mapping Engine validates each stage's structured output and persists the result as a `MappingProposal` (including its `shortlistResult`) with its `MappingProposalItem`s (operation- and field-level candidates, each with a confidence score and rationale).
7. The API/UI Layer is notified that new proposals are ready for review — handed off to [mapping-review-and-approval.md](mapping-review-and-approval.md).

## Sequence diagram

```mermaid
sequenceDiagram
    participant U as User
    participant API as API/UI Layer
    participant Reg as Spec Registry
    participant Bus as Event Bus
    participant ME as Mapping Engine
    participant LLM as LLM Provider

    U->>API: Register app (spec, baseUrl, credentials, role)
    API->>Reg: registerApp(...)
    Reg->>Reg: parse + build IR, store ApiSpec v1
    Reg-->>Bus: SpecIngested(specId)
    Bus->>ME: trigger mapping detection
    ME->>Reg: fetch candidate spec pairs (IR)
    ME->>LLM: shortlistResourcePairs(summaries) [per unordered spec pair]
    LLM-->>ME: ResourceShortlist
    ME->>LLM: generateMappingProposal(promptContext) [per shortlisted resource pair]
    LLM-->>ME: MappingSuggestionSet
    ME->>ME: validate + persist MappingProposal (incl. shortlistResult) + items
    ME-->>API: notify "proposals ready"
```

## Notes

- Resources for which stage 1 shortlisted no counterpart are surfaced in the review UI with a manual "analyze this resource pair anyway" action — the escape hatch for a shortlist miss (see [mapping-review-and-approval.md](mapping-review-and-approval.md) and [architecture/mapping-engine.md](../architecture/mapping-engine.md)).
- Registering a consumer-only app (a `CONSUMER` spec with no `baseUrl`) triggers the same flow — the resulting `MappingProposal`s are what later become `AdapterBinding`s once approved (see [architecture/adapter-engine.md](../architecture/adapter-engine.md)).
- This same flow (steps 3–6) runs again, scoped to just the new elements, whenever an already-registered app's spec is updated — see [architecture/extensibility.md](../architecture/extensibility.md).
