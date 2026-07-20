import type {
  ApiSpec,
  ApprovedMapping,
  FieldMapping,
  Ir,
  IrResourceGroup,
  OperationMapping,
  ResourceBinding,
  ScopeCorrespondence,
} from "@mediator/domain";
import { scopeIdentityKeySchema } from "@mediator/domain";
import { describe, expect, it } from "vitest";

import { canonicalResourcePairRef } from "./artifact-instantiation/derive.js";
import { derivePollScopeMode } from "./sync/poll-scope-mode.js";
import {
  ScopeLinkAuthoringResolver,
  deriveScopeCorrespondenceProposal,
  deriveScopeKeyRefCandidates,
  isProposableScopeIdentityPairing,
  namesMatch,
  proposeScopeCorrespondences,
  type ScopeCorrespondenceProposalOps,
  type ScopeCorrespondenceProposer,
} from "./scope-authoring.js";

/**
 * **SS-18 — the L3 authoring / derivation entry point.** These cases pin the behaviour
 * every later slice depends on: that a scoped pair gets an **unconfirmed** proposal with
 * the right container refs and a value-preserving candidate key, that a **non-scoped**
 * pair gets nothing at all, that an absent `sourceContainerRef` is what makes the rule
 * derive `per-scope-pinned`, and that re-derivation never duplicates or clobbers.
 *
 * The landscape modelled throughout is scenario-1's: **Gitea `issues` -> Vikunja `tasks`**,
 * where the target write is `PUT /projects/{id}/tasks` (the container `{id}` is a *scope*
 * parameter, not the record id — SS-4) and the source captures its container as
 * `repository.owner` + `repository.name`.
 */

const GITEA = "app-gitea";
const VIKUNJA = "app-vikunja";
const GITEA_SPEC = "spec-gitea";
const VIKUNJA_SPEC = "spec-vikunja";
const PAIR_REF = canonicalResourcePairRef(
  { appId: GITEA, resourceRef: "issues" },
  { appId: VIKUNJA, resourceRef: "tasks" },
);

// ── IR fixtures ───────────────────────────────────────────────────────────────

function group(overrides: Partial<IrResourceGroup> & { resourceRef: string }): IrResourceGroup {
  return {
    name: overrides.resourceRef,
    operations: [],
    schemas: [],
    crossResourceRefs: [],
    ...overrides,
  };
}

/** Vikunja `tasks`: the create is `PUT /projects/{id}/tasks` — `{id}` is the CONTAINER. */
const vikunjaTasks = group({
  resourceRef: "tasks",
  operations: [
    {
      operationId: "tasks_create",
      method: "put",
      path: "/projects/{id}/tasks",
      parameters: [{ name: "id", location: "path", required: true, type: "integer" }],
    },
  ],
});

/** Vikunja `projects`: the container resource, listable and with a `title` identity. */
const vikunjaProjects = group({
  resourceRef: "projects",
  operations: [
    {
      operationId: "projects_list",
      method: "get",
      path: "/projects",
      parameters: [],
      responseSchema: {
        name: "Project",
        fields: [
          { name: "id", type: "integer", required: true },
          { name: "title", type: "string", required: true },
          { name: "description", type: "string", required: false },
        ],
      },
    },
  ],
});

/** Gitea `issues`: the scoped source record resource. */
const giteaIssues = group({ resourceRef: "issues" });

/** Gitea `repos`: the source container resource, WITH a list operation (enumerable). */
const giteaRepos = group({
  resourceRef: "repos",
  operations: [
    {
      operationId: "repos_list",
      method: "get",
      path: "/repos",
      parameters: [],
      responseSchema: {
        name: "Repository",
        fields: [
          { name: "id", type: "integer", required: true },
          { name: "owner", type: "string", required: true },
          { name: "name", type: "string", required: true },
        ],
      },
    },
  ],
});

const GITEA_IR: Ir = [giteaIssues, giteaRepos];
const VIKUNJA_IR: Ir = [vikunjaTasks, vikunjaProjects];

// ── ResourceBinding fixtures ──────────────────────────────────────────────────

function binding(overrides: Partial<ResourceBinding> & { resourceRef: string }): ResourceBinding {
  return {
    id: `rb-${overrides.resourceRef}`,
    apiSpecId: "spec",
    ...overrides,
  };
}

const unconfirmedRef = (path: string): ResourceBinding["nativeIdRef"] => ({
  value: { kind: "field", path },
  confirmedBy: null,
  confirmedAt: null,
});

const unconfirmedOperationRef = (operationId: string): ResourceBinding["collectionReadRef"] => ({
  value: { kind: "operation", operationId },
  confirmedBy: null,
  confirmedAt: null,
});

/** Gitea `issues` captures its container from the record (SS-7), derived-unconfirmed. */
const giteaIssuesBinding = binding({
  resourceRef: "issues",
  sourceScopeRef: {
    components: [
      { key: "owner", fieldPath: "repository.owner" },
      { key: "name", fieldPath: "repository.name" },
    ],
    confirmedBy: null,
    confirmedAt: null,
  },
});

/** Gitea `repos` with a derived (unconfirmed) collection read -> the source IS enumerable. */
const giteaReposBinding = binding({
  resourceRef: "repos",
  nativeIdRef: unconfirmedRef("id"),
  collectionReadRef: unconfirmedOperationRef("repos_list"),
});

/** Vikunja `tasks` with the SS-2-derived, still-unconfirmed `constant` scope entry for `{id}`. */
const vikunjaTasksBinding = binding({
  resourceRef: "tasks",
  scopePathBindings: [
    { kind: "constant", parameterName: "id", value: "", confirmedBy: null, confirmedAt: null },
  ],
});

const vikunjaProjectsBinding = binding({
  resourceRef: "projects",
  nativeIdRef: unconfirmedRef("id"),
  collectionReadRef: unconfirmedOperationRef("projects_list"),
});

/** The approved create: `issues_create -> tasks_create`, no `targetIdParamRef` (a create). */
const createOperationMapping: OperationMapping = {
  id: "om-1",
  mappingId: "m-1",
  sourceOperationRef: "issues/issues_create",
  targetOperationRef: "tasks/tasks_create",
  action: "create",
};

