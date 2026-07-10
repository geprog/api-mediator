# Phase 2 — Detection eval harness

A **scored report**, not a pass/fail gate: it runs the real-provider detection engine over each
scenario's vendored specs and measures the produced proposals against `scenarios/*/ground-truth.yaml`
— resource-pair precision/recall (both stages), operation CRUD classification, identity-candidate hit
rate, transform-kind agreement, field-mapping precision/recall, consumer-provider phase/parameter
correctness, and negatives-avoidance — plus the two-stage design's key **health signal** (shortlist
recall, the offline proxy for production escape-hatch usage).

This is the one Phase-2 area whose numbers depend on a real model. Its criteria are therefore about
**what is measured and how the report is shaped**, not about hitting a specific accuracy number: the
thresholds are tracked and reported, never asserted as unit-test truth. Mechanical correctness
(enumeration, shapes, blast radii, persistence) is covered deterministically by CE/TD/PP and must
**not** be re-litigated here with a live model.

**Actor:** operator / developer (runs the harness to evaluate a provider+prompt against ground
truth).

**Concept references (whole file):** [mapping-engine.md](../architecture/mapping-engine.md)
*Matching approach*, *Escape hatch*, *Confidence & ambiguity*, *Structured proposal formats*;
[overview.md](../architecture/overview.md) *Scale assumption*;
[observability.md](../architecture/observability.md) *Metrics — Mapping Engine* (shortlist yield,
escape-hatch usage as the key health signal); [scenarios/README.md](../../scenarios/README.md)
*Ground truth*; the ground-truth fixtures for
[scenario-1](../../scenarios/scenario-1-small-overlap/ground-truth.yaml),
[scenario-3](../../scenarios/scenario-3-consumer-provider/ground-truth.yaml),
[scenario-4](../../scenarios/scenario-4-mixed/ground-truth.yaml). Related tooling:
`scenarios/shared/check-ground-truth.py` (checks ground-truth ops exist in specs — a *different*,
static check; the harness here scores detection *output*).

> **Scored report, not a gate.** The concept treats detection quality as a monitored *signal*
> (shortlist yield, escape-hatch usage, average confidence trend) — not a boolean. The harness emits
> per-scenario metrics and diffs; it must **not** be wired as a CI red/green gate on accuracy. A
> non-empty run and a well-formed report are gate-able; the accuracy numbers are for humans.

> **Thresholds are config-defined.** Any target numbers (e.g. "shortlist recall ≥ X") are harness
> configuration recorded in the report, not concept constants.

---

## EH-1 — Run detection over a scenario and emit a scored report

**As a** developer, **I can** run the detection engine over a scenario's vendored specs with the real
provider and get a machine-readable scored report, **so that** I can evaluate a provider+prompt
against ground truth reproducibly.

### Acceptance criteria

1. **Given** a scenario directory (its vendored `specs/oas3/` inputs — the default detection input
   per [scenarios/README.md](../../scenarios/README.md)) and its `ground-truth.yaml`, **when** the
   harness runs, **then** it decomposes the specs, runs two-stage detection with the configured
   provider, and produces the `MappingProposal`s + `shortlistResult`s the scoring reads.
2. **Given** a completed run, **when** the report is written, **then** it records, per scenario, the
   provider identity used (`generatedBy`: providerId/model/promptVersion) alongside the metrics, so a
   score is always attributable to a provider+prompt version.
3. **Given** the report, **when** produced, **then** it is a **scored report** — per-scenario metric
   values plus the concrete matched/missed/false-positive items — and is **not** asserted as a
   red/green accuracy gate (a well-formed, non-empty report is the only gate-able outcome).
4. **Given** the harness needs to compare produced proposals to ground truth, **when** it maps a
   detected correspondence to a ground-truth entry, **then** it matches by IR resource/operation/field
   references (the same `resourceRef`/operation/field identity the concept uses), tolerating the
   trimmed-vs-full spec split the fixtures document (paths reference trimmed specs unless marked
   full-spec-only).
5. **Given** the harness invokes the engine, **when** it does so, **then** it calls the **detection
   engine directly** over the fixture specs (bypassing the Event Bus and the `SpecIngested` trigger),
   so scoring is a function of inputs and provider only — see the README open question confirming
   direct-invocation over bus-triggered.

### Out of scope

- Asserting any accuracy floor as a build gate — deliberately excluded (scored report only).
- The production OTel dashboards that show the same signals live — those exist per
  [observability.md](../architecture/observability.md); the harness is the offline, ground-truth-
  scored counterpart.

### Dependencies

Blocked by LP-2 (real provider), TD-1..2, PP-1..3. Precedes EH-2, EH-3.

---

## EH-2 — Score stage-1 shortlist quality and negatives-avoidance

**As a** developer, **I** measure how well the shortlist recovers the genuine resource pairs and
avoids confidently proposing the ground-truth negatives, **so that** I can tell whether stage 1's
recall bias is calibrated.

### Acceptance criteria

