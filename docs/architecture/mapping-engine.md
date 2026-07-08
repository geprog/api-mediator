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

This enumerates the *spec* pairs. Which *resource* pairs within a spec pair get a full analysis is decided by the stage-1 shortlist below — computed once per unordered spec pair and shared by both directional analyses.

## Matching approach: two-stage — shortlist, then detail

The "~15-20 apps" scale assumption (see [overview.md](overview.md)) bounds the number of *apps*, but the naive cost driver would be the number of candidate **resource** pairs — the full cross-product of resource groups on each side. At the assumed scale (20 apps × ~10 resource groups each) that cross-product is ~38,000 detail analyses for a full landscape pass — and the overwhelming majority are obviously unrelated pairs (an `Invoices` resource vs. a `TicketComments` resource) that don't need a full operation/field analysis to dismiss. The engine therefore matches in two stages, using the same LLM for both rather than introducing a separate embedding/keyword pre-filter component (and its similarity-threshold tuning knob):

### Stage 1 — shortlist pass (one call per spec pair)

One call per **unordered** spec pair, containing only resource-level *summaries* of both specs — resource name, description, operation summaries, top-level field list; the same lightweight summary form the decomposition above already produces for cross-resource references. The LLM returns a `ResourceShortlist` (see the structured formats below): the resource pairs that plausibly correspond, each with confidence and rationale. Resource *correspondence* is direction-agnostic — whether `Customers` ↔ `Contacts` correspond doesn't depend on sync direction; only the transforms do, and those belong to stage 2 — so one shortlist is computed per unordered pair and reused by both directional detail analyses.

The shortlist prompt is deliberately **recall-biased**: when in doubt, include the pair. A false positive costs one wasted detail call; a false negative means a real mapping is never proposed at all — the one failure mode this design adds over exhaustive matching. The second mitigation for that failure mode is the manual escape hatch below.

### Stage 2 — detail pass (one call per shortlisted resource pair)

For each **shortlisted** resource pair, the engine builds a prompt containing both resources' full operations and schemas and asks the LLM to produce operation- and field-level correspondences — the `MappingSuggestionSet` below, with validation, corrective retries, and per-pair failure marking. This stage is exactly what a single-stage design would run; the shortlist only decides *which* pairs reach it.

### What this costs, honestly

At the assumed scale (20 apps × 10 resource groups, all peers): ~190 shortlist calls (unordered spec pairs) plus a detail call per genuinely-corresponding resource pair per direction — typically a handful per spec pair, ~760 landscape-wide — for a total of roughly **1,000 LLM calls**, versus ~38,000 for the exhaustive cross-product. Registering one new app costs ~19 shortlist + ~80 detail calls instead of ~3,800. Token volume drops similarly: full resource content is sent only for plausible pairs, instead of every resource being re-sent once per counterpart resource (~10× duplication at this scale); summaries are sent once per spec pair.

The shortlist also bounds the *human* cost, which exhaustive matching would quietly make quadratic: reviewers see proposal items only for plausible resource pairs, not for the whole cross-product.

### Escape hatch: the shortlist is reviewable, not silent

The persisted stage-1 result (`MappingProposal.shortlistResult`, see [data-model.md](data-model.md)) includes the resources for which **no** counterpart was shortlisted, and the review UI surfaces them the same way `unmapped` items are surfaced (see [flows/mapping-review-and-approval.md](../flows/mapping-review-and-approval.md)). A reviewer can trigger a detail analysis for any resource pair manually — the correction path when the recall-biased shortlist still misses a real correspondence. How often this is needed is the design's key health signal (see [observability.md](observability.md)): frequent manual additions mean stage-1 recall is too low.

## Structured proposal formats

The Mapping Engine requests (and validates) a fixed structured output from the LLM at each stage.

Stage 1 returns a `ResourceShortlist`:

```
ResourceShortlist {
  candidatePairs: [
    { sourceResource, targetResource, confidence, rationale }
  ]
}
```