function proposalInput(
  overrides: {
    readonly sourceIr?: Ir;
    readonly sourceBindings?: readonly ResourceBinding[];
    readonly targetIr?: Ir;
    readonly targetBindings?: readonly ResourceBinding[];
    readonly operationMappings?: readonly OperationMapping[];
  } = {},
): Parameters<typeof deriveScopeCorrespondenceProposal>[0] {
  return {
    resourcePairRef: PAIR_REF,
    source: {
      appId: GITEA,
      ir: overrides.sourceIr ?? GITEA_IR,
      resourceRef: "issues",
      bindings: overrides.sourceBindings ?? [giteaIssuesBinding, giteaReposBinding],
    },
    target: {
      appId: VIKUNJA,
      ir: overrides.targetIr ?? VIKUNJA_IR,
      resourceRef: "tasks",
      bindings: overrides.targetBindings ?? [vikunjaTasksBinding, vikunjaProjectsBinding],
    },
    operationMappings: overrides.operationMappings ?? [createOperationMapping],
    newId: () => "corr-1",
  };
}

// ── SS-18.1 / 18.2 / 18.3 — the derivation ────────────────────────────────────

describe("deriveScopeCorrespondenceProposal — a scoped pair (SS-18.1)", () => {
  it("proposes an UNCONFIRMED correspondence with the derived container refs + candidate key", () => {
    const result = deriveScopeCorrespondenceProposal(proposalInput());

    expect(result.kind).toBe("proposed");
    if (result.kind !== "proposed") return;
    const { correspondence } = result;

    // SS-18.1 — one per pair, created unconfirmed. NOTHING is auto-confirmed.
    expect(correspondence.resourcePairRef).toBe(PAIR_REF);
    expect(correspondence.confirmedBy).toBeNull();
    expect(correspondence.confirmedAt).toBeNull();

    // SS-18.2 — the target container is the resource whose native id addresses `{id}`
    // in `PUT /projects/{id}/tasks`; the source container is Gitea `repos`.
    expect(correspondence.targetContainerRef).toStrictEqual({
      appId: VIKUNJA,
      resourceRef: "projects",
    });
    expect(correspondence.sourceContainerRef).toStrictEqual({
      appId: GITEA,
      resourceRef: "repos",
    });

    // SS-18.3 — source `name` pairs to target `title` by name similarity, value-preservingly
    // (a `rename` is the one value-preserving transform kind). The source's other component,
    // `owner`, has no counterpart on a Vikunja project, so it is simply not paired rather
    // than forced onto an unrelated field — the operator adds it in the SS-15.4 panel if the
    // heuristic was wrong.
    expect(correspondence.scopeIdentityKey).toStrictEqual([
      { sourceScopeKey: "name", targetFieldPath: "title", transform: { kind: "rename" } },
    ]);
  });

  it("derives a candidate key that is value-preserving and a valid ScopeIdentityKey (SS-18.3)", () => {
    const result = deriveScopeCorrespondenceProposal(proposalInput());
    expect(result.kind).toBe("proposed");
    if (result.kind !== "proposed") return;

    // The domain schema itself rejects a value-altering pairing, so parsing is the proof
    // that no proposal can ever carry one.
    expect(() =>
      scopeIdentityKeySchema.parse(result.correspondence.scopeIdentityKey),
    ).not.toThrow();
    for (const pairing of result.correspondence.scopeIdentityKey) {
      expect(isProposableScopeIdentityPairing(pairing)).toBe(true);
    }
  });

  it("pairs source `name` to target `title` rather than to an unrelated field (SS-18.3)", () => {
    // `description` is present on the target container and must never win over `title`.
    const result = deriveScopeCorrespondenceProposal(proposalInput());
    expect(result.kind).toBe("proposed");
    if (result.kind !== "proposed") return;
    const paths = result.correspondence.scopeIdentityKey.map((pairing) => pairing.targetFieldPath);
    expect(paths).not.toContain("description");
  });
});

describe("deriveScopeCorrespondenceProposal — a NON-scoped pair gets nothing (SS-18 out of scope)", () => {
  it("skips a target write operation with no container path parameter", () => {
    // `POST /tasks` — the only path param would be the record id, and there is none.
    const flatTasks = group({
      resourceRef: "tasks",
      operations: [{ operationId: "tasks_create", method: "post", path: "/tasks", parameters: [] }],
    });
    const result = deriveScopeCorrespondenceProposal(
      proposalInput({
        targetIr: [flatTasks, vikunjaProjects],
        targetBindings: [binding({ resourceRef: "tasks" }), vikunjaProjectsBinding],
      }),
    );
    expect(result).toStrictEqual({ kind: "skipped", reason: "not-scoped" });
  });

  it("skips a parameter that is the record id, not a container (SS-4)", () => {
    // `PATCH /tasks/{id}` with `targetIdParamRef` naming `{id}` — the record id, so the
    // op contributes no scope parameter at all.
    const byIdTasks = group({
      resourceRef: "tasks",
      operations: [
        {
          operationId: "tasks_update",
          method: "patch",
          path: "/tasks/{id}",
          parameters: [{ name: "id", location: "path", required: true, type: "integer" }],
        },
      ],
    });
    const result = deriveScopeCorrespondenceProposal(
      proposalInput({
        targetIr: [byIdTasks, vikunjaProjects],
        targetBindings: [binding({ resourceRef: "tasks" }), vikunjaProjectsBinding],
        operationMappings: [
          {
            id: "om-2",
            mappingId: "m-1",
            sourceOperationRef: "issues/issues_update",
            targetOperationRef: "tasks/tasks_update",
            action: "update",
            targetIdParamRef: "tasks/tasks_update#id",
          },
        ],
      }),
    );
    expect(result).toStrictEqual({ kind: "skipped", reason: "not-scoped" });
  });

  it("skips a container satisfied by a CONFIRMED constant — the L1 single-container case", () => {
    const l1Binding = binding({
      resourceRef: "tasks",
      scopePathBindings: [
        {
          kind: "constant",
          parameterName: "id",
          value: "42",
          confirmedBy: "operator",
          confirmedAt: new Date("2026-07-20T00:00:00.000Z"),
        },
      ],
    });
    const result = deriveScopeCorrespondenceProposal(
      proposalInput({ targetBindings: [l1Binding, vikunjaProjectsBinding] }),
    );
    expect(result).toStrictEqual({ kind: "skipped", reason: "not-scoped" });
  });

  it("skips a container satisfied by a CONFIRMED record-derived — the L2 shared value-space case", () => {
    const l2Binding = binding({
      resourceRef: "tasks",
      scopePathBindings: [
        {
          kind: "record-derived",
          parameterName: "id",
          sourceScopeKey: "project",
          confirmedBy: "operator",
          confirmedAt: new Date("2026-07-20T00:00:00.000Z"),
        },
      ],
    });
    const result = deriveScopeCorrespondenceProposal(
      proposalInput({ targetBindings: [l2Binding, vikunjaProjectsBinding] }),
    );
    expect(result).toStrictEqual({ kind: "skipped", reason: "not-scoped" });
  });

  it("still proposes when the entry is UNCONFIRMED — a derived default satisfies nothing", () => {
    // The default fixture's `{id}` entry is the SS-2-derived unconfirmed `constant`.
    expect(deriveScopeCorrespondenceProposal(proposalInput()).kind).toBe("proposed");
  });

  it("skips when the source resource captures no container identity (no sourceScopeRef)", () => {
    const result = deriveScopeCorrespondenceProposal(
      proposalInput({ sourceBindings: [binding({ resourceRef: "issues" }), giteaReposBinding] }),
    );
    expect(result).toStrictEqual({ kind: "skipped", reason: "no-source-scope-capture" });
  });

  it("skips when the container path parameter names no IR resource with a native id", () => {
    const result = deriveScopeCorrespondenceProposal(
      proposalInput({
        // `projects` exists but has no binding, so nothing gives it a native id.
        targetBindings: [vikunjaTasksBinding],
      }),
    );
    expect(result).toStrictEqual({ kind: "skipped", reason: "target-container-unresolved" });
  });
});

