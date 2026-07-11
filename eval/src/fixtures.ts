import type {
  ApiSpec,
  GeneratedBy,
  IrOperation,
  IrResourceGroup,
  MappingPhase,
  MappingProposal,
  MappingProposalItem,
  ShortlistResultPair,
  TransformKind,
} from "@mediator/domain";

import type { HarnessConfig } from "./config.js";
import type { ProposalWithItems, ScoringInput } from "./context.js";
import { parseGroundTruth } from "./ground-truth.js";
import type { LoadedSpec } from "./scenario-loader.js";

/**
 * Hand-built fixtures for the deterministic scoring tests. Everything here is fully
 * controlled — small IRs whose `resourceRef`s align 1:1 to the ground-truth
 * resources, and hand-built proposals — so the tests can assert EXACT metric
 * numbers (the gate-able part of the harness). No provider, no IR builder, no I/O.
 */

const CREATED_AT = new Date("2026-07-10T00:00:00.000Z");

export const FIXTURE_CONFIG: HarnessConfig = {
  confidenceThreshold: 0.7,
  shortlistRecallFloor: 0.8,
};

export const FIXTURE_GENERATED_BY: GeneratedBy = {
  providerId: "fixture",
  model: "fixture-model",
  promptVersion: "fixture-v1",
};

// ── IR + spec builders ───────────────────────────────────────────────────────

function irOp(operationId: string, method: IrOperation["method"], path: string): IrOperation {
  return { operationId, method, path, parameters: [] };
}

function group(resourceRef: string, operations: IrOperation[]): IrResourceGroup {
  return { resourceRef, name: resourceRef, operations, schemas: [], crossResourceRefs: [] };
}

function spec(
  id: string,
  app: string,
  role: ApiSpec["role"],
  parsedIR: IrResourceGroup[],
): LoadedSpec {
  return {
    app,
    spec: {
      id,
      appId: `app-${app}`,
      role,
      rawDocument: {},
      parsedIR,
      analysisExclusions: [],
      version: 1,
      contentHash: `hash-${id}`,
      status: "active",
      createdAt: CREATED_AT,
    },
  };
}

// ── Proposal-item builders ───────────────────────────────────────────────────

let itemCounter = 0;
function nextId(): string {
  itemCounter += 1;
  return `item-${String(itemCounter)}`;
}

export function operationItem(
  sourceRef: string,
  targetRef: string,
  sourceOperationId: string,
  targetOperationId: string,
  confidence: number,
): MappingProposalItem {
  return {
    id: nextId(),
    proposalId: "p",
    kind: "operation",
    sourceRef: {
      resourceRef: sourceRef,
      target: { kind: "operation", operationId: sourceOperationId },
    },
    targetRef: {
      resourceRef: targetRef,
      target: { kind: "operation", operationId: targetOperationId },
    },
    transformSuggestion: null,
    confidenceScore: confidence,
    ambiguousAlternatives: [],
    unmapped: false,
    rationale: "",
    reviewState: "pending",
  };
}

export function fieldItem(
  sourceRef: string,
  targetRef: string,
  sourceField: string,
  targetField: string,
  transform: TransformKind,
  confidence: number,
  opts: { identity?: boolean; phase?: MappingPhase } = {},
): MappingProposalItem {
  const base: MappingProposalItem = {
    id: nextId(),
    proposalId: "p",
    kind: "field",
    sourceRef: { resourceRef: sourceRef, target: { kind: "field", path: sourceField } },
    targetRef: { resourceRef: targetRef, target: { kind: "field", path: targetField } },
    transformSuggestion: { transform },
    confidenceScore: confidence,
    ambiguousAlternatives: [],
    unmapped: false,
    rationale: "",
    reviewState: "pending",
  };
  const withIdentity = opts.identity === true ? { ...base, identityCandidate: true } : base;
  return opts.phase === undefined ? withIdentity : { ...withIdentity, phase: opts.phase };
}

export function parameterItem(
  sourceRef: string,
  targetRef: string,
  sourceOperationId: string,
  targetOperationId: string,
  sourceParam: string,
  targetParam: string,
  confidence: number,
): MappingProposalItem {
  return {
    id: nextId(),
    proposalId: "p",
    kind: "parameter",
    sourceRef: {
      resourceRef: sourceRef,
      target: { kind: "parameter", operationId: sourceOperationId, parameter: sourceParam },
    },
    targetRef: {
      resourceRef: targetRef,
      target: { kind: "parameter", operationId: targetOperationId, parameter: targetParam },
    },
    transformSuggestion: null,
    confidenceScore: confidence,
    ambiguousAlternatives: [],
    unmapped: false,
    rationale: "",
    reviewState: "pending",
  };
}