Stage 2 returns a `MappingSuggestionSet` per shortlisted resource pair:

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
      identityCandidate: bool,
      confidence, rationale,
      ambiguousAlternatives: [{ targetField, confidence }],
      unmapped: bool
    }
  ]
}
```

`ambiguousAlternatives` and `unmapped` are structurally identical on both `operationMappings` and `fieldMappings` — an operation can have more than one plausible match (e.g. two similarly-named endpoints) exactly as a field can, so the schema doesn't special-case operations to a narrower shape. Both map onto the single `MappingProposalItem` entity regardless of `kind` (see [data-model.md](data-model.md)).

For **peer-peer** pairs, the provider is additionally asked to flag at most one field pairing per resource pair as `identityCandidate: true` — the business-level key (email, SKU, order number, …) whose values are expected to identify the *same record* in both apps. This is a suggestion only: it pre-selects the identity choice in the review UI, but `FieldMapping.isIdentityKey` is set exclusively by explicit reviewer confirmation (see [flows/mapping-review-and-approval.md](../flows/mapping-review-and-approval.md)), because a wrong identity key makes the Sync Engine silently merge unrelated records — the worst failure mode it has (see *Identity correlation* in [sync-engine.md](sync-engine.md)). Consumer-provider pairs skip this: the adapter never correlates records across apps.

Both stages' outputs are validated against fixed JSON schemas before anything is persisted (the shortlist as `MappingProposal.shortlistResult`, suggestions as `MappingProposalItem`s — see [data-model.md](data-model.md)). Malformed output triggers a corrective retry (re-prompting with the validation error) — the core mapping logic never trusts free-text LLM output directly; only validated structured output is persisted. Retries are capped (e.g. 3 attempts per call); at the ceiling, the two stages fail with very different blast radii: a failed **detail** call marks that one resource pair's analysis `failed`, while a failed **shortlist** call leaves the *entire spec pair* unanalyzed — alerted more urgently for exactly that reason (see [observability.md](observability.md)). Either failure is surfaced in the review UI as needing attention rather than silently consuming LLM budget in a retry loop.

## Confidence & ambiguity

- `confidenceScore` (0–1) on every item.
- `ambiguousAlternatives[]` populated when multiple targets are plausible — surfaced in the review UI as a choice, not a silent best-guess.
- `unmapped: true` for source fields with no found counterpart — surfaced as "needs manual mapping or is intentionally unmapped."
- A configurable threshold (e.g. `< 0.7`) sets `reviewRequired = true` on an item, which drives the default sort order in the review UI (see [flows/mapping-review-and-approval.md](../flows/mapping-review-and-approval.md)) — lowest-confidence and flagged items surface first.

## Pluggable LLM provider interface

```
interface LLMMappingProvider {
  shortlistResourcePairs(context: ShortlistPromptContext): ResourceShortlist   // stage 1
  generateMappingProposal(context: MappingPromptContext): MappingSuggestionSet // stage 2
}

ShortlistPromptContext = {
  sourceSpecSummaryIR, targetSpecSummaryIR,   // resource-level summaries only
  promptVersion
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
2. **Additive** changes (new operation, new field): the Mapping Engine runs an incremental analysis scoped only to the new elements, producing a small delta `MappingProposal` for review. The staging follows the granularity of the change: a new *resource group* gets one scoped shortlist call (its summary vs. the counterpart spec's summaries) followed by detail calls for any shortlisted pairs; a new field or operation inside an already-shortlisted resource skips stage 1 entirely and goes straight to a scoped detail call. Existing `ApprovedMapping`s are untouched and stay active.
3. **Breaking** changes (removed/renamed/retyped field or operation): only the `ApprovedMapping`/`SyncRule`/`AdapterBinding` records that reference the changed elements are marked `stale` and paused — a delta-review model. Everything else for that app (mappings unaffected by the change) keeps running uninterrupted. See [extensibility.md](extensibility.md) for the full lifecycle.

## Observability hooks

Every LLM call (latency, success/failure, token usage — labeled by stage, shortlist vs. detail), the shortlist yield (candidate pairs per spec pair), escape-hatch usage (manually triggered detail analyses), and every proposal's confidence distribution are emitted as OpenTelemetry metrics/traces — see [observability.md](observability.md) for the specific signals and the Grafana dashboard built on top of them.