// ── SS-18.2 / SS-13.5 — enumerable vs non-enumerable source ───────────────────

/**
 * A source binding carrying a CONFIRMED `scope-link` entry — what makes a source read
 * per-container, and therefore what turns `sourceContainerRef`'s presence/absence into
 * `per-scope-enumerated` vs `per-scope-pinned` (SS-13.5).
 */
const perContainerSourceBinding: ResourceBinding = {
  ...giteaIssuesBinding,
  scopePathBindings: [
    {
      kind: "scope-link",
      parameterName: "owner",
      scopeKeyRef: "owner",
      confirmedBy: "operator",
      confirmedAt: new Date("2026-07-20T00:00:00.000Z"),
    },
  ],
};

describe("sourceContainerRef presence drives the derived poll-scope mode (SS-18.2 / SS-13.5)", () => {
  it("an ENUMERABLE source container yields sourceContainerRef -> per-scope-enumerated", () => {
    const result = deriveScopeCorrespondenceProposal(proposalInput());
    expect(result.kind).toBe("proposed");
    if (result.kind !== "proposed") return;

    expect(result.correspondence.sourceContainerRef).toBeDefined();
    expect(derivePollScopeMode(perContainerSourceBinding, result.correspondence)).toBe(
      "per-scope-enumerated",
    );
  });

  it("a NON-enumerable source container omits sourceContainerRef -> per-scope-pinned (SS-13.4)", () => {
    // scenario-1's trimmed Gitea spec: `repos` exists as a resource but offers no list
    // operation, so its binding carries no `collectionReadRef`.
    const notEnumerable = binding({ resourceRef: "repos", nativeIdRef: unconfirmedRef("id") });
    const result = deriveScopeCorrespondenceProposal(
      proposalInput({ sourceBindings: [giteaIssuesBinding, notEnumerable] }),
    );
    expect(result.kind).toBe("proposed");
    if (result.kind !== "proposed") return;

    expect(result.correspondence.sourceContainerRef).toBeUndefined();
    expect(derivePollScopeMode(perContainerSourceBinding, result.correspondence)).toBe(
      "per-scope-pinned",
    );
  });

  it("omits sourceContainerRef when the source spec has no container resource at all", () => {
    const result = deriveScopeCorrespondenceProposal(
      proposalInput({ sourceIr: [giteaIssues], sourceBindings: [giteaIssuesBinding] }),
    );
    expect(result.kind).toBe("proposed");
    if (result.kind !== "proposed") return;
    expect(result.correspondence.sourceContainerRef).toBeUndefined();
  });
});

// ── SS-18.3 — value-preserving only ──────────────────────────────────────────

describe("isProposableScopeIdentityPairing — value-preserving only (SS-18.3)", () => {
  it("accepts a pairing with no transform and one with a rename transform", () => {
    expect(
      isProposableScopeIdentityPairing({ sourceScopeKey: "name", targetFieldPath: "name" }),
    ).toBe(true);
    expect(
      isProposableScopeIdentityPairing({
        sourceScopeKey: "name",
        targetFieldPath: "title",
        transform: { kind: "rename" },
      }),
    ).toBe(true);
  });

  it.each(["coerce", "aggregate", "expression"] as const)(
    "rejects a value-altering `%s` pairing — a scope value must round-trip",
    (kind) => {
      expect(
        isProposableScopeIdentityPairing({
          sourceScopeKey: "name",
          targetFieldPath: "title",
          transform: { kind },
        }),
      ).toBe(false);
    },
  );
});

// ── SS-18.4 — the derived `scopeKeyRef` ──────────────────────────────────────

