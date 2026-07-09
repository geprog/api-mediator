# Build vs. Buy — Existing Tools as the Sync & Adapter Engines

This document evaluates whether an existing open-source workflow/integration tool could serve as the mediator's **execution engines** — the [Sync Engine](architecture/sync-engine.md) and the [Adapter/Gateway Engine](architecture/adapter-engine.md) — so that the project's own effort can concentrate on the [Mapping Engine](architecture/mapping-engine.md), where its actual novelty lies. It complements [related-work.md](related-work.md), which asks *"who else does what we do"* (positioning); this document asks *"can we adopt a tool to do part of it for us"* (build vs. buy). Research date: July 2026.

**Headline finding:** no candidate can replace both engines, and none provides the sync engine's stateful core — identity correlation, per-side baselines, loop prevention, tombstones, conflict resolution (criteria S3–S10 below) rate "build it yourself" in every column. That core is not accidental plumbing; together with mapping creation it *is* the product. What tools **can** cover is the operational substrate around that core (scheduling, retries, durable execution — Temporal) and much of the adapter engine's serving/aggregation layer (Apache Camel or KrakenD). The recommendation is at the end.

## What "buy" would have to cover

The two engines are pure consumers of the `ApprovedMapping` contract (`FieldMapping`/`OperationMapping`/`ParameterMapping`, see [data-model.md](architecture/data-model.md)), sharing the Transformation Executor, Outbound Call Executor, Credential Store access pattern, and Audit Log (see [overview.md](architecture/overview.md)). Any adopted tool must honor that contract programmatically:

- **Flows are generated, never hand-built.** Execution units (workflows/flows/routes/endpoint configs) would be *compiled from `ApprovedMapping`s* and managed entirely via API: created and activated on `MappingApproved`, suspended when a mapping goes `stale`, re-pointed on successor adoption (see [extensibility.md](architecture/extensibility.md)). A tool whose lifecycle assumes a human in a visual editor fails this regardless of its other merits — criterion C2 below is gating.
- **Sync state outlives any execution.** `RecordLink`, `SyncFieldState`, cursors and snapshots (see [data-model.md](architecture/data-model.md)) must be durable, queryable by the UI (manual linking, conflict resolution), and shared across both directions of a bidirectional pair — criterion C3 asks where that state would live.

## Adoption models

Each candidate is rated under its declared best-fit model (named in the matrix column header); the per-candidate verdict discusses alternatives.

- **(a) Tool as engine** — the tool *is* the sync and/or adapter engine: mediator semantics live in generated flows plus custom nodes/plugins; `ApprovedMapping`s compile to flow definitions.
- **(b) Tool as substrate** — the tool owns the operational shell (scheduling, retries, ordering, durability); the sync/adapter *semantics* (identity resolution, loop prevention, conflicts, aggregation) stay in mediator-owned code the tool invokes.
- **(c) Tool not in the loop** — the custom build per [architecture/](architecture/overview.md); the baseline column.

## Candidates

