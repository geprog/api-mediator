# Phase 2 — Pluggable `LLMMappingProvider`

The seam between the Mapping Engine core and whatever model backs it. The core owns prompt
templating, validation, retry, and repair; the provider owns exactly one thing — turning a prompt
context into a structured stage output. Phase 2 ships **two** implementations behind the one
interface: a real Ollama-backed provider (for accuracy, exercised by the eval harness) and a
deterministic fake/replay provider (for every mechanical unit/e2e test in TD/PP/CE, and for offline
runs). Every proposal records which provider/model/prompt produced it.

**Actor:** system (Mapping Engine core depends on the interface; operator selects the active provider
by configuration).

**Concept references (whole file):** [mapping-engine.md](../architecture/mapping-engine.md)
*Pluggable LLM provider interface*, *Structured proposal formats*;
[overview.md](../architecture/overview.md) *Key interfaces* (`LLMMappingProvider.*`);
[data-model.md](../architecture/data-model.md) `MappingProposal.generatedBy`; [glossary.md](../glossary.md)
`LLMMappingProvider`, `ResourceShortlist`, `Shortlist pass (stage 1)`, `Detail pass (stage 2)`.

> **The provider is swappable configuration, never hardcoded.** The concept lists illustrative
> implementations (hosted large-model API, self-hosted open-weight model, rules/embeddings-only
> fallback) but hardcodes none ([mapping-engine.md](../architecture/mapping-engine.md)). The active
> provider is a config choice; the core behaves identically regardless of which is active.

> **Exact prompt text and model id are implementation-/config-defined.** `promptVersion` is the
> stable handle the concept fixes; the concrete template strings and the chosen Ollama model are
> implementation choices, stated behaviorally below.

---

## LP-1 — The `LLMMappingProvider` interface (two stages, two contexts)

**As the** Mapping Engine core, **I** depend only on a two-method `LLMMappingProvider` interface plus
a response-schema validator, **so that** detection behavior is consistent no matter which model backs
it and a new backend is a config swap, not a core change.

### Acceptance criteria

1. **Given** the interface, **when** defined, **then** it exposes exactly two methods:
   `shortlistResourcePairs(context: ShortlistPromptContext): ResourceShortlist` (stage 1) and
   `generateMappingProposal(context: MappingPromptContext): MappingSuggestionSet` (stage 2), named
   verbatim ([mapping-engine.md](../architecture/mapping-engine.md) *Pluggable LLM provider
   interface*).
2. **Given** a `ShortlistPromptContext`, **when** constructed, **then** it carries
   `sourceSpecSummaryIR`, `targetSpecSummaryIR` (resource-level **summaries only** — name,
   description, operation summaries, top-level field list), and `promptVersion`.
3. **Given** a `MappingPromptContext`, **when** constructed, **then** it carries `sourceResourceIR`,
   `targetResourceIR` (the **full** operations + schemas of the one resource pair), `promptVersion`,
   and an **optional** `priorFeedback` that is **always absent in Phase 2** (re-mapping supplies it —
   Phase 6).
4. **Given** the core, **when** it invokes a provider, **then** it depends on **no** provider-specific
   type — only the interface and the two structured output types — so a provider can be substituted
   without recompiling the core's detection logic.