describe("deriveScopeKeyRefCandidates (SS-18.4)", () => {
  const correspondence: ScopeCorrespondence = {
    id: "corr-1",
    resourcePairRef: PAIR_REF,
    scopeIdentityKey: [{ sourceScopeKey: "name", targetFieldPath: "title" }],
    targetContainerRef: { appId: VIKUNJA, resourceRef: "projects" },
    sourceContainerRef: { appId: GITEA, resourceRef: "repos" },
    confirmedBy: null,
    confirmedAt: null,
  };

  /** Gitea `issues` as a per-container SOURCE read: two scope params, two scope components. */
  const giteaTwoParamBinding: ResourceBinding = {
    ...giteaIssuesBinding,
    sourceScopeRef: {
      components: [
        { key: "owner", fieldPath: "repository.owner" },
        { key: "repo", fieldPath: "repository.name" },
      ],
      confirmedBy: null,
      confirmedAt: null,
    },
    scopePathBindings: [
      { kind: "constant", parameterName: "owner", value: "", confirmedBy: null, confirmedAt: null },
      { kind: "constant", parameterName: "repo", value: "", confirmedBy: null, confirmedAt: null },
    ],
  };

  it("derives the TARGET side's key from the container's nativeIdRef leaf", () => {
    // SS-11 discovery builds the target scope key as `{ [nativeIdRef leaf]: nativeId }`,
    // so this is the component a `scope-link` binding must name.
    expect(
      deriveScopeKeyRefCandidates({
        correspondence,
        appId: VIKUNJA,
        binding: vikunjaTasksBinding,
        targetContainerBinding: vikunjaProjectsBinding,
      }),
    ).toStrictEqual({ id: "id" });
  });

  it("pairs each SOURCE scope parameter to the component that NAMES it — never one key into both rows", () => {
    // The hazard this guards: a multi-part Gitea container whose `{owner}`/`{repo}` params
    // both pre-fill `owner` composes `alice/alice` — a VALID repository path, so the write
    // lands in a real-but-wrong container instead of failing loudly.
    const candidates = deriveScopeKeyRefCandidates({
      correspondence,
      appId: GITEA,
      binding: giteaTwoParamBinding,
      targetContainerBinding: vikunjaProjectsBinding,
    });

    expect(candidates).toStrictEqual({ owner: "owner", repo: "repo" });
    expect(candidates["owner"]).not.toBe(candidates["repo"]);
  });

  it("withholds a SOURCE parameter's candidate when no component names it (multi-part container)", () => {
    const unmatched: ResourceBinding = {
      ...giteaTwoParamBinding,
      scopePathBindings: [
        {
          kind: "constant",
          parameterName: "workspace",
          value: "",
          confirmedBy: null,
          confirmedAt: null,
        },
      ],
    };
    // Two components, neither named `workspace` -> no guess at all for that parameter.
    expect(
      deriveScopeKeyRefCandidates({
        correspondence,
        appId: GITEA,
        binding: unmatched,
        targetContainerBinding: vikunjaProjectsBinding,
      }),
    ).toStrictEqual({});
  });

  it.each([
    ["organization-first", ["organization", "org"]],
    ["org-first", ["org", "organization"]],
  ])(
    "withholds when SEVERAL components name one parameter (%s) — never array order",
    (_label, keys) => {
      // `namesMatch` treats org/organization (and repo/repository) as one noun, and SS-7
      // lets an operator key components freely — so both can legitimately match `{org}`.
      // Picking the first would make the derived key depend on component ordering.
      const ambiguous: ResourceBinding = {
        ...giteaIssuesBinding,
        sourceScopeRef: {
          components: keys.map((key) => ({ key, fieldPath: `owner.${key}` })),
          confirmedBy: null,
          confirmedAt: null,
        },
        scopePathBindings: [
          {
            kind: "constant",
            parameterName: "org",
            value: "",
            confirmedBy: null,
            confirmedAt: null,
          },
        ],
      };
      expect(
        deriveScopeKeyRefCandidates({
          correspondence,
          appId: GITEA,
          binding: ambiguous,
          targetContainerBinding: vikunjaProjectsBinding,
        }),
      ).toStrictEqual({});
    },
  );

  it("never spreads a SINGLE component across two scope parameters — the unnamed one is withheld", () => {
    // A source capturing only `repo` but polling `GET /repos/{owner}/{repo}/issues`: the
    // captured scope cannot fill both slots, and pre-filling `{owner}` from the `repo`
    // component composes a real-but-wrong container (`alice/alice` is a valid repo path).
    // `{repo}` is still offered — it is paired by NAME (the strongest signal), not by the
    // one-component fallback, which is off entirely here. A partly pre-filled resource is
    // safe: each row confirms independently and an empty `scopeKeyRef` cannot be submitted
    // (`canSupplyScopeKeyRef` disables the action; the server 400s it), so the blank
    // `{owner}` row blocks any container from being composed until the operator fills it.
    const oneComponentTwoParams: ResourceBinding = {
      ...giteaIssuesBinding,
      sourceScopeRef: {
        components: [{ key: "repo", fieldPath: "repository.name" }],
        confirmedBy: null,
        confirmedAt: null,
      },
      scopePathBindings: [
        {
          kind: "constant",
          parameterName: "owner",
          value: "",
          confirmedBy: null,
          confirmedAt: null,
        },
        {
          kind: "constant",
          parameterName: "repo",
          value: "",
          confirmedBy: null,
          confirmedAt: null,
        },
      ],
    };

    const candidates = deriveScopeKeyRefCandidates({
      correspondence,
      appId: GITEA,
      binding: oneComponentTwoParams,
      targetContainerBinding: vikunjaProjectsBinding,
    });

    // The hazard: `{owner}` must NOT be pre-filled from the `repo` component.
    expect(candidates["owner"]).toBeUndefined();
    expect(candidates).toStrictEqual({ repo: "repo" });
  });

  it("withholds every parameter when a single component names NONE of two scope parameters", () => {
    // Same shape, but the component names neither parameter, so the one-component fallback
    // (off with >1 parameter) is the only thing that could have filled them — nothing does.
    const noNameMatch: ResourceBinding = {
      ...giteaIssuesBinding,
      sourceScopeRef: {
        components: [{ key: "project", fieldPath: "project_id" }],
        confirmedBy: null,
        confirmedAt: null,
      },
      scopePathBindings: [
        {
          kind: "constant",
          parameterName: "owner",
          value: "",
          confirmedBy: null,
          confirmedAt: null,
        },
        {
          kind: "constant",
          parameterName: "repo",
          value: "",
          confirmedBy: null,
          confirmedAt: null,
        },
      ],
    };
    expect(
      deriveScopeKeyRefCandidates({
        correspondence,
        appId: GITEA,
        binding: noNameMatch,
        targetContainerBinding: vikunjaProjectsBinding,
      }),
    ).toStrictEqual({});
  });

  it("pairs a SINGLE-component source container whatever the parameter is called — unambiguous", () => {
    const single: ResourceBinding = {
      ...giteaIssuesBinding,
      sourceScopeRef: {
        components: [{ key: "project", fieldPath: "project_id" }],
        confirmedBy: null,
        confirmedAt: null,
      },
      scopePathBindings: [
        {
          kind: "constant",
          parameterName: "workspace",
          value: "",
          confirmedBy: null,
          confirmedAt: null,
        },
      ],
    };
    expect(
      deriveScopeKeyRefCandidates({
        correspondence,
        appId: GITEA,
        binding: single,
        targetContainerBinding: vikunjaProjectsBinding,
      }),
    ).toStrictEqual({ workspace: "project" });
  });

  it("offers nothing when the container binding has no nativeIdRef — never a guess", () => {
    expect(
      deriveScopeKeyRefCandidates({
        correspondence,
        appId: VIKUNJA,
        binding: vikunjaTasksBinding,
        targetContainerBinding: binding({ resourceRef: "projects" }),
      }),
    ).toStrictEqual({});
  });

  it("offers nothing for an app on neither side of the correspondence", () => {
    expect(
      deriveScopeKeyRefCandidates({
        correspondence,
        appId: "app-unrelated",
        binding: vikunjaTasksBinding,
        targetContainerBinding: vikunjaProjectsBinding,
      }),
    ).toStrictEqual({});
  });
});

