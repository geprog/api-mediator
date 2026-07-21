import type {
  ConfirmableRef,
  Ir,
  IrResourceGroup,
  ResourceBinding,
  ScopeComponent,
  ScopeCorrespondence,
  ScopePathBinding,
} from "@mediator/domain";
import { describe, expect, it } from "vitest";

import {
  pausesDependentRules,
  revalidateResourceBinding,
  revalidateScopeCorrespondence,
  type ScopeCorrespondenceSide,
  type ScopeRevalidationFinding,
} from "./scope-revalidation.js";

// ── IR fixtures ────────────────────────────────────────────────────────────────
//
// A minimal Gitea-shaped scoped record resource (`issues`, scoped by {owner}/{repo},
// addressed by container-relative `number`) plus its container resource (`repos`), and a
// Vikunja-shaped target (`tasks` scoped by {project}, container `projects`). Small,
// hand-built IR so each breaking change can be applied surgically.

const CONFIRMED = { confirmedBy: "op@example.com", confirmedAt: new Date("2026-07-20T00:00:00Z") };

function giteaIssuesGroup(overrides: Partial<IrResourceGroup> = {}): IrResourceGroup {
  return {
    resourceRef: "issues",
    name: "Issues",
    operations: [
      {
        operationId: "issueList",
        method: "get",
        path: "/repos/{owner}/{repo}/issues",
        parameters: [
          { name: "owner", location: "path", required: true },
          { name: "repo", location: "path", required: true },
          { name: "page", location: "query", required: false },
        ],
      },
      {
        operationId: "issueGet",
        method: "get",
        path: "/repos/{owner}/{repo}/issues/{index}",
        parameters: [
          { name: "owner", location: "path", required: true },
          { name: "repo", location: "path", required: true },
          { name: "index", location: "path", required: true },
        ],
      },
    ],
    schemas: [
      {
        name: "Issue",
        fields: [
          { name: "id", type: "integer", required: true },
          { name: "number", type: "integer", required: true },
          { name: "title", type: "string", required: true },
          { name: "repository", type: "RepositoryMeta", required: true },
        ],
      },
      {
        name: "RepositoryMeta",
        fields: [
          { name: "owner", type: "string", required: true },
          { name: "name", type: "string", required: true },
        ],
      },
    ],
    crossResourceRefs: [],
    ...overrides,
  };
}

function giteaReposGroup(): IrResourceGroup {
  return {
    resourceRef: "repos",
    name: "Repositories",
    operations: [
      {
        operationId: "repoList",
        method: "get",
        path: "/repos",
        parameters: [{ name: "page", location: "query", required: false }],
      },
    ],
    schemas: [
      {
        name: "Repository",
        fields: [
          { name: "id", type: "integer", required: true },
          { name: "owner", type: "string", required: true },
          { name: "name", type: "string", required: true },
        ],
      },
    ],
    crossResourceRefs: [],
  };
}

function vikunjaProjectsGroup(overrides: Partial<IrResourceGroup> = {}): IrResourceGroup {
  return {
    resourceRef: "projects",
    name: "Projects",
    operations: [
      {
        operationId: "projectList",
        method: "get",
        path: "/projects",
        parameters: [{ name: "page", location: "query", required: false }],
      },
    ],
    schemas: [
      {
        name: "Project",
        fields: [
          { name: "id", type: "integer", required: true },
          { name: "title", type: "string", required: true },
        ],
      },
    ],
    crossResourceRefs: [],
    ...overrides,
  };
}

function fieldRef(path: string, confirmed = true): ConfirmableRef {
  return { value: { kind: "field", path }, ...(confirmed ? CONFIRMED : unconfirmed()) };
}
function operationRef(operationId: string, confirmed = true): ConfirmableRef {
  return { value: { kind: "operation", operationId }, ...(confirmed ? CONFIRMED : unconfirmed()) };
}
function parameterRef(operationId: string, parameter: string, confirmed = true): ConfirmableRef {
  return {
    value: { kind: "parameter", operationId, parameter },
    ...(confirmed ? CONFIRMED : unconfirmed()),
  };
}
function unconfirmed(): { confirmedBy: null; confirmedAt: null } {
  return { confirmedBy: null, confirmedAt: null };
}

