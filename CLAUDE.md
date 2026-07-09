# API Mediator

A self-hosted service that sits between REST APIs in a software landscape: it ingests OpenAPI specs, proposes mappings between them with LLM assistance, has humans review/approve those mappings, and then executes them — proactively via a polling **Sync Engine** or on demand via a live **Adapter/Gateway Engine**.

The concept is fully specified in `docs/` and is the **source of truth**:

- `docs/architecture/*.md` — components, data model, security, sync/adapter/mapping engines
- `docs/flows/*.md` — end-to-end flows (registration, mapping review, sync polling, adapter resolution)
- `docs/glossary.md` — canonical domain terms; always use these names in code and requirements

## Development conventions

- **Branching**: the local branch `v2` is the integration branch for all development. Never commit directly to `v2` (or `main`). Every piece of work happens on a feature branch created from `v2`, and gets merged into `v2` only once it is finished.
- **Merging is gated on review**: before a feature branch is merged into `v2`, the code-reviewer agent must review it and give an explicit APPROVE verdict; all must-fix findings have to be resolved and re-reviewed first. No branch reaches `v2` unreviewed — not even "trivial" ones.
- **Subagent isolation**: the feature-implementer, unit-test-engineer, and e2e-test-engineer agents run in isolated git worktrees branched from local HEAD (`worktree.baseRef: "head"` in `.claude/settings.json`). Two consequences: (1) be on `v2` (or the relevant feature branch) when delegating, and **commit work before handing it to a test agent** — worktrees only see committed state; (2) a subagent's result comes back as a worktree branch, which is merged into `v2` once finished. The code-reviewer and product-owner run in the main checkout on purpose: the reviewer must see the uncommitted working-tree diff, and the product-owner only writes `docs/requirements/`.
- **Language**: TypeScript in strict mode everywhere (`"strict": true`, plus `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`). No `any` — use `unknown` plus narrowing. Exported functions carry explicit return types.
- **Frontend**: Vue 3 with `<script setup lang="ts">` (Composition API). No Options API, no other frontend frameworks.
- **Unit tests**: Vitest. **E2E tests**: Playwright.
- **Naming**: code identifiers follow `docs/glossary.md` (e.g. `ApprovedMapping`, `RecordLink`, `SyncFieldState`) — do not invent synonyms for existing domain terms.
- Before finishing any code change: typecheck, lint, and run the affected tests.
