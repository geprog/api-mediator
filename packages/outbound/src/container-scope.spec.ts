import type {
  IrResourceGroup,
  OperationMapping,
  ResourceBinding,
  ScopeLink,
  ScopePathBinding,
} from "@mediator/domain";
import { describe, expect, it } from "vitest";

import {
  resolveSingleRecordRead,
  resolveWriteOperationBinding,
  type SingleRecordReadBinding,
} from "./binding-resolvers.js";
import {
  containerScopeParamNames,
  fillContainerScopeParams,
  resolveScopeLinkScopeValues,
  resolveScopeRefFillValues,
  targetScopeKeyOf,
  type ScopeLinkReader,
} from "./container-scope.js";
import { ContainerUnresolvedError } from "./errors.js";

/**
 * Unit tests for the **SS-12 write-side container resolution** (`kind: "scope-link"`,
 * Layer 3). The oracle is `docs/requirements/scoped-resource-sync.md` SS-12: a scope
 * parameter is filled **verbatim** from the record's resolved `ScopeLink` (create → its
 * captured scope→link; a linked delete/update → the stored `RecordLink.scopeRef`, which
 * resolves even an **archived** link), the record-id and the scope are **never crossed**,
 * and an absent / unresolvable / unsafe container **parks** — never a guessed container.
 */

const CONFIRMED_AT = new Date("2026-07-13T00:00:00.000Z");
const APP_GITEA = "app-gitea";
const APP_VIKUNJA = "app-vikunja";

/** The scenario-1 `ScopeLink`: Gitea repo `alice/phoenix` ↔ Vikunja project id `42`. */
function phoenixLink(overrides: Partial<ScopeLink> = {}): ScopeLink {
  return {
    id: "link-phoenix-42",
    scopeCorrespondenceId: "corr-1",
    appAId: APP_GITEA,
    appAScopeKey: { owner: "alice", name: "phoenix" },
    appBId: APP_VIKUNJA,
    appBScopeKey: { id: "42" },
    resourcePairRef: "pair::issues|tasks",
    establishedBy: "identity-match",
    status: "active",
    createdAt: CONFIRMED_AT,
    ...overrides,
  };
}

function scopeLinkBinding(
  parameterName: string,
  scopeKeyRef: string,
  confirmed = true,
): ScopePathBinding {
  return {
    kind: "scope-link",
    parameterName,
    scopeKeyRef,
    confirmedBy: confirmed ? "operator" : null,
    confirmedAt: confirmed ? CONFIRMED_AT : null,
  };
}