/** A fully-confirmed `issues` binding: native id `id`, address `number`, scoped {owner}/{repo}. */
function confirmedIssuesBinding(overrides: Partial<ResourceBinding> = {}): ResourceBinding {
  const scopePathBindings: ScopePathBinding[] = [
    { kind: "constant", parameterName: "owner", value: "alice", ...CONFIRMED },
    { kind: "constant", parameterName: "repo", value: "phoenix", ...CONFIRMED },
  ];
  const components: ScopeComponent[] = [
    { key: "owner", fieldPath: "repository.owner" },
    { key: "name", fieldPath: "repository.name" },
  ];
  return {
    id: "rb-issues",
    apiSpecId: "spec-gitea",
    resourceRef: "issues",
    nativeIdRef: fieldRef("id"),
    recordAddressRef: fieldRef("number"),
    collectionReadRef: operationRef("issueList"),
    paginationRef: parameterRef("issueList", "page"),
    sourceScopeRef: { components, ...CONFIRMED },
    scopePathBindings,
    ...overrides,
  };
}

function makeCorrespondence(overrides: Partial<ScopeCorrespondence> = {}): ScopeCorrespondence {
  return {
    id: "corr-1",
    resourcePairRef: "app-gitea:issues|app-vikunja:tasks",
    scopeIdentityKey: [{ sourceScopeKey: "owner", targetFieldPath: "title" }],
    targetContainerRef: { appId: "app-vikunja", resourceRef: "projects" },
    sourceContainerRef: { appId: "app-gitea", resourceRef: "repos" },
    ...CONFIRMED,
    ...overrides,
  };
}

// ── SS-16.1 — additive re-pin carries every artifact forward unchanged ─────────

describe("revalidateResourceBinding — SS-16.1 additive re-pin", () => {
  it("carries every confirmed artifact forward byte-identical when the IR is unchanged", () => {
    const ir: Ir = [giteaIssuesGroup()];
    const binding = confirmedIssuesBinding();

    const { binding: out, findings } = revalidateResourceBinding(binding, ir);

    expect(findings).toEqual([]);
    // Refs keep their confirmation (kind + value + confirmedBy/At).
    expect(out.nativeIdRef).toStrictEqual(binding.nativeIdRef);
    expect(out.recordAddressRef).toStrictEqual(binding.recordAddressRef);
    expect(out.collectionReadRef).toStrictEqual(binding.collectionReadRef);
    expect(out.paginationRef).toStrictEqual(binding.paginationRef);
    expect(out.sourceScopeRef).toStrictEqual(binding.sourceScopeRef);
    expect(out.scopePathBindings).toStrictEqual(binding.scopePathBindings);
  });

  it("carries an additively-extended IR forward unchanged (a new field is not a break)", () => {
    const group = giteaIssuesGroup();
    const issueSchema = group.schemas.find((s) => s.name === "Issue");
    issueSchema?.fields.push({ name: "assignee", type: "string", required: false });
    const binding = confirmedIssuesBinding();

    const { findings } = revalidateResourceBinding(binding, [group]);
    expect(findings).toEqual([]);
  });
});

// ── SS-16.2 — breaking change to a bound scope parameter ───────────────────────

describe("revalidateResourceBinding — SS-16.2 breaking scope-parameter change", () => {
  it("returns a removed bound scope parameter to unconfirmed and reports it (pauses rules)", () => {
    // The write ops drop `{repo}` (a rename or removal): only `{owner}` remains a scope param.
    const group = giteaIssuesGroup({
      operations: [
        {
          operationId: "issueList",
          method: "get",
          path: "/orgs/{owner}/issues",
          parameters: [
            { name: "owner", location: "path", required: true },
            { name: "page", location: "query", required: false },
          ],
        },
      ],
    });
    const binding = confirmedIssuesBinding();

    const { binding: out, findings } = revalidateResourceBinding(binding, [group]);

    const removed = findings.find((f) => f.kind === "scope-parameter-removed");
    expect(removed).toStrictEqual({
      kind: "scope-parameter-removed",
      resourceRef: "issues",
      parameterName: "repo",
      wasConfirmed: true,
    });
    // `owner` still confirmed; `repo` retained but returned to unconfirmed (not dropped).
    const owner = out.scopePathBindings?.find((e) => e.parameterName === "owner");
    const repo = out.scopePathBindings?.find((e) => e.parameterName === "repo");
    expect(owner?.confirmedBy).toBe("op@example.com");
    expect(repo).toBeDefined();
    expect(repo?.confirmedBy).toBeNull();
    expect(repo?.confirmedAt).toBeNull();
    expect(findings.every(pausesDependentRules)).toBe(true);
  });
});

