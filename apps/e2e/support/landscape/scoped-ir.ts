import type { IrOperation, IrResourceGroup, IrSchema } from "@mediator/domain";

/**
 * A **faithful minimal IR** for the **Slice D scoped (Layer-3) capstone** — the
 * multi-container Gitea↔Vikunja landscape, at the apps' **real** paths so every outbound
 * call the engine composes hits the live containers correctly. It is the scoped sibling of
 * {@link ./ir.ts}, which models the SU-6 single-container (Layer-1 `constant`) round; the
 * two coexist because they pin deliberately different binding shapes.
 *
 * ## Why this IR is drawn from the **FULL** Gitea spec (the ratified Slice-D fixture call)
 *
 * The `repos` group's list operation is the whole point. `scenarios/scenario-1-small-overlap/
 * specs/oas3/gitea.trimmed.oas3.json` has **no repo-list at all** (its only param-free repo
 * path is `GET /repos/issues/search`), so a trimmed-spec rule can never derive a
 * `ScopeCorrespondence.sourceContainerRef` and therefore never reaches
 * `per-scope-enumerated` mode (SS-13.5) — SS-17.1's live container enumeration and SS-17.4's
 * per-scope backfill fan-out would simply not execute. `gitea.full.oas3.json` **does** carry
 * repo-list operations, and this IR models one of them, which is exactly what puts the rule
 * in `per-scope-enumerated` mode.
 *
 * Two deliberate, documented fixture decisions, both verified against the live containers:
 *
 *  1. **`GET /user/repos` is the source container list**, not the full spec's other repo-list
 *     `GET /repos/search`. `/repos/search` returns an `{ ok, data: [...] }` **envelope** and
 *     enumerates every repository in the whole instance — i.e. shared landscape state this
 *     journey does not own. `/user/repos` returns a **bare array** of exactly the token
 *     owner's repositories, so the capstone enumerates precisely the containers it created
 *     and cleaned up (the suite's isolate-your-own-state rule). In the full spec this
 *     operation is tagged `user`; grouping it under `repos` here is this fixture's authoring
 *     choice, mirroring how the SU-6 IR authors its own groups — IR *grouping* is a
 *     spec-ingestion concern, not what Slice D exercises.
 *  2. **`GET /projects/{id}/tasks` is the Vikunja container-scoped task list.** SS-14.1 scopes
 *     a target identity lookup **only** by filling the target collection read's container
 *     `{…}` — so with a param-free `GET /tasks` the lookup would search every project and two
 *     same-titled records in different containers would cross-match. Vikunja **implements**
 *     `GET /projects/{id}/tasks` (verified live: HTTP 200, bare task array) but its published
 *     OpenAPI document declares only the `PUT` on that path. This is the scenario's documented
 *     "specs lie about the implementation" messiness, and it is reported as a finding rather
 *     than hidden: a provider whose spec omits a container-scoped collection read cannot get
 *     scoped identity matching from the spec alone.
 *
 * Native-id + collection-read choices (all of these are actually executed):
 *  - Gitea source poll / target identity lookup → `giteaListIssues` = `GET
 *    /repos/{owner}/{repo}/issues`; `{owner}`/`{repo}` are **scope** path parameters filled
 *    per container from the resolved `ScopeLink` (SS-12), never a `constant`.
 *  - Gitea container list → `giteaListUserRepos` = `GET /user/repos` (param-free bare array).
 *  - Vikunja source poll / target identity lookup → `vikunjaListProjectTasks` = `GET
 *    /projects/{id}/tasks`; `{id}` is a scope path parameter filled from the `ScopeLink`.
 *  - Vikunja target create → `vikunjaCreateTask` = `PUT /projects/{id}/tasks` — the scoped
 *    create whose `{id}` proves a record lands in the **correct** container.
 *  - Vikunja target update → `vikunjaUpdateTask` = `POST /tasks/{id}`, `{id}` the record id
 *    from the `RecordLink` (Vikunja's verb inversion: it creates with PUT, updates with POST).
 *  - Vikunja container list → `vikunjaListProjects` = `GET /projects` (param-free bare array).
 */

function op(
  operationId: string,
  method: IrOperation["method"],
  path: string,
  parameters: IrOperation["parameters"],
  responseSchema?: IrSchema,
): IrOperation {
  return { operationId, method, path, parameters, ...(responseSchema ? { responseSchema } : {}) };
}

