# Scenario 3 — one provider, one consumer (Vikunja + todo-widget)

The minimal adapter scenario: Vikunja is the only running backend (PROVIDER
spec), and `specs/consumer/todo-widget.yaml` is a hand-written CONSUMER spec —
the API a small dashboard widget *wishes existed*. Per the concept the mediator
hosts that API itself as a virtual provider and resolves calls against Vikunja;
the consumer is deliberately **not** a container (host port 13900 is reserved
for the mediator's adapter server).

| App | Image | Host port | API base | Spec |
|---|---|---|---|---|
| Vikunja | `vikunja/vikunja:2.3.0` | 13400 | `http://localhost:13400/api/v1` | live: `/api/v1/docs.json` |
| todo-widget (consumer) | — | 13900 (reserved) | — | `specs/consumer/todo-widget.yaml` |

## Run

```bash
docker compose up -d --wait   # start Vikunja
./bootstrap.sh                # admin user + API token -> .tokens.env
./seed.sh                     # fixture tasks (idempotent)
../shared/build-specs.sh .    # vendor/refresh provider specs
```

## What this scenario tests

Consumer-provider mapping mechanics (docs/architecture/adapter-engine.md,
data-model.md): one mapping covering both halves of a round trip via `request`
and `response` phase transforms, ParameterMappings for path/query params, and
single-binding writes. The consumer's field shapes are deliberately skewed
against Vikunja's:

| todo-widget | Vikunja `models.Task` | Transform |
|---|---|---|
| `todoId: string` | `id: int` | coerce |
| `name` | `title` | rename |
| `notes` | `description` | rename |
| `done: boolean` | `done: boolean` | direct |
| `due` | `due_date` | rename |
| `updatedAt` | `updated` | rename |

Ground truth incl. operation bindings and phase-separated transforms:
[ground-truth.yaml](ground-truth.yaml).

## Concept probes built into this scenario

- **Param-free binding choice**: `GET /todos` should bind to the global
  `GET /api/v1/tasks`, not the project-scoped list — the latter would leave
  `{id}` without a consumer-side counterpart (no constant-parameter binding
  exists for adapter reads).
- **Request-phase constant**: `POST /todos/{todoId}/complete` has no body; the
  backend update must synthesize `done=true` as an expression transform.
- **Filter-language mismatch**: the consumer's typed `done` query param vs
  Vikunja's `filter` query language — expected to surface as low-confidence or
  unmapped rather than a clean ParameterMapping.
- **Note**: Vikunja 2.x removed `GET /tasks/all` (0.x); the global list is
  `GET /api/v1/tasks`. Ground truth tracks the vendored 2.3.0 spec.