// ── SS-16.3 — a new required path parameter appears ────────────────────────────

describe("revalidateResourceBinding — SS-16.3 new required scope parameter", () => {
  it("creates a new unconfirmed scope binding for a newly-introduced path parameter", () => {
    // The list op gains an `{org}` container segment before the record resource.
    const group = giteaIssuesGroup({
      operations: [
        {
          operationId: "issueList",
          method: "get",
          path: "/orgs/{org}/repos/{owner}/{repo}/issues",
          parameters: [
            { name: "org", location: "path", required: true },
            { name: "owner", location: "path", required: true },
            { name: "repo", location: "path", required: true },
            { name: "page", location: "query", required: false },
          ],
        },
      ],
    });
    const binding = confirmedIssuesBinding();

    const { binding: out, findings } = revalidateResourceBinding(binding, [group]);

    expect(findings).toContainEqual({
      kind: "scope-parameter-added",
      resourceRef: "issues",
      parameterName: "org",
    });
    const org = out.scopePathBindings?.find((e) => e.parameterName === "org");
    expect(org?.kind).toBe("constant");
    expect(org?.confirmedBy).toBeNull();
    // The pre-existing confirmed params are untouched (carried forward).
    expect(out.scopePathBindings?.find((e) => e.parameterName === "owner")?.confirmedBy).toBe(
      "op@example.com",
    );
  });
});

// ── SS-16.2 + SS-19 — recordAddressRef re-validation ───────────────────────────

describe("revalidateResourceBinding — recordAddressRef (SS-19) re-validation", () => {
  it("returns recordAddressRef to unconfirmed when its address field disappears (SS-16.2)", () => {
    // The `number` field is removed from the Issue representation (breaking).
    const group = giteaIssuesGroup();
    const issue = group.schemas.find((s) => s.name === "Issue");
    if (issue) issue.fields = issue.fields.filter((f) => f.name !== "number");
    const binding = confirmedIssuesBinding();

    const { binding: out, findings } = revalidateResourceBinding(binding, [group]);

    const finding = findings.find((f) => f.kind === "binding-ref-invalidated");
    expect(finding).toMatchObject({ ref: "recordAddressRef", wasConfirmed: true });
    // Retained-but-unconfirmed, NEVER dropped — dropping would silently reinstate
    // native-id addressing on a scoped resource (the SS-19 404/clobber failure).
    expect(out.recordAddressRef).toBeDefined();
    expect(out.recordAddressRef?.confirmedBy).toBeNull();
  });

  it("carries a still-valid recordAddressRef forward unchanged (additive re-pin)", () => {
    const { binding: out, findings } = revalidateResourceBinding(confirmedIssuesBinding(), [
      giteaIssuesGroup(),
    ]);
    expect(findings.some((f) => f.kind === "binding-ref-invalidated")).toBe(false);
    expect(out.recordAddressRef).toStrictEqual(fieldRef("number"));
  });
});

// ── SS-16.2 — collection-read / pagination / sourceScopeRef refs ───────────────

