# Phase 6 — Observability (metrics, dashboards, alerting)

The full [observability.md](../architecture/observability.md) surface, made real. OpenTelemetry
instrumentation is a cross-cutting concern already partly present; Phase 6 inventories what exists, fills
the **business-metric** gaps (chiefly the Sync Engine), and stands up the four Grafana **dashboards** and
the **alerting** rules — several of which fire on the lifecycle transitions Phase 6 introduced (SL-4
staleness, CO-1/SL-7 `composition-required`).

**What already exists vs. what Phase 6 adds** (checked against `packages/telemetry/src/index.ts`,
`apps/backend/src/http/adapter-runtime/adapter-telemetry.ts`,
`apps/backend/src/modules/detection/telemetry.ts`):

- **Bootstrap** — `@mediator/telemetry` (`startTelemetry`/`getMeter`/`getTracer`/`getActiveTraceContext`,
  OTLP exporters, Node auto-instrumentation, `traceId`/`spanId` on `SyncEvent`/`AuditLog`) — **built**;
  clean no-op when disabled.
- **Adapter Engine metrics** — `adapter.request.count` (outcome/cause), `adapter.request.duration`,
  `adapter.request.degraded.count`, `adapter.request.cache_hit.count`/`cache_miss.count`, per endpoint —
  **built** (`AdapterTelemetry`); covers observability.md's Adapter row in full.
- **Mapping Engine metrics** — `mapping.detection.llm_call.{duration,attempts,count}`,
  `mapping.detection.llm.tokens` (per provider/stage), `mapping.detection.retry_ceiling.count`,
  `mapping.detection.shortlist.yield` — **built** (`createDetectionMetricsSink`).
- **Traces** — one trace per adapter request (`AdapterTelemetry.tracer`) and per detection run — **built**;
  the sync-execution reconciler exposes optional metrics ports (currently no-op).

**Gaps Phase 6 fills** (specified but not emitted): the entire **Sync Engine metric row** (per-`SyncRule`
success/failure/skipped-loop/skipped-policy/conflict; poller lag; backfill progress/duration;
identity-resolution failure rate); the Mapping row's **escape-hatch usage**, **analysis-scope
exclusions/re-inclusions**, **review queue depth**, **average confidence trend**; the **Landscape-health**
per-app signals; the four **Grafana dashboards**; and the **alerting** rules. Every new business metric
follows the existing sinks' pattern (pure reading functions + a thin OTel adapter that **no-ops when
telemetry is disabled** — telemetry is never on a business-critical path).

**Actor:** system (instrumentation emits); operator (reads dashboards, receives alerts). No mutation.

**Concept references (whole file):** [observability.md](../architecture/observability.md) (all sections —
*Instrumentation*: Traces/Metrics/Logs; *Grafana dashboards*; *Alerting*; *Relationship to the
Audit/Event Log*); [sync-engine.md](../architecture/sync-engine.md) (the sync outcomes/lag/backfill/
identity-resolution the metrics count); [extensibility.md](../architecture/extensibility.md) (the
staleness asymmetry the alerts encode); [graph-overview.md](../flows/graph-overview.md) *Relationship to
the Grafana landscape-health dashboard*; [glossary.md](../glossary.md) `OpenTelemetry`, `Grafana`,
`Trace / span`. Reused seams: existing `AdapterTelemetry`, `createDetectionMetricsSink`,
`SyncExecutionReconcilerMetrics` ports; the provisioned `ops/grafana/` `api-mediator-health` dashboard.

> **Authoritative:** OTel is a **complementary operational layer**, never on any business-critical path (the
> mediator functions with the telemetry pipeline down); the mediator depends only on the OTel SDK/API,
> never a specific backend (swappable behind the Collector); every `SyncEvent`/`AuditLog` carries a
> `traceId`/`spanId`; the four dashboard groupings and the alert conditions are as enumerated in
> observability.md. **Implementation choice:** metric instrument names/units, alert thresholds
> (config-defined; open question 9), dashboard JSON/layout, label cardinality within the "ids and enums
> only, never payload values" rule.

---

## OB-1 — Sync Engine business metrics

**As a** landscape operator, **I** can see per-`SyncRule` outcome rates, poller lag, backfill progress, and
identity-resolution failures, **so that** I can tell a healthy sync relationship from a stuck or
misbehaving one before a consumer notices.

