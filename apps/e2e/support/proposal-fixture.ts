import { randomUUID } from "node:crypto";

import type {
  ApiSpec,
  Ir,
  MappingProposal,
  MappingProposalItem,
  ProposalElementRef,
  RegisteredApp,
} from "@mediator/domain";

/**
 * The **replayed** peer-peer proposal fixture for the RU-5 capstone journey: a
 * persisted `MappingProposal` + `MappingProposalItem`s built **without invoking an
 * LLM** (RU-5 crit 1), over two registered apps and two `PROVIDER` specs whose IR
 * resolves. It mirrors the shape of the backend's approval fixtures (Gitea issues →
 * Vikunja tasks) so the approve invariants behave identically to production, and it
 * includes a peer-peer identity-candidate field item (`emailField`) plus a
 * low-confidence field the journey can edit to an invalid target (crit 5).
 *
 * Pure data only — {@link ../db seedPeerPeerProposal} does the DB inserts. Every id
 * is minted per call so each test seeds isolated state and cleans up by those ids.
 */

const CREATED_AT = new Date("2026-07-12T00:00:00.000Z");

function operationRef(resourceRef: string, operationId: string): ProposalElementRef {
  return { resourceRef, target: { kind: "operation", operationId } };
}
function fieldRef(resourceRef: string, path: string): ProposalElementRef {
  return { resourceRef, target: { kind: "field", path } };
}

/** The source spec's IR — a Gitea-like `issues` resource. */
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

/** The target spec's IR — a Vikunja-like `tasks` resource. */
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

function appOf(id: string, name: string, baseUrl: string): RegisteredApp {
  return {
    id,
    name,
    status: "active",
    baseUrl,
    capabilities: {
      supportsPolling: true,
      supportsDeltaQuery: false,
      supportsChangeTimestamps: false,
      defaultPollInterval: 60_000,
    },
    createdAt: CREATED_AT,
  };
}

function specOf(id: string, appId: string, ir: Ir): ApiSpec {
  return {
    id,
    appId,
    role: "PROVIDER",
    rawDocument: { openapi: "3.1.0", info: { title: "e2e-fixture", version: "1" } },
    parsedIR: ir,
    analysisExclusions: [],
    version: 1,
    contentHash: `sha256:${id}`,
    status: "active",
    createdAt: CREATED_AT,
  };
}

/** The named items of the seeded proposal, so a spec can address each precisely. */
export interface PeerPeerProposalItems {
  readonly listOp: MappingProposalItem;
  readonly createOp: MappingProposalItem;
  readonly updateOp: MappingProposalItem;
  readonly deleteOp: MappingProposalItem;
  readonly titleField: MappingProposalItem;
  readonly emailField: MappingProposalItem;
  readonly stateField: MappingProposalItem;
  readonly legacyField: MappingProposalItem;
}

/** A fully-built peer-peer replayed proposal fixture, ready to seed. */
export interface PeerPeerProposalFixture {
  readonly sourceApp: RegisteredApp;
  readonly targetApp: RegisteredApp;
  readonly sourceSpec: ApiSpec;
  readonly targetSpec: ApiSpec;
  readonly proposal: MappingProposal;
  readonly items: PeerPeerProposalItems;
  readonly allItems: readonly MappingProposalItem[];
}

export interface BuildPeerPeerFixtureOptions {
  /** The base URL both apps register — a mock backend the test asserts stays untouched. */
  readonly baseUrl: string;
  /** Id factory (defaults to `randomUUID`), so ids are unique per seed. */
  readonly newId?: () => string;
}

/**
 * Build a peer-peer replayed proposal (issues → tasks). All correspondences are
 * `pending`; the journey decides them through the real UI. `emailField` is the
 * identity-candidate rename pairing; `stateField` is a low-confidence field the
 * invalid-edit test re-points to a non-existent target.
 */
export function buildPeerPeerProposalFixture(
  options: BuildPeerPeerFixtureOptions,
): PeerPeerProposalFixture {
  const newId = options.newId ?? randomUUID;

  const sourceAppId = newId();
  const targetAppId = newId();
  const sourceSpecId = newId();
  const targetSpecId = newId();
  const proposalId = newId();

  const sourceApp = appOf(sourceAppId, `e2e-issues-${sourceAppId.slice(0, 8)}`, options.baseUrl);
  const targetApp = appOf(targetAppId, `e2e-tasks-${targetAppId.slice(0, 8)}`, options.baseUrl);
  const sourceSpec = specOf(sourceSpecId, sourceAppId, ISSUES_IR);
  const targetSpec = specOf(targetSpecId, targetAppId, TASKS_IR);

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

  const base = { proposalId, ambiguousAlternatives: [], reviewState: "pending" as const };

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
  // The peer-peer identity-candidate field: a value-preserving rename, pre-flagged
  // so the identity-key panel pre-selects it (never auto-confirmed).
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
  // Low-confidence (reviewRequired) coerce field — the invalid-edit test re-points
  // this to a non-existent target to trigger AS-3 at approve.
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

  const items: PeerPeerProposalItems = {
    listOp,
    createOp,
    updateOp,
    deleteOp,
    titleField,
    emailField,
    stateField,
    legacyField,
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

  return { sourceApp, targetApp, sourceSpec, targetSpec, proposal, items, allItems };
}