describe("revalidateResourceBinding — container-list + capture refs", () => {
  it("invalidates a collectionReadRef whose operation is gone, offering a fresh candidate", () => {
    const group = giteaIssuesGroup({
      operations: [
        {
          operationId: "issuesIndex", // renamed from `issueList`
          method: "get",
          path: "/repos/{owner}/{repo}/issues",
          parameters: [
            { name: "owner", location: "path", required: true },
            { name: "repo", location: "path", required: true },
          ],
        },
      ],
    });
    const { binding: out, findings } = revalidateResourceBinding(confirmedIssuesBinding(), [group]);

    const finding = findings.find(
      (f) => f.kind === "binding-ref-invalidated" && f.ref === "collectionReadRef",
    );
    expect(finding).toMatchObject({ replacedByCandidate: true, wasConfirmed: true });
    // The candidate points at the surviving list op, unconfirmed.
    expect(out.collectionReadRef?.value).toStrictEqual({
      kind: "operation",
      operationId: "issuesIndex",
    });
    expect(out.collectionReadRef?.confirmedBy).toBeNull();
    // pagination pointed at the vanished `issueList` op → invalidated, no candidate.
    expect(
      findings.some((f) => f.kind === "binding-ref-invalidated" && f.ref === "paginationRef"),
    ).toBe(true);
  });

  it("returns sourceScopeRef to unconfirmed when a captured component's field disappears", () => {
    const group = giteaIssuesGroup();
    const meta = group.schemas.find((s) => s.name === "RepositoryMeta");
    if (meta) meta.fields = meta.fields.filter((f) => f.name !== "name"); // drop repository.name
    const { binding: out, findings } = revalidateResourceBinding(confirmedIssuesBinding(), [group]);

    const finding = findings.find((f) => f.kind === "source-scope-ref-invalidated");
    expect(finding).toMatchObject({ brokenComponentKeys: ["name"], wasConfirmed: true });
    expect(out.sourceScopeRef?.confirmedBy).toBeNull();
    // Components retained so the operator sees which capture broke.
    expect(out.sourceScopeRef?.components).toHaveLength(2);
  });
});

// ── the whole-resource-gone case ───────────────────────────────────────────────

describe("revalidateResourceBinding — resource group removed", () => {
  it("returns the binding unchanged with no findings when its resource left the IR", () => {
    const { binding: out, findings } = revalidateResourceBinding(
      confirmedIssuesBinding(),
      [giteaReposGroup()], // no `issues` group
    );
    expect(findings).toEqual([]);
    expect(out).toStrictEqual(confirmedIssuesBinding());
  });
});

// ── SS-16.4/16.5 — ScopeCorrespondence re-validation ───────────────────────────

function giteaSide(group: IrResourceGroup, binding: ResourceBinding): ScopeCorrespondenceSide {
  return {
    appId: "app-gitea",
    ir: [group, giteaReposGroup()],
    bindings: [binding, reposBinding()],
    resourceRef: "issues",
  };
}
function vikunjaSide(projects = vikunjaProjectsGroup()): ScopeCorrespondenceSide {
  return {
    appId: "app-vikunja",
    ir: [projects],
    bindings: [projectsBinding()],
    resourceRef: "tasks",
  };
}
function reposBinding(): ResourceBinding {
  return {
    id: "rb-repos",
    apiSpecId: "spec-gitea",
    resourceRef: "repos",
    nativeIdRef: fieldRef("id"),
    collectionReadRef: operationRef("repoList"),
    scopePathBindings: [],
  };
}
function projectsBinding(): ResourceBinding {
  return {
    id: "rb-projects",
    apiSpecId: "spec-vikunja",
    resourceRef: "projects",
    nativeIdRef: fieldRef("id"),
    collectionReadRef: operationRef("projectList"),
    scopePathBindings: [],
  };
}

describe("revalidateScopeCorrespondence — SS-16.1 additive re-pin", () => {
  it("carries a confirmed correspondence forward unchanged when nothing it asserts changed", () => {
    const result = revalidateScopeCorrespondence({
      correspondence: makeCorrespondence(),
      source: giteaSide(giteaIssuesGroup(), confirmedIssuesBinding()),
      target: vikunjaSide(),
    });
    expect(result.findings).toEqual([]);
    expect(result.archiveScopeLinks).toBe("none");
    expect(result.correspondence.confirmedBy).toBe("op@example.com");
  });
});

