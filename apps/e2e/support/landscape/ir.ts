import type { IrOperation, IrResourceGroup, IrSchema } from "@mediator/domain";

/**
 * A **faithful minimal IR** for the scenario-1 Gitea/Vikunja apps — the "replayed
 * mapping" scaffold's spec side, at the apps' **real** paths so every outbound call the
 * engine composes hits the live container correctly. It mirrors the committed
 * Gitea/Vikunja `issues`/`tasks` groups (a minimal subset — the sync round's operations).
 *
 * Native-id + collection-read choices (the only ones actually executed):
 *  - Gitea source poll → `giteaListIssues` = `GET /repos/{owner}/{repo}/issues` — the REAL
 *    scoped collection read, native id `id`. Its `{owner}`/`{repo}` are **scope** path
 *    parameters the Layer-1 SS-4 resolver substitutes from the binding's confirmed
 *    `constant` scope bindings (this capstone exercises exactly that against live Gitea).
 *  - Vikunja source poll / target identity lookup → `vikunjaListTasks` = `GET /tasks`
 *    (param-free), native id `id`.
 *  - Vikunja target update → `vikunjaUpdateTask` = `POST /tasks/{id}` (Vikunja updates with
 *    POST — verb-semantics probe), id filled from the `RecordLink` — the clean, constant-
 *    free write the capstone lands.
 *
 * The Gitea *target* update (`giteaEditIssue`, with `{owner}/{repo}/{index}`) exists only
 * to satisfy the enablement gate's propagatable-operation check for the Vikunja→Gitea
 * echo rule; it is **never executed** (that rule's every change is recognized as a loop
 * echo and skipped before any write). The comment ops likewise never execute — their
 * rule is blocked on a missing identity key (SU-6.5).
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

// ── Response schemas (the native-id field must be top-level so the collection body is
//    read as the records array — see binding-resolvers.ts `deriveRecordsPath`). ────────

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
  ],
};

const COMMENT_SCHEMA: IrSchema = {
  name: "Comment",
  fields: [
    { name: "id", type: "integer", required: true },
    { name: "body", type: "string", required: false },
    { name: "created_at", type: "string", required: false },
    { name: "updated_at", type: "string", required: false },
  ],
};

const TASK_COMMENT_SCHEMA: IrSchema = {
  name: "TaskComment",
  fields: [
    { name: "id", type: "integer", required: true },
    { name: "comment", type: "string", required: false },
    { name: "created", type: "string", required: false },
    { name: "updated", type: "string", required: false },
  ],
};

// ── Gitea IR ────────────────────────────────────────────────────────────────────────

export const GITEA_ISSUES_GROUP: IrResourceGroup = {
  resourceRef: "issues",
  name: "issues",
  operations: [
    // The REAL scoped collection read the source poll + target identity lookup use — its
    // `{owner}`/`{repo}` are SCOPE path parameters the SS-4 resolver substitutes from the
    // binding's confirmed `constant` scope bindings (Layer 1), no longer the param-free
    // `/repos/issues/search` workaround.
    op(
      "giteaListIssues",
      "get",
      "/repos/{owner}/{repo}/issues",
      [pathParam("owner"), pathParam("repo")],
      ISSUE_SCHEMA,
    ),
    // The scoped by-index update — never executed (only satisfies the echo rule's gate);
    // `{owner}`/`{repo}` are scope params, `{index}` is the record id.
    op("giteaEditIssue", "patch", "/repos/{owner}/{repo}/issues/{index}", [
      pathParam("owner"),
      pathParam("repo"),
      pathParam("index"),
    ]),
    op(
      "giteaGetIssue",
      "get",
      "/repos/{owner}/{repo}/issues/{index}",
      [pathParam("owner"), pathParam("repo"), pathParam("index")],
      ISSUE_SCHEMA,
    ),
  ],
  schemas: [ISSUE_SCHEMA],
  crossResourceRefs: [],
};

export const GITEA_COMMENTS_GROUP: IrResourceGroup = {
  resourceRef: "comments",
  name: "comments",
  operations: [
    op(
      "giteaListComments",
      "get",
      "/repos/{owner}/{repo}/issues/comments",
      [pathParam("owner"), pathParam("repo")],
      COMMENT_SCHEMA,
    ),
    op("giteaUpdateComment", "patch", "/repos/{owner}/{repo}/issues/comments/{id}", [
      pathParam("owner"),
      pathParam("repo"),
      pathParam("id"),
    ]),
  ],
  schemas: [COMMENT_SCHEMA],
  crossResourceRefs: [],
};

// ── Vikunja IR ──────────────────────────────────────────────────────────────────────

export const VIKUNJA_TASKS_GROUP: IrResourceGroup = {
  resourceRef: "tasks",
  name: "tasks",
  operations: [
    op("vikunjaListTasks", "get", "/tasks", [], TASK_SCHEMA),
    // The clean, constant-free target update the capstone actually lands.
    op("vikunjaUpdateTask", "post", "/tasks/{id}", [pathParam("id")], TASK_SCHEMA),
    op("vikunjaGetTask", "get", "/tasks/{id}", [pathParam("id")], TASK_SCHEMA),
  ],
  schemas: [TASK_SCHEMA],
  crossResourceRefs: [],
};

export const VIKUNJA_COMMENTS_GROUP: IrResourceGroup = {
  resourceRef: "comments",
  name: "comments",
  operations: [
    op(
      "vikunjaListComments",
      "get",
      "/tasks/{taskID}/comments",
      [pathParam("taskID")],
      TASK_COMMENT_SCHEMA,
    ),
    op("vikunjaUpdateComment", "post", "/tasks/{taskID}/comments/{commentID}", [
      pathParam("taskID"),
      pathParam("commentID"),
    ]),
  ],
  schemas: [TASK_COMMENT_SCHEMA],
  crossResourceRefs: [],
};

// ── Ref strings (the serialized `resourceRef/operationId[#parameter]` form the resolvers
//    and `OperationMapping.targetIdParamRef` parse). ──────────────────────────────────

export const GITEA_ISSUES_LIST_OP = "issues/giteaListIssues";
export const GITEA_ISSUES_EDIT_OP = "issues/giteaEditIssue";
export const GITEA_ISSUES_EDIT_ID_PARAM = "issues/giteaEditIssue#index";
export const GITEA_COMMENTS_LIST_OP = "comments/giteaListComments";
export const GITEA_COMMENTS_EDIT_OP = "comments/giteaUpdateComment";
export const GITEA_COMMENTS_EDIT_ID_PARAM = "comments/giteaUpdateComment#id";

export const VIKUNJA_TASKS_LIST_OP = "tasks/vikunjaListTasks";
export const VIKUNJA_TASKS_UPDATE_OP = "tasks/vikunjaUpdateTask";
export const VIKUNJA_TASKS_UPDATE_ID_PARAM = "tasks/vikunjaUpdateTask#id";
export const VIKUNJA_COMMENTS_LIST_OP = "comments/vikunjaListComments";
export const VIKUNJA_COMMENTS_UPDATE_OP = "comments/vikunjaUpdateComment";
export const VIKUNJA_COMMENTS_UPDATE_ID_PARAM = "comments/vikunjaUpdateComment#commentID";
