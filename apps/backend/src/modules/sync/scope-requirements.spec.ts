import type {
  ApiSpec,
  AppCapabilities,
  ApprovedMapping,
  ConfirmableRef,
  FieldMapping,
  IrOperation,
  IrParameter,
  IrRefTarget,
  IrResourceGroup,
  OperationMapping,
  RegisteredApp,
  ResourceBinding,
  ScopePathBinding,
  SourceScopeRef,
  SyncRule,
} from "@mediator/domain";
import { stripUndefined } from "@mediator/domain";
import {
  findUnfilledPathParam,
  resolveSourceReadBinding,
  resolveWriteOperationBinding,
} from "@mediator/outbound";
import { evaluateEnablement, type EnablementInput } from "@mediator/sync-engine";
import { describe, expect, it } from "vitest";

import type { RuleArtifacts } from "./resolution.js";
import { computeRequiredScopeBindings } from "./scope-requirements.js";

/**
 * Unit tests for the **SS-5 scope-requirement classification** — which scope
 * (non-record-id) path parameters the operations a rule actually calls require, keyed to
 * the SAME record-id-vs-scope split the SS-4 resolver uses. Fixtures are hand-built IR
 * that mirrors scenario-1 shapes (Gitea `/repos/{owner}/{repo}/issues…`, Vikunja
 * `/tasks/{id}` + `/projects/{id}/tasks`) plus a couple of edges. The gate-composition
 * tests feed the computed `requiredScopeBindings` through the real `evaluateEnablement`,
 * exactly as the SA enable flow does.
 */

const T0 = new Date("2026-07-16T00:00:00.000Z");

// ── IR + domain builders ───────────────────────────────────────────────────────

function confirmedRef(value: IrRefTarget): ConfirmableRef {
  return { value, confirmedBy: "op", confirmedAt: T0 };
}
function pathParam(name: string): IrParameter {
  return { name, location: "path", required: true };
}
function queryParam(name: string): IrParameter {
  return { name, location: "query", required: false };
}
function operation(o: {
  operationId: string;
  method: IrOperation["method"];
  path: string;
  parameters?: readonly IrParameter[];
}): IrOperation {
  return {
    operationId: o.operationId,
    method: o.method,
    path: o.path,
    parameters: [...(o.parameters ?? [])],
  };
}
function group(resourceRef: string, operations: readonly IrOperation[]): IrResourceGroup {
  return {
    resourceRef,
    name: resourceRef,
    operations: [...operations],
    schemas: [],
    crossResourceRefs: [],
  };
}
function confirmedConstant(parameterName: string, value: string): ScopePathBinding {
  return { kind: "constant", parameterName, value, confirmedBy: "op", confirmedAt: T0 };
}
function unconfirmedConstant(parameterName: string): ScopePathBinding {
  return { kind: "constant", parameterName, value: "", confirmedBy: null, confirmedAt: null };
}
function confirmedRecordDerived(parameterName: string, sourceScopeKey: string): ScopePathBinding {
  return {
    kind: "record-derived",
    parameterName,
    sourceScopeKey,
    confirmedBy: "op",
    confirmedAt: T0,
  };
}
function unconfirmedRecordDerived(parameterName: string, sourceScopeKey: string): ScopePathBinding {
  return {
    kind: "record-derived",
    parameterName,
    sourceScopeKey,
    confirmedBy: null,
    confirmedAt: null,
  };
}
function confirmedSourceScopeRef(
  components: readonly { key: string; fieldPath: string }[],
): SourceScopeRef {
  return { components: [...components], confirmedBy: "op", confirmedAt: T0 };
}
function binding(o: {
  resourceRef: string;
  nativeId?: boolean;
  collectionRead?: string;
  scopePathBindings?: readonly ScopePathBinding[];
}): ResourceBinding {
  return stripUndefined({
    id: `rb-${o.resourceRef}`,
    apiSpecId: `spec-${o.resourceRef}`,
    resourceRef: o.resourceRef,
    nativeIdRef: o.nativeId === true ? confirmedRef({ kind: "field", path: "id" }) : undefined,
    collectionReadRef:
      o.collectionRead !== undefined
        ? confirmedRef({ kind: "operation", operationId: o.collectionRead })
        : undefined,
    scopePathBindings: [...(o.scopePathBindings ?? [])],
  });
}
function capabilities(overrides: Partial<AppCapabilities> = {}): AppCapabilities {
  return {
    supportsPolling: true,
    supportsDeltaQuery: false,
    supportsChangeTimestamps: false,
    defaultPollInterval: 60_000,
    ...overrides,
  };
}
function app(id: string, caps: AppCapabilities): RegisteredApp {
  return {
    id,
    name: id,
    status: "active",
    baseUrl: `https://${id}`,
    capabilities: caps,
    createdAt: T0,
  };
}
function spec(id: string, appId: string, parsedIR: readonly IrResourceGroup[]): ApiSpec {
  return {
    id,
    appId,
    role: "PROVIDER",
    rawDocument: {},
    parsedIR: [...parsedIR],
    analysisExclusions: [],
    version: 1,
    contentHash: "hash",
    status: "active",
    createdAt: T0,
  };
}
function mapping(): ApprovedMapping {
  return {
    id: "map-1",
    sourceSpecId: "spec-src",
    targetSpecId: "spec-tgt",
    sourceAppId: "app-src",
    targetAppId: "app-tgt",
    variant: "peer-peer",
    approvedBy: "op",
    approvedAt: T0,
    status: "active",
  };
}
function makeRule(overrides: Partial<SyncRule> = {}): SyncRule {
  return {
    id: "rule-1",
    approvedMappingId: "map-1",
    resourcePairRef: "app-src:src|app-tgt:tgt",
    status: "disabled",
    pollOperationRef: undefined,
    deletePropagation: "ignore",
    backfillMode: "link-only",
    backfillStatus: "pending",
    ...overrides,
  };
}
const identityKey: FieldMapping = {
  id: "fm-id",
  mappingId: "map-1",
  sourcePath: "number",
  targetPath: "identifier",
  transform: "rename",
  isIdentityKey: true,
  targetLookupParamRef: "filter", // filtered-read → never fetch-and-match
};
function omap(o: {
  id: string;
  action: OperationMapping["action"];
  targetOperationRef: string;
  targetIdParamRef?: string;
}): OperationMapping {
  return stripUndefined({
    id: o.id,
    mappingId: "map-1",
    sourceOperationRef: `src.${o.id}`,
    targetOperationRef: o.targetOperationRef,
    action: o.action,
    targetIdParamRef: o.targetIdParamRef,
  });
}

