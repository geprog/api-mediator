# Scenario 1 — small overlap (Gitea + Vikunja)

Two real apps whose specs overlap on a small, genuine slice — issues↔tasks,
labels↔labels, users↔users — while the bulk of both specs (git plumbing,
kanban views, tokens, …) has no counterpart. This is the shortlist-precision
scenario: of Gitea's 467 operations and Vikunja's 160, only a handful of
resource pairs should survive the mapping-detection shortlist.

| App | Image | Host port | API base | Spec |
|---|---|---|---|---|
| Gitea | `gitea/gitea:1.25.5` | 11300 | `http://localhost:11300/api/v1` | live: `/swagger.v1.json` |
| Vikunja | `vikunja/vikunja:2.3.0` | 11400 | `http://localhost:11400/api/v1` | live: `/api/v1/docs.json` |

## Run

```bash
docker compose up -d --wait   # start the landscape
./bootstrap.sh                # admin users + API tokens -> .tokens.env
./seed.sh                     # overlapping fixture data (idempotent)
```

Registering with the mediator (once one exists): both specs are PROVIDER
specs; the vendored copies live in `specs/` so detection runs don't need the
containers at all. `specs/trimmed/` (Gitea 84 ops, Vikunja 30 ops) keeps the
full overlap story at a fraction of the LLM cost; `specs/oas3/` holds OAS 3.0
conversions of both variants (originals are Swagger 2.0). Rebuild everything
with `../shared/build-specs.sh .` while the landscape is running;
`../shared/fetch-specs.sh . --check` fails loudly if an image bump drifted a
live spec away from the vendored copy.

## Seeded data (see `../shared/fixtures.env`)

- Users `alice`/`bob` (same usernames + emails in both apps) — identity keys.
- Container `phoenix`: a Gitea repo and a Vikunja project.
- Three shared work items (identity = title), including one closed/done item
  ("Prepare Q3 release") to exercise the `state: open|closed` ↔
  `done: boolean` coercion.
- Labels `bug`/`docs` with matching colors (`color` ↔ `hex_color`).
- One app-unique item on each side ("Refactor CI pipeline" only in Gitea,
  "Water the office plants" only in Vikunja) so sync/detection has honest
  non-overlap.

## Expected mappings

Machine-readable ground truth: [ground-truth.yaml](ground-truth.yaml).
Summary of what a correct detection run should find:

| Gitea | Vikunja | Notable transforms |
|---|---|---|
| issues | tasks | `body`→`description`, `state`→`done` (enum→bool), `updated_at`→`updated`, `labels[].name`→`labels[].title` |
| issue-comments | task-comments | `body`→`comment`; no natural identity key — SyncRule must stay blocked |
| labels | labels | `name`→`title`, `color`→`hex_color` |
| users | users | `login`→`username`, `full_name`→`name`; `email` direct |

And what it must not confidently propose: repositories↔projects (structural
analogs, semantically different), milestones↔buckets (deadline grouping vs
kanban column), plus the no-counterpart resources on both sides — see the
`negatives` section of the YAML for verdicts and rationale.

## Concept probes built into this scenario

- **Constant path parameters**: every Gitea issue operation needs
  `{owner}/{repo}` fixed to `alice/phoenix`; Vikunja's project-scoped ops need
  `{id}`. The concept must answer how a ResourceBinding pins these (the
  global `GET /repos/issues/search` and `GET /tasks` are the param-free
  alternatives).
- **Verb semantics**: Vikunja creates with PUT and updates with POST —
  CRUD-action classification must come from semantics, not verb convention.
- **Spec messiness**: both as-served specs violate the strict OpenAPI schema
  in places (see `../shared/validate-specs.sh`) — ingestion has to be tolerant
  of exactly this.