function proposal(
  id: string,
  sourceSpecId: string,
  targetSpecId: string,
  candidatePairs: ShortlistResultPair[],
  items: MappingProposalItem[],
): ProposalWithItems {
  const p: MappingProposal = {
    id,
    sourceSpecId,
    targetSpecId,
    generatedBy: FIXTURE_GENERATED_BY,
    shortlistResult: { candidatePairs, noCounterpartResources: [] },
    status: "pending",
    createdAt: CREATED_AT,
  };
  return { proposal: p, items };
}

function candidate(
  sourceResource: string,
  targetResource: string,
  confidence: number,
  analysisFailed = false,
): ShortlistResultPair {
  return { sourceResource, targetResource, confidence, rationale: "", analysisFailed };
}

// ── Peer-peer fixture ────────────────────────────────────────────────────────

const PEER_GROUND_TRUTH = `
meta:
  scenario: fixture-peer
pairs:
  - source: { app: a, resource: widgets }
    target: { app: b, resource: gadgets }
    kind: peer-peer
    operations:
      list: { source: GET /widgets, target: GET /gadgets }
      create: { source: POST /widgets, target: POST /gadgets }
    identityKey: { source: code, target: code2 }
    fields:
      - { source: name, target: label, transform: rename }
      - { source: code, target: code2, transform: direct }
    plausible:
      - { source: note, target: label }
    unmapped:
      source: [secret]
      target: []
negatives:
  - source: { app: a, resource: legacy }
    target: { app: b, resource: orphan }
    verdict: incorrect-but-tempting
  - source: { app: a, resource: spare }
    target: { app: b, resource: sundry }
    verdict: ambiguous
`;

/**
 * A fully-controlled peer-peer scenario: `app-a/widgets` ↔ `app-b/gadgets` (a
 * genuine pair), a confidently-proposed `incorrect-but-tempting` negative, and a
 * low-confidence `ambiguous` negative. IR `resourceRef`s align 1:1 by operation.
 */
export function peerScoringInput(): ScoringInput {
  itemCounter = 0;
  const specA = spec("spec-a", "a", "PROVIDER", [
    group("widget", [
      irOp("listWidgets", "get", "/widgets"),
      irOp("createWidgets", "post", "/widgets"),
    ]),
    group("legacy", [irOp("listLegacy", "get", "/legacy")]),
    group("spare", [irOp("listSpare", "get", "/spare")]),
  ]);
  const specB = spec("spec-b", "b", "PROVIDER", [
    group("gadget", [
      irOp("listGadgets", "get", "/gadgets"),
      irOp("createGadgets", "post", "/gadgets"),
    ]),
    group("orphan", [irOp("listOrphan", "get", "/orphan")]),
    group("sundry", [irOp("listSundry", "get", "/sundry")]),
  ]);

  const candidatePairs = [
    candidate("widget", "gadget", 0.9),
    candidate("legacy", "orphan", 0.8), // confident negative → failure
    candidate("spare", "sundry", 0.4), // low-confidence ambiguous → tolerated
  ];
  const items = [
    operationItem("widget", "gadget", "listWidgets", "listGadgets", 0.9),
    operationItem("widget", "gadget", "createWidgets", "createGadgets", 0.85),
    fieldItem("widget", "gadget", "name", "label", "rename", 0.9),
    fieldItem("widget", "gadget", "code", "code2", "rename", 0.95, { identity: true }),
    fieldItem("widget", "gadget", "note", "label", "rename", 0.9), // plausible false-positive
  ];

  const forward = proposal("p-ab", "spec-a", "spec-b", candidatePairs, items);
  const backward = proposal("p-ba", "spec-b", "spec-a", candidatePairs, []);

  return {
    scenario: "fixture-peer",
    groundTruth: parseGroundTruth(PEER_GROUND_TRUTH),
    specs: [specA, specB],
    proposals: [forward, backward],
    generatedBy: FIXTURE_GENERATED_BY,
    config: FIXTURE_CONFIG,
  };
}

// ── Consumer-provider fixture ────────────────────────────────────────────────

const CONSUMER_GROUND_TRUTH = `
meta:
  scenario: fixture-consumer
pairs:
  - source: { app: widget-consumer, resource: todos }
    target: { app: backend, resource: tasks }
    kind: consumer-provider
    operations:
      - consumer: GET /todos
        binding:
          backend: GET /tasks
          aggregation: single
        parameters:
          - { source: "query:page", target: "query:page", transform: direct }
        response:
          - { source: id, target: todoId, transform: coerce }
          - { source: title, target: name, transform: rename }
      - consumer: POST /todos/{id}/done
        binding:
          backend: POST /tasks/{id}
          aggregation: single
        parameters:
          - { source: "path:id", target: "path:id", transform: coerce }
        request:
          - { source: name, target: title, transform: rename }
          - { source: null, target: done, transform: expression }
`;

