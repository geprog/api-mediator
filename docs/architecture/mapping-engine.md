# Mapping Engine

The Mapping Engine is the AI core of the mediator: given a pair of OpenAPI specs, it proposes how their resources, operations, and fields correspond to each other. It is used identically for both product capabilities — the only difference is which spec pairs get analyzed:

- **Peer-peer** (`PROVIDER` ↔ `PROVIDER`): candidates for [data sync](sync-engine.md).
- **Consumer-provider** (`CONSUMER` ↔ `PROVIDER`): candidates for the [live adapter](adapter-engine.md).

## Spec decomposition

1. Resolve all `$ref`s in the OpenAPI document.
2. Group into resource-level IR units, by `tags` or path-prefix heuristic. Each unit contains:
   - its operations: method, path, summary/description, parameters, request schema, response schema, `operationId`
   - the flattened component schemas it references: field name, type, description, required-ness
3. Cross-resource references are included only as lightweight summaries (schema name + top-level field list), not fully expanded, to bound the size of what gets sent to the LLM.

This decomposition is what both the Mapping Engine and the Spec Registry's IR (see [data-model.md](data-model.md)) share — the IR is not mapping-specific, it is the normalized form the whole system reasons over.

## Candidate pair selection

- Every `PROVIDER` spec vs. every other active `PROVIDER` spec, both directions — i.e. an A↔B peer pair produces **two** separate candidate analyses (A→B and B→A), each its own `MappingProposal`. Approving both independently is what yields a bidirectional sync pair (see [data-model.md](data-model.md)); there is no single "bidirectional" analysis run.
- Every `CONSUMER` spec vs. every active `PROVIDER` spec (direction: consumer needs ← provider offers).

## Matching approach: direct LLM reasoning, no pre-filter stage

The "~15-20 apps" scale assumption (see [overview.md](overview.md)) bounds the number of *apps*, not the number of LLM calls directly — the actual cost driver is the number of candidate **resource** pairs, i.e. apps × resource-groups-per-app on each side. The no-pre-filter simplicity choice below is valid at the assumed scale only as long as per-app resource counts stay modest (low tens); a landscape of 15-20 apps that each expose hundreds of resource groups would blow past the assumption's intent even though the app count is unchanged. This resource-count dimension should be tracked alongside app count when deciding whether the assumption still holds.

Given that assumption, the number of candidate resource pairs stays small enough that the engine calls the LLM once per candidate resource pair directly — there is no embedding/keyword pre-filter stage shortlisting pairs before the LLM runs. This is a deliberate simplicity choice: it removes an entire component (and a similarity-threshold tuning knob) at a scale where LLM cost/latency is not a concern. If the landscape grows well beyond this scale — in app count or in per-app resource count — a pre-filter stage should be reconsidered.

For each candidate resource pair, the Mapping Engine builds a prompt containing both resources' operations and schemas and asks the LLM to produce operation- and field-level correspondences.

## Structured proposal format

The Mapping Engine requests (and validates) a fixed structured output from the LLM:

```
MappingSuggestionSet {
  operationMappings: [
    {
      sourceOperationId, targetOperationId,
      confidence, rationale,
      ambiguousAlternatives: [{ targetOperationId, confidence }],
      unmapped: bool
    }
  ],
  fieldMappings: [
    {
      sourceField, targetField,
      transform: "rename" | "coerce" | "aggregate" | "expression",
      transformDetail,
      confidence, rationale,
      ambiguousAlternatives: [{ targetField, confidence }],
      unmapped: bool
    }
  ]
}
```

`ambiguousAlternatives` and `unmapped` are structurally identical on both `operationMappings` and `fieldMappings` — an operation can have more than one plausible match (e.g. two similarly-named endpoints) exactly as a field can, so the schema doesn't special-case operations to a narrower shape. Both map onto the single `MappingProposalItem` entity regardless of `kind` (see [data-model.md](data-model.md)).

This is validated against a fixed JSON schema before being persisted as a `MappingProposal` + `MappingProposalItem`s (see [data-model.md](data-model.md)). Malformed output triggers a corrective retry (re-prompting with the validation error) — the core mapping logic never trusts free-text LLM output directly; only validated structured output becomes a `MappingProposalItem`. Retries are capped (e.g. 3 attempts per candidate pair); if the provider still can't produce valid output, that pair's analysis is marked `failed` rather than retried indefinitely, is surfaced in the review UI as needing attention, and emits a dedicated failure metric (see [observability.md](observability.md)) rather than silently consuming LLM budget in a retry loop.

## Confidence & ambiguity

- `confidenceScore` (0–1) on every item.
- `ambiguousAlternatives[]` populated when multiple targets are plausible — surfaced in the review UI as a choice, not a silent best-guess.
- `unmapped: true` for source fields with no found counterpart — surfaced as "needs manual mapping or is intentionally unmapped."
- A configurable threshold (e.g. `< 0.7`) sets `reviewRequired = true` on an item, which drives the default sort order in the review UI (see [flows/mapping-review-and-approval.md](../flows/mapping-review-and-approval.md)) — lowest-confidence and flagged items surface first.

## Pluggable LLM provider interface

```
interface LLMMappingProvider {
  generateMappingProposal(context: MappingPromptContext): MappingSuggestionSet
}

MappingPromptContext = {
  sourceResourceIR, targetResourceIR,
  promptVersion,
  priorFeedback?   // optional: previously-edited mappings for this app pair, to inform future proposals
}
```

- The Mapping Engine core depends only on this interface plus a response-schema validator. It owns prompt templating, retry, and repair logic itself, so behavior is consistent regardless of which model backs it.
- The interface is intentionally provider-agnostic: illustrative implementations include a wrapper around a hosted large-model API, a wrapper around a self-hosted open-weight model, or a rules/embeddings-only fallback provider for offline operation. None of these are hardcoded into the core — the active provider is a swappable configuration.
- Every `MappingProposal` records `generatedBy: { providerId, model, promptVersion }` so proposals are reproducible and comparable across provider/prompt changes.

## Re-mapping on spec change

1. A new `ApiSpec` version is ingested by the Spec Registry, which diffs old vs. new IR and produces a `SpecDiff`, classifying each change as additive or breaking.
2. **Additive** changes (new operation, new field): the Mapping Engine runs an incremental analysis scoped only to the new elements, producing a small delta `MappingProposal` for review. Existing `ApprovedMapping`s are untouched and stay active.
3. **Breaking** changes (removed/renamed/retyped field or operation): only the `ApprovedMapping`/`SyncRule`/`AdapterBinding` records that reference the changed elements are marked `stale` and paused — a delta-review model. Everything else for that app (mappings unaffected by the change) keeps running uninterrupted. See [extensibility.md](extensibility.md) for the full lifecycle.

## Observability hooks

Every LLM call (latency, success/failure, token usage) and every proposal's confidence distribution is emitted as OpenTelemetry metrics/traces — see [observability.md](observability.md) for the specific signals and the Grafana dashboard built on top of them.