/** A `ScopeLinkReader` fake mirroring `ScopeLinkRepository.getById` (resolves any status). */
class FakeScopeLinkReader implements ScopeLinkReader {
  readonly #byId = new Map<string, ScopeLink>();
  public constructor(links: readonly ScopeLink[]) {
    for (const link of links) {
      this.#byId.set(link.id, link);
    }
  }
  public getById(id: string): Promise<ScopeLink | undefined> {
    return Promise.resolve(this.#byId.get(id));
  }
}

describe("targetScopeKeyOf (SS-12.5 — the scope from the ScopeLink's target side)", () => {
  it("picks the target app's side, direction-agnostic (B side)", () => {
    expect(targetScopeKeyOf(phoenixLink(), APP_VIKUNJA)).toEqual({ id: "42" });
  });

  it("picks the target app's side when it is the A side", () => {
    expect(targetScopeKeyOf(phoenixLink(), APP_GITEA)).toEqual({ owner: "alice", name: "phoenix" });
  });

  it("returns undefined when the link does not address the target app (never guessed)", () => {
    expect(targetScopeKeyOf(phoenixLink(), "app-unrelated")).toBeUndefined();
  });
});

describe("resolveScopeLinkScopeValues (SS-12.1 — verbatim fill from the target scope key)", () => {
  it("fills the parameter verbatim from the target key selected by scopeKeyRef", () => {
    const values = resolveScopeLinkScopeValues([scopeLinkBinding("id", "id")], { id: "42" });
    expect(values.get("id")).toBe("42");
  });

  it("omits an entry whose scopeKeyRef component is absent from the target key (→ parks, not fabricated)", () => {
    const values = resolveScopeLinkScopeValues([scopeLinkBinding("id", "missing")], { id: "42" });
    expect(values.has("id")).toBe(false);
  });

  it("omits an UNSAFE target key value (empty / slash / dot-dot) — never a wrong-container path", () => {
    expect(resolveScopeLinkScopeValues([scopeLinkBinding("id", "id")], { id: "" }).has("id")).toBe(
      false,
    );
    expect(
      resolveScopeLinkScopeValues([scopeLinkBinding("id", "id")], { id: "a/b" }).has("id"),
    ).toBe(false);
    expect(
      resolveScopeLinkScopeValues([scopeLinkBinding("id", "id")], { id: ".." }).has("id"),
    ).toBe(false);
  });

  it("ignores unconfirmed scope-link entries and non-scope-link kinds (used nowhere until confirmed)", () => {
    const bindings: ScopePathBinding[] = [
      scopeLinkBinding("id", "id", false),
      {
        kind: "constant",
        parameterName: "other",
        value: "x",
        confirmedBy: "op",
        confirmedAt: CONFIRMED_AT,
      },
    ];
    expect(resolveScopeLinkScopeValues(bindings, { id: "42" }).size).toBe(0);
  });
});

describe("containerScopeParamNames", () => {
  it("returns record-derived + scope-link param names, excluding constants and duplicates", () => {
    const bindings: ScopePathBinding[] = [
      {
        kind: "constant",
        parameterName: "region",
        value: "eu",
        confirmedBy: "op",
        confirmedAt: CONFIRMED_AT,
      },
      scopeLinkBinding("id", "id"),
      {
        kind: "record-derived",
        parameterName: "owner",
        sourceScopeKey: "owner",
        confirmedBy: "op",
        confirmedAt: CONFIRMED_AT,
      },
    ];
    expect(containerScopeParamNames(bindings)).toEqual(["id", "owner"]);
  });
});

describe("resolveScopeRefFillValues (SS-12.3 — a LINKED delete/update routes from scopeRef)", () => {
  const bindings = [scopeLinkBinding("id", "id")];

  it("L3 scope-link scopeRef → getById → target key → fill map", async () => {
    const reader = new FakeScopeLinkReader([phoenixLink()]);
    const values = await resolveScopeRefFillValues({
      scopeRef: { kind: "scope-link", scopeLinkId: "link-phoenix-42" },
      targetAppId: APP_VIKUNJA,
      scopePathBindings: bindings,
      reader,
    });
    expect(values.get("id")).toBe("42");
  });

  it("resolves even an ARCHIVED ScopeLink — a final delete still routes (SS-10.5 / SS-12.3)", async () => {
    const reader = new FakeScopeLinkReader([phoenixLink({ status: "archived" })]);
    const values = await resolveScopeRefFillValues({
      scopeRef: { kind: "scope-link", scopeLinkId: "link-phoenix-42" },
      targetAppId: APP_VIKUNJA,
      scopePathBindings: bindings,
      reader,
    });
    expect(values.get("id")).toBe("42");
  });

  it("L2 resolved scopeRef → the frozen values directly (SS-12.7, no ScopeLink read)", async () => {
    const reader = new FakeScopeLinkReader([]);
    const values = await resolveScopeRefFillValues({
      scopeRef: { kind: "resolved", values: { owner: "alice", name: "phoenix" } },
      targetAppId: APP_GITEA,
      scopePathBindings: [],
      reader,
    });
    expect(Object.fromEntries(values)).toEqual({ owner: "alice", name: "phoenix" });
  });

  it("ABSENT scopeRef → parks (ContainerUnresolvedError), never a generic transient (SS-12.4)", async () => {
    const reader = new FakeScopeLinkReader([]);
    await expect(
      resolveScopeRefFillValues({
        scopeRef: undefined,
        targetAppId: APP_VIKUNJA,
        scopePathBindings: bindings,
        reader,
      }),
    ).rejects.toBeInstanceOf(ContainerUnresolvedError);
  });

  it("scope-link scopeRef pointing at a MISSING ScopeLink → parks (SS-12.4)", async () => {
    const reader = new FakeScopeLinkReader([]);
    await expect(
      resolveScopeRefFillValues({
        scopeRef: { kind: "scope-link", scopeLinkId: "gone" },
        targetAppId: APP_VIKUNJA,
        scopePathBindings: bindings,
        reader,
      }),
    ).rejects.toBeInstanceOf(ContainerUnresolvedError);
  });

  it("a ScopeLink that does not address the target app → parks (never guessed)", async () => {
    const reader = new FakeScopeLinkReader([phoenixLink()]);
    await expect(
      resolveScopeRefFillValues({
        scopeRef: { kind: "scope-link", scopeLinkId: "link-phoenix-42" },
        targetAppId: "app-unrelated",
        scopePathBindings: bindings,
        reader,
      }),
    ).rejects.toBeInstanceOf(ContainerUnresolvedError);
  });
});

describe("fillContainerScopeParams (SS-12.5 — id × scope never crossed)", () => {
  it("fills only the named container params, leaving the record-id {id} untouched", () => {
    // `{owner}` is a scope param; `{index}` is the record id — never filled here.
    const filled = fillContainerScopeParams(
      "/repos/{owner}/issues/{index}",
      ["owner"],
      new Map([["owner", "alice"]]),
    );
    expect(filled.path).toBe("/repos/alice/issues/{index}");
    expect(filled.unfilled).toEqual([]);
  });

  it("reports an unfilled container param (a missing/unsafe key) → the caller parks", () => {
    const filled = fillContainerScopeParams("/projects/{id}/tasks", ["id"], new Map());
    expect(filled.path).toBe("/projects/{id}/tasks");
    expect(filled.unfilled).toEqual(["id"]);
  });

  it("url-encodes the substituted container value", () => {
    const filled = fillContainerScopeParams(
      "/t/{tenant}/x",
      ["tenant"],
      new Map([["tenant", "a b"]]),
    );
    expect(filled.path).toBe("/t/a%20b/x");
  });
});

// ── SS-12.8 — the true multi-scope create composes PUT /projects/42/tasks ─────────

/** The Vikunja `tasks` create op `PUT /projects/{id}/tasks` — `{id}` is a SCOPE param (no record id). */
function vikunjaTasksGroup(): IrResourceGroup {
  return {
    resourceRef: "tasks",
    name: "tasks",
    operations: [
      {
        operationId: "put /projects/{id}/tasks",
        method: "put",
        path: "/projects/{id}/tasks",
        parameters: [{ name: "id", location: "path", required: true }],
        requestSchema: {
          name: "Task",
          fields: [{ name: "title", type: "string", required: false }],
        },
      },
      {
        operationId: "post /tasks/{id}",
        method: "post",
        path: "/tasks/{id}",
        parameters: [{ name: "id", location: "path", required: true }],
      },
      {
        operationId: "delete /tasks/{id}",
        method: "delete",
        path: "/projects/{id}/tasks/{taskId}",
        parameters: [
          { name: "id", location: "path", required: true },
          { name: "taskId", location: "path", required: true },
        ],
      },
    ],
    schemas: [],
    crossResourceRefs: [],
  };
}

function tasksBinding(scope: ScopePathBinding[]): ResourceBinding {
  return {
    id: "rb-tasks",
    apiSpecId: "spec-vikunja",
    resourceRef: "tasks",
    scopePathBindings: scope,
  };
}

function createMapping(): OperationMapping {
  return {
    id: "op-create",
    mappingId: "mapping-1",
    sourceOperationRef: "issues/get /issues",
    targetOperationRef: "tasks/put /projects/{id}/tasks",
    action: "create",
  };
}

describe("SS-12.8 — resolveWriteOperationBinding composes the true multi-scope create", () => {
  const scope = [scopeLinkBinding("id", "id")];

  it("create PUT /projects/{id}/tasks with the alice/phoenix↔42 link → /projects/42/tasks", () => {
    // The loader resolves the container (captured scope → active ScopeLink) into these values.
    const scopeLinkValues = resolveScopeLinkScopeValues(
      scope,
      targetScopeKeyOf(phoenixLink(), APP_VIKUNJA) ?? {},
    );
    const binding = resolveWriteOperationBinding(
      createMapping(),
      vikunjaTasksGroup(),
      tasksBinding(scope),
      undefined,
      { scopeLinkValues, deferMode: "scope-link" },
    );
    expect(binding?.method).toBe("PUT");
    expect(binding?.pathTemplate).toBe("/projects/42/tasks");
    expect(binding?.pathTemplate).not.toContain("{");
  });

  it("create with NO resolved ScopeLink defers {id} templated (→ handler parks, SS-12.6)", () => {
    const binding = resolveWriteOperationBinding(
      createMapping(),
      vikunjaTasksGroup(),
      tasksBinding(scope),
      undefined,
      { deferMode: "scope-link" },
    );
    // The op resolves (not undefined) with the container param left templated for the handler.
    expect(binding?.pathTemplate).toBe("/projects/{id}/tasks");
  });

  it("delete op with deferMode=container leaves the scope-link {id} templated (routes from scopeRef)", () => {
    const deleteMapping: OperationMapping = {
      id: "op-delete",
      mappingId: "mapping-1",
      sourceOperationRef: "issues/delete",
      targetOperationRef: "tasks/delete /tasks/{id}",
      action: "delete",
      targetIdParamRef: "tasks/delete /tasks/{id}#taskId",
    };
    const binding = resolveWriteOperationBinding(
      deleteMapping,
      vikunjaTasksGroup(),
      tasksBinding(scope),
      undefined,
      { deferMode: "container" },
    );
    // `{id}` (scope) deferred for the handler; `{taskId}` (record id) always templated.
    expect(binding?.pathTemplate).toBe("/projects/{id}/tasks/{taskId}");
  });
});

// ── SS-12.3 — a LINKED single-record read routes via scopeRef, not the captured scope ─────

/** Gitea `issues` by-id read `/repos/{owner}/{repo}/issues/{index}` — owner/repo scope, index id. */
function issuesReadGroup(): IrResourceGroup {
  return {
    resourceRef: "issues",
    name: "issues",
    operations: [
      {
        operationId: "getIssue",
        method: "get",
        path: "/repos/{owner}/{repo}/issues/{index}",
        parameters: [
          { name: "owner", location: "path", required: true },
          { name: "repo", location: "path", required: true },
          { name: "index", location: "path", required: true },
        ],
      },
    ],
    schemas: [],
    crossResourceRefs: [],
  };
}

function recordDerivedBinding(parameterName: string, sourceScopeKey: string): ScopePathBinding {
  return {
    kind: "record-derived",
    parameterName,
    sourceScopeKey,
    confirmedBy: "operator",
    confirmedAt: CONFIRMED_AT,
  };
}

function issuesReadBinding(scope: ScopePathBinding[]): ResourceBinding {
  return {
    id: "rb-issues",
    apiSpecId: "spec-gitea",
    resourceRef: "issues",
    scopePathBindings: scope,
  };
}

describe("SS-12.3 — resolveSingleRecordRead routes a linked read via the scopeRef container", () => {
  const READ: SingleRecordReadBinding = { readOperationId: "getIssue", idParamRef: "index" };
  const CONTAINER = new Map<string, string>([
    ["owner", "alice"],
    ["repo", "phoenix"],
  ]);

  it("(a) scope-link container: fills {owner}/{repo} from resolvedScopeValues, id {index} templated", () => {
    const resolved = resolveSingleRecordRead({
      binding: READ,
      targetGroup: issuesReadGroup(),
      baseUrl: "https://gitea.test",
      targetBinding: issuesReadBinding([
        scopeLinkBinding("owner", "owner"),
        scopeLinkBinding("repo", "repo"),
      ]),
      resolvedScopeValues: CONTAINER,
    });
    // Routed to the stored container; the record-id param stays templated for the reader (id × scope).
    expect(resolved?.pathTemplate).toBe("/repos/alice/phoenix/issues/{index}");
  });

  it("(b) record-derived container with NO captured scope (a delete): still routes via scopeRef", () => {
    const resolved = resolveSingleRecordRead({
      binding: READ,
      targetGroup: issuesReadGroup(),
      baseUrl: "https://gitea.test",
      targetBinding: issuesReadBinding([
        recordDerivedBinding("owner", "owner"),
        recordDerivedBinding("repo", "repo"),
      ]),
      // capturedScope OMITTED — the container comes from RecordLink.scopeRef, not the (gone) source record.
      resolvedScopeValues: CONTAINER,
    });
    expect(resolved?.pathTemplate).toBe("/repos/alice/phoenix/issues/{index}");
  });

  it("takes precedence over a captured scope (both agree for a value-preserving rule)", () => {
    const resolved = resolveSingleRecordRead({
      binding: READ,
      targetGroup: issuesReadGroup(),
      baseUrl: "https://gitea.test",
      targetBinding: issuesReadBinding([
        recordDerivedBinding("owner", "owner"),
        recordDerivedBinding("repo", "repo"),
      ]),
      capturedScope: { owner: "alice", repo: "phoenix" },
      resolvedScopeValues: CONTAINER,
    });
    expect(resolved?.pathTemplate).toBe("/repos/alice/phoenix/issues/{index}");
  });

  it("unresolvable (no captured scope, no resolvedScopeValues) → undefined (the handler parks upstream)", () => {
    const resolved = resolveSingleRecordRead({
      binding: READ,
      targetGroup: issuesReadGroup(),
      baseUrl: "https://gitea.test",
      targetBinding: issuesReadBinding([
        scopeLinkBinding("owner", "owner"),
        scopeLinkBinding("repo", "repo"),
      ]),
    });
    expect(resolved).toBeUndefined();
  });
});