function makeArtifacts(o: {
  rule?: SyncRule;
  operationMappings: readonly OperationMapping[];
  fieldMappings?: readonly FieldMapping[];
  sourceGroup: IrResourceGroup;
  targetGroup: IrResourceGroup;
  sourceBinding: ResourceBinding;
  targetBinding: ResourceBinding;
  sourceCapabilities?: AppCapabilities;
}): RuleArtifacts {
  const rule = o.rule ?? makeRule();
  return {
    rule,
    mapping: mapping(),
    fieldMappings: o.fieldMappings ?? [identityKey],
    operationMappings: [...o.operationMappings],
    sourceApp: app("app-src", o.sourceCapabilities ?? capabilities()),
    targetApp: app("app-tgt", capabilities()),
    sourceBaseUrl: "https://app-src",
    targetBaseUrl: "https://app-tgt",
    sourceSpec: spec("spec-src", "app-src", [o.sourceGroup]),
    targetSpec: spec("spec-tgt", "app-tgt", [o.targetGroup]),
    sourceGroup: o.sourceGroup,
    targetGroup: o.targetGroup,
    sourceBinding: o.sourceBinding,
    targetBinding: o.targetBinding,
    sourceResourceRef: o.sourceGroup.resourceRef,
    targetResourceRef: o.targetGroup.resourceRef,
    appAId: "app-src",
    appBId: "app-tgt",
  };
}

// ── Scenario-1 IR shapes ─────────────────────────────────────────────────────

/** Gitea issues (source): every op is repo-scoped by `{owner}`/`{repo}`. */
const giteaIssues = group("src", [
  operation({
    operationId: "listRepoIssues",
    method: "get",
    path: "/repos/{owner}/{repo}/issues",
    parameters: [pathParam("owner"), pathParam("repo")],
  }),
  operation({
    operationId: "getIssue",
    method: "get",
    path: "/repos/{owner}/{repo}/issues/{index}",
    parameters: [pathParam("owner"), pathParam("repo"), pathParam("index")],
  }),
]);

/** Vikunja tasks (target): asymmetric — id-only update/delete, scoped create. */
const vikunjaTasks = group("tgt", [
  operation({ operationId: "listTasks", method: "get", path: "/tasks" }),
  operation({
    operationId: "getTask",
    method: "get",
    path: "/tasks/{id}",
    parameters: [pathParam("id")],
  }),
  operation({
    operationId: "updateTask",
    method: "post",
    path: "/tasks/{id}",
    parameters: [pathParam("id")],
  }),
  operation({
    operationId: "deleteTask",
    method: "delete",
    path: "/tasks/{id}",
    parameters: [pathParam("id")],
  }),
  // The `{id}` here is the PROJECT scope, not the record id — same name, different role.
  operation({
    operationId: "createTask",
    method: "put",
    path: "/projects/{id}/tasks",
    parameters: [pathParam("id")],
  }),
]);

