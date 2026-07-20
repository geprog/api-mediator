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
  deriveScopeKeyRefCandidate,
  isProposableScopeIdentityPairing,
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

describe("sourceContainerRef presence drives the derived poll-scope mode (SS-18.2 / SS-13.5)", () => {
  /** A source binding carrying a CONFIRMED `scope-link` entry — what makes a read per-container. */
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

describe("deriveScopeKeyRefCandidate (SS-18.4)", () => {
  const correspondence: ScopeCorrespondence = {
    id: "corr-1",
    resourcePairRef: PAIR_REF,
    scopeIdentityKey: [{ sourceScopeKey: "name", targetFieldPath: "title" }],
    targetContainerRef: { appId: VIKUNJA, resourceRef: "projects" },
    sourceContainerRef: { appId: GITEA, resourceRef: "repos" },
    confirmedBy: null,
    confirmedAt: null,
  };

  it("derives the TARGET side's key from the container's nativeIdRef leaf", () => {
    // SS-11 discovery builds the target scope key as `{ [nativeIdRef leaf]: nativeId }`,
    // so this is the component a `scope-link` binding must name.
    expect(
      deriveScopeKeyRefCandidate({
        correspondence,
        appId: VIKUNJA,
        binding: vikunjaTasksBinding,
        targetContainerBinding: vikunjaProjectsBinding,
      }),
    ).toBe("id");
  });

  it("derives the SOURCE side's key from the resource's own sourceScopeRef components", () => {
    // The source scope key is the record's captured scope, keyed by `sourceScopeRef` keys.
    expect(
      deriveScopeKeyRefCandidate({
        correspondence,
        appId: GITEA,
        binding: giteaIssuesBinding,
        targetContainerBinding: vikunjaProjectsBinding,
      }),
    ).toBe("owner");
  });

  it("offers nothing when the container binding has no nativeIdRef — never a guess", () => {
    expect(
      deriveScopeKeyRefCandidate({
        correspondence,
        appId: VIKUNJA,
        binding: vikunjaTasksBinding,
        targetContainerBinding: binding({ resourceRef: "projects" }),
      }),
    ).toBeUndefined();
  });

  it("offers nothing for an app on neither side of the correspondence", () => {
    expect(
      deriveScopeKeyRefCandidate({
        correspondence,
        appId: "app-unrelated",
        binding: vikunjaTasksBinding,
        targetContainerBinding: vikunjaProjectsBinding,
      }),
    ).toBeUndefined();
  });
});

// ── SS-18.6 — the orchestration is idempotent and never clobbers ─────────────

/**
 * Mirrors `ScopeCorrespondenceRepository.propose` exactly (the "fakes must mirror real
 * repos" discipline): keyed on `resourcePairRef` so there is never a duplicate; an
 * UNCONFIRMED row is refreshed by a newer candidate; a CONFIRMED row is returned
 * untouched. It never writes `confirmedBy`/`confirmedAt`, exactly as the real
 * `ON CONFLICT DO UPDATE ... WHERE confirmed_by IS NULL` cannot.
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
    const refreshed: ScopeCorrespondence = {
      ...existing,
      scopeIdentityKey: candidate.scopeIdentityKey,
      targetContainerRef: candidate.targetContainerRef,
      ...(candidate.sourceContainerRef !== undefined
        ? { sourceContainerRef: candidate.sourceContainerRef }
        : {}),
    };
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

function buildOps(proposer: FakeScopeCorrespondenceProposer): ScopeCorrespondenceProposalOps {
  const specs = new Map<string, ApiSpec>([
    [GITEA_SPEC, specOf(GITEA_SPEC, GITEA, GITEA_IR)],
    [VIKUNJA_SPEC, specOf(VIKUNJA_SPEC, VIKUNJA, VIKUNJA_IR)],
  ]);
  const bindings = new Map<string, ResourceBinding[]>([
    [GITEA_SPEC, [giteaIssuesBinding, giteaReposBinding]],
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
    const stored = await proposeScopeCorrespondences({
      mapping: peerMapping,
      fields: [titleField],
      operations: [createOperationMapping],
      ops: buildOps(proposer),
      newId: () => "corr-1",
    });

    expect(stored).toHaveLength(1);
    expect(stored[0]?.resourcePairRef).toBe(PAIR_REF);
    expect(stored[0]?.confirmedBy).toBeNull();
    expect(proposer.rows.size).toBe(1);
  });

  it("is idempotent: re-running never duplicates the pair's correspondence (SS-18.6)", async () => {
    const proposer = new FakeScopeCorrespondenceProposer();
    const run = (): Promise<readonly ScopeCorrespondence[]> =>
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

  it("proposes nothing for a consumer-provider mapping (the Phase-5 adapter path)", async () => {
    const proposer = new FakeScopeCorrespondenceProposer();
    const stored = await proposeScopeCorrespondences({
      mapping: { ...peerMapping, variant: "consumer-provider" },
      fields: [titleField],
      operations: [createOperationMapping],
      ops: buildOps(proposer),
      newId: () => "corr-1",
    });
    expect(stored).toStrictEqual([]);
    expect(proposer.rows.size).toBe(0);
  });

  it("proposes nothing for a mapping whose pairs are all non-scoped (no regression to L1/L2)", async () => {
    const proposer = new FakeScopeCorrespondenceProposer();
    const stored = await proposeScopeCorrespondences({
      mapping: peerMapping,
      // A field-only mapping covering `issues -> tasks` with NO approved write operation:
      // nothing establishes a container path parameter, so nothing is proposed.
      fields: [titleField],
      operations: [],
      ops: buildOps(proposer),
      newId: () => "corr-1",
    });
    expect(stored).toStrictEqual([]);
    expect(proposer.rows.size).toBe(0);
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
    expect(context).toStrictEqual({ scopeLinkAvailable: true, scopeKeyRefCandidate: "id" });
  });

  it("keeps scope-link UNAVAILABLE for a pair with no proposed correspondence", async () => {
    const context = await buildResolver([]).resolve(vikunjaTasksBinding, VIKUNJA);
    expect(context).toStrictEqual({
      scopeLinkAvailable: false,
      scopeKeyRefCandidate: undefined,
    });
  });

  it("keeps scope-link unavailable for a resource with no scope path parameter at all", async () => {
    const context = await buildResolver([correspondence]).resolve(vikunjaProjectsBinding, VIKUNJA);
    expect(context).toStrictEqual({
      scopeLinkAvailable: false,
      scopeKeyRefCandidate: undefined,
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
    expect(context).toStrictEqual({ scopeLinkAvailable: true, scopeKeyRefCandidate: undefined });
  });
});
