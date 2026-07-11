# Local development environment

This sets up the infrastructure the API Mediator needs to run locally: a
**PostgreSQL** database, a **Grafana + OpenTelemetry** stack for telemetry, and
a **local LLM** (via Ollama) backing the Mapping Engine. The mediator
application itself runs on the host.

> The product concept is in `docs/` and is the source of truth. This file only
> covers the local dev environment.

## Prerequisites

- Docker (with the Compose plugin) — for Postgres and Grafana
- [Ollama](https://ollama.com) running on the host — for the Mapping Engine LLM

## 1. Configuration

```bash
cp .env.example .env
```

`.env` (git-ignored) holds the Postgres credentials and the Mapping Engine LLM
settings. The defaults work out of the box; see the comments in
[.env.example](.env.example) for what each value does.

## 2. Database

```bash
docker compose up -d          # start Postgres in the background
docker compose ps             # check health
docker compose down           # stop (data is kept in the named volume)
docker compose down -v        # stop and wipe the database
```

Postgres listens on `localhost:${POSTGRES_PORT:-5432}`. If a Postgres is already
using 5432, set `POSTGRES_PORT` (and the port in `DATABASE_URL`) in `.env`.

## 3. Observability (Grafana)

`docker compose up -d` also starts a **Grafana** container backed by the
all-in-one [`grafana/otel-lgtm`](https://github.com/grafana/docker-otel-lgtm)
stack — an OpenTelemetry Collector plus Prometheus (metrics), Tempo (traces) and
Loki (logs), with Grafana and its datasources pre-provisioned. It stands in for
the full `Collector → stores → Grafana` pipeline described in
[docs/architecture/observability.md](docs/architecture/observability.md) as a
single dev container.

Open the dashboards at **http://localhost:${GRAFANA_PORT:-3000}** (anonymous
admin access; no login). If the mediator's own dev server needs port 3000, set
`GRAFANA_PORT` in `.env`.

The mediator (running on the host) exports OTLP to the container's published
receivers on `4317` (gRPC) and `4318` (HTTP); `OTEL_EXPORTER_OTLP_ENDPOINT` in
`.env` points at the HTTP one. Telemetry is not on any business-logic critical
path — the mediator runs fine with this container stopped. The container's
`/data` (Grafana dashboards plus the Prometheus/Tempo/Loki stores) persists in
a named volume across `docker compose down`; `down -v` wipes it and starts from
the image's provisioned dashboards again.

## 4. Mapping Engine model

The Mapping Engine is provider-agnostic — the core depends only on the
`LLMMappingProvider` interface plus a response-schema validator (see
[docs/architecture/mapping-engine.md](docs/architecture/mapping-engine.md)). For
local development it is backed by a self-hosted open-weight model served by
Ollama, selected with `MAPPING_LLM_PROVIDER=ollama`.

> **Default model:** `MAPPING_LLM_MODEL` now defaults to `gemma4:26b`, which
> produces valid, recall-biased shortlists where glm-4.7-flash is too weak, at
> the cost of slower CPU inference (a detail call can take a minute-plus);
> glm-4.7-flash (below) stays selectable for fast, lower-accuracy iteration.

Pull the default model once:

```bash
ollama pull gemma4:26b
```

### Why glm-4.7-flash

The two mapping stages don't generate code — they read decomposed OpenAPI specs
and emit **fixed structured JSON** (a `ResourceShortlist`, then a
`MappingSuggestionSet`), validated against schemas with corrective retries. What
matters is reasoning quality over schemas and reliable structured output, not
raw code-completion skill.

- **~30B MoE, reasoning model.** Only a fraction of parameters are active per
  token, so it stays usable on CPU (no GPU required) while reasoning well enough
  to be recall-biased on the shortlist stage — the property the concept leans on
  most (a missed pair is never proposed at all).
- **Clean structured output.** Its private reasoning arrives on a separate
  `thinking` channel; `message.content` stays pure JSON, and it honors Ollama's
  schema-constrained decoding — so the provider can pass each stage's JSON
  schema as Ollama's `format` and read `message.content` directly.
- **Fits the box.** The Q4_K_M build is ~19 GB and runs comfortably in host RAM.

**Performance note:** on CPU this generates at ~15–20 tok/s. A shortlist call
takes tens of seconds; a full detail call with schemas can take one to a few
minutes. That is fine — mapping is an asynchronous, human-reviewed flow, not a
request-path operation — but it is why `MAPPING_LLM_REQUEST_TIMEOUT_MS` defaults
high. Set `MAPPING_LLM_THINKING=false` to roughly halve per-call latency while
iterating, at some cost to shortlist recall.

### Switching models

Point `MAPPING_LLM_MODEL` at any model you have pulled. Whatever you pick must
(a) follow the required JSON schemas reliably and (b) be an **instruct/chat**
model — a `*-base` completion model will not follow the prompt structure and is
not suitable. The chosen `providerId` and `model` are recorded on every
`MappingProposal.generatedBy`.

## 5. Verify the model end to end

With Ollama running and the model pulled:

```bash
curl -s http://localhost:11434/api/chat -d '{
  "model": "glm-4.7-flash:latest",
  "stream": false,
  "options": { "temperature": 0 },
  "format": {
    "type": "object",
    "properties": { "candidatePairs": { "type": "array", "items": {
      "type": "object",
      "properties": {
        "sourceResource": { "type": "string" },
        "targetResource": { "type": "string" },
        "confidence": { "type": "number" },
        "rationale": { "type": "string" }
      },
      "required": ["sourceResource","targetResource","confidence","rationale"]
    } } },
    "required": ["candidatePairs"]
  },
  "messages": [
    { "role": "system", "content": "You shortlist plausibly-corresponding API resource pairs. Be recall-biased." },
    { "role": "user", "content": "Source resources: Customers, Invoices. Target resources: Contacts, Bills. Shortlist corresponding resource pairs." }
  ]
}' | python3 -c "import sys,json; print(json.load(sys.stdin)['message']['content'])"
```

You should get schema-valid JSON pairing `Customers↔Contacts` and
`Invoices↔Bills`. That confirms Ollama, the model, and schema-constrained
decoding are all working the way the Mapping Engine will drive them.