const updateTaskMapping = omap({
  id: "updateTask",
  action: "update",
  targetOperationRef: "tgt/updateTask",
  targetIdParamRef: "tgt/updateTask#id",
});
const createTaskMapping = omap({
  id: "createTask",
  action: "create",
  targetOperationRef: "tgt/createTask",
});
const deleteTaskMapping = omap({
  id: "deleteTask",
  action: "delete",
  targetOperationRef: "tgt/deleteTask",
  targetIdParamRef: "tgt/deleteTask#id",
});

function sourceIssuesBinding(scope: readonly ScopePathBinding[]): ResourceBinding {
  return binding({
    resourceRef: "src",
    nativeId: true,
    collectionRead: "listRepoIssues",
    scopePathBindings: scope,
  });
}
function targetTasksBinding(scope: readonly ScopePathBinding[]): ResourceBinding {
  return binding({
    resourceRef: "tgt",
    nativeId: true,
    collectionRead: "listTasks",
    scopePathBindings: scope,
  });
}

// ── SS-5.1/5.2/5.3 — which operations contribute which scope params ────────────

describe("computeRequiredScopeBindings — Gitea issues → Vikunja tasks", () => {
  it("update-only rule requires the source owner/repo and NO target project id (SS-5.3)", () => {
    const artifacts = makeArtifacts({
      rule: makeRule({ pollOperationRef: "src/listRepoIssues" }),
      operationMappings: [updateTaskMapping],
      sourceGroup: giteaIssues,
      targetGroup: vikunjaTasks,
      sourceBinding: sourceIssuesBinding([]),
      targetBinding: targetTasksBinding([]),
    });

    const required = computeRequiredScopeBindings(artifacts, { backfillSkipped: false });

    // Source: the repo-scoped poll + collection read → owner + repo (deduped).
    expect(required).toEqual(
      expect.arrayContaining([
        { kind: "constant", parameterName: "owner", side: "source", resourceRef: "src" },
        { kind: "constant", parameterName: "repo", side: "source", resourceRef: "src" },
      ]),
    );
    // SS-5.3: `POST /tasks/{id}` is id-only → NO target scope requirement.
    expect(required.filter((r) => r.side === "target")).toEqual([]);
    expect(required).toHaveLength(2);
  });

  it("create-capable rule ALSO requires the target project {id} (contrast with SS-5.3)", () => {
    const artifacts = makeArtifacts({
      rule: makeRule({ pollOperationRef: "src/listRepoIssues" }),
      operationMappings: [createTaskMapping, updateTaskMapping],
      sourceGroup: giteaIssues,
      targetGroup: vikunjaTasks,
      sourceBinding: sourceIssuesBinding([]),
      targetBinding: targetTasksBinding([]),
    });

    const required = computeRequiredScopeBindings(artifacts, { backfillSkipped: false });

    // `PUT /projects/{id}/tasks` create has NO targetIdParamRef → its `{id}` is scope.
    expect(required).toEqual(
      expect.arrayContaining([
        { kind: "constant", parameterName: "owner", side: "source", resourceRef: "src" },
        { kind: "constant", parameterName: "repo", side: "source", resourceRef: "src" },
        { kind: "constant", parameterName: "id", side: "target", resourceRef: "tgt" },
      ]),
    );
    expect(required).toHaveLength(3);
  });

  it("a propagate delete op that is id-only adds no scope (SS-5.3), and is ignored when not propagating", () => {
    const ignoring = makeArtifacts({
      rule: makeRule({ pollOperationRef: "src/listRepoIssues", deletePropagation: "ignore" }),
      operationMappings: [updateTaskMapping, deleteTaskMapping],
      sourceGroup: giteaIssues,
      targetGroup: vikunjaTasks,
      sourceBinding: sourceIssuesBinding([]),
      targetBinding: targetTasksBinding([]),
    });
    const propagating = makeArtifacts({
      rule: makeRule({ pollOperationRef: "src/listRepoIssues", deletePropagation: "propagate" }),
      operationMappings: [updateTaskMapping, deleteTaskMapping],
      sourceGroup: giteaIssues,
      targetGroup: vikunjaTasks,
      sourceBinding: sourceIssuesBinding([]),
      targetBinding: targetTasksBinding([]),
    });
    // `DELETE /tasks/{id}` is id-only, so it adds nothing either way; the source scope is
    // the same. (The delete op's inclusion is gated on propagation, but here it is empty.)
    expect(computeRequiredScopeBindings(ignoring, { backfillSkipped: false })).toEqual(
      computeRequiredScopeBindings(propagating, { backfillSkipped: false }),
    );
  });

  it("a SCOPED delete op is required only when deletePropagation = propagate", () => {
    // The delete op carries a scope (`{project}`) that no OTHER included op has (the update
    // is id-only), so it isolates the propagation gate: `ignore` never calls the delete →
    // no `project`; `propagate` calls it → `project` required.
    const scopedDeleteTarget = group("tgt", [
      operation({ operationId: "listTasks", method: "get", path: "/tasks" }),
      operation({
        operationId: "updateTask",
        method: "post",
        path: "/tasks/{id}",
        parameters: [pathParam("id")],
      }),
      operation({
        operationId: "deleteTaskScoped",
        method: "delete",
        path: "/projects/{project}/tasks/{id}",
        parameters: [pathParam("project"), pathParam("id")],
      }),
    ]);
    const scopedDeleteMapping = omap({
      id: "deleteTaskScoped",
      action: "delete",
      targetOperationRef: "tgt/deleteTaskScoped",
      targetIdParamRef: "tgt/deleteTaskScoped#id",
    });
    const base = {
      operationMappings: [updateTaskMapping, scopedDeleteMapping],
      sourceGroup: giteaIssues,
      targetGroup: scopedDeleteTarget,
      sourceBinding: sourceIssuesBinding([]),
      targetBinding: targetTasksBinding([]),
    } as const;

    const ignoring = computeRequiredScopeBindings(
      makeArtifacts({
        ...base,
        rule: makeRule({ pollOperationRef: "src/listRepoIssues", deletePropagation: "ignore" }),
      }),
      { backfillSkipped: false },
    );
    const propagating = computeRequiredScopeBindings(
      makeArtifacts({
        ...base,
        rule: makeRule({ pollOperationRef: "src/listRepoIssues", deletePropagation: "propagate" }),
      }),
      { backfillSkipped: false },
    );

    // `ignore` never calls `DELETE /projects/{project}/tasks/{id}` → no target scope.
    expect(ignoring.filter((r) => r.side === "target")).toEqual([]);
    // `propagate` calls it → its `{project}` scope (its `{id}` is the record id) is required.
    expect(propagating).toContainEqual({
      kind: "constant",
      parameterName: "project",
      side: "target",
      resourceRef: "tgt",
    });
    expect(propagating.filter((r) => r.side === "target")).toEqual([
      { kind: "constant", parameterName: "project", side: "target", resourceRef: "tgt" },
    ]);
  });
});