// ── SS-18.6 — the orchestration is idempotent and never clobbers ─────────────

/**
 * Mirrors `ScopeCorrespondenceRepository.propose` exactly (the "fakes must mirror real
 * repos" discipline): keyed on `resourcePairRef` so there is never a duplicate; an
 * UNCONFIRMED row is refreshed by a newer candidate **from the same authoring direction**;
 * a CONFIRMED row, and one authored by the COUNTERPART direction, are returned untouched.
 * It never writes `confirmedBy`/`confirmedAt`, exactly as the real
 * `ON CONFLICT DO UPDATE ... WHERE confirmed_by IS NULL AND <same direction>` cannot.
 */
class FakeScopeCorrespondenceProposer implements ScopeCorrespondenceProposer {
  public readonly rows = new Map<string, ScopeCorrespondence>();
  public calls = 0;

  public seed(correspondence: ScopeCorrespondence): void {
    this.rows.set(correspondence.resourcePairRef, correspondence);
  }

  public propose(candidate: ScopeCorrespondence): Promise<ScopeCorrespondence> {
    this.calls += 1;
    const existing = this.rows.get(candidate.resourcePairRef);
    if (existing === undefined) {
      this.rows.set(candidate.resourcePairRef, candidate);
      return Promise.resolve(candidate);
    }
    if (existing.confirmedBy !== null) {
      return Promise.resolve(existing); // confirmed -> untouched
    }
    if (existing.targetContainerRef.appId !== candidate.targetContainerRef.appId) {
      // The counterpart direction writes into the OTHER app's container: refreshing here
      // would mirror the pair's container refs (and flip its derived poll-scope mode).
      // The real repo's `target_container_ref->>'appId'` setWhere skips the update arm.
      return Promise.resolve(existing);
    }
    // The real repo writes `source_container_ref` unconditionally (the `set` clause names
    // it), so an absent candidate CLEARS a previously-stored ref — it does not preserve it.
    // Mirroring that is load-bearing: a source that stops being enumerable on re-ingest
    // must actually drop the ref, or the rule keeps deriving `per-scope-enumerated`.
    const refreshed: ScopeCorrespondence = {
      ...existing,
      scopeIdentityKey: candidate.scopeIdentityKey,
      targetContainerRef: candidate.targetContainerRef,
      ...(candidate.sourceContainerRef !== undefined
        ? { sourceContainerRef: candidate.sourceContainerRef }
        : {}),
    };
    if (candidate.sourceContainerRef === undefined) {
      delete refreshed.sourceContainerRef;
    }
    this.rows.set(candidate.resourcePairRef, refreshed);
    return Promise.resolve(refreshed);
  }
}

function specOf(id: string, appId: string, parsedIR: Ir): ApiSpec {
  return {
    id,
    appId,
    role: "PROVIDER",
    rawDocument: {},
    parsedIR,
    analysisExclusions: [],
    version: 1,
    contentHash: `sha256:${id}`,
    status: "active",
    createdAt: new Date("2026-07-20T00:00:00.000Z"),
  };
}

function buildOps(
  proposer: FakeScopeCorrespondenceProposer,
  sourceBindings: readonly ResourceBinding[] = [giteaIssuesBinding, giteaReposBinding],
): ScopeCorrespondenceProposalOps {
  const specs = new Map<string, ApiSpec>([
    [GITEA_SPEC, specOf(GITEA_SPEC, GITEA, GITEA_IR)],
    [VIKUNJA_SPEC, specOf(VIKUNJA_SPEC, VIKUNJA, VIKUNJA_IR)],
  ]);
  const bindings = new Map<string, ResourceBinding[]>([
    [GITEA_SPEC, [...sourceBindings]],
    [VIKUNJA_SPEC, [vikunjaTasksBinding, vikunjaProjectsBinding]],
  ]);
  return {
    specs: { getById: (id) => Promise.resolve(specs.get(id)) },
    bindings: { listByApiSpecId: (id) => Promise.resolve(bindings.get(id) ?? []) },
    correspondences: proposer,
  };
}

const peerMapping: ApprovedMapping = {
  id: "m-1",
  sourceSpecId: GITEA_SPEC,
  targetSpecId: VIKUNJA_SPEC,
  sourceAppId: GITEA,
  targetAppId: VIKUNJA,
  variant: "peer-peer",
  approvedBy: "operator",
  approvedAt: new Date("2026-07-20T00:00:00.000Z"),
  status: "active",
};

const titleField: FieldMapping = {
  id: "fm-1",
  mappingId: "m-1",
  sourcePath: "issues/title",
  targetPath: "tasks/title",
  transform: "rename",
};

