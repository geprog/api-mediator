import type { ApiSpec, IrResourceGroup } from "@mediator/domain";

/**
 * Shared test fixtures for `@mediator/mapping-engine`, deliberately **not** built
 * into `dist` (excluded in `tsconfig.build.json`): sample `ApiSpec`s + IR shaped
 * on the scenario-1 Gitea `issues` ↔ Vikunja `tasks` peer pair (plus a small
 * consumer spec for the consumer-provider path) and the valid/malformed scripted
 * stage outputs the `FakeProvider` replays.
 *
 * All fixture data is spec metadata only — no credential or live-record values.
 * Spec ids are chosen so `"spec-gitea" < "spec-todo" < "spec-vikunja"` fixes a
 * predictable canonical shortlist orientation (Gitea as canonical source of the
 * peer pair, the consumer as canonical source of the consumer-provider pair).
 */

const CREATED_AT = new Date("2026-07-10T00:00:00.000Z");

// ── IR resource groups ───────────────────────────────────────────────────────

export const giteaIssues: IrResourceGroup = {
  resourceRef: "issues",
  name: "Issues",
  operations: [
    {
      operationId: "issueListIssues",
      method: "get",
      path: "/repos/{owner}/{repo}/issues",
      summary: "List a repository's issues",
      parameters: [
        { name: "state", location: "query", required: false, type: "string" },
        { name: "owner", location: "path", required: true, type: "string" },
      ],
    },
    {
      operationId: "issueCreateIssue",
      method: "post",
      path: "/repos/{owner}/{repo}/issues",
      summary: "Create an issue",
      parameters: [{ name: "owner", location: "path", required: true, type: "string" }],
    },
  ],
  schemas: [
    {
      name: "Issue",
      fields: [
        { name: "id", type: "integer", required: true },
        { name: "title", type: "string", required: true, description: "Issue title" },
        { name: "body", type: "string", required: false },
        { name: "state", type: "string", required: false },
      ],
    },
  ],
  crossResourceRefs: [],
};

/** A Gitea resource with no Vikunja counterpart — lands in the no-counterpart set. */
export const giteaMilestones: IrResourceGroup = {
  resourceRef: "milestones",
  name: "Milestones",
  operations: [
    {
      operationId: "issueListMilestones",
      method: "get",
      path: "/repos/{owner}/{repo}/milestones",
      summary: "List milestones",
      parameters: [],
    },
  ],
  schemas: [
    {
      name: "Milestone",
      fields: [
        { name: "id", type: "integer", required: true },
        { name: "title", type: "string", required: true },
      ],
    },
  ],
  crossResourceRefs: [],
};

export const vikunjaTasks: IrResourceGroup = {
  resourceRef: "tasks",
  name: "Tasks",
  operations: [
    {
      operationId: "vikunjaListTasks",
      method: "get",
      path: "/projects/{project}/tasks",
      summary: "List a project's tasks",
      parameters: [
        { name: "filter", location: "query", required: false, type: "string" },
        { name: "project", location: "path", required: true, type: "string" },
      ],
    },
    {
      operationId: "vikunjaCreateTask",
      method: "put",
      path: "/projects/{project}/tasks",
      summary: "Create a task",
      parameters: [{ name: "project", location: "path", required: true, type: "string" }],
    },
  ],
  schemas: [
    {
      name: "Task",
      fields: [
        { name: "id", type: "integer", required: true },
        { name: "title", type: "string", required: true },
        { name: "description", type: "string", required: false },
        { name: "done", type: "boolean", required: false },
      ],
    },
  ],
  crossResourceRefs: [],
};

/** A small consumer resource used for the consumer-provider path. */
export const todoWidget: IrResourceGroup = {
  resourceRef: "todos",
  name: "Todos",
  operations: [
    {
      operationId: "listTodos",
      method: "get",
      path: "/todos",
      summary: "List todos",
      parameters: [{ name: "owner", location: "query", required: false, type: "string" }],
    },
  ],
  schemas: [
    {
      name: "Todo",
      fields: [
        { name: "id", type: "string", required: true },
        { name: "title", type: "string", required: true },
        { name: "state", type: "string", required: false },
      ],
    },
  ],
  crossResourceRefs: [],
};

// ── Spec factory + fixtures ──────────────────────────────────────────────────

export function makeSpec(
  overrides: Partial<ApiSpec> & Pick<ApiSpec, "id" | "appId" | "role">,
): ApiSpec {
  return {
    rawDocument: { openapi: "3.1.0" },
    parsedIR: [],
    analysisExclusions: [],
    version: 1,
    contentHash: `sha256:${overrides.id}`,
    status: "active",
    createdAt: CREATED_AT,
    ...overrides,
  };
}

export const giteaSpec: ApiSpec = makeSpec({
  id: "spec-gitea",
  appId: "app-gitea",
  role: "PROVIDER",
  parsedIR: [giteaIssues, giteaMilestones],
});

export const vikunjaSpec: ApiSpec = makeSpec({
  id: "spec-vikunja",
  appId: "app-vikunja",
  role: "PROVIDER",
  parsedIR: [vikunjaTasks],
});