function pathParam(name: string): { name: string; location: "path"; required: true; type: string } {
  return { name, location: "path", required: true, type: "string" };
}

// ── Response schemas ─────────────────────────────────────────────────────────────────
// The native-id field is top-level on every one of these, so each collection body is read
// as the records array itself (`deriveRecordsPath` returns no wrapper path).

/**
 * The nested container object a live Gitea **issue** carries:
 * `repository: { id, name, owner, full_name }` — note `owner` is a plain STRING here.
 * Modeled as its own schema referenced by `Issue.repository`'s `type`, which is how the
 * IR decomposer represents a nested object (and what SS-7's `sourceScopeRef` derivation
 * reads to produce the `repository.owner` / `repository.name` component paths).
 */
const ISSUE_REPOSITORY_SCHEMA: IrSchema = {
  name: "IssueRepository",
  fields: [
    { name: "id", type: "integer", required: true },
    { name: "name", type: "string", required: true },
    { name: "owner", type: "string", required: true },
    { name: "full_name", type: "string", required: false },
  ],
};

const ISSUE_SCHEMA: IrSchema = {
  name: "Issue",
  fields: [
    { name: "id", type: "integer", required: true },
    { name: "number", type: "integer", required: true },
    { name: "title", type: "string", required: true },
    { name: "body", type: "string", required: false },
    { name: "state", type: "string", required: false },
    { name: "updated_at", type: "string", required: false },
    { name: "created_at", type: "string", required: false },
    // The container identity the Layer-3 `sourceScopeRef` captures per record.
    { name: "repository", type: "IssueRepository", required: false },
  ],
};

/**
 * A Gitea **repository** as `GET /user/repos` returns it. Only the fields discovery reads
 * are modeled: the native id, and the two container-identity fields the `repos` binding's
 * `sourceScopeRef` captures (`owner.login` is an OBJECT member here — unlike the plain
 * string an *issue* record carries — which is exactly why the two bindings need their own
 * `sourceScopeRef` component paths).
 */
const REPO_OWNER_SCHEMA: IrSchema = {
  name: "RepoOwner",
  fields: [
    { name: "id", type: "integer", required: true },
    { name: "login", type: "string", required: true },
  ],
};

const REPOSITORY_SCHEMA: IrSchema = {
  name: "Repository",
  fields: [
    { name: "id", type: "integer", required: true },
    { name: "name", type: "string", required: true },
    { name: "full_name", type: "string", required: false },
    { name: "owner", type: "RepoOwner", required: false },
  ],
};

const TASK_SCHEMA: IrSchema = {
  name: "Task",
  fields: [
    { name: "id", type: "integer", required: true },
    { name: "title", type: "string", required: true },
    { name: "description", type: "string", required: false },
    { name: "done", type: "boolean", required: false },
    { name: "updated", type: "string", required: false },
    { name: "created", type: "string", required: false },
    // The container a task sits in — the Vikunja-side `sourceScopeRef` capture.
    { name: "project_id", type: "integer", required: false },
  ],
};

/**
 * A Vikunja **project** as `GET /projects` returns it. `title` is the field the proposed
 * scope identity key pairs the Gitea repo's `name` component to (SS-18.3's own worked
 * example, source `name` ↔ target `title`).
 *
 * The live record also carries an `owner` OBJECT. It is deliberately **not** modeled: a
 * container identity value must be a comparable scalar, so an object-typed `owner` would
 * make `targetContainerSignature` return `undefined` and no container would ever match.
 * Modeling only the comparable representation keeps the fixture honest about what a scope
 * identity key can actually pair.
 */
const PROJECT_SCHEMA: IrSchema = {
  name: "Project",
  fields: [
    { name: "id", type: "integer", required: true },
    { name: "title", type: "string", required: true },
    { name: "description", type: "string", required: false },
    { name: "updated", type: "string", required: false },
    { name: "created", type: "string", required: false },
  ],
};

// ── Gitea IR (record resource + its container resource, ONE spec) ────────────────────
// Both groups live in a single `ApiSpec`: `deriveScopeCorrespondenceProposal` (SS-18.2)
// resolves the container resource within the *record* resource's own spec IR.