describe("proposeScopeCorrespondences (SS-18.1 / SS-18.6)", () => {
  it("proposes one unconfirmed correspondence for the mapping's scoped pair", async () => {
    const proposer = new FakeScopeCorrespondenceProposer();
    const outcome = await proposeScopeCorrespondences({
      mapping: peerMapping,
      fields: [titleField],
      operations: [createOperationMapping],
      ops: buildOps(proposer),
      newId: () => "corr-1",
    });

    expect(outcome.proposed).toHaveLength(1);
    expect(outcome.proposed[0]?.resourcePairRef).toBe(PAIR_REF);
    expect(outcome.proposed[0]?.confirmedBy).toBeNull();
    expect(outcome.skipped).toStrictEqual([]);
    expect(proposer.rows.size).toBe(1);
  });

  it("is idempotent: re-running never duplicates the pair's correspondence (SS-18.6)", async () => {
    const proposer = new FakeScopeCorrespondenceProposer();
    const run = (): Promise<unknown> =>
      proposeScopeCorrespondences({
        mapping: peerMapping,
        fields: [titleField],
        operations: [createOperationMapping],
        ops: buildOps(proposer),
        newId: () => "corr-1",
      });

    await run();
    await run();
    await run();

    expect(proposer.rows.size).toBe(1);
    expect(proposer.calls).toBe(3); // it really did re-run; the write is what dedups.
  });

  it("never clobbers a CONFIRMED scopeIdentityKey on re-derivation (SS-18.6)", async () => {
    const proposer = new FakeScopeCorrespondenceProposer();
    const confirmedAt = new Date("2026-07-19T00:00:00.000Z");
    proposer.seed({
      id: "corr-existing",
      resourcePairRef: PAIR_REF,
      // An operator corrected the candidate to something the heuristic would not derive.
      scopeIdentityKey: [{ sourceScopeKey: "owner", targetFieldPath: "description" }],
      targetContainerRef: { appId: VIKUNJA, resourceRef: "projects" },
      confirmedBy: "operator",
      confirmedAt,
    });

    await proposeScopeCorrespondences({
      mapping: peerMapping,
      fields: [titleField],
      operations: [createOperationMapping],
      ops: buildOps(proposer),
      newId: () => "corr-1",
    });

    const stored = proposer.rows.get(PAIR_REF);
    expect(stored?.id).toBe("corr-existing");
    expect(stored?.confirmedBy).toBe("operator");
    expect(stored?.confirmedAt).toStrictEqual(confirmedAt);
    expect(stored?.scopeIdentityKey).toStrictEqual([
      { sourceScopeKey: "owner", targetFieldPath: "description" },
    ]);
  });

  it("refreshes an UNCONFIRMED candidate with the newer derivation (SS-18.6)", async () => {
    const proposer = new FakeScopeCorrespondenceProposer();
    proposer.seed({
      id: "corr-existing",
      resourcePairRef: PAIR_REF,
      scopeIdentityKey: [{ sourceScopeKey: "stale", targetFieldPath: "stale" }],
      targetContainerRef: { appId: VIKUNJA, resourceRef: "stale" },
      confirmedBy: null,
      confirmedAt: null,
    });

    await proposeScopeCorrespondences({
      mapping: peerMapping,
      fields: [titleField],
      operations: [createOperationMapping],
      ops: buildOps(proposer),
      newId: () => "corr-1",
    });

    const stored = proposer.rows.get(PAIR_REF);
    expect(stored?.targetContainerRef).toStrictEqual({
      appId: VIKUNJA,
      resourceRef: "projects",
    });
    expect(stored?.confirmedBy).toBeNull();
  });

  it("a source that STOPS being enumerable on re-ingest clears sourceContainerRef -> per-scope-pinned (SS-13.5)", async () => {
    const proposer = new FakeScopeCorrespondenceProposer();
    const run = (sourceBindings: readonly ResourceBinding[]): Promise<unknown> =>
      proposeScopeCorrespondences({
        mapping: peerMapping,
        fields: [titleField],
        operations: [createOperationMapping],
        ops: buildOps(proposer, sourceBindings),
        newId: () => "corr-1",
      });

    // Re-ingest 1: `repos` offers a collection read -> enumerable.
    await run([giteaIssuesBinding, giteaReposBinding]);
    expect(proposer.rows.get(PAIR_REF)?.sourceContainerRef).toBeDefined();

    // Re-ingest 2: the trimmed spec drops the repo-list -> NOT enumerable. The refresh must
    // CLEAR the stored ref, not preserve it — otherwise the rule keeps deriving
    // `per-scope-enumerated` and the Poller tries to enumerate a list that is gone.
    await run([
      giteaIssuesBinding,
      binding({ resourceRef: "repos", nativeIdRef: unconfirmedRef("id") }),
    ]);
    const pinned = proposer.rows.get(PAIR_REF);
    expect(pinned?.sourceContainerRef).toBeUndefined();
    expect(derivePollScopeMode(perContainerSourceBinding, pinned)).toBe("per-scope-pinned");
  });

  it("a source that BECOMES enumerable on re-ingest sets sourceContainerRef -> per-scope-enumerated (SS-13.5)", async () => {
    const proposer = new FakeScopeCorrespondenceProposer();
    const run = (sourceBindings: readonly ResourceBinding[]): Promise<unknown> =>
      proposeScopeCorrespondences({
        mapping: peerMapping,
        fields: [titleField],
        operations: [createOperationMapping],
        ops: buildOps(proposer, sourceBindings),
        newId: () => "corr-1",
      });

    await run([
      giteaIssuesBinding,
      binding({ resourceRef: "repos", nativeIdRef: unconfirmedRef("id") }),
    ]);
    expect(proposer.rows.get(PAIR_REF)?.sourceContainerRef).toBeUndefined();

    // The full spec is ingested: a repo-list appears -> the unconfirmed candidate upgrades.
    await run([giteaIssuesBinding, giteaReposBinding]);
    const enumerated = proposer.rows.get(PAIR_REF);
    expect(enumerated?.sourceContainerRef).toStrictEqual({ appId: GITEA, resourceRef: "repos" });
    expect(derivePollScopeMode(perContainerSourceBinding, enumerated)).toBe("per-scope-enumerated");
  });

  it("proposes nothing for a consumer-provider mapping (the Phase-5 adapter path)", async () => {
    const proposer = new FakeScopeCorrespondenceProposer();
    const outcome = await proposeScopeCorrespondences({
      mapping: { ...peerMapping, variant: "consumer-provider" },
      fields: [titleField],
      operations: [createOperationMapping],
      ops: buildOps(proposer),
      newId: () => "corr-1",
    });
    expect(outcome).toStrictEqual({ proposed: [], skipped: [] });
    expect(proposer.rows.size).toBe(0);
  });

  it("proposes nothing for a mapping whose pairs are all non-scoped (no regression to L1/L2)", async () => {
    const proposer = new FakeScopeCorrespondenceProposer();
    const outcome = await proposeScopeCorrespondences({
      mapping: peerMapping,
      // A field-only mapping covering `issues -> tasks` with NO approved write operation:
      // nothing establishes a container path parameter, so nothing is proposed.
      fields: [titleField],
      operations: [],
      ops: buildOps(proposer),
      newId: () => "corr-1",
    });
    expect(outcome.proposed).toStrictEqual([]);
    expect(proposer.rows.size).toBe(0);
    // The skip is REPORTED, not silently discarded — `not-scoped` is the benign reason.
    expect(outcome.skipped).toStrictEqual([{ resourcePairRef: PAIR_REF, reason: "not-scoped" }]);
  });
});