describe("revalidateScopeCorrespondence — SS-16.5 container resource disappears", () => {
  it("returns the correspondence to unconfirmed and archives ALL links when the target container is gone", () => {
    const result = revalidateScopeCorrespondence({
      correspondence: makeCorrespondence(),
      source: giteaSide(giteaIssuesGroup(), confirmedIssuesBinding()),
      // Vikunja IR no longer exposes `projects`.
      target: {
        appId: "app-vikunja",
        ir: [],
        bindings: [projectsBinding()],
        resourceRef: "tasks",
      },
    });
    expect(result.findings).toContainEqual({
      kind: "container-resource-removed",
      side: "target",
      appId: "app-vikunja",
      resourceRef: "projects",
      wasConfirmed: true,
    });
    expect(result.correspondence.confirmedBy).toBeNull();
    expect(result.archiveScopeLinks).toBe("all");
  });

  it("drops the source container ref (→ per-scope-pinned) when the source container is gone", () => {
    const result = revalidateScopeCorrespondence({
      correspondence: makeCorrespondence(),
      // Gitea IR no longer exposes `repos` (only issues).
      source: {
        appId: "app-gitea",
        ir: [giteaIssuesGroup()],
        bindings: [confirmedIssuesBinding()],
        resourceRef: "issues",
      },
      target: vikunjaSide(),
    });
    expect(result.findings).toContainEqual({
      kind: "container-resource-removed",
      side: "source",
      appId: "app-gitea",
      resourceRef: "repos",
      wasConfirmed: true,
    });
    // Source side removed → enumerable becomes false → derives per-scope-pinned.
    expect(result.correspondence.sourceContainerRef).toBeUndefined();
    expect(result.correspondence.confirmedBy).toBeNull();
    expect(result.archiveScopeLinks).toBe("all");
  });
});

describe("revalidateScopeCorrespondence — SS-16.4 scope-identity-key break", () => {
  it("archives ONLY identity-match links when a target identity field disappears", () => {
    // Vikunja `projects` loses its `title` identity field (the pairing's target end).
    const projects = vikunjaProjectsGroup({
      schemas: [{ name: "Project", fields: [{ name: "id", type: "integer", required: true }] }],
    });
    const result = revalidateScopeCorrespondence({
      correspondence: makeCorrespondence(),
      source: giteaSide(giteaIssuesGroup(), confirmedIssuesBinding()),
      target: vikunjaSide(projects),
    });
    expect(result.findings).toContainEqual({
      kind: "scope-identity-key-invalidated",
      issue: "target-field-removed",
      sourceScopeKey: "owner",
      wasConfirmed: true,
    });
    expect(result.correspondence.confirmedBy).toBeNull();
    expect(result.archiveScopeLinks).toBe("identity-match");
  });

  it("reports a source-component break when the pairing's sourceScopeKey no longer exists", () => {
    // The source binding's sourceScopeRef no longer carries an `owner` component.
    const binding = confirmedIssuesBinding({
      sourceScopeRef: {
        components: [{ key: "name", fieldPath: "repository.name" }],
        ...CONFIRMED,
      },
    });
    const result = revalidateScopeCorrespondence({
      correspondence: makeCorrespondence(),
      source: giteaSide(giteaIssuesGroup(), binding),
      target: vikunjaSide(),
    });
    expect(result.findings).toContainEqual({
      kind: "scope-identity-key-invalidated",
      issue: "source-component-removed",
      sourceScopeKey: "owner",
      wasConfirmed: true,
    });
    expect(result.archiveScopeLinks).toBe("identity-match");
  });
});

describe("pausesDependentRules", () => {
  it("returns true for every finding kind (each names a now-unusable or unfilled artifact)", () => {
    const kinds: ScopeRevalidationFinding[] = [
      { kind: "scope-parameter-removed", resourceRef: "r", parameterName: "p", wasConfirmed: true },
      { kind: "scope-parameter-added", resourceRef: "r", parameterName: "p" },
      {
        kind: "binding-ref-invalidated",
        resourceRef: "r",
        ref: "nativeIdRef",
        wasConfirmed: true,
        replacedByCandidate: false,
      },
      {
        kind: "source-scope-ref-invalidated",
        resourceRef: "r",
        brokenComponentKeys: ["k"],
        wasConfirmed: true,
      },
      {
        kind: "container-resource-removed",
        side: "target",
        appId: "a",
        resourceRef: "r",
        wasConfirmed: true,
      },
      {
        kind: "scope-identity-key-invalidated",
        issue: "source-component-removed",
        sourceScopeKey: "k",
        wasConfirmed: true,
      },
    ];
    expect(kinds.every(pausesDependentRules)).toBe(true);
  });
});
