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
- Every `CONSUMER` spec vs. every *other* app's active `PROVIDER` spec — **one analysis per pair**, always with the consumer spec as `sourceSpec` and the provider spec as `targetSpec`. There is no reverse-direction analysis: the mediator hosts the consumer's wished-for API as a *virtual provider* and never calls the consumer itself (see [adapter-engine.md](adapter-engine.md)). What would otherwise need a second direction is covered *inside* the single proposal by the request/response **phases** of its field suggestions (see the structured formats below). An app's `CONSUMER` spec is never paired with the same app's own `PROVIDER` spec — serving an app's wishes from itself would be a no-op; the two roles are registered and analyzed independently.

This enumerates the *spec* pairs. Which *resource* pairs within a spec pair get a full analysis is decided by the stage-1 shortlist below — computed once per unordered spec pair and shared by both directional analyses — over the resources **in analysis scope**: resource groups the operator has excluded (`ApiSpec.analysisExclusions`, see *Scoping down* below) are removed from both sides before stage 1 ever sees them.

## Matching approach: two-stage — shortlist, then detail

The "~15-20 apps" scale assumption (see [overview.md](overview.md)) bounds the number of *apps*, but the naive cost driver would be the number of candidate **resource** pairs — the full cross-product of resource groups on each side. At the assumed scale (20 apps × ~10 resource groups each) that cross-product is ~38,000 detail analyses for a full landscape pass — and the overwhelming majority are obviously unrelated pairs (an `Invoices` resource vs. a `TicketComments` resource) that don't need a full operation/field analysis to dismiss. The engine therefore matches in two stages, using the same LLM for both rather than introducing a separate embedding/keyword pre-filter component (and its similarity-threshold tuning knob):

### Stage 1 — shortlist pass (one call per spec pair)

One call per **unordered** spec pair, containing only resource-level *summaries* of both specs' in-scope resources (see *Scoping down* below) — resource name, description, operation summaries, top-level field list; the same lightweight summary form the decomposition above already produces for cross-resource references. The LLM returns a `ResourceShortlist` (see the structured formats below): the resource pairs that plausibly correspond, each with confidence and rationale. Resource *correspondence* is direction-agnostic — whether `Customers` ↔ `Contacts` correspond doesn't depend on sync direction; only the transforms do, and those belong to stage 2 — so one shortlist is computed per unordered pair and reused by both directional detail analyses.

The shortlist prompt is deliberately **recall-biased**: when in doubt, include the pair. A false positive costs one wasted detail call; a false negative means a real mapping is never proposed at all — the one failure mode this design adds over exhaustive matching. The second mitigation for that failure mode is the manual escape hatch below.

### Stage 2 — detail pass (one call per shortlisted resource pair)

For each **shortlisted** resource pair, the engine builds a prompt containing both resources' full operations and schemas and asks the LLM to produce operation- and field-level correspondences — the `MappingSuggestionSet` below, with validation, corrective retries, and per-pair failure marking. This stage is exactly what a single-stage design would run; the shortlist only decides *which* pairs reach it.

### What this costs, honestly

At the assumed scale (20 apps × 10 resource groups, all peers): ~190 shortlist calls (unordered spec pairs) plus a detail call per *shortlisted* resource pair per direction — a recall-biased superset of the genuine correspondences, each false positive costing one wasted detail call (the accepted price of recall bias); assuming the shortlist stays near the genuine handful per spec pair, ~760 landscape-wide — for a total of roughly **1,000 LLM calls**, versus ~38,000 for the exhaustive cross-product. Registering one new app costs ~19 shortlist + ~80 detail calls instead of ~3,800. Token volume drops similarly: full resource content is sent only for plausible pairs, instead of every resource being re-sent once per counterpart resource (~10× duplication at this scale); summaries are sent once per spec pair.

The shortlist also bounds the *human* cost, which exhaustive matching would quietly make quadratic: reviewers see proposal items only for plausible resource pairs, not for the whole cross-product.

### Escape hatch: the shortlist is reviewable, not silent