// ── SS-18.4 — the kind-selector context ──────────────────────────────────────

describe("ScopeLinkAuthoringResolver (SS-18.4)", () => {
  const correspondence: ScopeCorrespondence = {
    id: "corr-1",
    resourcePairRef: PAIR_REF,
    scopeIdentityKey: [{ sourceScopeKey: "name", targetFieldPath: "title" }],
    targetContainerRef: { appId: VIKUNJA, resourceRef: "projects" },
    confirmedBy: null,
    confirmedAt: null,
  };

  function buildResolver(
    correspondences: readonly ScopeCorrespondence[],
  ): ScopeLinkAuthoringResolver {
    return new ScopeLinkAuthoringResolver({
      correspondences: {
        listByResourceSide: (appId, resourceRef) =>
          Promise.resolve(
            correspondences.filter((entry) =>
              entry.resourcePairRef.split("|").some((side) => side === `${appId}:${resourceRef}`),
            ),
          ),
      },
      repos: {
        apiSpecs: {
          listByAppId: (appId) =>
            Promise.resolve(appId === VIKUNJA ? [specOf(VIKUNJA_SPEC, VIKUNJA, VIKUNJA_IR)] : []),
        },
        resourceBindings: {
          listByApiSpecId: () => Promise.resolve([vikunjaTasksBinding, vikunjaProjectsBinding]),
        },
      },
    });
  }

  it("makes scope-link available with the derived scopeKeyRef once a correspondence exists", async () => {
    const context = await buildResolver([correspondence]).resolve(vikunjaTasksBinding, VIKUNJA);
    expect(context).toStrictEqual({
      scopeLinkAvailable: true,
      scopeKeyRefCandidates: { id: "id" },
    });
  });

  it("keeps scope-link UNAVAILABLE for a pair with no proposed correspondence", async () => {
    const context = await buildResolver([]).resolve(vikunjaTasksBinding, VIKUNJA);
    expect(context).toStrictEqual({
      scopeLinkAvailable: false,
      scopeKeyRefCandidates: {},
    });
  });

  it("keeps scope-link unavailable for a resource with no scope path parameter at all", async () => {
    const context = await buildResolver([correspondence]).resolve(vikunjaProjectsBinding, VIKUNJA);
    expect(context).toStrictEqual({
      scopeLinkAvailable: false,
      scopeKeyRefCandidates: {},
    });
  });

  it("withholds the candidate when several scoped pairs claim the resource — never a wrong container key", async () => {
    const second: ScopeCorrespondence = {
      ...correspondence,
      id: "corr-2",
      resourcePairRef: canonicalResourcePairRef(
        { appId: "app-other", resourceRef: "issues" },
        { appId: VIKUNJA, resourceRef: "tasks" },
      ),
    };
    const context = await buildResolver([correspondence, second]).resolve(
      vikunjaTasksBinding,
      VIKUNJA,
    );
    expect(context).toStrictEqual({ scopeLinkAvailable: true, scopeKeyRefCandidates: {} });
  });
});

// ── namesMatch — the shared "same resource" matcher (regression: S2) ──────────

describe("namesMatch — singular/plural variation", () => {
  /**
   * Regression guard. An earlier `singularize` committed to stripping `-es` before `-s`,
   * so every noun ending in `e` pluralized with a bare `-s` failed to match its singular
   * (`issues -> issu`). Because `deriveTargetContainer` and `deriveSourceContainerRef` both
   * resolve their container through this matcher, that turned into "no proposal at all" for
   * the most common resource names in the Gitea/Vikunja landscape — i.e. exactly the L3
   * unreachability SS-18 exists to remove.
   */
  it.each([
    ["issues", "issue"],
    ["spaces", "space"],
    ["pages", "page"],
    ["milestones", "milestone"],
    ["files", "file"],
    ["releases", "release"],
    ["repositories", "repository"],
  ])("matches %s <-> %s", (plural, singular) => {
    expect(namesMatch(plural, singular)).toBe(true);
    expect(namesMatch(singular, plural)).toBe(true);
  });

  it.each([
    ["projects", "project"],
    ["tasks", "task"],
    ["boxes", "box"],
    ["labels", "label"],
  ])("still matches the regular %s <-> %s", (plural, singular) => {
    expect(namesMatch(plural, singular)).toBe(true);
  });

  it("matches a known container-noun abbreviation across the plural boundary", () => {
    // Gitea: the record field is `repository`, the resource that lists them is `repos`.
    expect(namesMatch("repos", "repository")).toBe(true);
    expect(namesMatch("repositories", "repo")).toBe(true);
    expect(namesMatch("orgs", "organization")).toBe(true);
  });

  it("does not match unrelated nouns", () => {
    expect(namesMatch("issues", "projects")).toBe(false);
    expect(namesMatch("name", "namespace")).toBe(false);
    expect(namesMatch("tasks", "teams")).toBe(false);
  });

  it("treats a boundary-delimited id suffix as noise, but not a bare trailing 'id'", () => {
    // `project_id` / `projectId` name the `projects` container …
    expect(namesMatch("project_id", "projects")).toBe(true);
    expect(namesMatch("projectId", "project")).toBe(true);
    // … while ordinary words merely ENDING in "id" keep their last two letters.
    expect(namesMatch("grid", "gr")).toBe(false);
    expect(namesMatch("uuid", "uu")).toBe(false);
    expect(namesMatch("valid", "val")).toBe(false);
    // A field literally named `id` still means `id`.
    expect(namesMatch("id", "id")).toBe(true);
  });
});

// ── SS-18.6 — a BIDIRECTIONAL pair: the counterpart approval must not invert it ──

/**
 * **The regression these tests exist for.** `resource_pair_ref` is direction-agnostic, so
 * both directions of a bidirectional pair (the canonical scenario-1 setup) land on the
 * same `ScopeCorrespondence` row — but a derivation is inherently *directional*: it reads
 * the **target** side's write ops for the container parameter and the **source** side's
 * `sourceScopeRef` for the identity key. Approving the counterpart direction therefore
 * re-derives the pair MIRRORED, and the unconditional
 * `onConflictDoUpdate ... setWhere isNull(confirmedBy)` refresh let it silently swap the
 * container refs of an existing (unconfirmed) correspondence — flipping the mode
 * `derivePollScopeMode` reads off them and re-pointing the pair at the wrong containers.
 */

