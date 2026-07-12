import { randomUUID } from "node:crypto";

import type {
  ApiSpec,
  Ir,
  MappingProposal,
  MappingProposalItem,
  ProposalElementRef,
} from "@mediator/domain";

/**
 * Replayed proposal fixtures for the Approval Service unit + integration tests: a
 * persisted `MappingProposal` + `MappingProposalItem`s (peer-peer and
 * consumer-provider) plus the two specs they were generated against, so the
 * approval invariants are deterministic without an LLM (AS: "deterministic over a
 * replayed proposal fixture"). Ids are minted per call so the same fixture can seed
 * an in-memory fake or a live Postgres.
 *
 * A `*.testkit.ts` file: type-checked, excluded from `dist`, never collected.
 */

function operationRef(resourceRef: string, operationId: string): ProposalElementRef {
  return { resourceRef, target: { kind: "operation", operationId } };
}
function fieldRef(resourceRef: string, path: string): ProposalElementRef {
  return { resourceRef, target: { kind: "field", path } };
}
function parameterRef(
  resourceRef: string,
  operationId: string,
  parameter: string,
): ProposalElementRef {
  return { resourceRef, target: { kind: "parameter", operationId, parameter } };
}

const CREATED_AT = new Date("2026-07-11T00:00:00.000Z");

function spec(input: { id: string; appId: string; role: ApiSpec["role"]; ir: Ir }): ApiSpec {
  return {
    id: input.id,
    appId: input.appId,
    role: input.role,
    rawDocument: { openapi: "3.1.0", info: { title: "fixture", version: "1" } },
    parsedIR: input.ir,
    analysisExclusions: [],
    version: 1,
    contentHash: `sha256:${input.id}`,
    status: "active",
    createdAt: CREATED_AT,
  };
}

// ── Peer-peer fixture (issues → tasks) ───────────────────────────────────────

const ISSUES_IR: Ir = [
  {
    resourceRef: "issues",
    name: "Issues",
    operations: [
      { operationId: "listIssues", method: "get", path: "/issues", parameters: [] },
      { operationId: "createIssue", method: "post", path: "/issues", parameters: [] },
      {
        operationId: "updateIssue",
        method: "patch",
        path: "/issues/{id}",
        parameters: [{ name: "id", location: "path", required: true }],
      },
      {
        operationId: "deleteIssue",
        method: "delete",
        path: "/issues/{id}",
        parameters: [{ name: "id", location: "path", required: true }],
      },
    ],
    schemas: [
      {
        name: "Issue",
        fields: [
          { name: "id", type: "integer", required: true },
          { name: "title", type: "string", required: true },
          { name: "email", type: "string", required: false },
          { name: "state", type: "string", required: false },
          { name: "legacyCode", type: "string", required: false },
        ],
      },
    ],
    crossResourceRefs: [],
  },
];

const TASKS_IR: Ir = [
  {
    resourceRef: "tasks",
    name: "Tasks",
    operations: [
      {
        operationId: "listTasks",
        method: "get",
        path: "/tasks",
        parameters: [{ name: "email", location: "query", required: false }],
      },
      { operationId: "createTask", method: "post", path: "/tasks", parameters: [] },
      {
        operationId: "updateTask",
        method: "put",
        path: "/tasks/{taskId}",
        parameters: [{ name: "taskId", location: "path", required: true }],
      },
      {
        operationId: "deleteTask",
        method: "delete",
        path: "/tasks/{taskId}",
        parameters: [{ name: "taskId", location: "path", required: true }],
      },
    ],
    schemas: [
      {
        name: "Task",
        fields: [
          { name: "id", type: "integer", required: true },
          { name: "title", type: "string", required: true },
          { name: "email", type: "string", required: false },
          { name: "done", type: "boolean", required: false },
        ],
      },
    ],
    crossResourceRefs: [],
  },
];

export interface PeerPeerFixture {
  readonly appAId: string;
  readonly appBId: string;
  readonly sourceSpec: ApiSpec;
  readonly targetSpec: ApiSpec;
  readonly proposal: MappingProposal;
  readonly items: {
    readonly listOp: MappingProposalItem;
    readonly createOp: MappingProposalItem;
    readonly updateOp: MappingProposalItem;
    readonly deleteOp: MappingProposalItem;
    readonly titleField: MappingProposalItem;
    readonly emailField: MappingProposalItem;
    readonly stateField: MappingProposalItem;
    readonly legacyField: MappingProposalItem;
  };
  readonly allItems: readonly MappingProposalItem[];
}