5. **Given** prompt templating, retry, and repair, **when** located, **then** they live in the
   **core**, not in any provider implementation, so all providers share identical validate/retry
   behavior ([mapping-engine.md](../architecture/mapping-engine.md): "It owns prompt templating,
   retry, and repair logic itself").

### Out of scope

- The JSON-schema validation + corrective-retry loop itself — TD-3 (this story fixes only that the
  core, not the provider, owns it).
- `priorFeedback`-driven re-proposals — Phase 6 ([extensibility.md](../architecture/extensibility.md)).

### Dependencies

Blocked by Phase-1 SI-1 (IR + summaries feed the contexts). Precedes LP-2, LP-3, TD-1, TD-2.

---

## LP-2 — Ollama-backed real provider

**As an** operator, **I can** configure a real, self-hosted Ollama-backed `LLMMappingProvider`, **so
that** detection runs against an actual model without depending on any hosted API.

### Acceptance criteria

1. **Given** the active provider is the Ollama-backed one, **when** `shortlistResourcePairs` is
   called, **then** it issues one call to the configured Ollama model and returns a value **parsed
   into** the `ResourceShortlist` shape (candidate pairs, each with `sourceResource`,
   `targetResource`, `confidence`, `rationale`).
2. **Given** the active provider is the Ollama-backed one, **when** `generateMappingProposal` is
   called, **then** it issues one call to the configured Ollama model and returns a value parsed into
   the `MappingSuggestionSet` shape (`operationMappings`, `fieldMappings`, `parameterMappings`).
3. **Given** the model returns output that does not parse into the stage's shape, **when** the
   provider returns, **then** it surfaces that to the core as a failed attempt (so the core's
   corrective retry — TD-3 — can drive another attempt); the provider does **not** silently invent a
   well-formed result.
4. **Given** provider configuration, **when** set, **then** the model id and endpoint are
   configuration values recorded into `generatedBy` (see LP-4), not compiled constants.
5. **Given** an Ollama call, **when** it completes or fails, **then** its latency, success/failure,
   and token usage are emitted as OpenTelemetry signals labeled by stage (shortlist vs. detail),
   matching the concept's observability hooks
   ([observability.md](../architecture/observability.md) *Metrics — Mapping Engine*).

### Out of scope

- Accuracy of what the model returns — that is **scored, not asserted**, by the eval harness (EH),
  against `scenarios/*/ground-truth.yaml`. This story asserts only wiring and shape, never that a
  particular pair is found.
- Hosted large-model API providers and the rules/embeddings-only fallback — additional
  implementations behind the same interface, not required to close Phase 2.

### Dependencies

Blocked by LP-1. Exercised by EH-1..3.

---

## LP-3 — Deterministic Fake/replay provider

**As a** test author, **I can** back the Mapping Engine with a scripted, deterministic
`LLMMappingProvider`, **so that** every mechanical behavior (enumeration, validation, retry, the two
blast radii, set-difference enrichment, persistence shape) is unit/e2e-testable without a live model
and without flakiness.

### Acceptance criteria

1. **Given** a FakeProvider scripted with a fixed `ResourceShortlist` for a spec pair, **when**
   `shortlistResourcePairs` is called for that pair, **then** it returns exactly that value,
   deterministically, with no network call.
2. **Given** a FakeProvider scripted with a fixed `MappingSuggestionSet` per resource pair, **when**
   `generateMappingProposal` is called for a pair, **then** it returns exactly that value.
3. **Given** a FakeProvider scripted to return a **malformed** output on attempt 1 and a valid output
   on attempt 2, **when** the core calls it, **then** the sequence is reproducible across runs — so
   the corrective-retry path (TD-3) can be asserted deterministically.
4. **Given** a FakeProvider scripted to return malformed output on **every** attempt, **when** the
   core calls it, **then** it keeps returning malformed output up to the retry ceiling — so both
   failure blast radii (TD-4) can be asserted deterministically.
5. **Given** the FakeProvider, **when** it is the active provider, **then** it records a stable
   provider identity into `generatedBy` (e.g. `providerId = "fake"`, a scripted `model`, and the
   `promptVersion` in effect) so persistence tests (LP-4, PP-1) can assert provenance.

### Out of scope

- Recording/replaying **real** Ollama transcripts as fixtures (a nicety) — optional; a hand-scripted
  fake satisfies every mechanical criterion. If added, it must stay a test/offline artifact, never a
  production provider.

### Dependencies

Blocked by LP-1. Required by (test doubles for) CE-*, TD-*, PP-*, DT-* stories.

---

## LP-4 — Record `generatedBy` provenance on every proposal

**As a** reviewer or operator, **I can** see which provider, model, and prompt version produced a
proposal, **so that** proposals are reproducible and comparable across provider/prompt changes.

### Acceptance criteria

1. **Given** any `MappingProposal` produced by detection (including a `failed` one), **when**
   persisted, **then** its `generatedBy` records `{ providerId, model, promptVersion }`
   ([data-model.md](../architecture/data-model.md) `MappingProposal.generatedBy`).
2. **Given** `generatedBy.promptVersion`, **when** inspected, **then** it is the single version handle
   that covers **both** stage prompts (shortlist + detail), matching the concept
   ([data-model.md](../architecture/data-model.md): "`promptVersion` covers both stage prompts").
3. **Given** two proposals produced by different active providers or prompt versions, **when**
   compared, **then** their `generatedBy` values differ accordingly.
4. **Given** the two directional peer-peer proposals for one unordered spec pair, **when** both are
   persisted, **then** each records its own `generatedBy` (the same provider/model/prompt in a single
   run, but stored per proposal).

### Out of scope

- Any UI that surfaces `generatedBy` in the review screen — Phase 3.
- Comparing proposals across prompt versions as a workflow (A/B prompt evaluation) — an eval-harness
  extension, not core Phase 2.

### Dependencies

Blocked by LP-1 and PP-1 (`MappingProposal` persistence).