The persisted stage-1 result (`MappingProposal.shortlistResult`, see [data-model.md](data-model.md)) includes the resources for which **no** counterpart was shortlisted, and the review UI surfaces them the same way `unmapped` items are surfaced (see [flows/mapping-review-and-approval.md](../flows/mapping-review-and-approval.md)). A reviewer can trigger a detail analysis for any resource pair manually — the correction path when the recall-biased shortlist still misses a real correspondence. How often this is needed is the design's key health signal (see [observability.md](observability.md)): frequent manual additions mean stage-1 recall is too low.

### Scoping down: operator exclusions

The shortlist protects **recall** among the resource pairs the engine considers; exclusions apply operator knowledge on the **precision and cost** side. At registration or any time after, an operator can exclude resource groups of a spec from mapping analysis (`ApiSpec.analysisExclusions`, see [data-model.md](data-model.md)). The case this serves is a large spec of which the landscape uses a fraction: a public API document with dozens of resource groups where the operator already knows only two participate. The recall-biased shortlist would still dutifully consider every group — growing the summary prompt, occasionally shortlisting plausible-but-unwanted pairs, and turning each of those into detail calls and review items. Exclusion removes those resources before stage 1 ever sees them, on whichever side of a spec pair they appear, cutting summary-prompt size, detail-call volume, and review noise below what the shortlist alone can achieve — it is also the first, zero-machinery mitigation for the "very large per-spec resource counts" revisit-trigger in [overview.md](overview.md).

The semantics are deliberately narrow — exclusions govern **analysis only**:

- An excluded resource is omitted from shortlist prompts and never reaches a detail call, including the scoped incremental analyses on spec change below — an *additive* change inside an excluded resource triggers nothing. A resource group newly added by a spec version is in scope by default: exclusions are explicit refs, never inherited by new elements. Like `ResourceBinding`s, exclusions are carried forward when a new spec version is ingested; a ref that no longer resolves is dropped.
- Existing `MappingProposal`s and `ApprovedMapping`s over an excluded resource are untouched: exclusion stops *proposing* anything new, it never pauses or removes what a human already approved — suspending a mapping is a separate, explicit action.
- **Re-inclusion is the correction path, and it is not silent either**: removing an exclusion triggers the same scoped incremental analysis as an additively added resource group (see *Re-mapping on spec change* below) — one scoped shortlist call for that resource's summary against each counterpart spec, then detail calls for whatever gets shortlisted. The review-UI escape hatch above deliberately does **not** bypass an exclusion: excluded resources are listed *as excluded* — distinct from "no counterpart shortlisted" — and carry no "analyze anyway" action (see [flows/mapping-review-and-approval.md](../flows/mapping-review-and-approval.md)), so the operator's declared scope stays the single source of truth about what is out of bounds rather than being quietly overridable from the review screen.

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
      phase: "request" | "response",   // consumer-provider pairs only; absent on peer-peer
      transform: "rename" | "coerce" | "aggregate" | "expression",
      transformDetail,
      identityCandidate: bool,         // peer-peer pairs only
      confidence, rationale,
      ambiguousAlternatives: [{ targetField, confidence }],
      unmapped: bool
    }
  ],
  parameterMappings: [                 // consumer-provider pairs only
    {
      sourceOperationId, targetOperationId,
      sourceParam, targetParam,
      transform, transformDetail,      // optional
      confidence, rationale,
      unmapped: bool
    }
  ]
}
```

`ambiguousAlternatives` and `unmapped` are structurally identical across `operationMappings`, `fieldMappings`, and `parameterMappings` — an operation can have more than one plausible match (e.g. two similarly-named endpoints) exactly as a field can, so the schema doesn't special-case operations to a narrower shape. All three map onto the single `MappingProposalItem` entity regardless of `kind` (see [data-model.md](data-model.md)).

For **consumer-provider** pairs, every field-level suggestion additionally carries a `phase`: `request` (consumer request field in → backend request field out) or `response` (backend response field in → consumer response field out), and `parameterMappings` cover the operation inputs that aren't resource fields — path/query/header parameters — scoped per operation pair. The two phases are independent transform sets over the same resource pair: a non-invertible transform in one phase (`fullName = firstName + " " + lastName`) has its own independently-proposed counterpart in the other phase, or none — the same no-inversion reasoning that makes bidirectional sync two one-way mappings (see [data-model.md](data-model.md)), applied inside one mapping because the adapter needs both halves to serve a single round trip. Both phases and the parameter mappings come out of the *same single detail call*: the prompt already contains both resources in full, so this adds output structure, not extra calls. Peer-peer suggestion sets carry neither `phase` nor `parameterMappings` — a peer-peer mapping has a single data direction, and the sync pipeline fills target operation parameters (the path id of an update, say) from the `RecordLink`, through the one confirmed id parameter on the `OperationMapping` (`targetIdParamRef`, see [data-model.md](data-model.md)), not from per-parameter mappings.

For **peer-peer** pairs, the provider is additionally asked to flag at most one field pairing per resource pair as `identityCandidate: true` — the business-level key (email, SKU, order number, …) whose values are expected to identify the *same record* in both apps. Only a value-preserving pairing qualifies — an identity key may carry no transform beyond `rename` (see [data-model.md](data-model.md)) — so the flag targets fields whose raw values correspond. Where the target resource's collection read declares a plausible lookup parameter for that field, the provider also names it — the suggested `targetLookupParamRef`, the parameter identity matching will query by (see [data-model.md](data-model.md) and *Identity correlation* in [sync-engine.md](sync-engine.md)). This is a suggestion only: it pre-selects the identity choice in the review UI, but `FieldMapping.isIdentityKey` is set exclusively by explicit reviewer confirmation (see [flows/mapping-review-and-approval.md](../flows/mapping-review-and-approval.md)), because a wrong identity key makes the Sync Engine silently merge unrelated records — the worst failure mode it has (see *Identity correlation* in [sync-engine.md](sync-engine.md)). Consumer-provider pairs skip this: the adapter never correlates records across apps.

Both stages' outputs are validated against fixed JSON schemas before anything is persisted (suggestions as `MappingProposalItem`s; the shortlist is *mechanically enriched* into `MappingProposal.shortlistResult` — the engine adds the in-scope resources for which no counterpart was shortlisted, computed by set difference rather than trusted from the LLM, and stage-2 retry-ceiling failures later mark their candidate pair `analysisFailed` there — see [data-model.md](data-model.md)). Malformed output triggers a corrective retry (re-prompting with the validation error) — the core mapping logic never trusts free-text LLM output directly; only validated structured output is persisted. Retries are capped (e.g. 3 attempts per call); at the ceiling, the two stages fail with very different blast radii: a failed **detail** call marks that one candidate pair `analysisFailed` on the proposal's persisted `shortlistResult` while the rest of the proposal proceeds, whereas a failed **shortlist** call fails the run itself — `MappingProposal.status = failed`, nothing reviewable for the *entire spec pair* — alerted more urgently for exactly that reason (see [data-model.md](data-model.md) and [observability.md](observability.md)). Either failure is surfaced in the review UI as needing attention rather than silently consuming LLM budget in a retry loop.

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
3. **Breaking** changes (removed/renamed/retyped field or operation): only the `ApprovedMapping`/`SyncRule`/`AdapterBinding` records that reference the changed elements are marked `stale` and paused — a delta-review model. Everything else for that app (mappings unaffected by the change) keeps running uninterrupted. For each mapping marked `stale`, the engine immediately runs the **scoped re-analysis that produces its re-review proposal**: one detail call per affected resource pair, against the new spec version — stage 1 is skipped, since the resource correspondence is already established — with the stale mapping's approved content passed as `priorFeedback`, so unaffected correspondences come back intact and review effort concentrates on what the spec change actually broke. The result is an ordinary `MappingProposal`; approving it yields the stale mapping's **successor** (see *Successor adoption* in [extensibility.md](extensibility.md) for the full lifecycle).

## Observability hooks

Every LLM call (latency, success/failure, token usage — labeled by stage, shortlist vs. detail), the shortlist yield (candidate pairs per spec pair), escape-hatch usage (manually triggered detail analyses), analysis-scope size (resource groups excluded per spec) and re-inclusion-triggered analyses, and every proposal's confidence distribution are emitted as OpenTelemetry metrics/traces — see [observability.md](observability.md) for the specific signals and the Grafana dashboard built on top of them.