// ── Source backfill collection read conditioning (delta rule) ──────────────────

describe("computeRequiredScopeBindings — backfill collection-read conditioning", () => {
  // A cross-scope delta poll (no path params) + a repo-scoped collection read used for
  // backfill enumeration only.
  const crossScopeSource = group("src", [
    operation({ operationId: "searchIssues", method: "get", path: "/repos/issues/search" }),
    operation({
      operationId: "listRepoIssues",
      method: "get",
      path: "/repos/{owner}/{repo}/issues",
      parameters: [pathParam("owner"), pathParam("repo")],
    }),
  ]);

  function deltaArtifacts(): RuleArtifacts {
    return makeArtifacts({
      rule: makeRule({ pollOperationRef: "src/searchIssues" }),
      operationMappings: [updateTaskMapping],
      sourceGroup: crossScopeSource,
      targetGroup: vikunjaTasks,
      sourceBinding: stripUndefined({
        ...binding({ resourceRef: "src", nativeId: true, collectionRead: "listRepoIssues" }),
        deltaCursorRef: confirmedRef({
          kind: "parameter",
          operationId: "searchIssues",
          parameter: "since",
        }),
      }),
      targetBinding: targetTasksBinding([]),
      sourceCapabilities: capabilities({ supportsDeltaQuery: true }),
    });
  }

  it("includes the backfill collection read's scope when backfill runs (mirrors BE-2.2)", () => {
    const required = computeRequiredScopeBindings(deltaArtifacts(), { backfillSkipped: false });
    // Poll op is the cross-scope search (no path params); the scope comes only from the
    // repo-scoped collection read the backfill enumerates.
    expect(required).toEqual(
      expect.arrayContaining([
        { kind: "constant", parameterName: "owner", side: "source", resourceRef: "src" },
        { kind: "constant", parameterName: "repo", side: "source", resourceRef: "src" },
      ]),
    );
    expect(required).toHaveLength(2);
  });

  it("omits the backfill collection read's scope when backfill is explicitly skipped", () => {
    const required = computeRequiredScopeBindings(deltaArtifacts(), { backfillSkipped: true });
    // Delta rule + backfill skipped → the collection read is not enumerated, and the
    // cross-scope poll op carries no scope → no source requirement at all.
    expect(required).toEqual([]);
  });
});