/** Gitea `issues` as a WRITE target: `POST /repos/{owner}/{repo}/issues` (both are containers). */
const giteaIssuesWritable = group({
  resourceRef: "issues",
  operations: [
    {
      operationId: "issues_create",
      method: "post",
      path: "/repos/{owner}/{repo}/issues",
      parameters: [
        { name: "owner", location: "path", required: true, type: "string" },
        { name: "repo", location: "path", required: true, type: "string" },
      ],
    },
  ],
});

/** Vikunja `tasks` as the counterpart SOURCE: it captures its project container per record. */
const vikunjaTasksSourceBinding = binding({
  resourceRef: "tasks",
  scopePathBindings: [
    { kind: "constant", parameterName: "id", value: "", confirmedBy: null, confirmedAt: null },
  ],
  sourceScopeRef: {
    components: [{ key: "title", fieldPath: "project.title" }],
    confirmedBy: null,
    confirmedAt: null,
  },
});

/** The counterpart direction's approved create: `tasks_create -> issues_create`. */
const counterpartOperationMapping: OperationMapping = {
  id: "om-2",
  mappingId: "m-2",
  sourceOperationRef: "tasks/tasks_create",
  targetOperationRef: "issues/issues_create",
  action: "create",
};

const counterpartField: FieldMapping = {
  id: "fm-2",
  mappingId: "m-2",
  sourcePath: "tasks/title",
  targetPath: "issues/title",
  transform: "rename",
};

/** The counterpart `ApprovedMapping` — Vikunja `tasks` -> Gitea `issues`, the same pair. */
const counterpartMapping: ApprovedMapping = {
  id: "m-2",
  sourceSpecId: VIKUNJA_SPEC,
  targetSpecId: GITEA_SPEC,
  sourceAppId: VIKUNJA,
  targetAppId: GITEA,
  variant: "peer-peer",
  approvedBy: "operator",
  approvedAt: new Date("2026-07-20T00:00:00.000Z"),
  status: "active",
};

/** Ops over BOTH directions' specs: Gitea `issues` is writable here, so it can be a target. */
function bidirectionalOps(
  proposer: FakeScopeCorrespondenceProposer,
): ScopeCorrespondenceProposalOps {
  const specs = new Map<string, ApiSpec>([
    [GITEA_SPEC, specOf(GITEA_SPEC, GITEA, [giteaIssuesWritable, giteaRepos])],
    [VIKUNJA_SPEC, specOf(VIKUNJA_SPEC, VIKUNJA, VIKUNJA_IR)],
  ]);
  const bindings = new Map<string, ResourceBinding[]>([
    [GITEA_SPEC, [giteaIssuesBinding, giteaReposBinding]],
    [VIKUNJA_SPEC, [vikunjaTasksSourceBinding, vikunjaProjectsBinding]],
  ]);
  return {
    specs: { getById: (id) => Promise.resolve(specs.get(id)) },
    bindings: { listByApiSpecId: (id) => Promise.resolve(bindings.get(id) ?? []) },
    correspondences: proposer,
  };
}

describe("proposeScopeCorrespondences — a bidirectional pair stays stable (SS-18.6)", () => {
  const approveDirectionA = (proposer: FakeScopeCorrespondenceProposer): Promise<unknown> =>
    proposeScopeCorrespondences({
      mapping: peerMapping,
      fields: [titleField],
      operations: [createOperationMapping],
      ops: bidirectionalOps(proposer),
      newId: () => "corr-a",
    });

  const approveDirectionB = (proposer: FakeScopeCorrespondenceProposer): Promise<unknown> =>
    proposeScopeCorrespondences({
      mapping: counterpartMapping,
      fields: [counterpartField],
      operations: [counterpartOperationMapping],
      ops: bidirectionalOps(proposer),
      newId: () => "corr-b",
    });

  it("approving direction B after A leaves A's container refs and derived mode untouched", async () => {
    const proposer = new FakeScopeCorrespondenceProposer();

    await approveDirectionA(proposer);
    const afterA = proposer.rows.get(PAIR_REF);
    expect(afterA?.targetContainerRef).toStrictEqual({ appId: VIKUNJA, resourceRef: "projects" });
    expect(afterA?.sourceContainerRef).toStrictEqual({ appId: GITEA, resourceRef: "repos" });
    const modeAfterA = derivePollScopeMode(perContainerSourceBinding, afterA);

    // The counterpart direction is approved — it derives the pair mirrored (Gitea `repos`
    // as the write container). It must not re-point the existing correspondence.
    await approveDirectionB(proposer);
    const afterB = proposer.rows.get(PAIR_REF);

    expect(afterB).toStrictEqual(afterA);
    expect(afterB?.targetContainerRef).toStrictEqual({ appId: VIKUNJA, resourceRef: "projects" });
    expect(afterB?.sourceContainerRef).toStrictEqual({ appId: GITEA, resourceRef: "repos" });
    expect(derivePollScopeMode(perContainerSourceBinding, afterB)).toBe(modeAfterA);
    // Still exactly one correspondence for the pair, still unconfirmed.
    expect(proposer.rows.size).toBe(1);
    expect(afterB?.confirmedBy).toBeNull();
  });

  it("is order-independent: whichever direction is approved FIRST authors the pair", async () => {
    const proposer = new FakeScopeCorrespondenceProposer();

    await approveDirectionB(proposer);
    const afterB = proposer.rows.get(PAIR_REF);
    // Direction B writes into Gitea's `repos` container.
    expect(afterB?.targetContainerRef).toStrictEqual({ appId: GITEA, resourceRef: "repos" });

    await approveDirectionA(proposer);
    expect(proposer.rows.get(PAIR_REF)).toStrictEqual(afterB);
    expect(proposer.rows.size).toBe(1);
  });

  it("re-approving the SAME direction still re-derives it (SS-18.6 idempotent refresh)", async () => {
    const proposer = new FakeScopeCorrespondenceProposer();

    await approveDirectionA(proposer);
    await approveDirectionB(proposer);
    // A re-ingest/re-approval of the AUTHORING direction is still allowed through.
    await approveDirectionA(proposer);

    const stored = proposer.rows.get(PAIR_REF);
    expect(stored?.targetContainerRef).toStrictEqual({ appId: VIKUNJA, resourceRef: "projects" });
    expect(proposer.calls).toBe(3); // every run really did reach the write.
  });
});
