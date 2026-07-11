import type { IrResourceGroup, MappingSuggestionSet, ResourceShortlist } from "@mediator/domain";

import type { MappingPromptContext, ShortlistPromptContext, SpecSummaryIR } from "./provider.js";

/**
 * Shared test fixtures for the `@mediator/llm` unit tests. Deliberately **not**
 * built into `dist` (excluded in `tsconfig.build.json`): these are test-only
 * sample IR summaries, full resources, and valid/malformed stage outputs, shaped
 * on the scenario-1 Gitea `issues` ↔ Vikunja `tasks` pair used across TD-2.
 *
 * All fixture data is spec metadata only — no credential or live-record values —
 * so it doubles as a check that the LLM data boundary carries only metadata.
 */

// ── Stage-1 summaries ────────────────────────────────────────────────────────

export const sourceSpecSummary: SpecSummaryIR = [
  {
    resourceRef: "issues",
    name: "Issues",
    description: "Gitea issues on a repository",
    operationSummaries: ["List repository issues", "Create an issue"],
    topLevelFields: ["id", "title", "body", "state"],
  },
  {
    resourceRef: "labels",
    name: "Labels",
    description: "Issue labels",
    operationSummaries: ["List labels"],
    topLevelFields: ["id", "name", "color"],
  },
];

export const targetSpecSummary: SpecSummaryIR = [
  {
    resourceRef: "tasks",
    name: "Tasks",
    description: "Vikunja tasks in a project",
    operationSummaries: ["List project tasks", "Create a task"],
    topLevelFields: ["id", "title", "description", "done"],
  },
];

export const shortlistContext: ShortlistPromptContext = {
  sourceSpecSummaryIR: sourceSpecSummary,
  targetSpecSummaryIR: targetSpecSummary,
  promptVersion: "test-prompt-v1",
};

// ── Stage-2 full resources ───────────────────────────────────────────────────

export const issuesResource: IrResourceGroup = {
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
      responseSchema: {
        name: "Issue",
        fields: [
          { name: "id", type: "integer", required: true },
          { name: "title", type: "string", required: true },
        ],
      },
    },
  ],
  schemas: [
    {
      name: "Issue",
      fields: [
        { name: "id", type: "integer", required: true },
        { name: "title", type: "string", required: true, description: "Issue title" },
        { name: "body", type: "string", required: false },
      ],
    },
  ],
  crossResourceRefs: [],
};

export const tasksResource: IrResourceGroup = {
  resourceRef: "tasks",
  name: "Tasks",
  operations: [
    {
      operationId: "getProjectTasks",
      method: "get",
      path: "/projects/{project}/tasks",
      summary: "List a project's tasks",
      parameters: [{ name: "filter", location: "query", required: false, type: "string" }],
      responseSchema: {
        name: "Task",
        fields: [
          { name: "id", type: "integer", required: true },
          { name: "title", type: "string", required: true },
        ],
      },
    },
  ],
  schemas: [
    {
      name: "Task",
      fields: [
        { name: "id", type: "integer", required: true },
        { name: "title", type: "string", required: true },
        { name: "description", type: "string", required: false },
      ],
    },
  ],
  crossResourceRefs: [],
};

export const peerPeerDetailContext: MappingPromptContext = {
  sourceResourceIR: issuesResource,
  targetResourceIR: tasksResource,
  variant: "peer-peer",
  promptVersion: "test-prompt-v1",
};

export const consumerProviderDetailContext: MappingPromptContext = {
  sourceResourceIR: issuesResource,
  targetResourceIR: tasksResource,
  variant: "consumer-provider",
  promptVersion: "test-prompt-v1",
};

// ── Valid stage outputs ──────────────────────────────────────────────────────

export const validShortlist: ResourceShortlist = {
  candidatePairs: [
    {
      sourceResource: "issues",
      targetResource: "tasks",
      confidence: 0.82,
      rationale: "Both are trackable work items with a title and completion state.",
    },
  ],
};

/** Peer-peer set with the identityCandidate on the value-preserving title↔title pairing. */
export const validPeerPeerSet: MappingSuggestionSet = {
  variant: "peer-peer",
  operationMappings: [
    {
      sourceOperationId: "issueListIssues",
      targetOperationId: "getProjectTasks",
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
      transform: "rename",
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
      transform: "rename",
      transformDetail: "",
      confidence: 0.72,
      rationale: "Free-text body maps to description.",
      ambiguousAlternatives: [],
      unmapped: false,
    },
  ],
};