// ── Target single-record read (only when the rule needs it) ────────────────────

describe("computeRequiredScopeBindings — target single-record read", () => {
  // Update is id-only PUT/PATCH (no scope); the single-record read is `{tenant}`-scoped,
  // so it is the SOLE contributor of the target `tenant` requirement — isolating whether
  // the read was consulted.
  const scopedReadTarget = group("tgt", [
    operation({ operationId: "listWidgets", method: "get", path: "/widgets" }),
    operation({
      operationId: "getWidget",
      method: "get",
      path: "/tenants/{tenant}/widgets/{id}",
      parameters: [pathParam("tenant"), pathParam("id")],
    }),
    operation({
      operationId: "updateWidgetPut",
      method: "put",
      path: "/widgets/{id}",
      parameters: [pathParam("id")],
    }),
    operation({
      operationId: "updateWidgetPatch",
      method: "patch",
      path: "/widgets/{id}",
      parameters: [pathParam("id")],
    }),
  ]);
  // A flat, scope-free source to isolate the target read's contribution.
  const flatSource = group("src", [
    operation({ operationId: "listFlat", method: "get", path: "/flat" }),
  ]);
  const flatSourceBinding = binding({
    resourceRef: "src",
    nativeId: true,
    collectionRead: "listFlat",
  });

  function widgetArtifacts(o: {
    updateOperationId: string;
    targetDriftCheck?: SyncRule["targetDriftCheck"];
  }): RuleArtifacts {
    return makeArtifacts({
      rule: makeRule(
        stripUndefined({ pollOperationRef: "src/listFlat", targetDriftCheck: o.targetDriftCheck }),
      ),
      operationMappings: [
        omap({
          id: "update",
          action: "update",
          targetOperationRef: `tgt/${o.updateOperationId}`,
          targetIdParamRef: `tgt/${o.updateOperationId}#id`,
        }),
      ],
      sourceGroup: flatSource,
      targetGroup: scopedReadTarget,
      sourceBinding: flatSourceBinding,
      targetBinding: binding({ resourceRef: "tgt", nativeId: true, collectionRead: "listWidgets" }),
    });
  }

  it("requires the read's scope for a PUT-shaped update (CF-5 read-carry)", () => {
    const required = computeRequiredScopeBindings(
      widgetArtifacts({ updateOperationId: "updateWidgetPut" }),
      { backfillSkipped: false },
    );
    expect(required).toEqual([
      { kind: "constant", parameterName: "tenant", side: "target", resourceRef: "tgt" },
    ]);
  });

  it("does NOT require the read's scope for a PATCH update with no drift check", () => {
    const required = computeRequiredScopeBindings(
      widgetArtifacts({ updateOperationId: "updateWidgetPatch" }),
      { backfillSkipped: false },
    );
    expect(required).toEqual([]);
  });

  it("requires the read's scope under targetDriftCheck = read-before-write (CF-6)", () => {
    const required = computeRequiredScopeBindings(
      widgetArtifacts({
        updateOperationId: "updateWidgetPatch",
        targetDriftCheck: "read-before-write",
      }),
      { backfillSkipped: false },
    );
    expect(required).toEqual([
      { kind: "constant", parameterName: "tenant", side: "target", resourceRef: "tgt" },
    ]);
  });
});

// ── Gate composition + no-divergence-from-SS-4 (the SA enable flow) ────────────