export const GITEA_SCOPED_ISSUES_GROUP: IrResourceGroup = {
  resourceRef: "issues",
  name: "issues",
  operations: [
    // The scoped collection read: source poll (Gitea→Vikunja) AND target identity lookup
    // (Vikunja→Gitea). `{owner}`/`{repo}` are filled per container from the `ScopeLink`.
    op(
      "giteaListIssues",
      "get",
      "/repos/{owner}/{repo}/issues",
      [pathParam("owner"), pathParam("repo")],
      ISSUE_SCHEMA,
    ),
    op(
      "giteaCreateIssue",
      "post",
      "/repos/{owner}/{repo}/issues",
      [pathParam("owner"), pathParam("repo")],
      ISSUE_SCHEMA,
    ),
    // `{index}` is the record id; `{owner}`/`{repo}` remain scope.
    op("giteaEditIssue", "patch", "/repos/{owner}/{repo}/issues/{index}", [
      pathParam("owner"),
      pathParam("repo"),
      pathParam("index"),
    ]),
  ],
  schemas: [ISSUE_SCHEMA, ISSUE_REPOSITORY_SCHEMA],
  crossResourceRefs: [],
};

/**
 * The **source container** resource — what makes this pair `per-scope-enumerated`. Its
 * `collectionReadRef` is the full-spec-only repo list SS-17.1 re-lists on every poll.
 */
export const GITEA_REPOS_GROUP: IrResourceGroup = {
  resourceRef: "repos",
  name: "repos",
  operations: [op("giteaListUserRepos", "get", "/user/repos", [], REPOSITORY_SCHEMA)],
  schemas: [REPOSITORY_SCHEMA, REPO_OWNER_SCHEMA],
  crossResourceRefs: [],
};

// ── Vikunja IR (record resource + its container resource, ONE spec) ──────────────────

export const VIKUNJA_SCOPED_TASKS_GROUP: IrResourceGroup = {
  resourceRef: "tasks",
  name: "tasks",
  operations: [
    // The container-scoped collection read: source poll (Vikunja→Gitea) AND the SS-14.1
    // target identity lookup that must search ONLY within the record's own project.
    op("vikunjaListProjectTasks", "get", "/projects/{id}/tasks", [pathParam("id")], TASK_SCHEMA),
    // The scoped CREATE — `{id}` is the container (a create carries no record-id path
    // param), so this is the write that proves correct-container propagation.
    op("vikunjaCreateTask", "put", "/projects/{id}/tasks", [pathParam("id")], TASK_SCHEMA),
    // The unscoped UPDATE — `{id}` here is the task's own id, from the `RecordLink`.
    op("vikunjaUpdateTask", "post", "/tasks/{id}", [pathParam("id")], TASK_SCHEMA),
  ],
  schemas: [TASK_SCHEMA],
  crossResourceRefs: [],
};

/** The **target container** resource — the projects a `ScopeLink` pairs Gitea repos to. */
export const VIKUNJA_PROJECTS_GROUP: IrResourceGroup = {
  resourceRef: "projects",
  name: "projects",
  operations: [op("vikunjaListProjects", "get", "/projects", [], PROJECT_SCHEMA)],
  schemas: [PROJECT_SCHEMA],
  crossResourceRefs: [],
};

// ── Ref strings (the serialized `resourceRef/operationId[#parameter]` form) ──────────

export const GITEA_SCOPED_ISSUES_LIST_OP = "issues/giteaListIssues";
export const GITEA_SCOPED_ISSUES_CREATE_OP = "issues/giteaCreateIssue";
export const GITEA_SCOPED_ISSUES_EDIT_OP = "issues/giteaEditIssue";
export const GITEA_SCOPED_ISSUES_EDIT_ID_PARAM = "issues/giteaEditIssue#index";
export const GITEA_REPOS_LIST_OP = "repos/giteaListUserRepos";

export const VIKUNJA_SCOPED_TASKS_LIST_OP = "tasks/vikunjaListProjectTasks";
export const VIKUNJA_SCOPED_TASKS_CREATE_OP = "tasks/vikunjaCreateTask";
export const VIKUNJA_SCOPED_TASKS_UPDATE_OP = "tasks/vikunjaUpdateTask";
export const VIKUNJA_SCOPED_TASKS_UPDATE_ID_PARAM = "tasks/vikunjaUpdateTask#id";
export const VIKUNJA_PROJECTS_LIST_OP = "projects/vikunjaListProjects";