/** A peer-peer (both PROVIDER) replayed proposal: Gitea issues → Vikunja tasks. */
export function peerPeerFixture(newId: () => string = randomUUID): PeerPeerFixture {
  const appAId = newId();
  const appBId = newId();
  const sourceSpecId = newId();
  const targetSpecId = newId();
  const proposalId = newId();

  const sourceSpec = spec({ id: sourceSpecId, appId: appAId, role: "PROVIDER", ir: ISSUES_IR });
  const targetSpec = spec({ id: targetSpecId, appId: appBId, role: "PROVIDER", ir: TASKS_IR });

  const proposal: MappingProposal = {
    id: proposalId,
    sourceSpecId,
    targetSpecId,
    generatedBy: { providerId: "fixture", model: "fixture", promptVersion: "v1" },
    shortlistResult: {
      candidatePairs: [
        {
          sourceResource: "issues",
          targetResource: "tasks",
          confidence: 0.8,
          rationale: "both track work items",
          analysisFailed: false,
        },
      ],
      noCounterpartResources: [],
    },
    status: "pending",
    createdAt: CREATED_AT,
  };

  const base = {
    proposalId,
    ambiguousAlternatives: [],
    reviewState: "pending" as const,
  };

  const listOp: MappingProposalItem = {
    ...base,
    id: newId(),
    kind: "operation",
    sourceRef: operationRef("issues", "listIssues"),
    targetRef: operationRef("tasks", "listTasks"),
    transformSuggestion: null,
    confidenceScore: 0.9,
    unmapped: false,
    rationale: "list ↔ list",
  };
  const createOp: MappingProposalItem = {
    ...base,
    id: newId(),
    kind: "operation",
    sourceRef: operationRef("issues", "createIssue"),
    targetRef: operationRef("tasks", "createTask"),
    transformSuggestion: null,
    confidenceScore: 0.9,
    unmapped: false,
    rationale: "create ↔ create",
  };
  const updateOp: MappingProposalItem = {
    ...base,
    id: newId(),
    kind: "operation",
    sourceRef: operationRef("issues", "updateIssue"),
    targetRef: operationRef("tasks", "updateTask"),
    transformSuggestion: null,
    confidenceScore: 0.85,
    unmapped: false,
    rationale: "update ↔ update",
  };
  const deleteOp: MappingProposalItem = {
    ...base,
    id: newId(),
    kind: "operation",
    sourceRef: operationRef("issues", "deleteIssue"),
    targetRef: operationRef("tasks", "deleteTask"),
    transformSuggestion: null,
    confidenceScore: 0.85,
    unmapped: false,
    rationale: "delete ↔ delete",
  };
  const titleField: MappingProposalItem = {
    ...base,
    id: newId(),
    kind: "field",
    sourceRef: fieldRef("issues", "title"),
    targetRef: fieldRef("tasks", "title"),
    transformSuggestion: { transform: "rename" },
    confidenceScore: 0.95,
    unmapped: false,
    rationale: "title ↔ title",
  };
  const emailField: MappingProposalItem = {
    ...base,
    id: newId(),
    kind: "field",
    sourceRef: fieldRef("issues", "email"),
    targetRef: fieldRef("tasks", "email"),
    transformSuggestion: { transform: "rename" },
    confidenceScore: 0.9,
    unmapped: false,
    rationale: "shared identity value",
    identityCandidate: true,
    targetLookupParamRef: "email",
  };
  const stateField: MappingProposalItem = {
    ...base,
    id: newId(),
    kind: "field",
    sourceRef: fieldRef("issues", "state"),
    targetRef: fieldRef("tasks", "done"),
    transformSuggestion: { transform: "coerce", detail: "open→false, closed→true" },
    confidenceScore: 0.6,
    unmapped: false,
    rationale: "state ↔ done",
  };
  const legacyField: MappingProposalItem = {
    ...base,
    id: newId(),
    kind: "field",
    sourceRef: fieldRef("issues", "legacyCode"),
    confidenceScore: 0.2,
    unmapped: true,
    rationale: "no counterpart",
  };

  const allItems = [
    listOp,
    createOp,
    updateOp,
    deleteOp,
    titleField,
    emailField,
    stateField,
    legacyField,
  ];

  return {
    appAId,
    appBId,
    sourceSpec,
    targetSpec,
    proposal,
    items: {
      listOp,
      createOp,
      updateOp,
      deleteOp,
      titleField,
      emailField,
      stateField,
      legacyField,
    },
    allItems,
  };
}

// ── Consumer-provider fixture (search → list) ────────────────────────────────