describe("scope requirements through evaluateEnablement (SA enable flow)", () => {
  /** A fully BE-passing create-capable scoped rule; scope confirmation is the only variable. */
  function scopedArtifacts(o: {
    sourceScope: readonly ScopePathBinding[];
    targetScope: readonly ScopePathBinding[];
  }): RuleArtifacts {
    return makeArtifacts({
      rule: makeRule({ pollOperationRef: "src/listRepoIssues" }),
      operationMappings: [createTaskMapping, updateTaskMapping],
      sourceGroup: giteaIssues,
      targetGroup: vikunjaTasks,
      sourceBinding: sourceIssuesBinding(o.sourceScope),
      targetBinding: targetTasksBinding(o.targetScope),
    });
  }

  function enablementInputFor(artifacts: RuleArtifacts, backfillSkipped: boolean): EnablementInput {
    return {
      rule: artifacts.rule,
      fieldMappings: artifacts.fieldMappings,
      operationMappings: artifacts.operationMappings,
      sourceBinding: artifacts.sourceBinding,
      targetBinding: artifacts.targetBinding,
      sourceCapabilities: artifacts.sourceApp.capabilities,
      targetCapabilities: artifacts.targetApp.capabilities,
      backfillSkipped,
      requiredScopeBindings: computeRequiredScopeBindings(artifacts, { backfillSkipped }),
    };
  }

  it("a fully-confirmed scoped rule enables (no scope blocker in stillNeeds)", () => {
    const artifacts = scopedArtifacts({
      sourceScope: [confirmedConstant("owner", "alice"), confirmedConstant("repo", "phoenix")],
      targetScope: [confirmedConstant("id", "42")],
    });
    const decision = evaluateEnablement(enablementInputFor(artifacts, false));
    expect(decision.kind).toBe("enable");
  });

  it("an unconfirmed target project {id} blocks with exactly the scope-binding requirement", () => {
    const artifacts = scopedArtifacts({
      sourceScope: [confirmedConstant("owner", "alice"), confirmedConstant("repo", "phoenix")],
      targetScope: [unconfirmedConstant("id")],
    });
    const decision = evaluateEnablement(enablementInputFor(artifacts, false));
    expect(decision.kind).toBe("blocked");
    if (decision.kind !== "blocked") throw new Error("expected blocked");
    expect(decision.stillNeeds).toContainEqual({
      kind: "scope-binding",
      parameterName: "id",
      side: "target",
      resourceRef: "tgt",
    });
    // Only the scope binding is missing — every other precondition is satisfied.
    expect(decision.stillNeeds).toEqual([
      { kind: "scope-binding", parameterName: "id", side: "target", resourceRef: "tgt" },
    ]);
  });

  it("the gate's required target set matches EXACTLY what the SS-4 resolver fills (no divergence)", () => {
    // With the project {id} confirmed, the write resolver composes a `{…}`-free path and
    // the gate raises no scope blocker.
    const confirmed = scopedArtifacts({
      sourceScope: [confirmedConstant("owner", "alice"), confirmedConstant("repo", "phoenix")],
      targetScope: [confirmedConstant("id", "42")],
    });
    const createBinding = resolveWriteOperationBinding(
      createTaskMapping,
      vikunjaTasks,
      confirmed.targetBinding,
    );
    expect(createBinding?.pathTemplate).toBe("/projects/42/tasks");
    expect(findUnfilledPathParam(createBinding?.pathTemplate ?? "")).toBeUndefined();
    expect(evaluateEnablement(enablementInputFor(confirmed, false)).kind).toBe("enable");

    // Drop the confirmed constant: the resolver refuses to fabricate (SS-4.4), and the
    // gate requires exactly that parameter — the two sets coincide.
    const missing = scopedArtifacts({
      sourceScope: [confirmedConstant("owner", "alice"), confirmedConstant("repo", "phoenix")],
      targetScope: [unconfirmedConstant("id")],
    });
    expect(
      resolveWriteOperationBinding(createTaskMapping, vikunjaTasks, missing.targetBinding),
    ).toBeUndefined();
    const decision = evaluateEnablement(enablementInputFor(missing, false));
    expect(decision.kind).toBe("blocked");
    if (decision.kind !== "blocked") throw new Error("expected blocked");
    expect(decision.stillNeeds).toEqual([
      { kind: "scope-binding", parameterName: "id", side: "target", resourceRef: "tgt" },
    ]);
  });
});

// ── Filtered-read lookup issues the target collection read (asymmetric scope) ───

