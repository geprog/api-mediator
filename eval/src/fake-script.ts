import { FakeProvider, type FakeProviderScript, type LLMMappingProvider } from "@mediator/llm";

/**
 * Scripted `FakeProvider` scenarios for the `--provider fake` smoke — a
 * deterministic, network-free stand-in that proves the whole harness pipeline
 * (load → detect → align → score → report) without a live model. It is NOT a
 * ground-truth oracle: the scripted outputs are a plausible partial run over the
 * real scenario-1 IR (real `resourceRef`s and `operationId`s so alignment and CRUD
 * scoring resolve), deliberately including a shortlist miss and a low-confidence
 * ambiguous pair so the report exercises those metric paths.
 */

// Canonical shortlist for scenario-1's Gitea↔Vikunja pair (spec-gitea < spec-vikunja
// → Gitea is the canonical source). `issue`/`task`/`user`/`repository`/`project` are
// the real trimmed-IR resource groups.
const scenario1Shortlist = {
  candidatePairs: [
    {
      sourceResource: "issue",
      targetResource: "task",
      confidence: 0.85,
      rationale: "Both are trackable work items with a title and a completion state.",
    },
    {
      sourceResource: "user",
      targetResource: "user",
      confidence: 0.65,
      rationale: "Both model user accounts.",
    },
    {
      sourceResource: "repository",
      targetResource: "project",
      confidence: 0.3,
      rationale: "Structural analog only — likely not a real sync pair (ambiguous).",
    },
  ],
};

/** Rich issues→tasks detail matching the scenario-1 ground truth (real operationIds). */
const issuesToTasks = {
  variant: "peer-peer",
  operationMappings: [
    op("issueListIssues", "get /tasks", 0.9, "collection list"),
    op("issueGetIssue", "get /tasks/{id}", 0.9, "single read"),
    op("issueCreateIssue", "put /projects/{id}/tasks", 0.85, "create (Vikunja PUT = create)"),
    op("issueEditIssue", "post /tasks/{id}", 0.8, "update (Vikunja POST = update)"),
    op("issueDelete", "delete /tasks/{id}", 0.9, "delete"),
  ],
  fieldMappings: [
    field("title", "title", "rename", 0.95, { identity: true }),
    field("body", "description", "rename", 0.85),
    field("state", "done", "coerce", 0.8, { detail: "open|closed -> boolean" }),
    field("due_date", "due_date", "rename", 0.8),
    field("created_at", "created", "rename", 0.8),
    field("updated_at", "updated", "rename", 0.8),
    field("closed_at", "done_at", "rename", 0.75),
    field("labels", "labels", "rename", 0.7),
    field("assignees", "assignees", "rename", 0.7),
  ],
};

const tasksToIssues = {
  variant: "peer-peer",
  operationMappings: [op("get /tasks", "issueListIssues", 0.9, "collection list")],
  fieldMappings: [field("title", "title", "rename", 0.95, { identity: true })],
};

const usersToUsers = {
  variant: "peer-peer",
  operationMappings: [],
  fieldMappings: [
    field("login", "username", "rename", 0.6, { identity: true }),
    field("email", "email", "rename", 0.6),
  ],
};

const emptyPeerPeer = { variant: "peer-peer", operationMappings: [], fieldMappings: [] };

function op(
  sourceOperationId: string,
  targetOperationId: string,
  confidence: number,
  rationale: string,
): unknown {
  return {
    sourceOperationId,
    targetOperationId,
    confidence,
    rationale,
    ambiguousAlternatives: [],
    unmapped: false,
  };
}

function field(
  sourceField: string,
  targetField: string,
  transform: string,
  confidence: number,
  opts: { identity?: boolean; detail?: string } = {},
): unknown {
  const base = {
    sourceField,
    targetField,
    transform,
    transformDetail: opts.detail ?? "",
    confidence,
    rationale: "",
    ambiguousAlternatives: [],
    unmapped: false,
  };
  return opts.identity === true ? { ...base, identityCandidate: true } : base;
}

const SCENARIO_1_SCRIPT: FakeProviderScript = {
  providerId: "fake",
  model: "fake-scenario-1",
  shortlistKey: () => "gitea-vikunja",
  shortlist: { "gitea-vikunja": [scenario1Shortlist] },
  detail: {
    "issue=>task@peer-peer": [issuesToTasks],
    "task=>issue@peer-peer": [tasksToIssues],
    "user=>user@peer-peer": [usersToUsers],
    "repository=>project@peer-peer": [emptyPeerPeer],
    "project=>repository@peer-peer": [emptyPeerPeer],
  },
};

/** An empty-shortlist fake for any other scenario — a well-formed but empty run. */
const EMPTY_SCRIPT: FakeProviderScript = {
  providerId: "fake",
  model: "fake-empty",
  shortlistKey: () => "any",
  shortlist: { any: [{ candidatePairs: [] }] },
  detail: {},
};

/**
 * Build a scripted `FakeProvider` for a scenario. Scenario-1 gets the rich partial
 * script above; every other scenario gets an empty-shortlist fake that still
 * produces a well-formed, non-empty report (proposals with empty shortlists).
 */
export function buildFakeProvider(scenario: string): LLMMappingProvider {
  return new FakeProvider(
    scenario === "scenario-1-small-overlap" ? SCENARIO_1_SCRIPT : EMPTY_SCRIPT,
  );
}