export const todoConsumerSpec: ApiSpec = makeSpec({
  id: "spec-todo",
  appId: "app-todo",
  role: "CONSUMER",
  parsedIR: [todoWidget],
});

// ── Valid scripted stage outputs ─────────────────────────────────────────────

/** Canonical-orientation shortlist for the Gitea↔Vikunja pair (issues ↔ tasks). */
export const giteaVikunjaShortlist = {
  candidatePairs: [
    {
      sourceResource: "issues",
      targetResource: "tasks",
      confidence: 0.82,
      rationale: "Both are trackable work items with a title and a completion state.",
    },
  ],
};

/** Peer-peer detail set for issues → tasks: identityCandidate on title↔title, no phase. */
export const issuesToTasksPeerPeer = {
  variant: "peer-peer" as const,
  operationMappings: [
    {
      sourceOperationId: "issueListIssues",
      targetOperationId: "vikunjaListTasks",
      confidence: 0.9,
      rationale: "Both list the collection.",
      ambiguousAlternatives: [],
      unmapped: false,
    },
    {
      sourceOperationId: "issueCreateIssue",
      targetOperationId: "vikunjaCreateTask",
      confidence: 0.86,
      rationale: "Both create one record.",
      ambiguousAlternatives: [],
      unmapped: false,
    },
  ],
  fieldMappings: [
    {
      sourceField: "title",
      targetField: "title",
      transform: "rename" as const,
      transformDetail: "",
      identityCandidate: true,
      targetLookupParamRef: "filter",
      confidence: 0.95,
      rationale: "Same business title; value-preserving identity key.",
      ambiguousAlternatives: [],
      unmapped: false,
    },
    {
      sourceField: "body",
      targetField: "description",
      transform: "rename" as const,
      transformDetail: "",
      confidence: 0.8,
      rationale: "Free-text body maps to description.",
      ambiguousAlternatives: [{ targetField: "done", confidence: 0.2 }],
      unmapped: false,
    },
    {
      sourceField: "state",
      targetField: null,
      transform: "rename" as const,
      transformDetail: "",
      confidence: 0.3,
      rationale: "No value-preserving counterpart on the target.",
      ambiguousAlternatives: [],
      unmapped: true,
    },
  ],
};

/** Reverse-direction peer-peer detail set for tasks → issues. */
export const tasksToIssuesPeerPeer = {
  variant: "peer-peer" as const,
  operationMappings: [
    {
      sourceOperationId: "vikunjaListTasks",
      targetOperationId: "issueListIssues",
      confidence: 0.9,
      rationale: "Both list the collection.",
      ambiguousAlternatives: [],
      unmapped: false,
    },
  ],
  fieldMappings: [
    {
      sourceField: "title",
      targetField: "title",
      transform: "rename" as const,
      transformDetail: "",
      identityCandidate: true,
      confidence: 0.95,
      rationale: "Same business title.",
      ambiguousAlternatives: [],
      unmapped: false,
    },
  ],
};

/** Consumer-provider detail set for todos → tasks (phase + parameterMappings). */
export const todosToTasksConsumerProvider = {
  variant: "consumer-provider" as const,
  operationMappings: [
    {
      sourceOperationId: "listTodos",
      targetOperationId: "vikunjaListTasks",
      confidence: 0.8,
      rationale: "Consumer list served from the provider list.",
      ambiguousAlternatives: [],
      unmapped: false,
    },
  ],
  fieldMappings: [
    {
      sourceField: "title",
      targetField: "title",
      phase: "response" as const,
      transform: "rename" as const,
      transformDetail: "",
      confidence: 0.85,
      rationale: "Backend title returned to the consumer.",
      ambiguousAlternatives: [],
      unmapped: false,
    },
    {
      sourceField: "state",
      targetField: "filter",
      phase: "request" as const,
      transform: "coerce" as const,
      transformDetail: "map open/closed to a filter expression",
      confidence: 0.6,
      rationale: "Consumer state maps to the backend filter query.",
      ambiguousAlternatives: [],
      unmapped: false,
    },
  ],
  parameterMappings: [
    {
      sourceOperationId: "listTodos",
      targetOperationId: "vikunjaListTasks",
      sourceParam: "owner",
      targetParam: "project",
      confidence: 0.7,
      rationale: "Owner scopes todos; project scopes tasks.",
      unmapped: false,
    },
  ],
};

/** Missing required fields — rejected by the shared shortlist validator. */
export const malformedShortlist: unknown = { candidatePairs: [{ sourceResource: "issues" }] };

/** A `phase` on a peer-peer field — a strict-mode-rejected unknown key. */
export const malformedPeerPeerDetail: unknown = {
  variant: "peer-peer",
  operationMappings: [],
  fieldMappings: [
    {
      sourceField: "title",
      targetField: "title",
      phase: "response",
      transform: "rename",
      transformDetail: "",
      confidence: 0.9,
      rationale: "has a phase it should not",
      ambiguousAlternatives: [],
      unmapped: false,
    },
  ],
};