describe("computeRequiredScopeBindings — filtered-read target collection read", () => {
  // An asymmetrically-scoped target (SS-2.4): its collection read (the filtered-read
  // lookup) is `{board}`-scoped, but its propagated write is id-only. The `{board}` scope
  // is therefore surfaced ONLY by the lookup read — proving filtered-read is gated too.
  const flatSource = group("src", [
    operation({ operationId: "listFlat", method: "get", path: "/flat" }),
  ]);
  const filteredReadTarget = group("tgt", [
    operation({
      operationId: "listBoardCards",
      method: "get",
      path: "/boards/{board}/cards",
      parameters: [pathParam("board"), queryParam("title")],
    }),
    operation({
      operationId: "updateCard",
      method: "post",
      path: "/cards/{id}",
      parameters: [pathParam("id")],
    }),
  ]);
  const filterKey: FieldMapping = { ...identityKey, targetLookupParamRef: "title" };
  const updateCardMapping = omap({
    id: "updateCard",
    action: "update",
    targetOperationRef: "tgt/updateCard",
    targetIdParamRef: "tgt/updateCard#id",
  });

  function filteredReadArtifacts(targetScope: readonly ScopePathBinding[]): RuleArtifacts {
    return makeArtifacts({
      rule: makeRule({ pollOperationRef: "src/listFlat" }),
      operationMappings: [updateCardMapping],
      fieldMappings: [filterKey],
      sourceGroup: flatSource,
      targetGroup: filteredReadTarget,
      sourceBinding: binding({ resourceRef: "src", nativeId: true, collectionRead: "listFlat" }),
      targetBinding: binding({
        resourceRef: "tgt",
        nativeId: true,
        collectionRead: "listBoardCards",
        scopePathBindings: targetScope,
      }),
    });
  }

  function enablementInputFor(artifacts: RuleArtifacts): EnablementInput {
    return {
      rule: artifacts.rule,
      fieldMappings: artifacts.fieldMappings,
      operationMappings: artifacts.operationMappings,
      sourceBinding: artifacts.sourceBinding,
      targetBinding: artifacts.targetBinding,
      sourceCapabilities: artifacts.sourceApp.capabilities,
      targetCapabilities: artifacts.targetApp.capabilities,
      backfillSkipped: false,
      requiredScopeBindings: computeRequiredScopeBindings(artifacts, { backfillSkipped: false }),
    };
  }

  /** Resolve the target collection read exactly as `RepoTargetCollectionReadResolver` does. */
  function resolveLookupRead(
    artifacts: RuleArtifacts,
  ): ReturnType<typeof resolveSourceReadBinding> {
    const lookupRule: SyncRule = {
      id: "lookup",
      approvedMappingId: "",
      resourcePairRef: "",
      status: "enabled",
    };
    return resolveSourceReadBinding({
      rule: lookupRule,
      sourceAppId: artifacts.targetApp.id,
      baseUrl: artifacts.targetBaseUrl,
      sourceCapabilities: { ...artifacts.targetApp.capabilities, supportsDeltaQuery: false },
      sourceGroup: artifacts.targetGroup,
      sourceBinding: artifacts.targetBinding,
    });
  }

  it("requires the target {board} scope for a FILTERED-READ lookup, though every write is id-only", () => {
    const required = computeRequiredScopeBindings(filteredReadArtifacts([]), {
      backfillSkipped: false,
    });
    // The scope comes solely from the filtered-read collection read; the id-only update
    // and the flat source contribute none.
    expect(required).toEqual([
      { kind: "constant", parameterName: "board", side: "target", resourceRef: "tgt" },
    ]);
  });

  it("no divergence: the lookup read resolves `{…}`-free exactly when the gate raises no scope blocker", () => {
    // Confirmed → the same `resolveSourceReadBinding` the lookup uses composes a `{…}`-free
    // path, and the gate enables.
    const confirmed = filteredReadArtifacts([confirmedConstant("board", "b1")]);
    const resolved = resolveLookupRead(confirmed);
    expect(resolved?.path).toBe("/boards/b1/cards");
    expect(findUnfilledPathParam(resolved?.path ?? "")).toBeUndefined();
    expect(evaluateEnablement(enablementInputFor(confirmed)).kind).toBe("enable");

    // Unconfirmed → the resolver refuses (undefined; the lookup would then throw), and the
    // gate requires exactly that parameter — the two sets coincide.
    const missing = filteredReadArtifacts([unconfirmedConstant("board")]);
    expect(resolveLookupRead(missing)).toBeUndefined();
    const decision = evaluateEnablement(enablementInputFor(missing));
    expect(decision.kind).toBe("blocked");
    if (decision.kind !== "blocked") throw new Error("expected blocked");
    expect(decision.stillNeeds).toEqual([
      { kind: "scope-binding", parameterName: "board", side: "target", resourceRef: "tgt" },
    ]);
  });
});

// ── SS-9 — record-derived scope-param classification (kind per parameter) ───────