export const validConsumerProviderSet: MappingSuggestionSet = {
  variant: "consumer-provider",
  operationMappings: [
    {
      sourceOperationId: "issueListIssues",
      targetOperationId: "getProjectTasks",
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
      phase: "response",
      transform: "rename",
      transformDetail: "",
      confidence: 0.85,
      rationale: "Backend title returned to the consumer.",
      ambiguousAlternatives: [],
      unmapped: false,
    },
    {
      sourceField: "state",
      targetField: "filter",
      phase: "request",
      transform: "coerce",
      transformDetail: "map open/closed to a filter expression",
      confidence: 0.6,
      rationale: "Consumer state filter mapped to the backend filter query.",
      ambiguousAlternatives: [],
      unmapped: false,
    },
  ],
  parameterMappings: [
    {
      sourceOperationId: "issueListIssues",
      targetOperationId: "getProjectTasks",
      sourceParam: "owner",
      targetParam: "project",
      confidence: 0.7,
      rationale: "Owner scopes issues; project scopes tasks.",
      unmapped: false,
    },
  ],
};

// ── Malformed / wrong-variant outputs (rejected by the shared schema) ─────────

/** Missing `targetResource`, `confidence`, `rationale` on the pair. */
export const malformedShortlist: unknown = {
  candidatePairs: [{ sourceResource: "issues" }],
};

/** A `phase` on a peer-peer field is a strict-mode-rejected unknown key. */
export const wrongVariantPeerPeerSet: unknown = {
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

/** Two identityCandidate:true pairings violate the "at most one" rule. */
export const twoIdentityCandidatesSet: unknown = {
  variant: "peer-peer",
  operationMappings: [],
  fieldMappings: [
    {
      sourceField: "title",
      targetField: "title",
      transform: "rename",
      transformDetail: "",
      identityCandidate: true,
      confidence: 0.9,
      rationale: "first identity",
      ambiguousAlternatives: [],
      unmapped: false,
    },
    {
      sourceField: "id",
      targetField: "id",
      transform: "rename",
      transformDetail: "",
      identityCandidate: true,
      confidence: 0.9,
      rationale: "second identity",
      ambiguousAlternatives: [],
      unmapped: false,
    },
  ],
};

// ── Repairable outputs (fixed by the repair pass before validation) ───────────

/**
 * Out-of-range `confidence` on the pairs — `2` (over) and `-5` (under). Ollama's
 * `format` grammar does not enforce numeric range, so a model can emit these; the
 * repair pass clamps them to `1` / `0` so an otherwise-valid answer still validates.
 */
export const outOfRangeConfidenceShortlist: unknown = {
  candidatePairs: [
    { sourceResource: "issues", targetResource: "tasks", confidence: 2, rationale: "over range" },
    { sourceResource: "labels", targetResource: "tags", confidence: -5, rationale: "under range" },
  ],
};

/** Whitespace-padded `resourceRef`s — the repair pass trims them before validation. */
export const paddedRefsShortlist: unknown = {
  candidatePairs: [
    {
      sourceResource: "  issues  ",
      targetResource: "\ttasks\n",
      confidence: 0.8,
      rationale: "padded refs",
    },
  ],
};

/**
 * A peer-peer set with out-of-range `confidence` on an operation mapping (`5`), a
 * field mapping (`-3`), and a nested `ambiguousAlternatives` entry (`9`) — all
 * clamped into `[0,1]` by the repair pass so the set validates.
 */
export const outOfRangeConfidencePeerPeerSet: unknown = {
  variant: "peer-peer",
  operationMappings: [
    {
      sourceOperationId: "issueListIssues",
      targetOperationId: "getProjectTasks",
      confidence: 5,
      rationale: "over range",
      ambiguousAlternatives: [],
      unmapped: false,
    },
  ],
  fieldMappings: [
    {
      sourceField: "title",
      targetField: "title",
      transform: "rename",
      transformDetail: "",
      confidence: -3,
      rationale: "under range",
      ambiguousAlternatives: [{ targetField: "name", confidence: 9 }],
      unmapped: false,
    },
  ],
};