1. **Given** a scenario's ground-truth `pairs`, **when** the harness scores stage 1, **then** it
   reports shortlist **recall** (fraction of ground-truth resource pairs that appear in the produced
   `shortlistResult` candidate pairs) and shortlist **precision** (fraction of shortlisted pairs that
   are genuine), per scenario.
2. **Given** a ground-truth `pair` that stage 1 did **not** shortlist, **when** the report is
   produced, **then** that pair is listed explicitly as a shortlist miss — the offline equivalent of
   a production escape-hatch use (see EH-3).
3. **Given** a scenario's `negatives` with `verdict: no-counterpart` or `incorrect-but-tempting`,
   **when** scored, **then** the harness reports whether detection **confidently** proposed any of
   them (a confident proposal of one is a scored failure line), e.g. scenario-1's Gitea `milestones` ↔
   Vikunja `buckets` (`incorrect-but-tempting`) must not be confidently proposed.
4. **Given** a `negative` with `verdict: ambiguous` (e.g. scenario-1 Gitea `repositories` ↔ Vikunja
   `projects`), **when** scored, **then** the harness distinguishes an acceptable **low-confidence**
   shortlist entry from a **confident** proposal — only the latter counts against the score
   ([scenario-1 ground-truth](../../scenarios/scenario-1-small-overlap/ground-truth.yaml) header:
   "ambiguous … acceptable as a low-confidence shortlist entry, must not survive review as an
   auto-approval").
5. **Given** the report, **when** produced, **then** it includes stage-1 **shortlist yield**
   (candidate pairs per spec pair), matching the concept's named metric
   ([observability.md](../architecture/observability.md) *Metrics — Mapping Engine*).

### Out of scope

- Detail-level (operation/field/transform) scoring — EH-3.

### Dependencies

Blocked by EH-1.

---

## EH-3 — Score stage-2 detail quality, consumer-provider phases, and the recall health signal

**As a** developer, **I** measure operation, field, identity, and transform accuracy — and the
shortlist-recall health signal — **so that** I can judge whether a provider+prompt is good enough and
whether stage-1 recall is the limiting factor.

### Acceptance criteria

1. **Given** a shortlisted resource pair with ground-truth `operations`, **when** the harness scores
   stage 2, **then** it reports **operation CRUD classification** accuracy — whether the detected
   `operationMappings` pair the correct target operation for each ground-truth CRUD action
   (list/read/create/update/delete), e.g. scenario-1 Vikunja's `PUT` = create / `POST` = update
   inversion is classified by semantics, not verb.
2. **Given** ground-truth `fields`, **when** scored, **then** the harness reports field-mapping
   **precision/recall** (genuine field pairs found vs. spurious ones), counting the ground-truth
   `unmapped` source fields and the `plausible` false-positives (e.g. scenario-1 `number` ↔ `index`)
   as items detection must **not** confidently map.
3. **Given** ground-truth `identityKey` on a peer-peer pair, **when** scored, **then** the harness
   reports the **identity-candidate hit rate** — whether the detector flagged the ground-truth
   identity field pairing with `identityCandidate` (e.g. scenario-1 `title`↔`title` for issues↔tasks;
   and correctly leaves `identityCandidate` unset where the pair has no natural key, e.g. comments).
4. **Given** ground-truth field `transform` kinds, **when** scored, **then** the harness reports
   **transform-kind agreement** between the detected `transform` and the expected kind. The
   ground-truth vocabulary includes `direct` (same name, value-preserving) which the concept's
   `MappingSuggestionSet.transform` enum (`rename` | `coerce` | `aggregate` | `expression`) has no
   member for — the harness scores `direct` against the concept's value-preserving representation per
   the README open question, and this modeling gap is a reported finding, not a silent coercion.
5. **Given** a **consumer-provider** scenario (3 and 4), **when** scored, **then** the harness reports
   whether field suggestions carry the correct `phase` (`request` vs. `response`), whether
   `parameterMappings` are produced for the operation inputs, and whether the hard request-phase
   **constant-synthesis** case is handled (scenario-3 `POST /todos/{todoId}/complete` synthesizing
   `done = true` from a bodyless consumer op).
6. **Given** the two-stage design's key health signal, **when** the report is produced, **then** it
   surfaces **shortlist recall** (from EH-2) as the offline proxy for production **escape-hatch
   usage** — low shortlist recall is flagged as "stage-1 recall too low," matching the concept's
   stated health signal ([mapping-engine.md](../architecture/mapping-engine.md) *Escape hatch*;
   [observability.md](../architecture/observability.md)).

### Out of scope

- Adapter aggregation-strategy / binding scoring (`single`/`fanout`/`collection-union`) — those are
  approval/composition-time decisions (Phase 5), not detection output; the harness scores the
  *proposal*, not the endpoint composition.
- Confirming identity keys or `action`s — Phase 3 review; the harness scores the *suggestion*
  (`identityCandidate`, the proposed operation pairing), not the confirmed value.

### Dependencies

Blocked by EH-1, EH-2.
