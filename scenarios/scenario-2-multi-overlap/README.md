# Scenario 2 — multiple overlaps (Gitea + Vikunja + Wekan + Keycloak)

Four apps from four domains — git forge, task management, kanban, identity —
with an overlap *web* rather than a single pair: work items exist in three
apps (issues/tasks/cards), users in all four, project containers in three
(repo/project/board). Six spec pairs with overlap strength ranging from rich
(Vikunja↔Wekan) over partial (Gitea↔Vikunja) to users-only (Keycloak↔anything).

| App | Image | Host port | API base | Spec |
|---|---|---|---|---|
| Gitea | `gitea/gitea:1.25.5` | 12300 | `/api/v1` | live: `/swagger.v1.json` |
| Vikunja | `vikunja/vikunja:2.3.0` | 12400 | `/api/v1` | live: `/api/v1/docs.json` |
| Wekan (+Mongo 7) | `wekanteam/wekan:v9.57` | 12500 | `/api` | vendored: `wekan.fi/api/v9.57/wekan.yml` |
| Keycloak | `quay.io/keycloak/keycloak:26.7.0` | 12600 | `/admin/realms/master` | vendored: `keycloak.org/docs-api/26.7.0/rest-api/openapi.json` |

Wekan and Keycloak don't serve their specs — the pinned image tags and the
published spec URLs are kept in step via `.env` (that's the whole reason the
tags are pinned where they are).

## Run

```bash
docker compose up -d --wait   # start the landscape (Mongo runs as 1-node replica set)
./bootstrap.sh                # users + API tokens -> .tokens.env
./seed.sh                     # optional: overlapping fixture data for sync tests
../shared/build-specs.sh .    # vendor/refresh all four specs
```

All four specs are PROVIDER specs. `specs/trimmed/` keeps the overlap story at
a fraction of the size (Gitea 84, Keycloak 67, Wekan 105, Vikunja 30 ops).

## Expected mappings

Ground truth: [ground-truth.yaml](ground-truth.yaml) (the
Gitea↔Vikunja pair is scenario 1's ground truth, unrepeated). Highlights:

| Pair | Character | Flagship transforms |
|---|---|---|
| Vikunja↔Wekan projects↔boards, tasks↔cards, buckets↔lists | richest pair | `due_date`→`dueAt`, `updated`→`modifiedAt`; `done` has **no** counterpart |
| Keycloak↔Gitea users | identity provisioning | `firstName`+`lastName`→`full_name` (aggregate/split), epoch-millis→RFC 3339, `enabled`→`prohibit_login` (inverted) |
| Keycloak↔Wekan users | narrow, awkward shapes | `email` → `emails[0].address` (scalar↔array-of-objects expression) |
| Keycloak↔Vikunja users | minimal | create-only propagation via `/register` |

Deliberate negatives: `done`↔`archived` (archived hides the card — mapping it
would vanish data), Gitea issues↔Wekan cards (better reached transitively via
Vikunja; approving it directly creates a sync 3-cycle → loop-prevention probe),
Keycloak clients/roles/sessions and Wekan swimlanes/checklists (no counterpart).

## Concept probes built into this scenario

- **Constant path params, everywhere**: Keycloak's `{realm}` on every op,
  Wekan's `{board}/{list}` nesting — sync ResourceBindings must pin multiple
  constants per collection read.
- **Kanban state vs boolean state**: Vikunja `done` maps to *which list the
  card is in*, not to any card field — state-as-position is outside the
  current FieldMapping vocabulary; ground truth expects it unmapped.
- **Operation shape mismatches**: Wekan's user-scoped board list
  (`/api/users/{userId}/boards`) and per-attribute update (`PUT .../title`).
- **Sync topology**: three work-item apps invite a triangle — loop prevention
  and transitive sync-routing get their first real test here.
- **Spec messiness, tier 2**: the vendored Wekan spec needed three upstream
  bugs repaired at vendor time (object-typed formData params, duplicate
  operationIds, object-shaped `parameters`) — see `shared/build-specs.sh`;
  the pristine YAML is kept alongside as `specs/full/wekan-v9.57.swagger.yml`.
- **Registration quirk**: Wekan's REST `/users/register` is permanently 403 in
  v9.x (server-side `forbidClientAccountCreation`); `bootstrap-wekan.sh`
  inserts users straight into Mongo using the image's own bcrypt — worth
  knowing before treating Wekan as a sync *target* for user provisioning.