- **Custom build (baseline)** — the engines exactly as specified in the architecture docs. The column every tool must beat: adopting a tool only pays off if it converts enough "build it yourself" cells into native/extension cells to outweigh its integration cost, license constraints, and any architectural mismatches it introduces.
- **n8n** *(model a)* — the most prominent self-hostable workflow-automation platform; the obvious "why not just use n8n?" this document exists to answer. Fair-code, not OSI open source: the [Sustainable Use License](https://docs.n8n.io/privacy-and-security/sustainable-use-license) makes C1 a first-order question.
- **Node-RED** *(model a)* — Apache-2.0, OpenJS Foundation, flow-based programming on Node.js; explicitly [embeddable](https://nodered.org/docs/user-guide/runtime/embedding) with an [Admin API](https://nodered.org/docs/api/admin/methods/) for programmatic flow deployment — the strongest license/embeddability profile in the workflow category.
- **Apache Camel** *(model a, embedded as a library)* — the classic integration framework: enterprise integration patterns, 300+ components, and a [contract-first REST DSL](https://camel.apache.org/manual/rest-dsl-openapi.html) that serves an OpenAPI spec directly. Already flagged in [related-work.md](related-work.md) as overlapping the execution layer.
- **Temporal** *(model b — sync side only)* — durable-execution platform (MIT-licensed [server](https://github.com/temporalio/temporal/blob/main/LICENSE)); has no HTTP-serving or connector layer, so it cannot *be* either engine, but its per-entity workflows match sync's per-record ordering, retry/dead-letter, and long-lived-state needs. Adapter rows are `n/a`.
- **KrakenD** *(model a — adapter side only)* — stateless API gateway (Apache-2.0, [Lura framework](https://luraproject.org/) under the Linux Foundation) whose flagship feature is declarative [backend aggregation/merging](https://www.krakend.io/docs/endpoints/response-manipulation/) — the closest existing thing to `fanout-merge`. Sync rows are `n/a`. Runners-up in this category, Kong OSS and Apache APISIX, were set aside: both are routing/policy gateways where response aggregation is plugin work, i.e. exactly the part the adapter engine needs most ([comparison](https://api7.ai/learning-center/api-gateway-guide/api-gateway-comparison-apisix-kong-traefik-krakend-tyk), accessed 2026-07-09).

## Evaluation criteria

Derived from the engine responsibilities in the architecture docs; IDs are stable so future candidates can be assessed against the same rows.

### Group S — Sync Engine ([sync-engine.md](architecture/sync-engine.md))

| ID | Criterion | Source |
|---|---|---|
| S1 | Scheduled per-rule polling — many independent poll jobs on per-`SyncRule` intervals | *Change detection: polling pull* |
| S2 | Delta-query polling with a durable cursor | *Polling pull pipeline*; `SyncRule.cursor` |
| S3 | Full-fetch content-hash snapshot diffing, paged to exhaustion, abort on partial fetch | *Polling pull pipeline*; `SyncRule.lastSnapshotRef` |
| S4 | Change classification (create/update/delete) incl. safe delete inference | *Change types* |
| S5 | Cross-app identity correlation — `RecordLink` lifecycle: create-propagation id capture, identity-key match, ambiguous-match parking, manual linking | *Identity correlation: RecordLink* |
| S6 | Loop/echo prevention — durable per-side `SyncFieldState` baselines, canonical-form capture from write responses | *Loop prevention* |
| S7 | Delete-echo and resurrection prevention via tombstoned links | *Loop prevention*; `RecordLink.tombstoneReason` |
| S8 | Conflict detection & resolution — observed-vs-baseline per side, LWW with epsilon/observation-order fallback, per-field `manual-resolve`, partial-conflict withholding | *Conflict handling* |
| S9 | Initial backfill — `link-only`/`push`, baseline seeding, polling gated on completion | *Initial backfill* |
| S10 | State-convergent idempotency — deterministic key incl. prior reconciled state, bounded-lookback dedup | *Idempotency* |
| S11 | Retry/backoff and dead-letter parking that never blocks the record's queue; manual replay through the pipeline | *Write failures: retry and dead-letter* |
| S12 | Per-`(mapping, resourceId)` sequential ordering | *Ordering and consistency* |

### Group A — Adapter Engine ([adapter-engine.md](architecture/adapter-engine.md))

| ID | Criterion | Source |
|---|---|---|
| A1 | Live server generated from an arbitrary consumer OpenAPI spec, incl. serving unmapped operations as `not-yet-mapped` | intro; *Binding* |
| A2 | Persisted binding resolution — execute stored `AdapterEndpoint`/`AdapterBinding` config, stale re-validation, no per-request replanning | *Binding*; *Stale bindings at request time* |
| A3 | Aggregation strategies — `single`/`fanout-merge`/`collection-union`/`fanout-first-success`, roles, `dependsOnBindingId` chaining, union dedup, pushdown-first parameters | *Aggregation strategies* |
| A4 | Two-phase request/response transforms (`FieldMapping.phase`, `ParameterMapping`s) | *Request pipeline* steps 5 & 7 |
| A5 | Distinct error semantics (`not-yet-mapped`, `mapping-stale`, `backend-disabled`, `mediator-transform-error`, degraded supplement responses) + consumer-schema response validation | *Error and partial-failure semantics* |
| A6 | Response caching with TTL **and** event-driven invalidation (SyncEvents, adapter writes) | *Caching* |
| A7 | Write operations — single-binding restriction, idempotency passthrough, sync interplay | *Write operations* |
| A8 | Inbound auth — mediator-issued adapter tokens validated per consumer | *Request pipeline* step 2; [security.md](architecture/security.md) |

### Group X — Shared components ([overview.md](architecture/overview.md), [security.md](architecture/security.md), [observability.md](architecture/observability.md))

| ID | Criterion | Source |
|---|---|---|
| X1 | Transformation Executor — rename/coerce/aggregate plus **sandboxed, non-Turing-complete** expression evaluation | `FieldMapping.transform`; security.md |
| X2 | Outbound Call Executor & credential discipline — `withCredential` scoped access, OAuth2 refresh inside the store | overview.md; security.md |
| X3 | Audit/Event Log — business-level `SyncEvent` rows (success/failure/skipped-loop/skipped-policy/conflict), queryable for idempotency lookback | overview.md; data-model.md |
| X4 | OpenTelemetry instrumentation with trace-to-`SyncEvent` correlation | observability.md |

### Group C — Cross-cutting adoption criteria

| ID | Criterion | Note |
|---|---|---|
| C1 | Licensing & distribution rights — internal use vs. offering the mediator commercially to third parties | **gating**; the distribution question is currently undecided, so both scenarios are documented |
| C2 | Programmatic flow management / embeddability — execution units generated from `ApprovedMapping`s, full API-driven lifecycle (create/activate/suspend/replace), never hand-built | **gating**; see *What "buy" would have to cover* |
| C3 | Mediator state storage — where `RecordLink`/`SyncFieldState`/cursors/snapshots live | tool-hosted vs. external mediator-owned store |
| C4 | Self-hosting & ops footprint vs. the single-instance deployment model in [overview.md](architecture/overview.md) | |
| C5 | Maturity / community / governance | |
| C6 | Security-model fit — secrets handling vs. Credential Store discipline, sandboxing of transform code, no unauthenticated inbound surface | [security.md](architecture/security.md) |

**Non-criteria**, deliberately: raw throughput and horizontal scale (the landscape is 15–20 apps — see *Scale assumption* in [overview.md](architecture/overview.md)); multi-tenancy (out of scope); visual flow-building ergonomics (flows are generated, so editor quality is irrelevant — it follows from C2).

## Evaluation matrix

Legend — what the **tool** contributes per criterion:

- `✓` **native** — first-class feature or concept of the tool
- `◐` **extension** — achievable through supported extension points (custom node/plugin/generated config) with modest effort
- `○` **custom** — must be built essentially from scratch; the tool provides no meaningful leverage
- `✗` **mismatch** — architecturally conflicts with the tool's model
- `n/a` — outside the candidate's evaluated scope
- `—` — criterion doesn't apply to the custom-build baseline (no third-party terms/tool to rate)

The custom-build baseline is `○` on every engine row *by definition* — the decision rule is whether a candidate converts enough `○` cells to `✓`/`◐` to pay for its integration cost, its license constraints, and any `✗` it introduces. **C1 and C2 are gating:** a `✗` there disqualifies model (a) adoption for that candidate regardless of the other rows.

| ID | Custom build | n8n (a) | Node-RED (a) | Camel (a) | Temporal (b, sync only) | KrakenD (a, adapter only) |
|---|---|---|---|---|---|---|
| S1 | ○ | ✓ | ✓ | ✓ | ✓ | n/a |
| S2 | ○ | ◐ | ◐ | ◐ | ✓ | n/a |
| S3 | ○ | ○ | ○ | ○ | ○ | n/a |
| S4 | ○ | ○ | ○ | ○ | ○ | n/a |
| S5 | ○ | ○ | ○ | ○ | ○ | n/a |
| S6 | ○ | ○ | ○ | ○ | ○ | n/a |
| S7 | ○ | ○ | ○ | ○ | ○ | n/a |
| S8 | ○ | ○ | ○ | ○ | ○ | n/a |
| S9 | ○ | ○ | ○ | ○ | ◐ | n/a |
| S10 | ○ | ○ | ○ | ◐ | ◐ | n/a |
| S11 | ○ | ◐ | ○ | ✓ | ✓ | n/a |
| S12 | ○ | ◐ | ◐ | ◐ | ✓ | n/a |
| A1 | ○ | ◐ | ◐ | ✓ | n/a | ✓ |
| A2 | ○ | ◐ | ◐ | ◐ | n/a | ◐ |
| A3 | ○ | ◐ | ◐ | ◐ | n/a | ◐ |
| A4 | ○ | ◐ | ◐ | ◐ | n/a | ◐ |
| A5 | ○ | ○ | ○ | ◐ | n/a | ◐ |
| A6 | ○ | ○ | ○ | ◐ | n/a | ◐ |
| A7 | ○ | ◐ | ◐ | ◐ | n/a | ◐ |
| A8 | ○ | ◐ | ◐ | ◐ | n/a | ✓ |
| X1 | ○ | ◐ | ◐ | ◐ | ○ | ◐ |
| X2 | ○ | ✓ | ◐ | ◐ | ○ | ◐ |
| X3 | ○ | ◐ | ○ | ○ | ◐ | ○ |
| X4 | ○ | ○ | ○ | ✓ | ◐ | ✓ |
| C1 | — | ◐ | ✓ | ✓ | ✓ | ✓ |
| C2 | — | ✓ | ✓ | ✓ | ✓ | ◐ |
| C3 | — | ○ | ○ | ○ | ◐ | ○ |
| C4 | — | ✓ | ✓ | ◐ | ◐ | ✓ |
| C5 | — | ✓ | ✓ | ✓ | ✓ | ✓ |
| C6 | — | ◐ | ○ | ◐ | ○ | ◐ |

## Per-candidate assessments

Evidence notes are keyed by criterion ID; capability and license claims carry their source and access date.

### n8n — model (a), verdict: no as engine, marginal as substrate

- **C1 (◐, conditional):** the [Sustainable Use License](https://docs.n8n.io/privacy-and-security/sustainable-use-license) (accessed 2026-07-09) permits use "only for your own internal business purposes or for non-commercial or personal use" and explicitly forbids white-labeling, hosting n8n for money, or any offering "where the value derives primarily from n8n functionality". **Internal/self-hosted use of the mediator: fine. Distributing or selling the mediator with n8n inside: requires n8n's paid Embed/enterprise agreement.** Since the distribution question is undecided, n8n carries a licensing contingency none of the other candidates has.
- **C2 (✓):** the [public REST API](https://docs.n8n.io/api/) (self-hosted: included; accessed 2026-07-09) covers workflow create/update/activate/delete — generating one workflow per `SyncRule`/`AdapterEndpoint` from `ApprovedMapping`s and driving its lifecycle on `MappingApproved`/`stale`/successor events is a supported pattern. n8n runs as its own service driven over HTTP; it is not embeddable as a library.
- **S1 (✓), S11 (◐), S12 (◐):** schedule triggers per workflow are native; per-node retry settings, error workflows, and retry-from-UI of stored executions approximate retry/dead-letter/replay, but parking semantics ("superseded by any later successful sync") are custom; per-key ordering doesn't exist — approximated by per-workflow concurrency 1, serializing each rule.
- **S2 (◐), C3 (○):** workflow static data can hold a cursor, but `RecordLink`/`SyncFieldState`/snapshots need an external mediator-owned DB accessed from Code/custom nodes — at which point n8n hosts none of the state the sync semantics run on.
- **S3–S10 (○):** the stateful sync core — snapshot diffing, identity correlation, baselines/loop prevention, tombstones, conflict resolution, state-convergent idempotency — has no counterpart in n8n ([related-work.md](related-work.md) already noted "no sync semantics"). It would be written as custom nodes calling the mediator's own store: n8n as engine degenerates into n8n as a scheduler around a custom engine.
- **A1–A8 (◐/○):** each consumer operation becomes a generated webhook-trigger workflow (custom paths and header/basic/JWT auth options exist). Serving a whole OpenAPI surface this way is workable but n8n contributes no spec-awareness: `not-yet-mapped`/`mapping-stale` error semantics, consumer-schema response validation (A5) and response caching with event-driven invalidation (A6) are entirely custom.
- **X1 (◐), C6 (◐):** expressions and Code nodes are full JavaScript — not the sandboxed, non-Turing-complete evaluator [security.md](architecture/security.md) requires; [task runners](https://docs.n8n.io/hosting/configuration/task-runners/) add process isolation but not a restricted language. **X2 (✓):** encrypted credential store with OAuth2 refresh and injection into HTTP nodes is genuinely native and close to the `withCredential` discipline. **X3 (◐):** stored execution history is queryable/replayable, but business-level `SyncEvent` statuses remain custom. **X4 (○):** no first-class OpenTelemetry in the community edition. **C4 (✓):** single container + Postgres ([queue mode](https://docs.n8n.io/hosting/scaling/queue-mode/) with Redis/workers exists but is unnecessary at this scale). **C5 (✓):** very large, very active ecosystem.
- **Verdict:** the cells n8n converts are the easy ones (scheduling, HTTP calls, credentials); every differentiating sync row stays `○`, the adapter fit is clumsy, and the license adds a contingency. As a model-(b) substrate it offers less than Temporal (no per-key ordering, no durable execution) while costing the same custom-core work.

### Node-RED — model (a), verdict: no

- **C1 (✓):** Apache-2.0, OpenJS Foundation — no restrictions in either distribution scenario. **C5 (✓):** mature (10+ years), stable governance; innovation cadence is slower than the other candidates'.
- **C2 (✓):** the strongest embeddability story: run [embedded](https://nodered.org/docs/user-guide/runtime/embedding) inside the mediator's own Node.js process and deploy generated flows via the [Admin API `POST /flows`](https://nodered.org/docs/api/admin/methods/post/flows/) (accessed 2026-07-09), with revision checks and partial-deployment types; the editor can be disabled entirely.
- **S1 (✓), S2 (◐):** inject-node intervals are native; cursors can live in a [pluggable persistent context store](https://nodered.org/docs/api/context/). **S11 (○):** no built-in retry/backoff, dead-letter, or stored execution history — catch nodes plus hand-built (or contrib) retry logic. **S12 (◐):** single event loop, but async nodes reorder messages; per-rule ordering must be engineered explicitly.
- **S3–S10 (○):** same verdict as n8n — none of the stateful sync core exists; flow-based programming gives message plumbing, not reconciliation state. **C3 (○):** context stores are key-value caches, not a queryable store for `RecordLink`/`SyncFieldState` that a UI drives manual linking from.
- **A1–A8 (◐/○):** `http-in` nodes per generated flow serve the consumer surface (embedding allows custom auth middleware for A8); everything semantic — aggregation roles, error taxonomy, schema validation, caching/invalidation — is custom function-node code.
- **X1/C6 (◐/○):** function nodes execute arbitrary JavaScript **in the runtime process, unsandboxed** — the sharpest conflict in this evaluation with security.md's non-Turing-complete sandboxed evaluator; credentials are encrypted with a single key in a flat file, well below the Credential Store discipline (X2 ◐). **X3 (○):** no execution history at all. **X4 (○):** no native OpenTelemetry. **C4 (✓):** the lightest footprint here.
- **Verdict:** perfect license, best embeddability — and the least engine. Node-RED brings visual wiring (explicitly a non-criterion) plus HTTP/schedule primitives the mediator's own stack (any Node.js HTTP framework + a job scheduler) provides equally, without the unsandboxed-function-node liability. Under model (b) there is essentially nothing left for it to contribute.

### Apache Camel — model (a) as embedded library, verdict: no as sync engine; credible for the adapter's serving layer

- **C1 (✓):** Apache-2.0. **C5 (✓):** 20+ years under the ASF, active 4.x LTS line.
- **A1 (✓):** the standout cell: the [contract-first REST DSL](https://camel.apache.org/manual/rest-dsl-openapi.html) (accessed 2026-07-09) loads an OpenAPI document at startup and serves every operation, routing each to a `direct:operationId` route — almost literally the Adapter Server Runtime, including trivially returning `not-yet-mapped` from operations whose route has no binding yet. Request validation against the spec is built in; response-side contract validation (A5) needs verification per version and likely custom wiring.
- **A2–A7 (◐):** enterprise integration patterns cover the mechanics well — multicast + aggregation strategies for `fanout-merge`, enrich for chaining, dead-letter channel, [Idempotent Consumer](https://camel.apache.org/components/4.18.x/eips/idempotentConsumer-eip.html) with pluggable repositories (the one candidate with native dedup infrastructure, S10 ◐) — but binding roles, union dedup via `RecordLink`s, pushdown-first parameters, and the error taxonomy are mediator logic in generated routes.
- **C2 (✓):** [route templates](https://camel.apache.org/manual/route-template.html) + `TemplatedRouteBuilder` exist precisely to instantiate parameterized routes programmatically at runtime; embedding as a library gives full lifecycle control (add/suspend/replace routes on mapping events).
- **S1 (✓), S11 (✓), S12 (◐):** timers/schedulers, redelivery policies, and dead-letter channel are native EIPs; per-key ordering needs per-rule route design (or a resequencer). **S2 (◐):** cursor storage in your own repository. **S3–S9 (○):** the sync core is absent, exactly as [related-work.md](related-work.md)'s "overlaps only with the execution layer" says.
- **X1 (◐):** Simple/JSONata-style expression languages are closer to a constrained evaluator than raw JS, though the mediator transform vocabulary is still a custom layer. **X2 (◐):** per-component auth + vault integrations; the `withCredential` discipline is custom. **X4 (✓):** first-class `camel-opentelemetry`. **X3 (○):** logs, not a business event ledger.
- **C4 (◐):** the real cost — a JVM runtime and its ecosystem. The concept is deliberately stack-agnostic, but if the mediator (whose Mapping Engine, UI, and services exist regardless) is built on a non-JVM stack, Camel forces a second stack for the execution layer.
- **Verdict:** the strongest model-(a) candidate for the **adapter engine** and the shared executors; contributes nothing to the sync core. Worth reconsidering if the implementation stack lands on the JVM.

### Temporal — model (b), sync side only, verdict: the credible substrate — if the ops cost is accepted

- **C1 (✓):** server is [MIT](https://github.com/temporalio/temporal/blob/main/LICENSE); no restrictions in either distribution scenario. **C5 (✓):** large production community, commercial backing (Temporal Cloud is optional, not required).
- **S1 (✓), S2 (✓), S11 (✓), S12 (✓):** the four operational rows the workflow tools fumble are Temporal's core product: [Schedules](https://docs.temporal.io/schedules) drive per-rule polling; workflow state is durable by construction (cursors survive anything); retry policies with backoff, unbounded durable retries, and human-in-the-loop intervention are native; a workflow per `(rule, record)` entity gives exactly the per-key sequential ordering S12 specifies. **S9 (◐):** backfill as a long-running, resumable, progress-queryable workflow is a natural fit; its semantics (link-only vs push, baseline seeding) stay custom. **S10 (◐):** deterministic replay preserves computed idempotency keys across crashes and retries; key derivation and `SyncEvent` lookback stay custom.
- **S3–S8 (○), C3 (◐), X1–X3 (○/◐):** everything semantic is still the mediator's code, running inside activities; `RecordLink`/`SyncFieldState` still need the external queryable store (workflow state can't serve the UI's manual-linking and conflict views), so Temporal replaces the *scheduler/queue/retry* layer of the custom engine — not its brain, not its state model. **X4 (◐):** SDK/server metrics and tracing interceptors exist; correlation to `SyncEvent`s is custom.
- **A1–A8 (n/a):** no HTTP serving; the adapter engine is untouched by this candidate.
- **C2 (✓):** everything is API-driven (schedules, signals, termination); note one structural shift: rather than generating a workflow *definition* per mapping (workflow code must be deterministic and versioned), the natural pattern is **one generic sync workflow program parameterized by `ApprovedMapping` data** — which is arguably cleaner than flow generation anyway. **C4 (◐):** the heaviest footprint in this comparison — the [self-hosted service](https://docs.temporal.io/self-hosted-guide) (accessed 2026-07-09) is a multi-service deployment over Postgres/Cassandra plus worker processes, measured against a concept that deliberately accepts a single instance with supervised restart. **C6 (○):** neutral — Temporal never touches credentials or transforms; the custom design applies unchanged.
- **Verdict:** the only candidate that de-risks a hard part of the custom build (durable per-record execution) instead of the easy part. The trade is pure ops weight versus a hand-rolled scheduler/queue at 15–20-app scale.

### KrakenD — model (a), adapter side only, verdict: covers real adapter ground, blocked by dynamism gaps

- **C1 (✓):** Apache-2.0 (KrakenD-CE and the underlying Lura framework, a Linux Foundation project); enterprise-only features exist but the aggregation core is CE. **C5 (✓):** established, smaller community than the others. **C4 (✓):** single static Go binary, stateless, no database — the lightest ops profile here.
- **A1 (✓), A3 (◐):** endpoints are declarative JSON config — generated from the consumer spec and `AdapterBinding`s, which suits C2's generate-don't-hand-build rule; parallel backend fan-out with object merging is the flagship feature and maps directly to `fanout-merge`, and the [sequential proxy](https://www.krakend.io/docs/endpoints/sequential-proxy/) (accessed 2026-07-09) covers `dependsOnBindingId` chaining. Gaps: `collection-union` dedup via `RecordLink`s (plugin + mediator lookup), `fanout-first-success` (no native fallback chain), role/strictness semantics (custom).
- **A4 (◐):** response manipulation (mapping/renaming/filtering/flatmap) is native and — being declarative rather than a scripting language — pleasantly close to X1's non-Turing-complete constraint (X1 ◐); `coerce`/`expression` transforms exceed it, needing plugins. **A5 (◐):** status handling exists; the error taxonomy and consumer-schema response validation are plugin work. **A6 (◐):** TTL-based [backend caching](https://www.krakend.io/docs/backends/caching/) is native, but there is no selective, event-driven invalidation path for SyncEvent/write signals. **A7 (◐):** single-backend write proxying is trivial; idempotency-key derivation is custom. **A8 (✓):** JWT validation is CE-native — mediator-issued adapter tokens fit directly. **X4 (✓):** native [OpenTelemetry](https://www.krakend.io/docs/telemetry/opentelemetry/).
- **C2 (◐):** the structural catch — configuration is immutable at runtime, loaded at startup; every `MappingApproved`, staleness event, or composition change means regenerating config and rolling a restart. Manageable (blue/green restarts of a stateless binary are cheap) but it turns the adapter's mapping-event reactivity into a deploy pipeline. **C3 (○)/X2 (◐)/X3 (○):** stateless by design; anything stateful (dedup lookups, `SyncEvent`s, credential brokering beyond static config) calls back into mediator services.
- **Verdict:** the best power-to-weight ratio for the adapter's serving/merging layer, at the cost of restart-based reconfiguration and plugins for exactly the mediator-specific semantics. A serious option for *inside* a custom adapter engine's runtime rather than instead of it.

## Comparative reading

The matrix has a clean fault line, and it is exactly the model-(a)-vs-(b) divide:

- **Rows S3–S10 are `○` in every column.** Snapshot diffing, `RecordLink` correlation, `SyncFieldState` baselines and loop prevention, tombstones, conflict resolution, state-convergent idempotency — no surveyed tool has these concepts, because they only make sense in a system that owns cross-app record identity over time. Adopting any workflow tool as "the sync engine" (model a) means writing all of it anyway, as custom nodes wrapped around an external state store — the tool shrinks to a scheduler wearing an engine costume.
- **What generic workflow tools do convert (S1, parts of S11/S12, X2) is the cheap 20%** — scheduling, HTTP execution, credentials — available in any stack's libraries. n8n and Node-RED, the two candidates the evaluation started from, convert the least differentiating rows while adding a license contingency (n8n) or a sandboxing conflict (Node-RED).
- **The specialized candidates each cover one engine's substrate well and the other not at all** — Temporal the sync side's operational shell, Camel/KrakenD the adapter's serving/aggregation layer. No tool spans both, which mirrors the concept's own observation that the two engines share only their inputs (`ApprovedMapping`) and executors.

## Recommendation

**Keep both engines custom (model c) as specified in the architecture docs — the premise that a workflow tool could take over the engines so the project "focuses solely on mapping creation" does not survive the matrix.** The sync engine's stateful core is as much the product's substance as mapping creation is; there is no tool to delegate it to.

Two narrower adoptions are worth keeping on the table, both deferred rather than rejected:

1. **Temporal as the sync engine's execution substrate (model b)** — replaces the custom scheduler/queue/retry/ordering plumbing with a proven durable-execution layer while all semantics stay in mediator code. Adopt if the implementation phase shows the hand-rolled substrate (per-record queues, crash recovery, backfill resumability) becoming a project of its own; skip if the single-instance deployment makes a simple DB-backed job queue sufficient at this scale.
2. **Camel (JVM stack) or KrakenD (any stack) inside the adapter engine** — contract-first spec serving respectively declarative fan-out/merge cover a real fraction of Group A. Decide when the implementation stack is chosen; neither touches the sync engine either way.

## Decision status & revisit triggers

Open input: **internal use vs. commercial distribution is undecided.** It doesn't change the recommendation (the decisive rows are license-independent), but it decides whether n8n would even be licensable as a component — resolve it before any n8n adoption, and before choosing between "ship the mediator with bundled third-party services" postures generally.

Re-open this evaluation when:

- the implementation stack is chosen (JVM ⇒ re-weigh Camel; Node.js ⇒ re-check the "own HTTP framework beats Node-RED" reasoning),
- the sync substrate proves harder than expected in implementation (⇒ Temporal, trigger 1 above),
- a webhook change detector is added per [extensibility.md](architecture/extensibility.md) (S1's weight drops, inbound-surface criteria appear),
- the scale assumption in [overview.md](architecture/overview.md) breaks (throughput becomes a criterion), or
- a candidate ships native sync-state semantics (any S3–S10 row would move — none has since [related-work.md](related-work.md)'s survey).

## Adding a candidate

1. Add a column to the matrix; rate every row under one declared adoption model, named in the header (`n/a` for rows outside its scope).
2. Add a per-candidate assessment section: evidence notes keyed by criterion ID for every non-`✓` cell, sources with access dates for license/capability claims, and a verdict that also addresses the alternative adoption model.
3. Check the gating rows (C1, C2) first — a `✗` there settles model (a) before the rest of the column is worth filling in.
4. Update the research date if the pass re-verified existing columns.
