# Scenario 4 — mixed (Gitea + Forgejo + Vikunja + task-dashboard consumer)

The full-stack scenario: three providers that map peer-to-peer among themselves
**and** one hand-written CONSUMER spec served by the mediator across all three.
Includes the Gitea↔Forgejo fork pair as a detection **calibration case** —
those two specs are near-identical, so anything the detector misses there is a
bug, not a judgment call.

| App | Image | Host port | API base | Spec |
|---|---|---|---|---|
| Gitea | `gitea/gitea:1.25.5` | 14300 | `/api/v1` | live: `/swagger.v1.json` |
| Forgejo | `codeberg.org/forgejo/forgejo:15.0.3` | 14350 | `/api/v1` | live: `/swagger.v1.json` |
| Vikunja | `vikunja/vikunja:2.3.0` | 14400 | `/api/v1` | live: `/api/v1/docs.json` |
| task-dashboard (consumer) | — | 14900 (reserved) | — | `specs/consumer/task-dashboard.yaml` |

## Run

```bash
docker compose up -d --wait
./bootstrap.sh                # admin users + tokens -> .tokens.env
./seed.sh                     # optional: overlapping fixtures (identical items in all 3 apps)
../shared/build-specs.sh .    # vendor/refresh provider specs
```

## What this scenario tests

**Peer-to-peer:** Gitea↔Forgejo (near-total overlap, ~zero transforms —
calibration), Gitea↔Vikunja and Forgejo↔Vikunja (scenario 1's partial pair,
×2). Three work-item apps also mean sync topology questions: bidirectional
rules between three apps must not loop (loop-prevention probe).

**Consumer-provider:** `GET /work-items` is a **collection-union** over three
backends (Gitea/Forgejo global issue search + Vikunja global task list) with
`q` filter pushdown, mediator-side pagination, `headline` dedup, and the
mediator-annotated `source` field. `POST /collections/{id}/work-items` is a
**single-binding write** to Vikunja — the Gitea/Forgejo creates are recorded as
rejected bindings (their `{owner}/{repo}` params have no consumer counterpart).
There is deliberately no by-id read: native ids don't align across backends
without RecordLinks.

Ground truth: [ground-truth.yaml](ground-truth.yaml).

## Concept probes built into this scenario

- **Confidence calibration**: the fork pair gives an objective ceiling —
  detection quality below ~100% recall on Gitea↔Forgejo is a detector bug.
- **"Mappable" ≠ "should sync"**: Gitea↔Forgejo repositories match perfectly
  at spec level but syncing git repos via REST is nonsense — human review must
  be able to reject a technically perfect proposal.
- **Union mechanics**: dedup by identity key, per-backend response transforms,
  filter pushdown vs mediator-side pagination.
- **Single-binding writes** with documented rejected alternatives.