### Acceptance criteria

1. **Given** a sync execution settles, **when** metrics are emitted, **then** a per-`SyncRule` counter
   records its outcome across **success / failure / skipped-loop / skipped-policy / conflict** — the exact
   status set the `SyncEvent` already carries — labeled by rule id
   ([observability.md](../architecture/observability.md) *Metrics* — Sync Engine; Phase-4 SD-4).
2. **Given** a rule's polling, **when** poller lag is computed, **then** a per-`SyncRule` metric exposes
   time since `lastRunAt` vs. the expected interval, so a stuck poller is observable — the signal the
   stuck-poller alert (OB-5) reads ([observability.md](../architecture/observability.md) *Metrics*,
   *Alerting*).
3. **Given** an initial backfill, **when** it runs, **then** its **progress and duration** are observable
   (a running/percent gauge + a completed-duration measurement) per rule
   ([observability.md](../architecture/observability.md) *Metrics*).
4. **Given** Identity Resolution, **when** it fails to resolve a record, **then** the **failure rate** is
   emitted split by cause — **no-match** vs. **ambiguous-match** — since those drive different operator
   actions (manual link vs. disambiguation) ([observability.md](../architecture/observability.md)
   *Metrics*; [sync-engine.md](../architecture/sync-engine.md)).
5. **Given** the metric emission is off any business-critical path, **when** telemetry is **disabled**,
   **then** every sink no-ops cleanly (via `getMeter`'s no-op meter) and sync runs identically — the
   established pattern (`createDetectionMetricsSink`, `AdapterTelemetry`).
6. **Given** every label, **when** a metric is emitted, **then** it carries only **ids/enums** (rule id,
   outcome, cause) — **never** a record payload, credential, or token
   ([observability.md](../architecture/observability.md) *Instrumentation*; the RT-5.5 discipline).
7. **Given** a per-metric pure reading function (mirroring `shortlistYieldReadings`), **when** it is
   extracted, **then** the outcome→counter mapping is unit-testable against a fake meter with no engine
   running.

### Out of scope

- Dashboards/alerts that consume these — OB-4/OB-5. Adapter/Mapping metrics — already built.

### Dependencies

Blocked by Phase-4 SD-4/SP-*/RL-*/BE-* (the executions/lag/backfill/identity-resolution being measured).
Precedes OB-3, OB-4, OB-5. May wire the existing `SyncExecutionReconcilerMetrics` ports.

---

## OB-2 — Mapping Engine metric gaps

**As a** landscape operator, **I** can see escape-hatch usage, analysis-scope exclusions/re-inclusions,
review-queue depth, and the confidence trend, **so that** I can tell whether the two-stage detection is
healthy and whether proposals are being reviewed fast enough.

### Acceptance criteria

1. **Given** a manually-triggered detail analysis (the review-UI **escape hatch**), **when** it runs,
   **then** an **escape-hatch usage rate** metric increments — frequent use means stage-1 recall is too
   low, the key health signal of the two-stage design
   ([observability.md](../architecture/observability.md) *Metrics* — Mapping Engine).
2. **Given** a spec's `analysisExclusions`, **when** analysis scope is observed, **then** **analysis-scope
   size** (resource groups excluded per spec) and **re-inclusion-triggered analyses** (SL-9) are countable
   ([observability.md](../architecture/observability.md) *Metrics*).
3. **Given** the review queue, **when** its depth is measured, **then** **pending proposals** and items
   flagged `reviewRequired` are exposed — the signal the "review queue growing unbounded" alert (OB-5)
   reads ([observability.md](../architecture/observability.md) *Metrics*, *Alerting*).
4. **Given** produced proposals, **when** their confidence is aggregated, **then** an **average confidence
   score trend** is observable ([observability.md](../architecture/observability.md) *Metrics*).
5. **Given** these extend the **existing** `createDetectionMetricsSink`, **when** they are added, **then**
   they reuse its per-provider labeling and no-op-when-disabled pattern — not a parallel sink
   (`apps/backend/src/modules/detection/telemetry.ts`).
6. **Given** an analysis **failure** distinction, **when** a detail call hits `analysisFailed` or a
   shortlist call fails the whole proposal (`MappingProposal.status = failed`), **then** it is emitted
   distinctly from a normal low-confidence proposal (extending the existing
   `mapping.detection.retry_ceiling.count`), so the analysis-retry-ceiling alert (OB-5) can surface it
   without it being lost in the queue ([observability.md](../architecture/observability.md) *Alerting*).

### Out of scope

- The already-built LLM latency/token/shortlist-yield metrics. Dashboards/alerts — OB-4/OB-5.

### Dependencies

Blocked by Phase-2 (proposals/shortlist/escape hatch), Phase-3 RA-5 (escape hatch), SL-9 (re-inclusion).
**Extends the existing detection metrics sink.** Precedes OB-4, OB-5.

---

## OB-3 — Landscape-health and lifecycle-state metrics

**As a** landscape operator, **I** can see per-app sync status, last successful sync time, and error rate
over time, plus the lifecycle-state gauges the tighter alerts need, **so that** the Grafana landscape-health
view is a true operational companion to the in-app structural graph.

### Acceptance criteria

1. **Given** each `RegisteredApp`, **when** landscape-health metrics are emitted, **then** **per-app sync
   status**, **last successful sync time**, and **error rate** are observable — the operational-health
   companion to the Graph Service's structural view
   ([observability.md](../architecture/observability.md) *Grafana dashboards* — Landscape health;
   [graph-overview.md](../flows/graph-overview.md) *Relationship to the Grafana landscape-health
   dashboard*).
2. **Given** an `AdapterBinding`'s `ApprovedMapping` transitions to **`stale`** (SL-4), **when** it does,
   **then** a metric/state makes "an **active** binding's mapping is now stale" observable — the input the
   tight-threshold stale-binding alert (OB-5) reads, distinct from a paused `SyncRule`'s staleness
   ([observability.md](../architecture/observability.md) *Alerting*;
   [extensibility.md](../architecture/extensibility.md) — the asymmetry).
3. **Given** an `AdapterEndpoint` sitting in **`composition-required`** (CO-1 second binding, or SL-7
   adoption flagging a broken config), **when** it persists, **then** the time-in-state is observable — the
   input the composition-required-aged alert (OB-5) reads
   ([observability.md](../architecture/observability.md) *Alerting*; CO-1.3, CO-7.4).
4. **Given** a sync write is **parked** (dead-letter) after exhausting its retry ceiling, **when** it is,
   **then** it is observable, feeding the parked-write alert (OB-5)
   ([observability.md](../architecture/observability.md) *Alerting*; [glossary.md](../glossary.md) `Parked
   (dead-letter) event`).
5. **Given** the metrics derive from durable business records where appropriate, **when** last-successful-
   sync / stale-binding state is computed, **then** it can read the **Audit/Event Log** (which other
   components already read) — distinct from, and complementary to, OTel
   ([observability.md](../architecture/observability.md) *Relationship to the Audit/Event Log*).
6. **Given** all labels, **when** emitted, **then** ids/enums only — never payload values (OB-1.6).

### Out of scope

- The dashboard/alert definitions — OB-4/OB-5 (this story emits the metrics they read). The in-app
  structural graph — GR-* (complementary, not this).

### Dependencies

Blocked by OB-1, SL-4/SL-7 (staleness/composition-required transitions), Phase-4 (parked writes), Phase-5
CO-1/CO-7 (`composition-required`). Precedes OB-4, OB-5.

---

## OB-4 — Grafana dashboards (provisioned)

**As a** landscape operator, **I** have the four dashboards observability.md specifies, provisioned as
code, **so that** monitoring is reproducible and every panel is backed by a metric the mediator actually
emits.

### Acceptance criteria

1. **Given** provisioned dashboards, **when** Phase 6 ships, **then** there are four dashboard groupings —
   **Landscape health**, **Sync engine**, **Adapter engine**, **Mapping engine** — as provisioned
   artifacts under `ops/grafana/` alongside the existing `api-mediator-health` dashboard
   ([observability.md](../architecture/observability.md) *Grafana dashboards*).
2. **Given** the **Sync engine** dashboard, **when** it is defined, **then** its panels reference
   poll-run throughput, poller lag per `SyncRule`, loop-prevention skip rate, and conflict rate — every one
   backed by an OB-1 metric name ([observability.md](../architecture/observability.md) *Grafana
   dashboards*).
3. **Given** the **Adapter engine** dashboard, **when** it is defined, **then** its panels reference request
   rate/latency/error rate per `AdapterEndpoint`, cache hit rate, and partial-failure/degraded rate — every
   one backed by an **already-emitted** `AdapterTelemetry` metric name.
4. **Given** the **Mapping engine** dashboard, **when** it is defined, **then** its panels reference LLM
   latency/error/token usage per provider and stage, shortlist yield, escape-hatch usage, analysis-scope
   exclusions/re-inclusions, proposals pending review, and average confidence trend — backed by the
   existing detection metrics plus OB-2.
5. **Given** the **Landscape health** dashboard, **when** it is defined, **then** its panels reference
   per-app sync status, last successful sync time, and error rate — backed by OB-3 — and it is documented as
   the operational-over-time companion to the in-app graph (GR-6.6).
6. **Given** each panel references a metric, **when** a **static consistency check** runs, **then** every
   metric name referenced by a provisioned dashboard **exists among the instruments the mediator emits**
   (the testable oracle for "the dashboard is backed by real metrics"; open question 10) — a dashboard may
   not reference a metric no component emits.

### Out of scope

- Choosing the metrics backend (Prometheus/Tempo/Loki) — the mediator depends only on the OTel SDK/API;
  the stack is swappable behind the Collector ([observability.md](../architecture/observability.md)
  *Pipeline*). Ad-hoc/exploratory dashboards.

### Dependencies

Blocked by OB-1, OB-2, OB-3, and the existing adapter/mapping metrics. Precedes OB-5 (alerts sit on the
same metrics).

---

## OB-5 — Grafana alerting rules

**As a** landscape operator, **I** am alerted on the conditions observability.md enumerates — with the
stale-binding case at a tighter threshold than sync staleness — **so that** an externally-visible failure
gets attention faster than a paused background job.

### Acceptance criteria

1. **Given** the alert rules, **when** Phase 6 ships, **then** provisioned Grafana alerting rules cover:
   a **stuck poller** (a `SyncRule` with no successful poll past N× its expected interval); an
   **`AdapterEndpoint` error rate** over threshold; the **mapping review queue growing unbounded**; a
   **mapping analysis at its retry ceiling** (detail `analysisFailed`, or the more-urgent shortlist
   `MappingProposal.status = failed`); a **parked sync write**; and any **`mediator-transform-error`**
   occurrence ([observability.md](../architecture/observability.md) *Alerting*).
2. **Given** a **stale `AdapterBinding`** — an active binding's `ApprovedMapping` transitioning to `stale`
   (SL-4) — **when** the alert fires, **then** it uses a **tighter** threshold (e.g. immediately) than the
   sync-staleness alert, because a stale binding is an active, externally-visible failure for a live caller
   right now, not a paused background job ([observability.md](../architecture/observability.md) *Alerting*;
   [extensibility.md](../architecture/extensibility.md) — the asymmetry; OB-3.2).
3. **Given** an **`AdapterEndpoint` sitting in `composition-required`** longer than a threshold (a newly
   approved binding or an adoption-flagged config awaiting a human composition decision), **when** it
   persists, **then** an alert fires ([observability.md](../architecture/observability.md) *Alerting*;
   OB-3.3, CO-1.3/CO-7.4).
4. **Given** the stuck-poller alert, **when** it is defined, **then** it covers **every** rule uniformly —
   polling being the only change-detection transport means this staleness signal has no silent transport
   whose inactivity is indistinguishable from "no changes"
   ([observability.md](../architecture/observability.md) *Alerting*).
5. **Given** every threshold (N× interval, error-rate %, queue depth, composition-required duration),
   **when** the rules are defined, **then** each is **config-defined** with a conservative default, not
   hard-coded (open question 9).
6. **Given** each alert rule references a metric, **when** the OB-4 static consistency check runs, **then**
   every metric an alert rule reads **exists among the emitted instruments** (the same testable oracle) —
   no alert sits on a metric no component emits.

### Out of scope

- Notification routing/channels (paging, email) — operational configuration outside the mediator's
  requirement surface. On-call policy.

### Dependencies

Blocked by OB-1, OB-2, OB-3, OB-4, and SL-4/CO-1/CO-7 (the transitions the lifecycle alerts fire on). The
phase's monitoring capstone.