/** A consumer-provider scenario exercising phase, parameters, and constant synthesis (`done`). */
export function consumerScoringInput(): ScoringInput {
  itemCounter = 0;
  const consumer = spec("spec-c", "widget-consumer", "CONSUMER", [
    group("todo", [
      irOp("listTodos", "get", "/todos"),
      irOp("completeTodo", "post", "/todos/{id}/done"),
    ]),
  ]);
  const provider = spec("spec-p", "backend", "PROVIDER", [
    group("task", [irOp("getTasks", "get", "/tasks"), irOp("postTask", "post", "/tasks/{id}")]),
  ]);

  const items = [
    fieldItem("todo", "task", "id", "todoId", "coerce", 0.85, { phase: "response" }),
    fieldItem("todo", "task", "title", "name", "rename", 0.8, { phase: "response" }),
    fieldItem("todo", "task", "name", "title", "rename", 0.8, { phase: "request" }),
    fieldItem("todo", "task", "state", "done", "expression", 0.75, { phase: "request" }),
    parameterItem("todo", "task", "listTodos", "getTasks", "page", "page", 0.8),
  ];
  const forward = proposal("p-cp", "spec-c", "spec-p", [candidate("todo", "task", 0.9)], items);

  return {
    scenario: "fixture-consumer",
    groundTruth: parseGroundTruth(CONSUMER_GROUND_TRUTH),
    specs: [consumer, provider],
    proposals: [forward],
    generatedBy: FIXTURE_GENERATED_BY,
    config: FIXTURE_CONFIG,
  };
}

// ── Stage-2 scoping fixture (shortlist-conditional stage-2 metrics) ───────────

const SCOPING_GROUND_TRUTH = `
meta:
  scenario: fixture-scoping
pairs:
  - source: { app: a, resource: widgets }
    target: { app: b, resource: gadgets }
    kind: peer-peer
    operations:
      list: { source: GET /widgets, target: GET /gadgets }
      create: { source: POST /widgets, target: POST /gadgets }
    identityKey: { source: code, target: code2 }
    fields:
      - { source: name, target: label, transform: rename }
      - { source: code, target: code2, transform: direct }
  - source: { app: a, resource: gizmos }
    target: { app: b, resource: doohickeys }
    kind: peer-peer
    operations:
      list: { source: GET /gizmos, target: GET /doohickeys }
    fields:
      - { source: foo, target: bar, transform: rename }
  - source: { app: a, resource: gears }
    target: { app: b, resource: cogs }
    kind: peer-peer
    operations:
      list: { source: GET /gears, target: GET /cogs }
    fields:
      - { source: baz, target: qux, transform: rename }
`;

/**
 * A scenario with three genuine ground-truth pairs but only ONE fully detected:
 * `widgets↔gadgets` is shortlisted + detail-analyzed; `gizmos↔doohickeys` is
 * resolvable but NOT shortlisted (a stage-1 recall miss); `gears↔cogs` is
 * shortlisted but its detail call `analysisFailed` (a stage-2 detail failure).
 * Used to assert stage-2 aggregates are conditional on shortlist — the two
 * undetected pairs must NOT drag the stage-2 precision/recall/CRUD denominators.
 */
export function peerScopingInput(): ScoringInput {
  itemCounter = 0;
  const specA = spec("spec-a", "a", "PROVIDER", [
    group("widget", [
      irOp("listWidgets", "get", "/widgets"),
      irOp("createWidgets", "post", "/widgets"),
    ]),
    group("gizmo", [irOp("listGizmos", "get", "/gizmos")]),
    group("gear", [irOp("listGears", "get", "/gears")]),
  ]);
  const specB = spec("spec-b", "b", "PROVIDER", [
    group("gadget", [
      irOp("listGadgets", "get", "/gadgets"),
      irOp("createGadgets", "post", "/gadgets"),
    ]),
    group("doohickey", [irOp("listDoohickeys", "get", "/doohickeys")]),
    group("cog", [irOp("listCogs", "get", "/cogs")]),
  ]);

  // widgets↔gadgets shortlisted+analyzed; gears↔cogs shortlisted but detail-failed;
  // gizmos↔doohickeys deliberately absent from the shortlist.
  const candidatePairs = [candidate("widget", "gadget", 0.9), candidate("gear", "cog", 0.5, true)];
  const items = [
    operationItem("widget", "gadget", "listWidgets", "listGadgets", 0.9),
    operationItem("widget", "gadget", "createWidgets", "createGadgets", 0.85),
    fieldItem("widget", "gadget", "name", "label", "rename", 0.9),
    fieldItem("widget", "gadget", "code", "code2", "rename", 0.95, { identity: true }),
  ];
  const forward = proposal("s-ab", "spec-a", "spec-b", candidatePairs, items);
  const backward = proposal("s-ba", "spec-b", "spec-a", candidatePairs, []);

  return {
    scenario: "fixture-scoping",
    groundTruth: parseGroundTruth(SCOPING_GROUND_TRUTH),
    specs: [specA, specB],
    proposals: [forward, backward],
    generatedBy: FIXTURE_GENERATED_BY,
    config: FIXTURE_CONFIG,
  };
}