describe("computeRequiredScopeBindings — record-derived (SS-9)", () => {
  function scopedArtifacts(o: {
    operationMappings: readonly OperationMapping[];
    sourceScope?: readonly ScopePathBinding[];
    sourceScopeRef?: SourceScopeRef;
    targetScope: readonly ScopePathBinding[];
  }): RuleArtifacts {
    return makeArtifacts({
      rule: makeRule({ pollOperationRef: "src/listRepoIssues" }),
      operationMappings: o.operationMappings,
      sourceGroup: giteaIssues,
      targetGroup: vikunjaTasks,
      sourceBinding: stripUndefined({
        ...sourceIssuesBinding(o.sourceScope ?? []),
        sourceScopeRef: o.sourceScopeRef,
      }),
      targetBinding: targetTasksBinding(o.targetScope),
    });
  }

  function enablementInputFor(artifacts: RuleArtifacts): EnablementInput {
    return {
      rule: artifacts.rule,
      fieldMappings: artifacts.fieldMappings,
      operationMappings: artifacts.operationMappings,
      sourceBinding: artifacts.sourceBinding,
      targetBinding: artifacts.targetBinding,
      sourceCapabilities: artifacts.sourceApp.capabilities,
      targetCapabilities: artifacts.targetApp.capabilities,
      backfillSkipped: false,
      requiredScopeBindings: computeRequiredScopeBindings(artifacts, { backfillSkipped: false }),
    };
  }

  it("a mixed rule: constant source owner/repo + a record-derived target {id} emits BOTH kinds (SS-9)", () => {
    // The Gitea→Vikunja create's project `{id}` is bound record-derived, selecting the
    // source `sourceScopeRef` component `name`. The source owner/repo stay constant.
    const required = computeRequiredScopeBindings(
      scopedArtifacts({
        operationMappings: [createTaskMapping, updateTaskMapping],
        targetScope: [confirmedRecordDerived("id", "name")],
      }),
      { backfillSkipped: false },
    );
    expect(required).toContainEqual({
      kind: "record-derived",
      parameterName: "id",
      side: "target",
      resourceRef: "tgt",
      sourceResourceRef: "src",
      sourceScopeKey: "name",
    });
    expect(required).toContainEqual({
      kind: "constant",
      parameterName: "owner",
      side: "source",
      resourceRef: "src",
    });
    expect(required).toContainEqual({
      kind: "constant",
      parameterName: "repo",
      side: "source",
      resourceRef: "src",
    });
    expect(required).toHaveLength(3);
  });

  it("the record-derived requirement carries the entry's sourceScopeKey verbatim (even unconfirmed)", () => {
    const required = computeRequiredScopeBindings(
      scopedArtifacts({
        operationMappings: [createTaskMapping, updateTaskMapping],
        // An UNCONFIRMED record-derived entry still classifies as record-derived (the gate
        // then blocks on its unconfirmed state); the selector is carried through.
        targetScope: [unconfirmedRecordDerived("id", "owner")],
      }),
      { backfillSkipped: false },
    );
    expect(required).toContainEqual({
      kind: "record-derived",
      parameterName: "id",
      side: "target",
      resourceRef: "tgt",
      sourceResourceRef: "src",
      sourceScopeKey: "owner",
    });
  });

  it("SS-5.3 still holds: an id-only update op surfaces no target requirement, even with a record-derived entry present", () => {
    // Update-only rule calls only `POST /tasks/{id}` (id-only). The `{id}` there is the
    // record id, not a scope, so the record-derived `id` entry is never surfaced.
    const required = computeRequiredScopeBindings(
      scopedArtifacts({
        operationMappings: [updateTaskMapping],
        targetScope: [confirmedRecordDerived("id", "name")],
      }),
      { backfillSkipped: false },
    );
    expect(required.filter((r) => r.side === "target")).toEqual([]);
  });

  it("gate flow: record-derived requirement + confirmed source component + confirmed target binding → enable (SS-9.1)", () => {
    const artifacts = scopedArtifacts({
      operationMappings: [createTaskMapping, updateTaskMapping],
      sourceScope: [confirmedConstant("owner", "alice"), confirmedConstant("repo", "phoenix")],
      sourceScopeRef: confirmedSourceScopeRef([{ key: "name", fieldPath: "repository.name" }]),
      targetScope: [confirmedRecordDerived("id", "name")],
    });
    expect(evaluateEnablement(enablementInputFor(artifacts)).kind).toBe("enable");
  });

  it("gate flow: source sourceScopeRef missing the selected component → blocked with source-scope-ref (SS-9.1a)", () => {
    const artifacts = scopedArtifacts({
      operationMappings: [createTaskMapping, updateTaskMapping],
      sourceScope: [confirmedConstant("owner", "alice"), confirmedConstant("repo", "phoenix")],
      // Confirmed, but carries `owner` — not the `name` the record-derived `{id}` selects.
      sourceScopeRef: confirmedSourceScopeRef([{ key: "owner", fieldPath: "repository.owner" }]),
      targetScope: [confirmedRecordDerived("id", "name")],
    });
    const decision = evaluateEnablement(enablementInputFor(artifacts));
    expect(decision.kind).toBe("blocked");
    if (decision.kind !== "blocked") throw new Error("expected blocked");
    expect(decision.stillNeeds).toContainEqual({
      kind: "source-scope-ref",
      side: "source",
      resourceRef: "src",
      sourceScopeKey: "name",
    });
  });
});
