# Local development environment

This sets up the two pieces of infrastructure the API Mediator needs to run
locally: a **PostgreSQL** database and a **local LLM** (via Ollama) backing the
Mapping Engine. The mediator application itself runs on the host.

> The product concept is in `docs/` and is the source of truth. This file only
> covers the local dev environment.

## Prerequisites

- Docker (with the Compose plugin) — for Postgres
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

## 3. Mapping Engine model

The Mapping Engine is provider-agnostic — the core depends only on the
`LLMMappingProvider` interface plus a response-schema validator (see
[docs/architecture/mapping-engine.md](docs/architecture/mapping-engine.md)). For
local development it is backed by a self-hosted open-weight model served by
Ollama, selected with `MAPPING_LLM_PROVIDER=ollama`.

Pull the default model once:

```bash
ollama pull glm-4.7-flash
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

## 4. Verify the model end to end

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