const SEARCH_IR: Ir = [
  {
    resourceRef: "search",
    name: "Search",
    operations: [
      {
        operationId: "searchIssues",
        method: "get",
        path: "/search",
        parameters: [
          { name: "owner", location: "query", required: false },
          { name: "q", location: "query", required: false },
        ],
      },
    ],
    schemas: [
      {
        name: "SearchResult",
        fields: [
          { name: "summary", type: "string", required: true },
          { name: "label", type: "string", required: false },
        ],
      },
    ],
    crossResourceRefs: [],
  },
];

const LIST_IR: Ir = [
  {
    resourceRef: "list",
    name: "List",
    operations: [
      {
        operationId: "listTasks",
        method: "get",
        path: "/list",
        parameters: [
          { name: "project", location: "query", required: false },
          { name: "query", location: "query", required: false },
        ],
      },
    ],
    schemas: [
      {
        name: "Task",
        fields: [
          { name: "title", type: "string", required: true },
          { name: "done", type: "boolean", required: false },
        ],
      },
    ],
    crossResourceRefs: [],
  },
];

export interface ConsumerProviderFixture {
  readonly consumerAppId: string;
  readonly backendAppId: string;
  readonly sourceSpec: ApiSpec;
  readonly targetSpec: ApiSpec;
  readonly proposal: MappingProposal;
  readonly items: {
    readonly searchOp: MappingProposalItem;
    readonly requestField: MappingProposalItem;
    readonly responseField: MappingProposalItem;
    readonly ownerParam: MappingProposalItem;
  };
  readonly allItems: readonly MappingProposalItem[];
}

/** A consumer-provider replayed proposal: consumer `search` → backend `list`. */
export function consumerProviderFixture(newId: () => string = randomUUID): ConsumerProviderFixture {
  const consumerAppId = newId();
  const backendAppId = newId();
  const sourceSpecId = newId();
  const targetSpecId = newId();
  const proposalId = newId();

  const sourceSpec = spec({
    id: sourceSpecId,
    appId: consumerAppId,
    role: "CONSUMER",
    ir: SEARCH_IR,
  });
  const targetSpec = spec({ id: targetSpecId, appId: backendAppId, role: "PROVIDER", ir: LIST_IR });

  const proposal: MappingProposal = {
    id: proposalId,
    sourceSpecId,
    targetSpecId,
    generatedBy: { providerId: "fixture", model: "fixture", promptVersion: "v1" },
    shortlistResult: {
      candidatePairs: [
        {
          sourceResource: "search",
          targetResource: "list",
          confidence: 0.7,
          rationale: "search ↔ list",
          analysisFailed: false,
        },
      ],
      noCounterpartResources: [],
    },
    status: "pending",
    createdAt: CREATED_AT,
  };

  const base = { proposalId, ambiguousAlternatives: [], reviewState: "pending" as const };

  const searchOp: MappingProposalItem = {
    ...base,
    id: newId(),
    kind: "operation",
    sourceRef: operationRef("search", "searchIssues"),
    targetRef: operationRef("list", "listTasks"),
    transformSuggestion: null,
    confidenceScore: 0.8,
    unmapped: false,
    rationale: "search ↔ list",
  };
  const requestField: MappingProposalItem = {
    ...base,
    id: newId(),
    kind: "field",
    phase: "request",
    sourceRef: fieldRef("search", "summary"),
    targetRef: fieldRef("list", "title"),
    transformSuggestion: { transform: "rename" },
    confidenceScore: 0.8,
    unmapped: false,
    rationale: "summary → title",
  };
  const responseField: MappingProposalItem = {
    ...base,
    id: newId(),
    kind: "field",
    phase: "response",
    sourceRef: fieldRef("search", "label"),
    targetRef: fieldRef("list", "done"),
    transformSuggestion: { transform: "coerce", detail: "label→done" },
    confidenceScore: 0.7,
    unmapped: false,
    rationale: "label ← done",
  };
  const ownerParam: MappingProposalItem = {
    ...base,
    id: newId(),
    kind: "parameter",
    sourceRef: parameterRef("search", "searchIssues", "owner"),
    targetRef: parameterRef("list", "listTasks", "project"),
    transformSuggestion: null,
    confidenceScore: 0.75,
    unmapped: false,
    rationale: "owner → project",
  };

  const allItems = [searchOp, requestField, responseField, ownerParam];

  return {
    consumerAppId,
    backendAppId,
    sourceSpec,
    targetSpec,
    proposal,
    items: { searchOp, requestField, responseField, ownerParam },
    allItems,
  };
}
